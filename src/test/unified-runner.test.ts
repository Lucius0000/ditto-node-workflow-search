import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AgentRunResult,BenchmarkTask,EvaluationSummary} from '../domain.js';
import type {LoadedBenchmark,PrivateScorer} from '../benchmark/types.js';
import {evaluateTasks} from '../benchmark/evaluator.js';
import {searchSubset} from '../benchmark/search-subset.js';
import {BASELINE_DEFINITION} from '../graph-agent/schema.js';
import {parseUnifiedArguments} from '../unified/cli.js';
import {evaluateUnifiedCandidate,UnifiedEvaluationError} from '../unified/evaluation.js';
import {UnifiedRunStore,artifactHash} from '../unified/store.js';
import type {UnifiedCandidate} from '../unified/search.js';
import {loadBenchmark} from '../benchmark/registry.js';
import {writeFile} from 'node:fs/promises';

const result=(answer='ok'):AgentRunResult=>({answer,executedNodeIds:['context','solve'],executedGraphIds:['agent'],inputTokens:2,outputTokens:1,totalTokens:3,usageKnown:true,providerAttempts:1});
function benchmark(count=33,split:'validate'|'test'='validate'):LoadedBenchmark{
 const tasks:BenchmarkTask[]=Array.from({length:count},(_,index)=>({id:'fixture:'+index,dataset:'drop',prompt:'Public question '+index,outputInstruction:'Return ok.',metadata:{split}}));
 const scorer:PrivateScorer={expectedLabel:()=> 'PRIVATE_EXPECTED_SENTINEL',async score(_id,prediction){return {score:prediction==='ok'?1:0,expected:'PRIVATE_EXPECTED_SENTINEL',prediction,normalizedExpected:'private',normalizedPrediction:prediction,method:'fixture'};}};
 return {dataset:'drop',split,tasks,evaluate:(runner,options)=>evaluateTasks(tasks,scorer,runner,options),evaluateSearchSubset:(ids,runner,options)=>evaluateTasks(searchSubset(split,tasks,ids),scorer,runner,options)};
}
function parent(summary:EvaluationSummary):UnifiedCandidate{return {id:'parent',designRound:0,proposalAttempt:0,parentId:null,status:'valid',definition:BASELINE_DEFINITION,rationale:'fixture',artifactHash:artifactHash(BASELINE_DEFINITION),evaluation:summary};}
async function workspace(run:(store:UnifiedRunStore)=>Promise<void>){const path=await mkdtemp(join(tmpdir(),'unified-runner-'));try{await run(new UnifiedRunStore(path));}finally{await rm(path,{recursive:true,force:true});}}

test('formal CLI fixes Search/Test repetitions and rejects prompt override during Test',()=>{
 const search=parseUnifiedArguments(['search','--dataset','drop'],'/workspace');
 assert.equal(search.maxValidEvaluations,20);assert.equal(search.maxProposalAttempts,3);assert.equal(search.requestMs,600000);assert.equal(search.workflowMs,null);assert.equal(search.concurrency,3);
 const frozen=parseUnifiedArguments(['test','--dataset','drop','--run-dir','runs/frozen'],'/workspace');assert.equal(frozen.concurrency,200);
 assert.throws(()=>parseUnifiedArguments(['search','--repeats','1']),/Invalid/);
 assert.throws(()=>parseUnifiedArguments(['test','--run-dir','runs/frozen','--user-prompt-file','prompt.md']),/cannot replace/);
 assert.throws(()=>parseUnifiedArguments(['search','--rounds','2','--max-valid-evaluations','2']),/not both/);
 assert.throws(()=>parseUnifiedArguments(['search','--system-prompt-file','evil.md']),/Invalid/);
});

test('validation subset closure rejects Test, duplicate IDs and unknown IDs',()=>{
 const loaded=benchmark();assert.equal(searchSubset('validate',loaded.tasks,['fixture:2'])[0]?.id,'fixture:2');
 assert.throws(()=>searchSubset('test',loaded.tasks,['fixture:0']),/validation split/);
 assert.throws(()=>searchSubset('validate',loaded.tasks,['fixture:0','fixture:0']),/distinct/);
 assert.throws(()=>searchSubset('validate',loaded.tasks,['missing']),/Unknown/);
});

test('all five real adapters expose only validation subset scoring while keeping private references closed',async()=>workspace(async store=>{
 const rows={drop:{id:1,context:'Public question',ref_text:'ok'},gsm8k:{id:1,question:'Public question',answer:'42'},math:{problem:'Public question',solution:'42'},
  humaneval:{task_id:'fixture',prompt:'def example():\n',entry_point:'example',canonical_solution:'    return 42',test:'assert True'},
  mbpp:{task_id:1,prompt:'Write example',entry_point:'example',code:'def example(): return 42',test:'assert True'}};
 for(const [name,row]of Object.entries(rows)){
  for(const split of ['validate','test']as const)await writeFile(store.path(name+'_'+split+'.jsonl'),JSON.stringify(row)+'\n');
  const loaded=await loadBenchmark(name as 'drop'|'gsm8k'|'math'|'humaneval'|'mbpp',{dataDir:store.directory,split:'validate',dataMode:'fixture'});
  assert.equal(typeof loaded.evaluateSearchSubset,'function');assert.equal('scorer' in loaded,false);assert.equal('references' in loaded,false);
  const frozen=await loadBenchmark(name as 'drop'|'gsm8k'|'math'|'humaneval'|'mbpp',{dataDir:store.directory,split:'test',dataMode:'fixture'});
  await assert.rejects(async()=>frozen.evaluateSearchSubset!([frozen.tasks[0]!.id],async()=>result()),/validation split/);
 }
}));

