import {auditDropAnswerRun} from './audit_drop_answer_contract.mjs';
// Bounded live validation. Search, confirmation and targeted regressions are separate.
import {readFile,mkdir,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {graph} from '@codesoul-co/ditto/runtime';
import {loadBenchmark} from '../dist/benchmark/index.js';
import {stratifiedSample,lengthBucket} from '../dist/benchmark/sampling.js';
import {publicAnswerContract} from '../dist/benchmark/answer-contract.js';
import {loadProviderSettings} from '../dist/config.js';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {providerEnvironment} from '../dist/unified/runner.js';
import {evaluationRuntimeIdentity} from '../dist/run/case-recovery.js';
import {UnifiedRunStore,artifactHash} from '../dist/unified/store.js';
import {createProviderBudget} from '../dist/unified/provider-budget.js';
import {evaluateUnifiedCandidate} from '../dist/unified/evaluation.js';
import {searchUnifiedWorkflows,parseUnifiedProposal,bestUnifiedCandidate} from '../dist/unified/search.js';
import {runGraphAgent} from '../dist/graph-agent/executor.js';
import {BASELINE_DEFINITION,validateDefinition,DefinitionError} from '../dist/graph-agent/schema.js';
import {withWorkflowTimeBudget} from '../dist/execution/time-budget.js';
import {GENERATION} from '../dist/protocol.js';
import {UNIFIED_SYSTEM_PROMPT,UNIFIED_SYSTEM_PROMPT_SHA256,UNIFIED_DEFINITION_GUIDE} from '../dist/unified/prompts.js';
import {NODE_SYSTEM_PROMPT_SHA256} from '../dist/graph-agent/system.js';
import {createDirectionBudget} from '../dist/unified/direction-budget.js';
import {MULTI_WORKER_POLICY} from '../dist/unified/exploration.js';
import {EVIDENCE_PRESENTATION_VERSION} from '../dist/graph-agent/evidence.js';

const flags=new Map();for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!['--output','--data-dir','--previous-run','--continue-confirmation'].includes(key)||!value||flags.has(key))throw Error('Use --output DIR --data-dir DIR [--previous-run DIR] [--continue-confirmation yes]');flags.set(key,value);}
const root=resolve(flags.get('--output')??'runs/drop-answer-contract-small'),dataDir=resolve(flags.get('--data-dir')??'data/datasets');
const previous=flags.has('--previous-run')?resolve(flags.get('--previous-run')):undefined;
const store=new UnifiedRunStore(root),project=process.cwd();await mkdir(root,{recursive:true});
const priorManifest=await store.optional('manifest.json'),continuing=flags.get('--continue-confirmation')==='yes';
if(priorManifest&&!continuing)throw Error('Existing frozen run: choose a new output directory; never overwrite paid evidence');
if(continuing&&(!priorManifest||priorManifest.status!=='interrupted'||priorManifest.error?.code!=='SEARCH_BUDGET_EXHAUSTED'))throw Error('Confirmation continuation requires the retained search-budget stop; it never resumes or expands search');
const settings={...loadProviderSettings(),concurrency:3},environment=providerEnvironment(project),runtimeIdentity=await evaluationRuntimeIdentity(project,environment);
const full=await loadBenchmark('drop',{dataDir,split:'validate',dataMode:'formal',limit:0});
const picked=stratifiedSample(full.tasks,36,20261029,t=>lengthBucket(t.prompt.length)),discovery=picked.slice(0,24),confirmation=picked.slice(24);
const subset=tasks=>({...full,tasks,identity:{...full.identity,selectedCount:tasks.length},evaluate:(runner,options)=>full.evaluateSearchSubset(tasks.map(t=>t.id),runner,options),
 evaluateSearchSubset:(ids,runner,options)=>{if(ids.some(id=>!tasks.some(t=>t.id===id)))throw Error('Outside frozen group');return full.evaluateSearchSubset(ids,runner,options);}});
