import {compileAgent,type AgentDefinition,type CompiledAgent,type AgentBoundary,type AgentBoundaryDecision} from '@codesoul-co/ditto/runtime';
import type {ModelProvider,SampleOutput} from '@codesoul-co/ditto/worker/infer';
import type {WorkerDefinition} from '@codesoul-co/ditto/worker';
import type {RegisteredTool} from '@codesoul-co/ditto/worker/interaction';
import {isDeepStrictEqual} from 'node:util';
import type {BenchmarkTask,CheckerAudit} from '../domain.js';
import type {ProviderSettings} from '../config.js';
import {createExperimentRuntime,type ExperimentRuntime} from '../ditto/runtime.js';
import {createTaskMemory} from '../ditto/task-memory.js';
import {createBenchmarkTools,closeBenchmarkTools} from '../ditto/benchmark-tools.js';
import {captureCapabilityExecution,type CapabilityInvocation,type CapabilityCompletion} from '../workflow/capability-observer.js';
import {applyCheckerSemantics,type ReflectionBinding} from '../workflow/checker-semantics.js';
import {checkerContract,validateCheckerCriteria} from '../workflow/checker-policy.js';
import {taskOutputRequirements} from '../benchmark/answer-contract.js';
import {currentProviderUsage,currentTimeBudgetSignal} from '../execution/time-budget.js';
import {GENERATION} from '../protocol.js';
import {graphAgentReflectionProvider} from '../graph-agent/reflect-contract.js';
import {ModelOutputFormatError} from '../graph-agent/bindings.js';
import type {GraphAgentResult,ModelResponseRecord} from '../graph-agent/executor.js';
import {createTaskRetrieval} from '../graph-agent/retrieval.js';
import {NODE_SYSTEM_PROMPT,NODE_SYSTEM_VERSION} from '../graph-agent/system.js';
import {automationScope,AUTOMATION_TOOLS} from '../benchmark/automation.js';
import {createAutomationTools} from '../ditto/automation-tools.js';
import {bfclScope,BFCL_GUIDE,BFCL_TOOLS} from '../benchmark/bfcl.js';
import {createBfclTools} from '../ditto/bfcl-tools.js';
import {AutomationActorBudgetExceeded} from '../execution/automation-budget.js';
import {createOfficialDataWorker,transformOfficialData} from './helpers.js';
import {createToolProgressTracker} from './progress.js';
import {HOST_INFER_MESSAGES_SCHEMA} from './native-contracts.js';
import {validateNativeLiteral} from './native-validation.js';
import {DefinitionError} from '../graph-agent/schema.js';
import {validateBfclSearchGraph} from './baselines.js';
import {BFCL_ACTION_CONTRACT} from './bfcl-strategy.js';
import {decodeBfclDsml} from './decision-protocol.js';

export const OFFICIAL_EXECUTOR_VERSION='ditto-official-compiled-agent-v1';
export const OFFICIAL_EVIDENCE_VERSION='official-native-source-map-v1';

function bfclBoundary(boundary:AgentBoundary):AgentBoundaryDecision{
 const {step,result,state}=boundary;
 if(step==='decision'){
  const decision=decodeBfclDsml(result)??transformOfficialData({operation:'decision',value:result,allowedTools:BFCL_TOOLS});
  if(decision.done&&state.complete!==true)throw new ModelOutputFormatError('BFCL cannot finish before the official conversation completes');
  return {update:{decision,final:decision.finalAnswer,complete:decision.done}};
 }
 if(step!=='bootstrap'&&step!=='action')throw new OfficialAgentContractError('Unknown BFCL conversation boundary');
 const bootstrap=step==='bootstrap';
 const provenance=[{graphId:bootstrap?'main':'action',nodeId:bootstrap?'state':'observe',
  nativePath:['structuredContent'],nodeType:bootstrap?'INTERACTION.ACT.TOOL':'INTERACTION.OBSERVE'}];
 const evidence=transformOfficialData({operation:'evidence',value:result,provenance});
 if(bootstrap)return {update:{history:[{role:'user',content:evidence}],complete:(result as {complete?:boolean}|null)?.complete===true}};
 const decision=state.decision as {tool:string};
 return {update:transformOfficialData({operation:'bfcl-history',tool:decision.tool,decision,value:result,evidence,history:state.history})};
}

