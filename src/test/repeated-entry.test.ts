import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runCodeSearch,evaluationRepeats,assertEvaluationMembers,type CodeSearchOptions,type CodeSearchServices} from '../code-search.js';
import {parseArguments} from '../config.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {evaluateTasks} from '../benchmark/evaluator.js';
import {automationScope,type AutomationSession} from '../benchmark/automation.js';
import {CaseRecovery} from '../run/case-recovery.js';
import type {BenchmarkTask,EvaluationSummary} from '../domain.js';

const read=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
// The production entry persists every event. Do not send thousands of fixture
// progress messages through the test-runner IPC buffer as well.
const originalLog=console.log;
console.log=()=>{};
after(()=>{console.log=originalLog;});
const counts={humaneval:33,mbpp:86,automationbench:200};
function fixtures(dataset:CodeSearchOptions['dataset'],workflowAttempts=1){
  let calls=0,optimizers=0,worlds=0,failAt=0;
  const tasks:BenchmarkTask[]=Array.from({length:counts[dataset]},(_,i)=>({id:`${dataset}:${i}`,dataset,prompt:`Public task ${i}`,outputInstruction:'',metadata:{}}));
  const scope=():AutomationSession=>({tools:[{name:'base64_encode',inputSchema:{type:'object'}}],async call(){throw Error('No tools requested in this fixture');},record(){},assertHealthy(){}});
  const services:CodeSearchServices={
    codeHash:async()=> 'offline-code',environment:async()=>dataset==='automationbench'?{automation:{identity:'fixed-offline'}}:{imageId:'fixed-offline'},
    load:async()=>({dataset,split:'validate',tasks,async evaluate(runner,options){
      const selected=options?.engineeringTaskIds?.map(id=>tasks.find(t=>t.id===id)!)??tasks;
      return evaluateTasks(selected,{expectedLabel:()=> 'private',async score(_id,answer){return {score:answer==='pass'?1:0,expected:'private',prediction:answer,normalizedExpected:'private',normalizedPrediction:answer,method:'fixture'};}},async task=>{
        worlds++;if(failAt&&worlds===failAt)throw Error('Injected non-transient fixture interruption');
        return dataset==='automationbench'?automationScope.run(scope(),()=>runner(task)):runner(task);
      },{...options,retryAttempts:workflowAttempts});
    }}),
    runtime:(settings,options)=>createExperimentRuntime(settings,{...options,provider:{async invoke(input){
      if(input.metadata?.role==='optimizer'){
        optimizers++;const payload=JSON.parse(String(input.messages[1]!.content));const branch=payload.constructionBranches[0];
        const id=dataset==='automationbench'?'actor':'sample-1';const old=branch.nodes.find((n:any)=>n.id===id);
        return {message:{role:'assistant',content:JSON.stringify({baseBranchId:branch.id,anchorNodeId:id,operation:'replace',node:{...old,config:{...old.config,instruction:`Candidate ${optimizers}`}},submit:true})},finishReason:'stop'};
      }
      const index=calls++;return {message:{role:'assistant',content:Math.floor(index/tasks.length)%2===0?'pass':'fail'},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
    }}}),
  };
  return {services,tasks,calls:()=>calls,optimizers:()=>optimizers,worlds:()=>worlds,failOn:(n:number)=>{failAt=n;}};
}
async function withKeys(run:()=>Promise<void>){
  const saved={ark:process.env.ARK_PLAN_KEY_LIU,ds:process.env.DS_API_KEY,concurrency:process.env.CODE_SOUL_CONCURRENCY};
  process.env.ARK_PLAN_KEY_LIU='offline';process.env.DS_API_KEY='offline';process.env.CODE_SOUL_CONCURRENCY='1';
  try{await run();}finally{
    for(const [key,value] of [['ARK_PLAN_KEY_LIU',saved.ark],['DS_API_KEY',saved.ds],['CODE_SOUL_CONCURRENCY',saved.concurrency]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
}

test('all three search entries default to five, explicit one wins, and auxiliary evaluation stays one',()=>{
  for(const dataset of Object.keys(counts)){
    assert.equal(parseArguments(['search','--dataset',dataset]).repeats,5);
    assert.equal(parseArguments(['search','--dataset',dataset,'--repeats','1']).repeats,1);
    for(const value of ['0','-1','1.5','NaN'])assert.throws(()=>parseArguments(['search','--dataset',dataset,'--repeats',value]));
    assert.ok(parseArguments(['search','--dataset',dataset,'--resume-dir','saved']).resumeDir);
    for(const args of [['--seed','7'],['--patience','1'],['--resume-round','2'],['--test-repeats','1']])assert.throws(()=>parseArguments(['search','--dataset',dataset,...args]));
  }
  assert.equal(evaluationRepeats('search'),5);assert.equal(evaluationRepeats('smoke'),1);assert.equal(evaluationRepeats('official'),1);
  for(const mode of ['smoke','official'] as const)assert.throws(()=>evaluationRepeats(mode,5));
});

test('a private saved world recovers scoring without another actor or write',async()=>{
  const task:BenchmarkTask={id:'automationbench:fixture',dataset:'automationbench',prompt:'Public',outputInstruction:'',metadata:{}};
  let runnerCalls=0,scorerCalls=0;
  const saved={snapshot:{world:{private:'PRIVATE_WORLD'},contract:'private-contract'},trace:[],answer:'completed'};
  const scorer={expectedLabel:()=> 'private assertions',recoveryData:()=>saved,async score(_id:string,answer:string,prior?:any){
    scorerCalls++;if(scorerCalls===1)throw Error('scoring process unavailable');
    assert.deepEqual(prior.judgeRecovery,saved);return {score:1,expected:'private',prediction:answer,normalizedExpected:'private',normalizedPrediction:'1',method:'fixture'};
  }};
  const runner=async()=>{runnerCalls++;return {answer:'completed',executedNodeIds:['actor','act'],executedGraphIds:['tools'],inputTokens:2,outputTokens:3,totalTokens:5};};
  const first=await evaluateTasks([task],scorer,runner,{retryAttempts:1});assert.equal(first.valid,false);
  const second=await evaluateTasks([task],scorer,runner,{priorCases:first.results});
  assert.equal(runnerCalls,1);assert.equal(scorerCalls,2);assert.equal(second.valid,true);assert.equal(second.totalTokens,5);
});

test('completed cases survive a crash before the pending workflow ledger commit, without creating new repeats',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ditto-pending-commit-'));
  try{
    const task:BenchmarkTask={id:'humaneval:fixture',dataset:'humaneval',prompt:'Public',outputInstruction:'',metadata:{}};
    const identity={candidate:'search-001',repeats:5};let calls=0;
    const scorer={expectedLabel:()=> 'private',async score(_id:string,prediction:string){return {score:0,expected:'private',prediction,normalizedExpected:'private',normalizedPrediction:prediction,method:'fixture'};}};
    const runner=async()=>{calls++;return {answer:'normal zero',executedNodeIds:[],executedGraphIds:[],inputTokens:1,outputTokens:1,totalTokens:2};};
    const first=await CaseRecovery.open(root,identity,{},true);
    await evaluateTasks([task],scorer,runner,{repeats:5,onCase:async({result})=>first.record(result)});await first.finish(true);
    const pending=await CaseRecovery.open(root,identity,{},true);
    const summary=await evaluateTasks([task],scorer,runner,{repeats:5,priorCases:pending.priorCases});
    assert.equal(calls,5);assert.equal(summary.results.length,5);assert.equal(summary.score,0);await pending.finish(true);
    const legacy=await CaseRecovery.open(root,identity);assert.equal(legacy.priorCases.length,0,'other entry points retain independent-evaluation semantics');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('actual three-dataset entries execute N x 5 independently, freeze one candidate, then official full Search once',async()=>withKeys(async()=>{
  const root=await mkdtemp(join(tmpdir(),'ditto-repeated-entry-'));
  try{for(const dataset of Object.keys(counts) as CodeSearchOptions['dataset'][]){
    const f=fixtures(dataset);const directory=join(root,dataset,'search');
    const options:CodeSearchOptions={dataset,mode:'search',source:'ark-plan',directory,dataDir:'offline',dockerImage:'offline',newCandidates:1};
    await runCodeSearch(options,f.services);
    assert.equal(f.calls(),counts[dataset]*10);assert.equal(f.optimizers(),1);assert.equal(f.worlds(),counts[dataset]*10);
    const manifest=await read(join(directory,'manifest.json'));assert.equal(manifest.identity.protocol.validationRepeats,5);
    const summary:EvaluationSummary=await read(join(directory,'best','summary.json'));
    assertEvaluationMembers(summary,f.tasks.map(t=>t.id),5);
    assert.deepEqual(summary.repeatScores,[1,0,1,0,1]);assert.equal(summary.score,.6);assert.ok(Math.abs(summary.standardDeviation-Math.sqrt(.24))<1e-12);
    const state=await read(join(directory,'resume-state.json'));assert.equal(state.completedRounds,1);assert.equal(state.nodeConstruction.evaluations.length,2);
    const before=f.calls();await runCodeSearch(options,f.services);assert.equal(f.calls(),before);
    await assert.rejects(runCodeSearch({...options,repeats:1},f.services),/identity changed/);
    const official=join(root,dataset,'official');await runCodeSearch({...options,mode:'official',source:'official',directory:official,selectedRun:directory,repeats:1},f.services);
    assert.equal(f.calls(),before+counts[dataset]);assert.equal(f.optimizers(),1);
    const officialSummary=await read(join(official,'summary.json'));assert.equal(officialSummary.results.length,counts[dataset]);assert.equal(officialSummary.repeats,1);
    const officialCalls=f.calls();await runCodeSearch({...options,mode:'official',source:'official',directory:official,selectedRun:directory,repeats:1},f.services);assert.equal(f.calls(),officialCalls);
    await assert.rejects(runCodeSearch({...options,mode:'official',source:'official',directory:join(root,dataset,'changed-code'),selectedRun:directory,repeats:1},{...f.services,codeHash:async()=> 'changed'}),/code\/data\/environment differs/);
  }}finally{await rm(root,{recursive:true,force:true});}
}));

test('five-repeat interruption preserves valid zeros by repeat index; one/five identity changes reject both directions',async()=>withKeys(async()=>{
  const root=await mkdtemp(join(tmpdir(),'ditto-repeat-recovery-'));
  try{
    const f=fixtures('humaneval',5);const directory=join(root,'search');
    const options:CodeSearchOptions={dataset:'humaneval',mode:'search',source:'ark-plan',directory,dataDir:'offline',dockerImage:'offline',newCandidates:1};
    f.failOn(40);await assert.rejects(runCodeSearch(options,f.services),/Invalid evaluation/);
    assert.equal(f.optimizers(),0);assert.equal((await read(join(directory,'manifest.json'))).status,'interrupted');
    const before=f.calls();assert.equal(before,164);
    await assert.rejects(runCodeSearch({...options,repeats:1},f.services),/identity changed/);assert.equal(f.calls(),before);
    f.failOn(0);await runCodeSearch(options,f.services);
    assert.equal(f.calls()-before,1+165,'one invalid baseline case plus complete new candidate; existing zeros retained');
    const one=fixtures('mbpp');const single={...options,dataset:'mbpp' as const,directory:join(root,'single'),repeats:1};
    await runCodeSearch(single,one.services);const calls=one.calls();
    await assert.rejects(runCodeSearch({...single,repeats:5},one.services),/identity changed/);assert.equal(one.calls(),calls);
  }finally{await rm(root,{recursive:true,force:true});}
}));

test('missing repeats and changed members cannot freeze or pass the completion gate',async()=>withKeys(async()=>{
  const root=await mkdtemp(join(tmpdir(),'ditto-repeat-reject-'));
  try{
    const f=fixtures('humaneval');const options:CodeSearchOptions={dataset:'humaneval',mode:'search',source:'ark-plan',directory:root,dataDir:'offline',dockerImage:'offline',newCandidates:1};
    const original=f.services.load!;
    const services={...f.services,load:async(...args:Parameters<typeof original>)=>{
      const loaded=await original(...args);return {...loaded,async evaluate(...params:Parameters<typeof loaded.evaluate>){const summary=await loaded.evaluate(...params);return {...summary,results:summary.results.slice(1)};}};
    }};
    await assert.rejects(runCodeSearch(options,services),/exact complete ordered/);assert.equal(f.optimizers(),0);
    const record=await read(join(root,'manifest.json'));assert.equal(record.status,'interrupted');
    await writeFile(join(root,'manifest.json'),JSON.stringify({...record,status:'complete'}));
    // Changed repetitions cannot short-circuit a forged completed manifest.
    await assert.rejects(runCodeSearch({...options,repeats:1},f.services),/identity changed/);
  }finally{await rm(root,{recursive:true,force:true});}
}));
test('staged entry refuses an unclean running manifest before any new model call',async()=>withKeys(async()=>{
  const root=await mkdtemp(join(tmpdir(),'ditto-unclean-entry-'));
  try{
    const f=fixtures('humaneval');const options:CodeSearchOptions={dataset:'humaneval',mode:'smoke',source:'ark-plan',directory:root,dataDir:'offline',dockerImage:'offline'};
    await runCodeSearch(options,f.services);const before=f.calls(),manifest=await read(join(root,'manifest.json'));
    await writeFile(join(root,'manifest.json'),JSON.stringify({...manifest,status:'running'}));
    await assert.rejects(runCodeSearch(options,f.services),/Unclean run.*automatic recovery is refused/);assert.equal(f.calls(),before);
    await writeFile(join(root,'manifest.json'),JSON.stringify({...manifest,status:'interrupted'}));
    await runCodeSearch(options,f.services);assert.equal(f.calls(),before,'a reviewed interruption still reuses its complete valid cases');
  }finally{await rm(root,{recursive:true,force:true});}
}));