const timeBudget={requestMs:120000,workflowMs:300000,reason:'Explicit bounded DROP answer-contract diagnostic, not formal Test'};
const limits={toolRepair:{maxCalls:6,maxTokens:20000},search:{maxCalls:500,maxTokens:700000},confirmation:{maxCalls:160,maxTokens:220000},regression:{maxCalls:48,maxTokens:90000}};
const manifest=continuing?{...priorManifest,status:'continuing-confirmation',continuation:{driverHash:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),reason:'Keep the stopped search and pending artifact; confirm only its best complete candidate, without increasing the search budget.'}}:{schemaVersion:1,experiment:'Ditto DROP user-answer-contract and exact-error-feedback small validation',date:'2026-10-30',formal:false,formalTest:false,
 protocol:'unified-small-discovery24x1-confirm12x2-answer-v3-multiworker',explorationPolicy:MULTI_WORKER_POLICY,evidencePresentation:EVIDENCE_PRESENTATION_VERSION,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
 sourceWorkingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim(),runtimeIdentity,environment,data:full.identity,
 driverHash:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),seed:20261029,
 discoveryIds:discovery.map(t=>t.id),confirmationIds:confirmation.map(t=>t.id),searchRepeats:1,confirmationRepeats:2,maxValidEvaluations:5,maxDesignRounds:4,maxProposalAttempts:3,
 limits,timeBudget,model:settings.model,endpoint:settings.baseUrl,systemPromptSha256:UNIFIED_SYSTEM_PROMPT_SHA256,nodeSystemSha256:NODE_SYSTEM_PROMPT_SHA256,
 publicAnswerContract:publicAnswerContract('drop'),scorer:'unchanged main drop-token-f1-max-alternatives',
 note:'Known diagnostic panel reused for paired comparison, not a new blind holdout. Confirmation and targeted regressions never enter optimizer feedback. Same source dataset and split as prior run.',status:'preparing'};
if(continuing){await store.write('manifest-before-confirmation-continuation.json',priorManifest);const initialAudit=await store.optional('AUDIT.json');if(initialAudit)await store.write('AUDIT-before-index-correction.json',initialAudit);}
await store.write('manifest.json',manifest);if(!continuing){await store.snapshot(project);await cp(resolve(project,'dist'),store.path('code-snapshot/dist'),{recursive:true});}
let phase='toolRepair';
const budgets=Object.fromEntries(Object.entries(limits).map(([name,limit])=>[name,createProviderBudget({...limit,...(continuing?{restored:priorManifest.usage[name]}:{}),onEvent:e=>store.append('usage.jsonl',{phase:name,...e})})]));
let activeDirection='baseline';
const directionBudget=createDirectionBudget({...limits.search,...(continuing?{restored:await store.optional('provider-direction-budgets.json')}:{}),onChange:value=>store.write('provider-direction-budgets.json',value)});
const ids=new WeakMap();
const experiment=createExperimentRuntime(settings,{timeBudget,connectTimeoutMs:5000,
 beforeProviderCall:async input=>{if(phase==='search')await directionBudget.beforeProviderCall(input,activeDirection);await budgets[phase].beforeProviderCall(input);const id=randomUUID();ids.set(input,{id,phase,direction:phase==='search'?activeDirection:undefined});await store.append('provider-requests.jsonl',{id,phase,direction:phase==='search'?activeDirection:undefined,at:new Date().toISOString(),input});},
 afterProviderCall:async e=>{const request=ids.get(e.input);await budgets[request?.phase??phase].afterProviderCall(e);if(request?.phase==='search')await directionBudget.afterProviderCall(e);await store.append('provider-responses.jsonl',{...request,at:new Date().toISOString(),metadata:e.input.metadata,output:e.output,diagnostics:e.diagnostics,error:e.error instanceof Error?{name:e.error.name,message:e.error.message}:e.error});}});