export class OfficialAgentContractError extends Error {
 readonly code='OFFICIAL_AGENT_CONTRACT';readonly failureKind='execution';readonly publicMessage:string;
 readonly publicIssue:{code:string;path:string;message:string;repairHint:string};
 constructor(message:string,readonly nodeId?:string,path?:string){
  super(message);this.name='OfficialAgentContractError';this.publicMessage=`${nodeId?`Node ${nodeId}: `:''}${message}`;
  this.publicIssue={code:this.code,path:path??(nodeId?`nodes.${nodeId}`:'agent'),message:this.publicMessage,repairHint:'Correct the named official Agent JSON input, expression or native output path. Preserve the original task, fixed host fields and scorer.'};
 }
}

export interface OfficialAgentResult extends GraphAgentResult {
 readonly sourceMap:CompiledAgent['sourceMap'];
 readonly executorVersion:typeof OFFICIAL_EXECUTOR_VERSION;
}
export interface OfficialExecutionOptions {readonly tools?:readonly RegisteredTool[];readonly workers?:readonly WorkerDefinition[];}

const modelErrors=new Set(['INVALID_MODEL_OUTPUT','INCOMPLETE_MODEL_OUTPUT','NO_CONSENSUS']);
const infrastructureErrors=new Set(['TIMEOUT','CANCELLED','PROVIDER_UNAVAILABLE','RETRIEVAL_BACKEND_ERROR','RETRIEVAL_PROVIDER_UNAVAILABLE','RETRIEVAL_TIMEOUT','RETRIEVAL_CANCELLED']);
const infer=(type:string)=>type.startsWith('INFER.REASONING.');
const text=(value:unknown):string=>typeof value==='string'?value:JSON.stringify(value);
const key=(event:Pick<CapabilityCompletion,'graphId'|'nodeId'>)=>`${event.graphId}/${event.nodeId}`;

/** Only identities are added to presentation; native data and answer values are not normalized. */
function references(value:unknown):string[]{
 if(!value||typeof value!=='object')return[];
 if(Array.isArray(value))return value.flatMap(references);
 const object=value as Record<string,unknown>;
 if(Object.hasOwn(object,'$literal'))return[];
 return[...(typeof object.$ref==='string'?[object.$ref]:[]),...Object.values(object).flatMap(references)];
}

function messageText(value:unknown,nodeId:string):string{
 if(typeof value==='string')return value;
 if(Array.isArray(value))return value.map(part=>{
  if(part?.type==='text'&&typeof part.text==='string')return part.text;
  if(part?.type==='json'&&Object.hasOwn(part,'data'))return JSON.stringify(part.data);
  throw new OfficialAgentContractError('Unsupported native message part in final answer',nodeId);
 }).join('\n');
 throw new OfficialAgentContractError('Final output must be an answer string or native MessagePart[] content; explicitly serialize numeric/tool values with HOST.DATA.TRANSFORM operation:"text" before projecting Graph/Loop output',nodeId);
}

