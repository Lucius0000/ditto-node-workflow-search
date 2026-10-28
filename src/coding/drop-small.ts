import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadProviderSettings } from '../config.js';
import { createExperimentRuntime } from '../ditto/runtime.js';
import { dropAdapter } from '../benchmark/drop.js';
import { stratifiedSample, lengthBucket } from '../benchmark/sampling.js';
import { scoreDropAnswer } from '../benchmark/text-scores.js';
import { evaluateTasks } from '../benchmark/evaluator.js';
import { evaluationRuntimeIdentity, assertEvaluationRuntimeIdentity } from '../run/case-recovery.js';
import { GENERATION, PROTOCOL } from '../protocol.js';
import type { BenchmarkTask, EvaluationSummary } from '../domain.js';
import { searchCodingWorkflows, type CodingSearchState, type CodingAttempt, type CodingEvaluationSummary } from './search.js';
import { BASELINE_MODULE, runExecutableModule, inspectModule, type ModuleShape } from './module.js';
import { CODING_EXECUTION_POLICY, CODING_MUTATION_POLICY } from './policy.js';
import {GRAPH_ARTIFACT_ADAPTER} from '../graph-agent/search.js';
import {GRAPH_AGENT_POLICY,parseDefinition,DefinitionError} from '../graph-agent/schema.js';
import {runGraphAgent} from '../graph-agent/executor.js';
import {withWorkflowTimeBudget} from '../execution/time-budget.js';
import {AGENT_REFLECTION_CONTRACT} from '../graph-agent/reflect-contract.js';

const values = new Map<string,string>();
for (let index=2;index<process.argv.length;index+=2) {
  const key=process.argv[index],value=process.argv[index+1];
  if(!key?.startsWith('--')||value===undefined)throw Error('Use --name value arguments');
  if(values.has(key))throw Error(`Duplicate ${key}`);values.set(key,value);
}
const supported = new Set(['--method','--experiment-version','--data-dir','--output-root','--rounds','--search-size','--confirm-size','--repeats','--seed','--request-timeout-ms','--workflow-timeout-ms','--resume']);
for(const key of values.keys())if(!supported.has(key))throw Error(`Unknown option ${key}`);
const integer=(key:string,fallback:number,min=1,max=1000)=>{const value=Number(values.get(key)??fallback);if(!Number.isSafeInteger(value)||value<min||value>max)throw Error(`Invalid ${key}`);return value;};
const project=process.cwd();
const method=values.get('--method')??'b';if(!['a','b'].includes(method))throw Error('--method must be a or b');
const experimentVersion=values.get('--experiment-version')??(method==='b'?'scheme-b-v1':'coding-a-v10');
if(!/^[a-zA-Z0-9._-]{1,32}$/.test(experimentVersion))throw Error('Invalid experiment version label');
const rounds=integer('--rounds',6,0,20),repeats=integer('--repeats',2,1,5),seed=integer('--seed',20261027,0,0x7fffffff);
const searchSize=integer('--search-size',12,2,100),confirmSize=integer('--confirm-size',12,2,100);
if(searchSize+confirmSize>200)throw Error('Disjoint subsets must fit the pinned 200-question Search set');
const timeBudget={requestMs:integer('--request-timeout-ms',120000,1000,1800000),workflowMs:integer('--workflow-timeout-ms',240000,1000,1800000)};
const output=resolve(values.get('--output-root')??`runs/ditto-drop-${method==='b'?'graph-agent-b-v1':'coding-a-v10'}-${seed}`);
const resume=values.get('--resume')==='true';
await mkdir(output,{recursive:true});
const write=async(name:string,data:unknown)=>{const path=join(output,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(data,null,2)+'\n');};
const event=async(data:Record<string,unknown>)=>{
  await appendFile(join(output,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...data})+'\n');
  if(!['coding-proposal-request','coding-candidate-proposed','coding-proposal-rejected','coding-evaluation-completed','coding-evaluation-invalid'].includes(String(data.type)))console.log(JSON.stringify(data));
  else if(data.type==='coding-proposal-rejected')console.log(JSON.stringify({type:data.type,id:(data.attempt as CodingAttempt).id,error:(data.attempt as CodingAttempt).error}));
};