const emit=async e=>{if(e.type==='unified-parent-selected')activeDirection=e.explorationDirection??'baseline';await store.append('events.jsonl',{phase,at:new Date().toISOString(),...e});if(['stage-completed','unified-proposal-rejected','unified-evaluation-completed','unified-quality-pruned','unified-design-skipped','unified-direction-budget-stopped'].includes(e.type))console.log(JSON.stringify({phase,type:e.type,id:e.id??e.attempt?.id,direction:e.attempt?.explorationDirection,score:e.attempt?.evaluation?.score??e.score,stage:e.stage,errors:e.attempt?.publicErrors}));};
async function evaluate(definition,id,tasks,repeats,reference,prune=false){return evaluateUnifiedCandidate({benchmark:subset(tasks),definition,id,store:new UnifiedRunStore(join(root,phase)),executionIdentity:{runtimeIdentity,phase,driverHash:manifest.driverHash},repeats,concurrency:3,retryAttempts:2,timeBudget,prune,...(reference?{reference}:{}),runTask:(d,t)=>runGraphAgent(d,t,experiment,settings),onEvent:emit});}

async function checkToolRepair(){
 const broken=structuredClone(BASELINE_DEFINITION);
 broken.graphs[0].nodes.splice(1,0,{id:'text-helper',type:'INTERACTION.ACT.TOOL',dependencies:[],config:{tool:'normalize_text',arguments:{raw:{ref:['task','prompt']}}}});
 const solve=broken.graphs[0].nodes.at(-1);solve.dependencies=['context','text-helper'];solve.config.evidence=[{ref:['nodes','text-helper','structuredContent']}];solve.config.instruction='Answer the original question. The tool only normalizes whitespace in the public passage; it does not compute an answer.';
 broken.tools=[{name:'normalize_text',description:'Normalize whitespace in supplied public text.',executeSource:'function(args){return {text:args.raw.replace(/\\s+/g," ").trim()};}'}];
 let issue;try{validateDefinition(broken);}catch(e){if(!(e instanceof DefinitionError))throw e;issue=e.issue;}
 if(issue?.path!=='tools[0].inputSchema')throw Error('Fault injection did not produce the intended exact schema diagnostic');
 const fixedIdentity=d=>{const x=structuredClone(d);delete x.tools[0].inputSchema;return artifactHash(x);};
 const proposalGraph=graph('tool-contract-repair-check').node('proposal','INFER.REASONING.SAMPLE',[],input=>({model:input.model,generation:GENERATION,
  messages:[{role:'system',content:UNIFIED_SYSTEM_PROMPT},{role:'user',content:input.request}],metadata:{role:'tool-contract-repair-check',nodeId:'proposal'}}));
 const errors=[];let definition;
 for(let attempt=1;attempt<=2;attempt++){
  const request={mode:'ENGINEERING REPAIR',dataset:'drop',interfaceGuide:UNIFIED_DEFINITION_GUIDE,immutableProtocol:{publicAnswerContract:publicAnswerContract('drop')},
   contractRepair:{rejectedAttemptId:'injected-missing-tool-schema',definition:broken,errors:[issue.message,...errors],issues:[issue]},
   instruction:'Repair only tools[0].inputSchema with the actual raw string argument schema. Return exactly rationale and the complete version:2 definition. Preserve all other fields, node instructions and tool code. This is a separate engineering contract check, not a quality search result.'};
  await store.write(`tool-repair/request-${attempt}.json`,request);
  const out=await experiment.runtime.run(proposalGraph,{model:{provider:experiment.providerName,model:experiment.model},request:JSON.stringify(request)});
  const raw=out.proposal.output.message.content;await store.write(`tool-repair/response-${attempt}.json`,{raw});
  try{definition=parseUnifiedProposal(raw).definition;if(fixedIdentity(definition)!==fixedIdentity(broken))throw Error('Repair changed fields other than tools[0].inputSchema');break;}
  catch(e){definition=undefined;errors.push(e.message);if(e instanceof DefinitionError)issue=e.issue;}
 }
 if(!definition){await store.write('tool-repair/result.json',{passed:false,errors});return;}
 const result=await withWorkflowTimeBudget(timeBudget,()=>runGraphAgent(definition,discovery[0],experiment,settings));
 const passed=result.executedNodeIds.includes('text-helper')&&!result.modelFailure;
 await store.write('tool-repair/definition.json',definition);await store.write('tool-repair/execution.json',result);await store.write('tool-repair/result.json',{passed,initialIssue:issue,repairedInputSchema:definition.tools[0].inputSchema,modelFailure:result.modelFailure??null});
 console.log(JSON.stringify({phase:'toolRepair',passed,schema:definition.tools[0].inputSchema}));
}

