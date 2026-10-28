import assert from 'node:assert/strict';
import test from 'node:test';
import type {CaseResult,EvaluationSummary,BenchmarkTask} from '../domain.js';
import {pairedRegressionDecision,unifiedStages,comparableTokens} from '../unified/policy.js';
import {buildUnifiedFeedback} from '../unified/feedback.js';

function summary(examples:number,score:number,repeats=5):EvaluationSummary{
  const results:CaseResult[]=Array.from({length:examples},(_,index)=>Array.from({length:repeats},(_,repeat)=>({caseId:`case:${index}#${repeat+1}`,valid:true,score,
    prediction:'public prediction',expected:'PRIVATE-GOLD',normalizedExpected:'PRIVATE-GOLD',normalizedPrediction:'public prediction',method:'fixture',latencyMs:1,inputTokens:1,outputTokens:1,totalTokens:2}))).flat();
  return {valid:true,score,standardDeviation:0,examples,repeats,results,successfulRuns:results.length,failedRuns:0,timeoutRuns:0,wrongRuns:0,inputTokens:results.length,outputTokens:results.length,totalTokens:2*results.length,durationMs:1};
}

test('prefix stages preserve each pinned dataset final size without assuming 200 examples',()=>{
  assert.deepEqual(unifiedStages(200),[16,32,64,128,200]);assert.deepEqual(unifiedStages(33),[16,32,33]);
  assert.deepEqual(unifiedStages(12),[12]);assert.deepEqual(unifiedStages(128),[16,32,64,128]);assert.throws(()=>unifiedStages(0));
});
test('regression uses all five matching repeats and an absolute threshold; equality advances',()=>{
  const reference=summary(200,.8);
  const below=pairedRegressionDecision(summary(16,.64),reference,16,200);
  assert.equal(below.reason,'large-paired-regression');assert.equal(below.advance,false);assert.equal(below.overlap,80);
  assert.equal(pairedRegressionDecision(summary(16,.65),reference,16,200).advance,true);
  assert.equal(pairedRegressionDecision(summary(32,.71),reference,32,200).advance,false);
  assert.equal(pairedRegressionDecision(summary(32,.72),reference,32,200).advance,true);
  assert.equal(pairedRegressionDecision(summary(200,.1),reference,200,200).reason,'completed-full-evaluation');
});
test('missing reference, mismatched repeats, duplicate cases and incomplete pairs never manufacture evidence',()=>{
  const current=summary(16,0),reference=summary(200,1);
  assert.equal(pairedRegressionDecision(current,undefined,16,200).reason,'insufficient-paired-evidence');
  assert.equal(pairedRegressionDecision(current,summary(200,1,1),16,200).advance,true);
  const duplicates={...current,results:current.results.map((row,index)=>index===1?current.results[0]!:row)};
  assert.equal(pairedRegressionDecision(duplicates,reference,16,200).reason,'insufficient-paired-evidence');
  const invalid={...current,valid:false};assert.equal(pairedRegressionDecision(invalid,reference,16,200).reason,'engineering-failure');
});
test('rich feedback pairs only public cases and never serializes scorer fields or private error text',()=>{
  const tasks:BenchmarkTask[]=Array.from({length:4},(_,index)=>({id:`case:${index}`,dataset:'drop',prompt:'Public passage '+index+' '+('x'.repeat(5000))+' QUESTION AT END?',outputInstruction:'Return an answer',metadata:{}}));
  const before=summary(4,.5,1),after=summary(4,.5,1);
  const results=after.results.map((row,index)=>({...row,score:[0,1,1,.5][index]!,prediction:'public result '+index,
    ...(index===3?{valid:false,error:'PRIVATE-SCORER-ERROR'}:{})}));
  const feedback=buildUnifiedFeedback([
    {id:'base',parentId:null,status:'valid',evaluation:before},
    {id:'child',parentId:'base',status:'quality-pruned',evaluation:{...after,results,qualityPruned:true,stage:4,
      publicTraces:[{taskId:'case:0',events:[{nodeId:'solve',output:{message:{content:'PUBLIC-TRACE'},expected:'PRIVATE-TRACE-GOLD',authorization:'SECRET-TOKEN'}}]}]}},
  ],tasks);
  const text=JSON.stringify(feedback);
  assert.doesNotMatch(text,/PRIVATE-GOLD|PRIVATE-SCORER|PRIVATE-TRACE-GOLD|SECRET-TOKEN|normalizedExpected/);
  assert.match(text,/PUBLIC-TRACE/);assert.match(text,/QUESTION AT END/);assert.match(text,/improvedTasks/);assert.match(text,/regressedTasks/);
  assert.match(text,/truncated/);assert.match(text,/"fullScore":null/);
  assert.equal(comparableTokens({...before,totalTokens:0,tokenUsageStatus:'known-lower-bound'}),Infinity);
});
