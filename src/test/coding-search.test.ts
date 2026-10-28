import assert from 'node:assert/strict';
import test from 'node:test';
import type { DittoRuntime } from '@codesoul-co/ditto/runtime';
import type { EvaluationSummary } from '../domain.js';
import { BASELINE_MODULE } from '../coding/module.js';
import { codingParentProbabilities, parseCodingProposal, searchCodingWorkflows, type CodingSearchState } from '../coding/search.js';

function summary(score=.5,valid=true):EvaluationSummary {
 return {score,valid,standardDeviation:0,repeats:1,examples:1,successfulRuns:valid?1:0,failedRuns:valid?0:1,timeoutRuns:0,wrongRuns:valid&&score<1?1:0,inputTokens:0,outputTokens:0,totalTokens:0,durationMs:1,
  results:[{caseId:'public-case',prediction:'public prediction',expected:'PRIVATE-GOLD',normalizedExpected:'PRIVATE-GOLD',normalizedPrediction:'public prediction',method:'fixture',score,valid,latencyMs:1,inputTokens:0,outputTokens:0,totalTokens:0,...(!valid?{failureKind:'judge' as const,error:'PRIVATE-SCORER-ERROR'}:{})}]};
}
const changed=(value:string)=>BASELINE_MODULE.replace('api.sample(task)',`api.sample(task,${JSON.stringify(value)})`);
const runtime=(run:(input:{request:string})=>unknown)=>({run:async(_graph:unknown,input:{request:string})=>run(input)}) as Pick<DittoRuntime,'run'>;
const proposal=(source:string)=>({proposal:{status:'success',output:{message:{content:JSON.stringify({rationale:'Public general edit',source})}}}});
const model={provider:'mock',model:'fixture'};

test('Top-K is selected by the program, excludes invalid measurements, and retains uniform exploration',async()=>{
 let calls=0;
 const result=await searchCodingWorkflows({runtime:runtime(()=>proposal(changed(String(++calls)))),model,rounds:3,evaluate:async()=>summary(.4+calls*.1)});
 const probabilities=codingParentProbabilities(result.state.history,2);
 assert.deepEqual(probabilities.map(row=>row.id),['search-004','search-003']);
 assert.ok(probabilities.every(row=>row.probability>=.15));
 assert.ok(Math.abs(probabilities.reduce((sum,row)=>sum+row.probability,0)-1)<1e-10);
 assert.equal(codingParentProbabilities([...result.state.history,{...result.state.history[0]!,id:'invalid',status:'invalid-evaluation',evaluation:summary(1,false)}],4).some(row=>row.id==='invalid'),false);
});

test('invalid measured workflows occupy their round and do not stop the next round or leak private feedback',async()=>{
 let calls=0,evaluations=0;
 const result=await searchCodingWorkflows({runtime:runtime(input=>{
  assert.doesNotMatch(input.request,/PRIVATE-GOLD|PRIVATE-SCORER-ERROR/);
  if(calls===1){const feedback=JSON.parse(input.request).history.find((row:{status:string})=>row.status==='invalid-evaluation');assert.equal('score' in feedback,false);}
  return proposal(changed(String(++calls)));
 }),model,rounds:2,evaluate:async()=>summary(.5,++evaluations!==2)});
 assert.deepEqual(result.state.history.map(row=>row.status),['valid','invalid-evaluation','valid']);
 assert.equal(evaluations,3);assert.equal(result.state.roundsCompleted,2);
});

test('malformed coding proposals are retained and bounded; later rounds still run',async()=>{
 let calls=0;
 const result=await searchCodingWorkflows({runtime:runtime(()=>{calls++;return {proposal:{status:'success',output:{message:{content:'not JSON'}}}};}),model,rounds:2,maxProposalAttempts:2,evaluate:async()=>summary()});
 assert.equal(calls,4);assert.equal(result.state.roundsCompleted,2);
 assert.equal(result.state.history.filter(row=>row.status==='invalid-proposal').length,4);
 assert.equal(result.best.id,'search-001');
 assert.throws(()=>parseCodingProposal(JSON.stringify({rationale:'x',source:BASELINE_MODULE,extra:'untrusted'})),/only/);
});

test('saved pending module resumes without another optimizer request; source changes reject',async()=>{
 let pending:CodingSearchState|undefined;
 await assert.rejects(searchCodingWorkflows({runtime:runtime(()=>{throw Error('no proposal');}),model,rounds:0,evaluate:async()=>summary(),save:async state=>{if(state.pending){pending=state;throw Error('interrupt after durable pending');}}}),/interrupt/);
 const result=await searchCodingWorkflows({runtime:runtime(()=>{throw Error('must not repropose');}),model,rounds:0,resume:pending!,evaluate:async()=>summary(.7)});
 assert.equal(result.best.evaluation.score,.7);assert.equal(result.state.history.length,1);
 await assert.rejects(searchCodingWorkflows({runtime:runtime(()=>{throw Error();}),model,rounds:0,resume:{...pending!,pending:{...pending!.pending!,source:changed('tampered')}},evaluate:async()=>summary()}),/baseline differs|identity mismatch/);
});

test('optimizer receives explicitly captured candidate execution feedback without scorer errors',async()=>{
 const result=await searchCodingWorkflows({runtime:runtime(input=>{
  assert.match(input.request,/context must be an object/);
  assert.doesNotMatch(input.request,/PRIVATE-GOLD|PRIVATE-SCORER-ERROR/);
  return proposal(changed('repair'));
 }),model,rounds:1,evaluate:async()=>({...summary(0),publicExecutionFeedback:[{message:'context must be an object',count:1}]})});
 assert.equal(result.state.roundsCompleted,1);
});

test('contract repair includes the rejected source and accumulated errors while retaining the original parent',async()=>{
 let calls=0;
 const badSource=BASELINE_MODULE.replace('createWorkflow','notTheEntrypoint');
 const result=await searchCodingWorkflows({runtime:runtime(input=>{
  const request=JSON.parse(input.request);calls++;
  assert.equal(request.parent.id,'search-001');
  if(calls===1)return {proposal:{status:'success',output:{message:{content:'not JSON'}}}};
  if(calls===2){assert.equal(request.contractRepair.rawResponse,'not JSON');return proposal(badSource);}
  assert.equal(request.contractRepair.source,badSource);
  assert.equal(request.contractRepair.errors.length,2);
  assert.doesNotMatch(input.request,/PRIVATE-GOLD|PRIVATE-SCORER-ERROR/);
  return proposal(changed('fixed executable child'));
 }),model,rounds:1,evaluate:async()=>summary(.5)});
 assert.equal(calls,3);
 assert.deepEqual(result.state.history.map(row=>row.status),['valid','invalid-proposal','invalid-proposal','valid']);
 assert.equal(result.state.roundsCompleted,1);assert.equal(result.state.history.at(-1)!.parentId,'search-001');
});