try{
 let result,state;
 if(continuing){state=await store.read('search-state.json');result={state,best:bestUnifiedCandidate(state.history)};if(!result.best)throw Error('No complete candidate to confirm');manifest.searchStopReason='SEARCH_BUDGET_EXHAUSTED; pending/partial candidate excluded';}
 else{
  await checkToolRepair();
  phase='search';manifest.status='searching';await store.write('manifest.json',manifest);
  try{result=await searchUnifiedWorkflows({runtime:experiment.runtime,model:{provider:experiment.providerName,model:experiment.model},dataset:'drop',publicTasks:discovery,expectedRepeats:1,
   maxValidEvaluations:5,maxDesignRounds:4,maxProposalAttempts:3,seed:20261029,identity:artifactHash(manifest),
   evaluate:(d,id,ref,context)=>{activeDirection=context?.direction??'baseline';return evaluate(d,id,discovery,1,ref,true);},save:async s=>{state=s;await store.write('search-state.json',s);},event:emit});}
  catch(e){if(e.code!=='SEARCH_BUDGET_EXHAUSTED'||!state||!bestUnifiedCandidate(state.history))throw e;result={state,best:bestUnifiedCandidate(state.history)};manifest.searchStopReason='SEARCH_BUDGET_EXHAUSTED; pending/partial candidate excluded';}
 }
 await store.write('frozen-selection.json',{selectedBeforeConfirmation:true,id:result.best.id,definition:result.best.definition,artifactHash:result.best.artifactHash,discoveryF1:result.best.evaluation.score});
 phase='confirmation';manifest.status='confirming';await store.write('manifest.json',manifest);
 const baseline=await evaluate(BASELINE_DEFINITION,'baseline',confirmation,2),selected=await evaluate(result.best.definition,'selected',confirmation,2);
 await store.write('comparison.json',{valid:baseline.valid&&selected.valid,selectedId:result.best.id,baselineF1:baseline.score,selectedF1:selected.score,delta:selected.score-baseline.score,
  baselineFullCredit:baseline.results.filter(r=>r.score===1).length/baseline.results.length,selectedFullCredit:selected.results.filter(r=>r.score===1).length/selected.results.length,
  baselineTokens:baseline.totalTokens,selectedTokens:selected.totalTokens});
 if(previous){
  phase='regression';manifest.status='regression';await store.write('manifest.json',manifest);
  const frozen=JSON.parse(await readFile(join(previous,'frozen-selection.json'),'utf8'));
  const regressionIds=['drop:8499','drop:1142','drop:0','drop:543','drop:1432','drop:131','drop:5333'];
  const panel=regressionIds.map(id=>full.tasks.find(t=>t.id===id));if(panel.some(t=>!t))throw Error('Missing targeted regression task');
  await evaluate(frozen.definition,'previous-winner-new-contract',panel,1);
  await store.write('regression/protocol.json',{definitionFrozenFrom:previous,ids:regressionIds,repeats:1,notUsedForSelection:true});
 }
 manifest.status='completed';
}catch(e){manifest.status='interrupted';manifest.error={message:e.message,code:e.code};await store.write('interruption.json',{message:e.message,code:e.code,stack:e.stack});process.exitCode=1;console.log(JSON.stringify({phase,error:e.message,code:e.code}));}
finally{await experiment.close();manifest.usage=Object.fromEntries(Object.entries(budgets).map(([name,b])=>[name,b.snapshot()]));await store.write('manifest.json',manifest);await store.flush();console.log(JSON.stringify({status:manifest.status,usage:manifest.usage}));}

// Offline score and exact-response replay audit: no provider/network calls.
await auditDropAnswerRun(root,dataDir);
