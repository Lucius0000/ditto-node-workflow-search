import {graph,graphStep,loop} from '@codesoul-co/ditto/runtime';
import type {ModelConfig,Message,ModelProvider,SampleOutput} from '@codesoul-co/ditto/worker/infer';
import type {AgentRunResult,BenchmarkTask,CheckerAudit} from '../domain.js';
import type {ProviderSettings} from '../config.js';
import {createExperimentRuntime,type ExperimentRuntime} from '../ditto/runtime.js';
import {createTaskMemory} from '../ditto/task-memory.js';
import {createBenchmarkTools,closeBenchmarkTools} from '../ditto/benchmark-tools.js';
import {captureCapabilityOutputs} from '../workflow/capability-observer.js';
import {applyCheckerSemantics,type ReflectionBinding} from '../workflow/checker-semantics.js';
import {checkerContract,validateCheckerCriteria} from '../workflow/checker-policy.js';
import {baselinePrompts,baselineTextMessages} from '../benchmark/baseline-prompts.js';
import {taskOutputRequirements} from '../benchmark/answer-contract.js';
import {currentProviderUsage,currentTimeBudgetSignal} from '../execution/time-budget.js';
import {GENERATION} from '../protocol.js';
import {generatedTools} from './tools.js';
import {graphAgentReflectionProvider,type AgentReflectionResponse} from './reflect-contract.js';
import {validateDefinition,topologicalNodes,type GraphDefinition,type DefinitionNode,type Source,type SemanticSource,type Condition,type Transition,GRAPH_AGENT_POLICY} from './schema.js';
import {evaluateBinding,readBindingPath,BindingContractError,ModelOutputFormatError,type BindingEnvironment} from './bindings.js';
import {createTaskRetrieval} from './retrieval.js';
import {NODE_SYSTEM_PROMPT,NODE_SYSTEM_VERSION} from './system.js';
import {automationScope,AUTOMATION_TOOLS} from '../benchmark/automation.js';
import {createAutomationTools} from '../ditto/automation-tools.js';
import {AutomationActorBudgetExceeded} from '../execution/automation-budget.js';
import {usesAutomationDecisionContract,validateAutomationDecision} from './automation-baseline.js';

class GraphRunBudgetExceeded extends Error {}