const python=process.env.DITTO_PROVIDER_PYTHON??resolve('.provider-venv/Scripts/python.exe');
const environment=JSON.parse(execFileSync(python,['-c','import sys,openai,httpx,json;print(json.dumps({"pythonExecutable":sys.executable,"pythonVersion":sys.version.split()[0],"openaiVersion":openai.__version__,"httpxVersion":httpx.__version__}))'],{encoding:'utf8',windowsHide:true}));
if(environment.openaiVersion!=='2.14.0'||environment.httpxVersion!=='0.28.1')throw Error('Install the exact requirements-provider.txt environment before evaluating');
process.env.DITTO_PROVIDER_PYTHON=python;
const identity=await evaluationRuntimeIdentity(project,{...environment,dittoVersion:'0.1.1'});
const full=await dropAdapter.load({dataDir:resolve(values.get('--data-dir')??'../data/datasets'),split:'validate',dataMode:'formal'});
if(full.identity?.verified!==true)throw Error('Diagnostic subsets require a verified complete MFlow Search file first');
const subset=stratifiedSample(full.tasks,searchSize+confirmSize,seed,task=>lengthBucket(task.prompt.length));
const discovery=subset.slice(0,searchSize),confirmation=subset.slice(searchSize);
const bytes=await readFile(join(resolve(values.get('--data-dir')??'../data/datasets'),'drop_validate.jsonl'));
const references=new Map<string,string>(bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line=>{const row=JSON.parse(line);return [`drop:${row.id}`,row.ref_text];}));
const scorer={expectedLabel:(id:string)=>references.get(id)!,async score(id:string,answer:string){return scoreDropAnswer(references.get(id)!,answer);}};
const settings={...loadProviderSettings(),concurrency:3};
const manifest={schemaVersion:1,experiment:'Ditto single-agent workflow search',experimentVersion,method:method==='b'?'B: declarative Graph/Loop plus typed execution Agent':'A: executable workflow module',kind:'exploratory-disjoint-Search-subsets',formalTest:false,sourcePR:6,
  protocol:{...PROTOCOL,id:method==='b'?GRAPH_AGENT_POLICY:'coding-node-v10-diagnostic',searchPolicy:method==='b'?GRAPH_AGENT_POLICY:'topk-program-search-single-node-v10',reflectionAdapter:'reflect-format-v3',
    budgetUnit:'new-design-round-after-baseline; invalid measurements occupy a round; bounded proposal retries',
    searchRounds:rounds,validationRepeats:repeats,testRepeats:null,workflowAttempts:3,proposalAttempts:3,splitProtocol:'exploratory-disjoint-Search-subsets',
    convergenceTopK:null,convergenceZ:null,convergenceConsecutiveRounds:null,execution:CODING_EXECUTION_POLICY},
  benchmarkAlignment:{repository:'https://github.com/erwinmsmith/MFlow',commit:PROTOCOL.baselineCommit,
    rawFileProtocol:full.identity.protocol,metric:'aflow-drop-token-f1-v2',formalRun:false,
    deviations:['sampled Search subsets','two-stage diagnostic selection/confirmation','diagnostic repeat and round budgets','bounded module execution','custom single-node mutation policy']},
  mutationPolicy:CODING_MUTATION_POLICY,
  agentReflectionContract:method==='b'?AGENT_REFLECTION_CONTRACT:null,
  preflight:{enabled:method==='b',publicTaskCount:method==='b'?2:0,usesScorer:false,reusesValidationResults:false,costRecordedSeparately:true},
  executionIdentity:identity,model:settings.model,endpoint:settings.baseUrl,generation:GENERATION,timeBudget,
  seed,rounds,repeats,topK:4,concurrency:3,data:full.identity,
  discoveryIds:discovery.map(task=>task.id),confirmationIds:confirmation.map(task=>task.id),
  selectionUsesConfirmation:false,toolPolicy:'bounded self-contained pure JavaScript; no host/network/files; one tool edit and at most one added Node per proposal'};
