import assert from 'node:assert/strict';
import test from 'node:test';
import type {DittoRuntime} from '@codesoul-co/ditto/runtime';
import type {BenchmarkTask,DatasetName,EvaluationSummary} from '../domain.js';
import {BASELINE_DEFINITION,type GraphDefinition} from '../graph-agent/schema.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {searchUnifiedWorkflows as searchWithWorkerPolicy,unifiedParentProbabilities,assertUnifiedComplete,type UnifiedSearchState,type UnifiedSearchOptions} from '../unified/search.js';
import {UNIFIED_SYSTEM_PROMPT,UNIFIED_SYSTEM_PROMPT_SHA256} from '../unified/prompts.js';
import {createHash} from 'node:crypto';

const model={provider:'mock',model:'fixture'};
// These fixtures isolate checkpoint/scoring behavior; worker allocation has its own live-path tests.
const searchUnifiedWorkflows=(options:UnifiedSearchOptions)=>searchWithWorkerPolicy({...options,exploration:false});
const tasks=(count=1,dataset:DatasetName='drop'):BenchmarkTask[]=>Array.from({length:count},(_,index)=>({id:`case:${index}`,dataset,prompt:`Public ${dataset} problem ${index}`,outputInstruction:'Return the requested answer',metadata:{}}));
function summary(score=.5,count=1,repeats=1,totalTokens=2):EvaluationSummary{
  const results=Array.from({length:count},(_,index)=>Array.from({length:repeats},(_,repeat)=>({caseId:`case:${index}#${repeat+1}`,valid:true,score,expected:'PRIVATE-GOLD',prediction:'public prediction',
    normalizedExpected:'PRIVATE-GOLD',normalizedPrediction:'public prediction',method:'fixture',latencyMs:0,inputTokens:1,outputTokens:1,totalTokens:2}))).flat();
  return {valid:true,score,standardDeviation:0,repeats,examples:count,results,successfulRuns:results.length,failedRuns:0,wrongRuns:0,timeoutRuns:0,inputTokens:1,outputTokens:1,totalTokens,durationMs:0};
}
const runtime=(respond:(input:{request:string;id:string})=>unknown)=>({run:async(_g:unknown,input:{request:string;id:string})=>respond(input)}) as Pick<DittoRuntime,'run'>;
function response(request:string,instruction:string){
  const parsed=JSON.parse(request);const definition:GraphDefinition=structuredClone(parsed.parent.definition);
  definition.version=2;definition.graphs[0]!.nodes.find(node=>node.type==='INFER.REASONING.SAMPLE')!.config.instruction=instruction;
  return {proposal:{status:'success',output:{message:{role:'assistant',content:JSON.stringify({rationale:'One reusable user-instruction change',definition})}}}};
}