test('first case is reused exactly once; advancing 16/32/33 stages still executes 33 times five calls',async()=>workspace(async store=>{
 const loaded=benchmark();const reference=parent(await loaded.evaluate(async()=>result(),{repeats:5}));const calls=new Map<string,number>();
 const summary=await evaluateUnifiedCandidate({benchmark:loaded,definition:BASELINE_DEFINITION,id:'candidate',reference,store,executionIdentity:'runtime-1',repeats:5,concurrency:3,prune:true,
  runTask:async(_definition,task)=>{calls.set(task.id,(calls.get(task.id)??0)+1);return result();}});
 assert.equal(summary.examples,33);assert.equal(summary.results.length,165);assert.equal(summary.score,1);assert.equal(summary.qualityPruned,undefined);
 assert.equal([...calls.values()].reduce((a,b)=>a+b,0),165);assert([...calls.values()].every(n=>n===5));
 const stage=await store.read<{overlap:number,repeats:number}>('evaluations/candidate/stage-16.json');assert.equal(stage.overlap,80);assert.equal(stage.repeats,5);
}));

test('quality prune retains 16x5 real observations and never invents a full evaluation',async()=>workspace(async store=>{
 const loaded=benchmark();const reference=parent(await loaded.evaluate(async()=>result(),{repeats:5}));let calls=0;
 const summary=await evaluateUnifiedCandidate({benchmark:loaded,definition:BASELINE_DEFINITION,id:'pruned',reference,store,executionIdentity:'runtime',repeats:5,concurrency:3,prune:true,
  runTask:async()=>{calls++;return result('wrong');}});
 assert.equal(calls,80);assert.equal(summary.valid,true);assert.equal(summary.qualityPruned,true);assert.equal(summary.stage,16);assert.equal(summary.examples,16);assert.equal(summary.results.length,80);
}));

test('baseline cannot be quality-pruned; model answer-format loss remains a valid zero',async()=>workspace(async store=>{
 const loaded=benchmark(3);const summary=await evaluateUnifiedCandidate({benchmark:loaded,definition:BASELINE_DEFINITION,id:'baseline',store,executionIdentity:'runtime',repeats:5,concurrency:1,prune:true,
  runTask:async()=>({...result(''),modelFailure:{code:'MODEL_OUTPUT_FORMAT',message:'Model did not return the declared answer format'}})});
 assert.equal(summary.valid,true);assert.equal(summary.score,0);assert.equal(summary.examples,3);assert.equal(summary.results.length,15);assert.equal(summary.qualityPruned,undefined);
}));

test('adapter failure is engineering invalid, recorded with raw partial execution and excluded from quality',async()=>workspace(async store=>{
 const loaded=benchmark(3);
 await assert.rejects(()=>evaluateUnifiedCandidate({benchmark:loaded,definition:BASELINE_DEFINITION,id:'broken',store,executionIdentity:'runtime',repeats:5,concurrency:1,prune:true,
  runTask:async()=>{throw Object.assign(new Error('Executor read the wrong field'),{publicMessage:'Missing declared node field',partialRun:{rawOutput:{message:{content:'ok'}}}});}}),error=>error instanceof UnifiedEvaluationError&&!error.infrastructureFailure&&error.publicMessage==='Missing declared node field');
 const saved=await store.read<{cases:readonly {valid:boolean}[]}>('evaluations/broken/checkpoint.json');assert.equal(saved.cases.length,1);assert.equal(saved.cases[0]?.valid,false);
 const errors=await store.lines<{partialRun:unknown}>('evaluations/broken/execution-errors.jsonl');assert(errors[0]?.partialRun);
 assert.equal(await store.optional('evaluations/broken/summary.json'),undefined);
}));

test('cached full cases are reused only for identical artifact/runtime and Test cannot enable pruning',async()=>workspace(async store=>{
 const loaded=benchmark(2);let calls=0;const options={benchmark:loaded,definition:BASELINE_DEFINITION,id:'same',store,executionIdentity:'runtime',repeats:5,concurrency:1,runTask:async()=>{calls++;return result();}};
 await evaluateUnifiedCandidate(options);assert.equal(calls,10);await evaluateUnifiedCandidate({...options,resume:true});assert.equal(calls,10);
 const changed=structuredClone(BASELINE_DEFINITION);changed.graphs[0]!.nodes.at(-1)!.config.instruction='A different public instruction';
 await assert.rejects(()=>evaluateUnifiedCandidate({...options,definition:changed,resume:true}),/identity differs/);
 await assert.rejects(()=>evaluateUnifiedCandidate({...options,executionIdentity:'changed-runtime',resume:true}),/identity differs/);
 await assert.rejects(()=>evaluateUnifiedCandidate({...options,benchmark:benchmark(2,'test'),id:'test',prune:true}),/forbidden on Test/);
 assert.equal(calls,10);
}));

test('frozen Test uses exactly three executions per task without a Search interface probe',async()=>workspace(async store=>{
 let calls=0;const summary=await evaluateUnifiedCandidate({benchmark:benchmark(2,'test'),definition:BASELINE_DEFINITION,id:'frozen',store,executionIdentity:'runtime-test',repeats:3,concurrency:2,
  runTask:async()=>{calls++;return result();}});
 assert.equal(calls,6);assert.equal(summary.results.length,6);assert.equal(summary.repeats,3);assert.equal(summary.qualityPruned,undefined);
}));

test('artifact paths cannot escape the run directory',async()=>workspace(async store=>{
 assert.throws(()=>store.path('../outside'),/escapes/);
 await store.write('safe/value.json',{ok:true});assert.equal(JSON.parse(await readFile(store.path('safe/value.json'),'utf8')).ok,true);
}));