export class AgentContractError extends Error {
 readonly code='B_AGENT_CONTRACT';readonly failureKind='execution';readonly publicMessage:string;
 readonly publicIssue:{code:string;path:string;message:string;repairHint:string};
 constructor(message:string,readonly nodeId?:string){super(message);this.publicMessage=`${nodeId?`Node ${nodeId}: `:''}${message}`;
  this.publicIssue={code:this.code,path:nodeId?`nodes.${nodeId}`:'workflow',message:this.publicMessage,repairHint:'Correct the named native binding, argument or declared output. Use the documented native field path; preserve the original task and scorer.'};}
}
export interface ModelResponseRecord {nodeId:string;nodeType:string;rawContent:SampleOutput['message']['content'];finishReason:string;systemMessages:unknown[]}
export interface GraphAgentResult extends AgentRunResult {
 readonly nodeInputs:Record<string,any>;readonly nodeOutputs:Record<string,any>;readonly rawNodeOutputs:Record<string,any>;
 readonly trace:readonly {graphId:string;nodeId:string;output:unknown}[];
 readonly reflectionResponses:readonly AgentReflectionResponse[];readonly modelResponses:readonly ModelResponseRecord[];
 readonly convertedNodeOutputs:Record<string,any>;readonly finalPrediction:string;readonly state:Record<string,any>;
 readonly modelFailure?:{kind:'model-output';code:string;message:string;nodeId?:string};
 /** Legacy interface only. Unified execution throws engineering errors instead of returning this flag. */
 readonly candidateFailure?:{kind:'binding';code:'B_AGENT_CONTRACT';message:string;nodeId?:string};
}
const MODEL_ERRORS=new Set(['INVALID_MODEL_OUTPUT','INCOMPLETE_MODEL_OUTPUT','NO_CONSENSUS']);
const INFRA_ERRORS=new Set(['TIMEOUT','CANCELLED','PROVIDER_UNAVAILABLE','RETRIEVAL_BACKEND_ERROR','RETRIEVAL_PROVIDER_UNAVAILABLE','RETRIEVAL_TIMEOUT','RETRIEVAL_CANCELLED']);
export function successfulOutput(raw:any,nodeId:string):any {
 if(raw?.status&&raw.status!=='success'){
  const code=String(raw.error?.code??raw.status),message=`${nodeId}: ${code}: ${raw.error?.message??''}`;
  if(MODEL_ERRORS.has(code))throw new ModelOutputFormatError(message,nodeId);
  if(INFRA_ERRORS.has(code))throw Object.assign(new Error(message),{code,infrastructureFailure:true});
  throw new AgentContractError(message,nodeId);
 }
 return raw?.output??raw;
}
/** Preserve legal native MessagePart[] rather than rejecting or coercing it to an empty answer. */
export function messageContentText(content:any,nodeId:string):string {
 if(typeof content==='string')return content;
 if(Array.isArray(content))return content.map(part=>{
  if(part?.type==='text'&&typeof part.text==='string')return part.text;
  if(part?.type==='json'&&Object.hasOwn(part,'data'))return JSON.stringify(part.data);
  throw new AgentContractError(`Unsupported native message part for ${nodeId}`,nodeId);
 }).join('\n');
 throw new AgentContractError(`Native message content missing for ${nodeId}`,nodeId);
}
export function answerValue(raw:any,nodeId:string):string {
 const output=successfulOutput(raw,nodeId),message=output?.message??output?.result;
 if(!message)throw new AgentContractError(`Typed answer output missing for ${nodeId}`,nodeId);
 return messageContentText(message.content,nodeId);
}
export function checkedReflectionOutput(node:Pick<DefinitionNode,'id'|'config'>,raw:any,binding:ReflectionBinding):any {
 const output=successfulOutput(raw,node.id);return{...raw,output:applyCheckerSemantics({id:node.id,config:{mode:node.config.mode}} as any,output,binding)};
}
export function projectValue(source:Extract<SemanticSource,{from:'node'}>,raw:any):any {
 const output=successfulOutput(raw,source.nodeId);
 switch(source.view){
  case'answer':return answerValue(raw,source.nodeId);
  case'context':{const c=output?.context??output;if(!Array.isArray(c?.items))throw new AgentContractError('Expected Context items',source.nodeId);return c;}
  case'assessment':return{assessment:output.assessment,issues:output.issues,checkerAudit:output.checkerAudit};
  case'external-result':return raw;
  case'memory-ids':{const records=Array.isArray(output)?output:output.items;if(!Array.isArray(records))throw new AgentContractError('Expected Memory records',source.nodeId);return records.map((v:any)=>v.id??v.memory?.id);}
  case'memory-records':case'cache':return output;
  case'evidence':{if(raw?.source&&Object.hasOwn(raw,'structuredContent'))return raw.structuredContent;const context=output?.context??output;if(Array.isArray(context?.items))return context.items.map((item:any)=>item.content);return output;}
 }
}
const asText=(value:any):string=>typeof value==='string'?value:JSON.stringify(value);
export async function runGraphAgent(inputDefinition:GraphDefinition,task:BenchmarkTask,shared:ExperimentRuntime,settings:ProviderSettings):Promise<GraphAgentResult> {
 const definition=validateDefinition(inputDefinition),signal=currentTimeBudgetSignal();
 const automation=automationScope.getStore();
 if(task.dataset==='automationbench'&&!automation)throw new AgentContractError('Automation execution requires a fresh task world');
 if(!automation&&definition.graphs.some(g=>g.nodes.some(n=>n.type==='INTERACTION.ACT.TOOL'&&(AUTOMATION_TOOLS as readonly string[]).includes(n.config.tool))))throw new AgentContractError('Official Automation tools require a task world');
 const toolCatalog=automation?`\n\nAvailable official task-world tools (call through the declared Graph):\n${JSON.stringify(automation.tools)}`:'';
 for(const g of definition.graphs)for(const node of g.nodes)if(node.type==='INFER.REASONING.REFLECT')validateCheckerCriteria(task.dataset,node.config.criteria);
 const standard=createBenchmarkTools(),custom=generatedTools(definition.tools??[]),retrieval=createTaskRetrieval(task);
 const contract=graphAgentReflectionProvider(shared.provider),modelResponses:ModelResponseRecord[]=[];
 let providerFault:unknown;
 const exhaustedReflections=new Map<string,string>();
 const recordingProvider:ModelProvider={async invoke(input,options){
  try{const response=await contract.provider.invoke(input,options);modelResponses.push({nodeId:String(input.metadata?.nodeId??'unknown'),nodeType:String(input.metadata?.nodeType??'unknown'),rawContent:structuredClone(response.message.content),finishReason:response.finishReason,systemMessages:input.messages.filter(m=>m.role==='system').map(m=>structuredClone(m.content))});return response;}
  catch(error){providerFault=error;throw error;}
 }};
 const scoped=createExperimentRuntime(settings,{provider:recordingProvider,managedProvider:true,tools:[...standard,...custom.tools,...createAutomationTools()],workers:[retrieval.worker],memory:createTaskMemory(),reflectionEvent:async event=>{
  if(event.outcome==='exhausted')exhaustedReflections.set(String(event.nodeId),event.error??'Model reflection did not satisfy its fixed output contract');
  await shared.reflectionEvent?.(event);
 }});
 const model:ModelConfig={provider:shared.providerName,model:shared.model};
 const nodes=new Map(definition.graphs.flatMap(g=>g.nodes.map(n=>[n.id,n] as const)));
 const normalized=new WeakMap<object,any>(),reflectionBindings=new Map<string,ReflectionBinding>();
 const nodeInputs:Record<string,any>={},nodeOutputs:Record<string,any>={},rawNodeOutputs:Record<string,any>={};
 const executedNodeIds:string[]=[],executedGraphIds:string[]=[],trace:{graphId:string;nodeId:string;output:unknown}[]=[];
 const audits:CheckerAudit[]=[],state=structuredClone(definition.loop.state??{});
 const normalize=(id:string,raw:any):any=>{
  if(!raw||typeof raw!=='object')return raw;if(normalized.has(raw))return normalized.get(raw);
  if(raw.status&&raw.status!=='success'){
   if(providerFault)throw providerFault;
   if(exhaustedReflections.has(id))throw new ModelOutputFormatError(exhaustedReflections.get(id)!,id);
   successfulOutput(raw,id);
  }
  if(raw.output?.generationOutcome?.usable===false)throw new ModelOutputFormatError('Model output was incomplete and unusable',id);
  const node=nodes.get(id)!;let value=raw;
  if(task.dataset==='automationbench'&&automation&&usesAutomationDecisionContract(node))validateAutomationDecision(messageContentText(successfulOutput(raw,id)?.message?.content,id),id,automation.tools);
  if(node.type==='INFER.REASONING.REFLECT'){
   const binding=reflectionBindings.get(id);if(!binding)throw new AgentContractError('Missing application-owned reflection binding',id);
   let substantive=raw;if(contract.preservedNodes.has(id)){const{revisedResult:_injected,...fields}=raw.output;substantive={...raw,output:fields};}
   value=checkedReflectionOutput(node,substantive,binding);audits.push(value.output.checkerAudit);
  }
  normalized.set(raw,value);return value;
 };
 const env=(available:Record<string,any>,previous=available,snapshot=state):BindingEnvironment=>({task:{id:task.id,dataset:task.dataset,prompt:task.prompt,outputInstruction:task.outputInstruction},nodes:available,prior:previous,state:snapshot,nodeOutput:(id,raw)=>successfulOutput(normalize(id,raw),id),isModelNode:id=>nodes.get(id)?.config.outputFormat==='json'});
 const resolve=(source:any,available:Record<string,any>,previous=available,snapshot=state):any=>{
  if(!source?.from)return evaluateBinding(source,env(available,previous,snapshot));
  if(source.from==='literal')return structuredClone(source.value);
  if(source.from==='task'){const text=task[source.field as 'prompt'|'outputInstruction'];if(!source.extract)return text;const numbers=text.match(/[-+]?\d+(?:,\d{3})*(?:\.\d+)?/g)??[],selected=numbers[source.extract.index];if(selected===undefined)throw new AgentContractError('Requested public numeric item is absent');return Number(selected.replaceAll(',',''));}
  if(source.from==='join')return source.parts.map((p:Source)=>asText(resolve(p,available,previous,snapshot))).join(source.separator);
  if(source.from==='previous')return Object.hasOwn(previous,source.nodeId)?projectValue({...source,from:'node'},normalize(source.nodeId,previous[source.nodeId])):resolve(source.fallback,available,previous,snapshot);
  if(!Object.hasOwn(available,source.nodeId))throw new AgentContractError(`Required node ${source.nodeId} did not execute`,source.nodeId);
  return projectValue(source,normalize(source.nodeId,available[source.nodeId]));
 };
 const bind=(node:DefinitionNode,available:Record<string,any>,previous:Record<string,any>,snapshot:Record<string,any>):any=>{
  const c=node.config,get=(s:any)=>resolve(s,available,previous,snapshot),metadata={experiment:GRAPH_AGENT_POLICY,nodeType:node.type,nodeId:node.id,taskId:task.id,dataset:task.dataset,systemVersion:NODE_SYSTEM_VERSION};
  const evidence=()=> (c.evidence??[]).map((s:Source)=>asText(get(s))).join('\n\n');
  const extra=()=>c.user===undefined?'':asText(get(c.user));
  const format=()=>c.outputFormat==='json'?'\n\nDeclared node output format: return strict JSON only.':'';
  const userMessages=()=>[{role:'user' as const,content:`Original task:\n${task.prompt}\n\nNode instruction:\n${c.instruction??''}\n\nAdditional user material:\n${extra()}\n\nTask output requirements:\n${taskOutputRequirements(task)}${format()}${toolCatalog}`}];
  switch(node.type){
   case'CONTEXT.LOAD':return{sources:c.sources.map((s:Source,i:number)=>({id:`${node.id}-source-${i}`,content:get(s)}))};
   case'CONTEXT.SELECT':return{context:get(c.context),purpose:'infer',strategy:{kind:'default'},...(c.query!==undefined?{query:asText(get(c.query))}:{}),...(c.limit?{limit:c.limit}:{}),...(c.maxTokens?{maxTokens:c.maxTokens}:{})};
   case'CONTEXT.UPDATE':return{context:get(c.context),...(c.add!==undefined?{add:[{id:`${node.id}-added`,content:get(c.add)}]}:{}),removeIds:c.removeIds??[]};
   case'CONTEXT.COMPRESS':return{context:get(c.context),...(c.maxItems?{maxItems:c.maxItems}:{}),...(c.maxTokens?{maxTokens:c.maxTokens}:{})};
   case'MEMORY.WRITE':return{memories:[{key:node.id,content:get(c.content)}]};
   case'MEMORY.GET':case'MEMORY.DELETE':return{ids:get(c.ids)};
   case'MEMORY.UPDATE':{const ids=get(c.ids);if(!Array.isArray(ids))throw new AgentContractError('Memory UPDATE ids must be an array',node.id);return{memories:ids.map((id:string)=>({id,content:get(c.content)}))};}
   case'MEMORY.SEARCH':return{query:asText(get(c.query)),limit:c.limit??3};
   case'MEMORY.QUERY':return{filter:c.filter??{},limit:c.limit??3};
   case'INFER.CACHE.LOOKUP':case'INFER.CACHE.INVALIDATE':case'INFER.CACHE.WRITE':{const key={scope:'sample',key:asText(get(c.key))};return node.type.endsWith('INVALIDATE')?{selector:{type:'key',key}}:node.type.endsWith('WRITE')?{key,value:get(c.value),...(c.ttlMs?{ttlMs:c.ttlMs}:{})}:{key};}
   case'INTERACTION.ACT.TOOL':return{call:{id:`${node.id}-call`,name:c.tool,arguments:Object.fromEntries(Object.entries(c.arguments).map(([key,source])=>[key,get(source)]))}};
   case'INTERACTION.OBSERVE':return{result:get(c.result)};
   case'RETRIEVAL.SEARCH':return{query:{content:asText(get(c.query))},target:{name:'task-public'},limit:c.limit??5};
   case'INFER.REASONING.SAMPLE':{
    const instruction=c.instruction||baselinePrompts(task.dataset)?.agent||'Solve the original public task accurately.';
    const body=task.dataset==='drop'||task.dataset==='gsm8k'?baselineTextMessages(task.dataset,instruction,task.prompt,evidence()):[{role:'user' as const,content:`${instruction}\n\n${task.prompt}\n\nOutput requirements:\n${task.outputInstruction}\n\n${evidence()}`}];
    const additional=[...(c.user===undefined?[]:[{role:'user' as const,content:extra()}]),...(toolCatalog?[{role:'user' as const,content:toolCatalog}]:[])];
    return{messages:[{role:'system',content:NODE_SYSTEM_PROMPT},...(task.dataset==='drop'?additional:[]),...body,...(task.dataset==='drop'?[]:additional),...(task.dataset==='drop'&&task.outputInstruction?[{role:'user',content:`Additional public task output requirements:\n${task.outputInstruction}`}]:[]),...(c.outputFormat==='json'?[{role:'user',content:format()}]:[])],model,generation:GENERATION,metadata};
   }
   case'INFER.REASONING.TRAJECTORY':return{messages:[{role:'system',content:NODE_SYSTEM_PROMPT},...userMessages(),{role:'user',content:`Evidence:\n${evidence()}`}],objective:c.instruction,strategy:{name:c.strategy,options:c.options??{}},constraints:{maxSteps:c.maxSteps??Number.MAX_SAFE_INTEGER},model,generation:GENERATION,metadata};
   case'INFER.REASONING.DELIBERATE':return{messages:userMessages(),objective:c.instruction||task.outputInstruction||'Return the final answer.',candidates:c.candidates.map((s:Source,i:number)=>({id:`candidate-${i}`,result:{role:'assistant',content:asText(get(s))}})),mode:c.mode,model,generation:GENERATION,metadata};
   case'INFER.REASONING.REFLECT':{
    const target:Message={role:'assistant',content:asText(get(c.target))};
    const feedback:CheckerAudit[]=(c.feedback??[]).map((s:Source)=>get(s).checkerAudit);
    if(feedback.some(f=>!f||f.originalAnswer!==target.content))throw new AgentContractError('Checker feedback targets a different answer',node.id);
    const criteria=[checkerContract(task.dataset),...c.criteria],targetNodeId=c.target.nodeId??c.target.ref?.[1]??'declared-target';
    reflectionBindings.set(node.id,{target,targetNodeId,feedback,criteria});
    return{messages:userMessages(),target:{result:target},mode:c.mode,criteria:criteria.map((description:string,i:number)=>({id:`criterion-${i}`,description,weight:1})),...(feedback.length?{context:[{id:`${node.id}-feedback`,content:{originalAnswer:target,checks:feedback.map(({assessment,issues,nodeId})=>({assessment,issues,nodeId}))}}]}:{}),model,generation:GENERATION,metadata};
   }
  }
 };
 const compiled=new Map<string,any>();
 for(const g of definition.graphs){let builder:any=graph<{prior:Record<string,any>;state:Record<string,any>}>(g.id);for(const node of topologicalNodes(g))builder=builder.node(node.id,node.type,node.dependencies,(frame:{prior:Record<string,any>;state:Record<string,any>},local:Record<string,any>)=>{
  const available={...frame.prior,...Object.fromEntries(node.dependencies.map(id=>[id,local[id]]))};
  try{const bound=bind(node,available,frame.prior,frame.state);nodeInputs[node.id]=structuredClone(bound);return bound;}
  catch(error){if(error instanceof BindingContractError)throw new AgentContractError(error.message,node.id);throw error;}
 });compiled.set(g.id,builder);}
 const matches=(condition:Condition):boolean=>{
  let left=resolve(condition.source??condition.left,nodeOutputs);if(condition.path)left=readBindingPath(left,condition.path);
  const right=condition.right===undefined?condition.value:resolve(condition.right,nodeOutputs);
  if(condition.operator==='truthy')return Boolean(left);if(condition.operator==='falsy')return!left;
  if(condition.operator==='equals')return JSON.stringify(left)===JSON.stringify(right);if(condition.operator==='not-equals')return JSON.stringify(left)!==JSON.stringify(right);
  if(typeof left!=='number'||typeof right!=='number'||!Number.isFinite(left)||!Number.isFinite(right))throw new AgentContractError('Numeric Loop conditions require finite numbers');
  return condition.operator==='gt'?left>right:condition.operator==='gte'?left>=right:condition.operator==='lt'?left<right:left<=right;
 };
 const visits:Record<string,number>={};
 const next=(t:Transition):string|undefined=>{switch(t.kind){case'end':return undefined;case'next':return t.graphId;case'repeat':return matches(t.until)||(visits[t.graphId]??0)>=t.maxVisits?t.nextGraphId:t.graphId;case'switch':return t.cases.find(c=>matches(c.when))?.graphId??t.defaultGraphId;}};
 const definitionLoop=loop<BenchmarkTask,string>({id:'declarative-execution-agent',maxIterations:definition.loop.maxGraphRuns,*plan(){let current:string|undefined=definition.loop.entryGraphId,runs=0;
  while(current!==undefined){if(runs++>=definition.loop.maxGraphRuns)throw new GraphRunBudgetExceeded('Declared Graph/Loop budget exhausted');const currentId=current;executedGraphIds.push(currentId);visits[currentId]=(visits[currentId]??0)+1;
   const raw:Record<string,any>=yield*graphStep(compiled.get(currentId),{prior:{...nodeOutputs},state:structuredClone(state)},signal?{signal}:{});
   for(const[id,value]of Object.entries(raw))nodeOutputs[id]=normalize(id,value);
   const snapshot=structuredClone(state),patch=Object.fromEntries(Object.entries(definition.loop.stateUpdates?.[currentId]??{}).map(([key,value])=>[key,resolve(value,nodeOutputs,nodeOutputs,snapshot)]));Object.assign(state,structuredClone(patch));
   current=next(definition.loop.transitions[currentId]!);
  }
  if(Object.hasOwn(definition.output,'answer')){const answer=resolve(definition.output.answer,nodeOutputs);if(typeof answer==='string')return answer;const p=(definition.output.answer as any)?.ref;if(Array.isArray(answer)&&Array.isArray(p)&&['message','result'].includes(p[2])&&p[3]==='content')return messageContentText(answer,p[1]);throw new AgentContractError('Declared final answer must evaluate to a string');}
  return answerValue(nodeOutputs[definition.output.nodeId!],definition.output.nodeId!);
 }});
 const result=(answer:string,modelFailure?:GraphAgentResult['modelFailure']):GraphAgentResult=>({answer,finalPrediction:answer,executedNodeIds,executedGraphIds,inputTokens:0,outputTokens:0,totalTokens:0,...currentProviderUsage(),nodeInputs,nodeOutputs,convertedNodeOutputs:nodeOutputs,rawNodeOutputs,trace,checkerAudits:audits,reflectionResponses:contract.responses,modelResponses,state:structuredClone(state),generationOutcomes:Object.values(nodeOutputs).flatMap(value=>value?.output?.generationOutcome?[value.output.generationOutcome]:[]),...(modelFailure?{modelFailure}:{})});
 try{const answer=await captureCapabilityOutputs(event=>{if(!nodes.has(event.nodeId))return;rawNodeOutputs[event.nodeId]=structuredClone(event.output);nodeOutputs[event.nodeId]=event.output;executedNodeIds.push(event.nodeId);trace.push({graphId:event.graphId,nodeId:event.nodeId,output:structuredClone(event.output)});nodeOutputs[event.nodeId]=normalize(event.nodeId,event.output);},()=>scoped.runtime.loop(definitionLoop,task,signal?{signal}:{}));return result(answer);}
 catch(error){
  if(error instanceof AutomationActorBudgetExceeded||providerFault instanceof AutomationActorBudgetExceeded)return {...result(''),executionBudget:(providerFault instanceof AutomationActorBudgetExceeded?providerFault:error as AutomationActorBudgetExceeded).outcome};
  if(error instanceof GraphRunBudgetExceeded)return {...result(''),executionBudget:{scope:'graph-runs',limit:definition.loop.maxGraphRuns,used:executedGraphIds.length}};
  if(providerFault)throw Object.assign(providerFault instanceof Error?providerFault:new Error(String(providerFault)),currentProviderUsage(),{partialRun:result(''),infrastructureFailure:true});
  if(error instanceof ModelOutputFormatError)return result('',{kind:'model-output',code:error.code,message:error.message,...(error.nodeId?{nodeId:error.nodeId}:{})});
  const failure=error instanceof AgentContractError?error:error instanceof BindingContractError?new AgentContractError(error.message):error instanceof Error?error:new Error(String(error));
  throw Object.assign(failure,currentProviderUsage(),{partialRun:result('')});
 }finally{await scoped.close();await custom.close();await closeBenchmarkTools(standard);}
}