if(resume){
 const previous=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));assertEvaluationRuntimeIdentity(previous.executionIdentity,identity);
 if(JSON.stringify(previous)!==JSON.stringify(manifest))throw Error('Resume configuration or selected questions changed');
}else{
 try{await readFile(join(output,'manifest.json'));throw Error('Output already exists; explicit --resume true is required');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 await write('manifest.json',manifest);
}
const scope=new AsyncLocalStorage<{phase:string;candidateId:string;taskId?:string}>();
const experiment=createExperimentRuntime(settings,{timeBudget,reflectionEvent:async data=>{await appendFile(join(output,'reflection-events.jsonl'),JSON.stringify({...scope.getStore(),...data})+'\n');}});
const planDescription=(shape:ModuleShape)=>shape.nodes.map(node=>`${node.id}:${node.type}[${node.dependencies.join(',')}]`).join(' → ');

async function measure(source:string,shape:ModuleShape,id:string,tasks:readonly BenchmarkTask[],phase:string):Promise<CodingEvaluationSummary>{
 const directory=join(phase,id);await write(`${directory}/shape.json`,shape);await writeFile(join(output,directory,method==='b'?'definition.json':'workflow.mjs'),source);
 const failures=new Map<string,number>();
 const results=await evaluateTasks(tasks,scorer,task=>scope.run({phase,candidateId:id,taskId:task.id},async()=>{
   const result=method==='b'?await runGraphAgent(parseDefinition(source),task,experiment,settings):await runExecutableModule(source,task,experiment,settings);
   const message=(result.candidateFailure as {message?:string}|undefined)?.message;
   if(message)failures.set(message,(failures.get(message)??0)+1);
   await write(`${directory}/executions/${task.id.replace(/[^a-zA-Z0-9_-]/g,'_')}-${Date.now()}.json`,result);return result;
 }),{repeats,concurrency:3,retryAttempts:3,timeBudget,onCase:async({completed,total,result})=>{
    await appendFile(join(output,directory,'cases.jsonl'),JSON.stringify(result)+'\n');
    if(completed%6===0||completed===total)console.log(JSON.stringify({type:'case-progress',phase,id,completed,total,score:result.score,valid:result.valid}));
 }});
 const summary={...results,publicExecutionFeedback:[...failures].map(([message,count])=>({message,count}))};
 await write(`${directory}/summary.json`,summary);
 console.log(JSON.stringify({type:'workflow-result',phase,id,valid:results.valid,f1:results.valid?results.score:null,nodeCount:shape.nodes.length,workflow:planDescription(shape),tokens:results.totalTokens}));
 return summary;
}

try{
 let state:CodingSearchState|undefined;
 if(resume)try{state=JSON.parse(await readFile(join(output,'search-state.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const result=await searchCodingWorkflows({runtime:experiment.runtime,model:{provider:experiment.providerName,model:experiment.model},rounds,topK:4,seed,maxProposalAttempts:3,
   ...(method==='b'?{artifactAdapter:GRAPH_ARTIFACT_ADAPTER,preflight:async(source:string,_shape:ModuleShape,id:string)=>{
    // No scorer or reference answers are used here. These are additional, charged interface probes.
    for(const task of discovery.slice(0,2)){
     let run;
     try{run=await withWorkflowTimeBudget(timeBudget,()=>scope.run({phase:'preflight',candidateId:id,taskId:task.id},()=>runGraphAgent(parseDefinition(source),task,experiment,settings)));}
     catch(error){
      const failure=error as Error&{partialRun?:unknown;totalTokens?:number;providerAttempts?:number};
      await write(`preflight/${id}/${task.id.replace(/[^a-zA-Z0-9_-]/g,'_')}-failed.json`,{error:failure.message,partialRun:failure.partialRun,totalTokens:failure.totalTokens,providerAttempts:failure.providerAttempts});
      if(/REFLECT_FORMAT_ERROR|INVALID_MODEL_OUTPUT/.test(failure.message))throw new DefinitionError(`Execution protocol preflight: ${failure.message}`);
      throw Object.assign(failure,{infrastructureFailure:true});
     }
     await write(`preflight/${id}/${task.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`,run);
     if(run.candidateFailure)throw new DefinitionError(`Execution Agent preflight: ${run.candidateFailure.nodeId??'binding'}: ${run.candidateFailure.message}`);
    }
   }}:{}),
   taskGoal:'Improve DROP passage-grounded reading, arithmetic and multi-span answers. Return only concise final answers, separated by | when needed. All code and tool logic must generalize across public task inputs.',
   ...(state?{resume:state}:{}),evaluate:(source,shape,id)=>measure(source,shape,id,discovery,'discovery'),
   save:current=>write('search-state.json',current),event:async data=>{
     await event({...data});
     const attempt=(data.attempt??data.pending) as CodingAttempt|undefined;
     if(attempt?.source)await writeFile(join(output,`${method==='b'?'definition':'attempt'}-${attempt.id}.${method==='b'?'json':'mjs'}`),attempt.source);
     if(attempt)await write(`attempt-${attempt.id}.json`,attempt);
   }});
 await write('frozen-selection.json',{selectedBeforeConfirmation:true,id:result.best.id,sourceHash:result.best.shape.sourceHash,discoveryScore:result.best.evaluation.score});
 const baseline=result.state.history.find(attempt=>attempt.parentId===null&&attempt.status==='valid')!;
 const selected=[];
 for(const [name,candidate]of [['baseline',baseline],['selected',result.best]] as const){
   let summary:EvaluationSummary;
   const path=join(output,'confirmation',name,'summary.json');
   try{summary=JSON.parse(await readFile(path,'utf8'));if(!resume)throw Error('Unexpected existing confirmation');}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;summary=await measure(candidate.source!,candidate.shape!,name,confirmation,'confirmation');}
   selected.push({name,summary});
 }
 const baselineConfirmation=selected[0]!.summary,chosenConfirmation=selected[1]!.summary;
 const comparison={valid:baselineConfirmation.valid&&chosenConfirmation.valid,
   baselineF1:baselineConfirmation.valid?baselineConfirmation.score:null,selectedF1:chosenConfirmation.valid?chosenConfirmation.score:null,
   delta:baselineConfirmation.valid&&chosenConfirmation.valid?chosenConfirmation.score-baselineConfirmation.score:null,
   baselineTokens:baselineConfirmation.totalTokens,selectedTokens:chosenConfirmation.totalTokens,
   baselineExactMatchRate:baselineConfirmation.results.filter(row=>row.score===1).length/baselineConfirmation.results.length,
   selectedExactMatchRate:chosenConfirmation.results.filter(row=>row.score===1).length/chosenConfirmation.results.length,
   rows:chosenConfirmation.results.map(row=>{const before=baselineConfirmation.results.find(value=>value.caseId===row.caseId)!;return {caseId:row.caseId,baseline:before.score,selected:row.score,delta:row.score-before.score,baselinePrediction:before.prediction,selectedPrediction:row.prediction};})};
 await write('confirmation-comparison.json',comparison);
 const attempts=result.state.history.map(attempt=>({round:attempt.round,id:attempt.id,parentId:attempt.parentId,status:attempt.status,rationale:attempt.rationale,
   f1:attempt.status==='valid'?attempt.evaluation!.score:null,error:attempt.error,workflow:attempt.shape?planDescription(attempt.shape):'Not executed',tools:attempt.shape?.tools.map(tool=>tool.name)}));
 await write('rounds.json',attempts);
 const lines=['# Ditto DROP workflow small-batch verification',`Method: ${manifest.method}.`,'',`Protocol: ${manifest.protocol.id}; SDK ${environment.openaiVersion}; Search ${discovery.length} + confirmation ${confirmation.length}; repeats ${repeats}.`,'',
   '| Round | Attempt | Parent | Status | F1 | Actual declared workflow |','| --- | --- | --- | --- | ---: | --- |',
   ...attempts.map(attempt=>`| ${attempt.round} | ${attempt.id} | ${attempt.parentId??'-'} | ${attempt.status} | ${attempt.f1===null?'—':(attempt.f1*100).toFixed(2)+'%'} | ${attempt.workflow.replaceAll('|','/')} |`),'',
   `Frozen best: ${result.best.id}; discovery ${(result.best.evaluation.score*100).toFixed(2)}%.`,
   `Confirmation baseline: ${comparison.baselineF1===null?'invalid':(comparison.baselineF1*100).toFixed(2)+'%'}; selected: ${comparison.selectedF1===null?'invalid':(comparison.selectedF1*100).toFixed(2)+'%'}.`,
   'This is an exploratory small Search subset, not the official Test. All invalid attempts remain in the ledger; missing F1 is not replaced by zero.'];
 await writeFile(join(output,'REPORT.md'),lines.join('\n')+'\n');
 console.log(JSON.stringify({type:'complete',selected:result.best.id,comparison}));
}finally{await experiment.close();}