/** The npm compiler owns expressions, Subgraph expansion, bindings, DAG and Loop scheduling. */
export async function runOfficialAgent(definition:AgentDefinition,task:BenchmarkTask,shared:ExperimentRuntime,settings:ProviderSettings,options:OfficialExecutionOptions={}):Promise<OfficialAgentResult>{
 let compiled:CompiledAgent;
 try{
  compiled=compileAgent(definition);
  if(task.dataset==='bfcl')validateBfclSearchGraph(compiled.definition);
 }catch(error){
  const diagnostic=(error as {diagnostic?:{path?:string;message?:string}})?.diagnostic;
  throw new OfficialAgentContractError(diagnostic?.message??(error instanceof Error?error.message:String(error)),undefined,diagnostic?.path??(error instanceof DefinitionError?error.path:undefined));
 }
 const signal=currentTimeBudgetSignal(),automation=automationScope.getStore(),bfcl=bfclScope.getStore();
 if(task.dataset==='automationbench'&&!automation)throw new OfficialAgentContractError('Automation execution requires a fresh official task world');
 if(task.dataset==='bfcl'&&!bfcl)throw new OfficialAgentContractError('BFCL execution requires a fresh official conversation world');
 const toolCatalog=automation?`Available official task-world tools:\n${JSON.stringify(automation.tools)}`:bfcl?`${BFCL_GUIDE}\nAvailable official conversation tools:\n${JSON.stringify(bfcl.tools)}`:'';
 const taskRequirements=taskOutputRequirements(task),originalTaskMessage={role:'user' as const,content:`Original task:\n${task.prompt}\n\nTask output requirements:\n${taskRequirements}`};
 const model={provider:shared.providerName,model:shared.model};
 const system=bfcl?NODE_SYSTEM_PROMPT+'\n\n'+BFCL_ACTION_CONTRACT:NODE_SYSTEM_PROMPT;
 const host={model,generation:GENERATION,system,taskRequirements,originalTaskMessage,taskMessage:originalTaskMessage.content,
  messages:[{role:'system',content:system},originalTaskMessage],toolCatalog};
 const input={task:{id:task.id,dataset:task.dataset,prompt:task.prompt,outputInstruction:task.outputInstruction},host};
 const standard=createBenchmarkTools(),retrieval=createTaskRetrieval(task);
 const contract=graphAgentReflectionProvider(shared.provider),modelResponses:ModelResponseRecord[]=[],audits:CheckerAudit[]=[];
 const nodeInputs:Record<string,any>={},nodeOutputs:Record<string,any>={},rawNodeOutputs:Record<string,any>={};
 const executedNodeIds:string[]=[],executedGraphIds:string[]=[],trace:{graphId:string;nodeId:string;output:unknown}[]=[];
 const reflectionBindings=new Map<string,ReflectionBinding>();
 const exhaustedReflections=new Map<string,string>();let providerFault:unknown,state:Record<string,unknown>={},firstSample=true;
 const recordingProvider:ModelProvider={async invoke(request,invokeOptions){
  try{
   const response=await contract.provider.invoke(request,invokeOptions);
   modelResponses.push({nodeId:String(request.metadata?.nodeId??'unknown'),nodeType:String(request.metadata?.nodeType??'unknown'),rawContent:structuredClone(response.message.content),finishReason:response.finishReason,systemMessages:request.messages.filter(m=>m.role==='system').map(m=>structuredClone(m.content))});
   return response;
  }catch(error){providerFault=error;throw error;}
 }};
 const progress=createToolProgressTracker();
 const scoped=createExperimentRuntime(settings,{provider:recordingProvider,managedProvider:true,tools:[...standard,...(bfcl?[]:createAutomationTools()),...createBfclTools(),...(options.tools??[])],workers:[retrieval.worker,...(bfcl?[]:[createOfficialDataWorker(progress)]),...(options.workers??[])],memory:createTaskMemory(),reflectionEvent:async event=>{
  if(event.outcome==='exhausted')exhaustedReflections.set(String(event.nodeId),event.error??'Model reflection did not satisfy its fixed response contract');
  await shared.reflectionEvent?.(event);
 }});
 const sourceFor=(event:Pick<CapabilityInvocation,'graphId'|'nodeId'>)=>compiled.sourceMap[event.graphId]?.[event.nodeId];
 const declarationFor=(event:Pick<CapabilityInvocation,'graphId'|'nodeId'>)=>{
  const source=sourceFor(event);return source?definition.graphs[source.graphId]?.nodes.find(n=>n.id===source.nodeId):undefined;
 };
 const prepare=(event:CapabilityInvocation):unknown=>{
  const nodeId=key(event),type=String(event.nodeType);let prepared=structuredClone(event.input) as any;
  if(infer(type)){
   if(!prepared||typeof prepared!=='object'||Array.isArray(prepared))throw new OfficialAgentContractError('Native inference input must be an object',nodeId);
   if(prepared.model!==undefined&&!isDeepStrictEqual(prepared.model,model))throw new OfficialAgentContractError('model must reference the fixed input.host.model',nodeId);
   if(prepared.generation!==undefined&&!isDeepStrictEqual(prepared.generation,GENERATION))throw new OfficialAgentContractError('generation must reference the fixed input.host.generation',nodeId);
   prepared.model=model;prepared.generation=GENERATION;
   if(!Array.isArray(prepared.messages))throw new OfficialAgentContractError('messages must contain the fixed input.host.messages and optional user artifacts',nodeId);
   const systems=prepared.messages.filter((m:any)=>m?.role==='system');
   if(systems.length!==1||systems[0].content!==system)throw new OfficialAgentContractError('messages must contain exactly the frozen host system; dataset/candidate instructions belong to user messages',nodeId);
   if(!prepared.messages.some((m:any)=>m?.role==='user'&&m.content===originalTaskMessage.content))throw new OfficialAgentContractError('Original public task and output requirements must remain present through input.host.messages',nodeId);
   prepared.metadata={...(prepared.metadata??{}),experiment:OFFICIAL_EXECUTOR_VERSION,nodeType:type,nodeId,graphId:event.graphId,taskId:task.id,dataset:task.dataset,systemVersion:NODE_SYSTEM_VERSION};
   const declaration=declarationFor(event),source=sourceFor(event);
   const provenance=references(declaration?.input).filter(r=>r.startsWith('nodes.')).map(ref=>{
    const [,producerId,...path]=ref.split('.'),producer=definition.graphs[source?.graphId??'']?.nodes.find(n=>n.id===producerId);
    return{namespace:'nodes',nodeId:producerId,graphId:source?.graphId,nativePath:path,...(producer&&'type'in producer?{nodeType:producer.type}:{})};
   });
   if(provenance.length)prepared.messages.push({role:'user',content:`Artifact provenance (identity, not proof of correctness):\nSource: ${JSON.stringify(provenance)}`});
   if(toolCatalog)prepared.messages.push({role:'user',content:toolCatalog});
   if(type==='INFER.REASONING.SAMPLE'&&firstSample){
    firstSample=false;
    if((definition.config as any)?.firstTaskRepeat===true)prepared.messages.push({...originalTaskMessage});
   }
   if(taskRequirements)prepared.messages.push({role:'user',content:`Fixed public task output requirements (apply to final answers; preserve an explicitly requested intermediate artifact format):\n${taskRequirements}`});
   try{validateNativeLiteral(prepared.messages,HOST_INFER_MESSAGES_SCHEMA,`${sourceFor(event)?.path??'nodes/'+nodeId}/input/messages`);}
   catch(error){if(error instanceof DefinitionError)throw new OfficialAgentContractError(`${error.detail}. This host requires string content or {type:"text",text:string}[]; use HOST.DATA.TRANSFORM text/json/concat to serialize data. $op:concat joins arrays, not text.`,nodeId,error.path);throw error;}
   if(type==='INFER.REASONING.REFLECT'){
    const criteria=(prepared.criteria??[]).map((c:any)=>c.description);
    validateCheckerCriteria(task.dataset,criteria);
    if(!criteria.includes(checkerContract(task.dataset)))prepared.criteria=[{id:'host-checker-contract',description:checkerContract(task.dataset),weight:1},...(prepared.criteria??[])];
    const target=prepared.target?.result;
    if(!target||target.role!=='assistant')throw new OfficialAgentContractError('REFLECT target.result must be the declared assistant answer',nodeId);
    const targetRef=references(declaration&&'input'in declaration?(declaration.input as any)?.target:undefined).find(r=>r.startsWith('nodes.'));
    const targetNodeId=targetRef?`${event.graphId}/${event.nodeId.slice(0,Math.max(0,event.nodeId.lastIndexOf('/')+1))}${targetRef.split('.')[1]}`:'declared-target';
    reflectionBindings.set(nodeId,{target,targetNodeId,feedback:[],criteria:prepared.criteria.map((c:any)=>c.description)});
   }
  }
  if(type==='HOST.DATA.TRANSFORM'&&prepared?.operation==='evidence'){
   const declaration=declarationFor(event),source=sourceFor(event);
   prepared.provenance=references(declaration?.input).filter(r=>r.startsWith('nodes.')).map(ref=>{
    const [,id,...path]=ref.split('.'),producer=definition.graphs[source?.graphId??'']?.nodes.find(n=>n.id===id);
    return{graphId:source?.graphId,nodeId:id,nativePath:path,...(producer&&'type'in producer?{nodeType:producer.type}:{})};
   });
  }
  nodeInputs[nodeId]=structuredClone(prepared);return prepared;
 };
 const complete=(event:CapabilityCompletion):unknown=>{
  const nodeId=key(event),type=String(event.nodeType),raw=event.output as any;
  rawNodeOutputs[nodeId]=structuredClone(raw);executedNodeIds.push(nodeId);trace.push({graphId:event.graphId,nodeId:event.nodeId,output:structuredClone(raw)});
  if(automation&&type==='INTERACTION.ACT.TOOL'){
   const call=nodeInputs[nodeId]?.call;
   if(call&&(AUTOMATION_TOOLS as readonly string[]).includes(call.name))progress.record(call,raw);
  }
  if(type.startsWith('INTERACTION.')){
   try{automation?.assertHealthy();bfcl?.assertHealthy();}catch(error){throw Object.assign(error instanceof Error?error:new Error(String(error)),{infrastructureFailure:true});}
  }
  if(raw?.status&&raw.status!=='success'&&!type.startsWith('INTERACTION.')){
   if(providerFault)throw providerFault;
   if(exhaustedReflections.has(nodeId))throw new ModelOutputFormatError(exhaustedReflections.get(nodeId)!,nodeId);
   const code=String(raw.error?.code??raw.status),message=`${nodeId}: ${code}: ${raw.error?.message??''}`;
   if(modelErrors.has(code))throw new ModelOutputFormatError(message,nodeId);
   if(infrastructureErrors.has(code))throw Object.assign(new Error(message),{code,infrastructureFailure:true});
   throw new OfficialAgentContractError(message,nodeId);
  }
  if(raw?.output?.generationOutcome?.usable===false)throw new ModelOutputFormatError('Model output was incomplete and unusable',nodeId);
  let normalized=raw;
  if(type==='INFER.REASONING.REFLECT'){
   const binding=reflectionBindings.get(nodeId);if(!binding)throw new OfficialAgentContractError('Missing host reflection target binding',nodeId);
   let substantive=raw.output;
   if(contract.preservedNodes.has(nodeId)){const{revisedResult:_injected,...fields}=substantive;substantive=fields;}
   const checked=applyCheckerSemantics({id:nodeId,config:{mode:nodeInputs[nodeId].mode}} as any,substantive,binding);
   audits.push(checked.checkerAudit);normalized={...raw,output:checked};
  }
  nodeOutputs[nodeId]=normalized;return normalized;
 };
 const result=(answer:string,modelFailure?:GraphAgentResult['modelFailure']):OfficialAgentResult=>({answer,finalPrediction:answer,executedNodeIds,executedGraphIds,inputTokens:0,outputTokens:0,totalTokens:0,...currentProviderUsage(),nodeInputs,nodeOutputs,convertedNodeOutputs:nodeOutputs,rawNodeOutputs,trace,checkerAudits:audits,reflectionResponses:contract.responses,modelResponses,state:structuredClone(state),sourceMap:compiled.sourceMap,executorVersion:OFFICIAL_EXECUTOR_VERSION,
  generationOutcomes:Object.values(nodeOutputs).flatMap(value=>value?.output?.generationOutcome?[value.output.generationOutcome]:[]),...(modelFailure?{modelFailure}:{})});
 try{
  const answer=await captureCapabilityExecution({before:prepare,after:complete},()=>compiled.run(scoped.runtime,input,{
   ...(signal?{signal}:{}),onGraph:event=>{if(event.status==='started')executedGraphIds.push(event.graphId);},onBoundary:boundary=>{
    const next=bfcl?bfclBoundary(boundary):undefined;
    state=structuredClone({...boundary.state,...next?.update});return next;
   },
  }));
  return result(messageText(answer,'output'));
 }catch(error){
  if(error instanceof AutomationActorBudgetExceeded||providerFault instanceof AutomationActorBudgetExceeded)return{...result(''),executionBudget:(providerFault instanceof AutomationActorBudgetExceeded?providerFault:error as AutomationActorBudgetExceeded).outcome};
  if(providerFault)throw Object.assign(providerFault instanceof Error?providerFault:new Error(String(providerFault)),currentProviderUsage(),{partialRun:result(''),infrastructureFailure:true});
  try{automation?.assertHealthy();bfcl?.assertHealthy();}catch(worldError){throw Object.assign(worldError instanceof Error?worldError:new Error(String(worldError)),currentProviderUsage(),{partialRun:result(''),infrastructureFailure:true});}
  if(error instanceof ModelOutputFormatError)return result('',{kind:'model-output',code:error.code,message:error.message,...(error.nodeId?{nodeId:error.nodeId}:{})});
  if((error as {infrastructureFailure?:boolean})?.infrastructureFailure)throw Object.assign(error instanceof Error?error:new Error(String(error)),currentProviderUsage(),{partialRun:result('')});
  if(error instanceof Error&&error.message==='Loop iteration limit reached')return{...result(''),executionBudget:{scope:'graph-runs',limit:definition.loop?.maxIterations??1,used:executedGraphIds.length}};
  const diagnostic=(error as {diagnostic?:{message?:string;path?:string}})?.diagnostic;
  const failure=error instanceof OfficialAgentContractError?error:new OfficialAgentContractError(diagnostic?.message??(error instanceof Error?error.message:String(error)),undefined,diagnostic?.path);
  throw Object.assign(failure,currentProviderUsage(),{partialRun:result('')});
 }finally{await scoped.close();await closeBenchmarkTools(standard);}
}