test('engineering repairs stay in one selected-parent round and do not consume complete valid budget',async()=>{
  let proposals=0,evaluations=0;
  const result=await searchUnifiedWorkflows({runtime:runtime(input=>{
    const request=JSON.parse(input.request);assert.doesNotMatch(input.request,/PRIVATE-GOLD|PRIVATE-SCORER/);
    if(++proposals===2){assert.equal(request.mode,'ENGINEERING REPAIR');assert.equal(request.parent.id,'unified-0001');assert.equal(request.contractRepair.definition.graphs[0].nodes[1].config.instruction,'attempt-1');assert.match(request.contractRepair.errors.join(' '),/Missing public field/);}
    return response(input.request,`attempt-${proposals}`);
  }),model,dataset:'drop',publicTasks:tasks(),expectedRepeats:1,maxValidEvaluations:2,maxDesignRounds:2,
    evaluate:async()=>{if(++evaluations===2)throw Object.assign(Error('PRIVATE-HOST-DETAIL'),{publicMessage:'Missing public field target'});return summary(evaluations===1?.5:.7);}});
  assert.equal(result.state.validEvaluations,2);assert.equal(result.state.designRoundsCompleted,1);assert.equal(result.state.proposalAttempts,2);
  assert.equal(result.state.engineeringFailures,1);assert.deepEqual(result.state.history.map(row=>row.status),['valid','invalid-evaluation','valid']);
  assert.equal(unifiedParentProbabilities(result.state.history).some(row=>row.id==='unified-0002'),false);
});
test('bounded rejected proposals skip the design round while later designs can fill a valid budget',async()=>{
  let proposals=0;
  const result=await searchUnifiedWorkflows({runtime:runtime(input=>++proposals<=3?{proposal:{status:'success',output:{message:{content:'invalid JSON'}}}}:response(input.request,'finally-valid')),
    model,dataset:'drop',publicTasks:tasks(),expectedRepeats:1,maxValidEvaluations:2,maxDesignRounds:2,evaluate:async()=>summary()});
  assert.equal(result.state.proposalAttempts,4);assert.equal(result.state.designRoundsCompleted,2);assert.equal(result.state.validEvaluations,2);
  assert.equal(result.state.history.filter(row=>row.status==='invalid-proposal').length,3);
});
test('quality pruning remains partial evidence, never an engineering failure or a Top-K parent',async()=>{
  let proposals=0,evaluations=0;
  const result=await searchUnifiedWorkflows({runtime:runtime(input=>response(input.request,`change-${++proposals}`)),model,dataset:'drop',publicTasks:tasks(2),expectedRepeats:1,
    maxValidEvaluations:2,maxDesignRounds:2,evaluate:async()=>++evaluations===2?{...summary(.1,1),qualityPruned:true,stage:1}:summary(evaluations===1?.8:.9,2)});
  assert.equal(result.state.validEvaluations,2);assert.equal(result.state.prunedEvaluations,1);assert.equal(result.state.engineeringFailures,0);
  assert.equal(result.state.history[1]!.status,'quality-pruned');assert.equal(unifiedParentProbabilities(result.state.history).some(row=>row.id===result.state.history[1]!.id),false);
});
test('pending checkpoint resumes without regenerating, but changed candidate identity is rejected',async()=>{
  let saved:UnifiedSearchState|undefined;
  const opts={runtime:runtime(()=>{throw Error('must not call optimizer');}),model,dataset:'drop' as const,publicTasks:tasks(),expectedRepeats:1,maxValidEvaluations:1,evaluate:async()=>summary()};
  await assert.rejects(searchUnifiedWorkflows({...opts,save:state=>{if(state.pending){saved=state;throw Error('stop after durable checkpoint');}}}),/durable checkpoint/);
  const resumed=await searchUnifiedWorkflows({...opts,resume:saved!});assert.equal(resumed.state.validEvaluations,1);
  const tampered=structuredClone(saved!);tampered.pending!.definition.graphs[0]!.nodes[1]!.config.instruction='tampered';
  await assert.rejects(searchUnifiedWorkflows({...opts,resume:tampered}),/artifact identity mismatch/);
});
test('full evaluations reject candidateFailure zeros, duplicate cases and score/history disagreement',()=>{
  const valid=summary();assertUnifiedComplete(valid,tasks(),1);
  assert.throws(()=>assertUnifiedComplete({...valid,results:[{...valid.results[0]!,candidateFailure:{kind:'binding',message:'bug'}}]},tasks(),1),/engineering-invalid/);
  assert.throws(()=>assertUnifiedComplete({...valid,score:.9},tasks(),1),/score does not match/);
  assert.throws(()=>assertUnifiedComplete({...valid,results:[{...valid.results[0]!,caseId:'other#1'}]},tasks(),1),/unexpected/);
});
test('checkpoint interruption after an accepted proposal preserves pending work instead of misclassifying it',async()=>{
  let saved:UnifiedSearchState|undefined,calls=0;
  const options={runtime:runtime(input=>response(input.request,`change-${++calls}`)),model,dataset:'drop' as const,publicTasks:tasks(),expectedRepeats:1,maxValidEvaluations:2,evaluate:async()=>summary()};
  await assert.rejects(searchUnifiedWorkflows({...options,save:state=>{if(state.pending?.designRound===1){saved=state;throw Error('disk checkpoint interrupted');}}}),/checkpoint interrupted/);
  assert.equal(saved!.pending!.id,'unified-0002');assert.equal(saved!.history.length,1);
  const resumed=await searchUnifiedWorkflows({...options,resume:saved!});assert.equal(calls,1);assert.equal(resumed.state.validEvaluations,2);
});
test('resource exhaustion preserves durable pending evaluation and never retries it as a bad design',async()=>{
  let saved:UnifiedSearchState|undefined;
  await assert.rejects(searchUnifiedWorkflows({runtime:runtime(()=>{throw Error('no optimizer');}),model,dataset:'drop',publicTasks:tasks(),expectedRepeats:1,maxValidEvaluations:1,
    save:state=>{saved=state;},evaluate:async()=>{throw Object.assign(Error('limit reached'),{code:'SEARCH_BUDGET_EXHAUSTED',infrastructureFailure:true});}}),/limit reached/);
  assert(saved!.pending);assert.equal(saved!.validEvaluations,0);assert.equal(saved!.engineeringFailures,0);
});
test('actual optimizer requests use exactly the same frozen system across datasets; task differences stay in user',async()=>{
  const captured:{system:unknown;user:unknown}[]=[];
  const experiment=createExperimentRuntime({baseUrl:'https://example.invalid',model:'fixture',apiKey:'offline',concurrency:1,timeoutMs:2000},{provider:{async invoke(input){
    captured.push({system:input.messages[0]!.content,user:input.messages[1]!.content});
    const proposal=response(String(input.messages[1]!.content),'general-user-instruction').proposal.output.message.content;
    return {message:{role:'assistant',content:proposal},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
  }}});
  try{
    for(const dataset of ['drop','math']as const)await searchUnifiedWorkflows({runtime:experiment.runtime,model:{provider:experiment.providerName,model:experiment.model},dataset,
      publicTasks:tasks(1,dataset),expectedRepeats:1,maxValidEvaluations:2,evaluate:async()=>summary()});
  }finally{await experiment.close();}
  assert.equal(captured.length,2);assert.equal(captured[0]!.system,UNIFIED_SYSTEM_PROMPT);assert.equal(captured[1]!.system,UNIFIED_SYSTEM_PROMPT);
  assert.notEqual(captured[0]!.user,captured[1]!.user);assert.equal(createHash('sha256').update(UNIFIED_SYSTEM_PROMPT).digest('hex'),UNIFIED_SYSTEM_PROMPT_SHA256);
  assert.equal(BASELINE_DEFINITION.graphs[0]!.nodes[1]!.config.instruction,'');
});
