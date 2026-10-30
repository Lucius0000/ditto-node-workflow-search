import assert from 'node:assert/strict';
import test from 'node:test';
import type {DittoRuntime} from '@codesoul-co/ditto/runtime';
import {BASELINE_DEFINITION,DefinitionError,type GraphDefinition} from '../graph-agent/schema.js';
import {presentEvidence} from '../graph-agent/evidence.js';
import {directionForRound,validateExploration} from '../unified/exploration.js';
import {createDirectionBudget} from '../unified/direction-budget.js';
import {searchUnifiedWorkflows} from '../unified/search.js';
import type {BenchmarkTask,EvaluationSummary} from '../domain.js';
import {DROP_ANSWER_CONTRACT} from '../benchmark/answer-contract.js';
import {createExperimentRuntime} from '../ditto/runtime.js';

const task:BenchmarkTask={id:'public-fixture',dataset:'drop',prompt:'Public passage and question',outputInstruction:'',metadata:{}};
function summary(definition:GraphDefinition):EvaluationSummary&{publicTraces:unknown[]}{return{valid:true,score:.5,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,wrongRuns:0,timeoutRuns:0,inputTokens:1,outputTokens:1,totalTokens:2,durationMs:0,
 results:[{caseId:task.id+'#1',valid:true,score:.5,prediction:'public',expected:'PRIVATE',normalizedExpected:'PRIVATE',normalizedPrediction:'public',method:'fixture',latencyMs:0,inputTokens:1,outputTokens:1,totalTokens:2}],
 publicTraces:[{rawNodeOutputs:Object.fromEntries(definition.graphs.flatMap(g=>g.nodes).map(n=>[n.id,{}]))}]};}
function child(direction:string):GraphDefinition{
 const d=structuredClone(BASELINE_DEFINITION),solve=d.graphs[0]!.nodes.at(-1)!;
 if(direction==='interaction'){
  d.graphs[0]!.nodes.splice(1,0,{id:'find',type:'INTERACTION.ACT.TOOL',dependencies:[],config:{tool:'literal_text_find',arguments:{text:{ref:['task','prompt']},needle:{literal:'public'}}}});
  solve.dependencies=['context','find'];solve.config.evidence=[{ref:['nodes','find','structuredContent']}];
 }else if(direction==='context-retrieval'){
  d.graphs[0]!.nodes.splice(1,0,{id:'selected',type:'CONTEXT.SELECT',dependencies:['context'],config:{context:{from:'node',nodeId:'context',view:'context'},limit:1}});
  solve.dependencies=['selected'];solve.config.evidence=[{ref:['nodes','selected','context','items']}];
 }else if(direction==='native-reasoning'){
  solve.type='INFER.REASONING.TRAJECTORY';solve.config={instruction:'Reason from the public task',strategy:'cot',maxSteps:1};
 }else{
  d.graphs[0]!.nodes.splice(1,0,{id:'cached',type:'INFER.CACHE.WRITE',dependencies:['context'],config:{key:{literal:'public'},value:{ref:['nodes','context','items']}}});
  solve.dependencies=['context','cached'];solve.config.evidence=[{ref:['nodes','cached','key']},{ref:['nodes','context','items']}];
 }
 return d;
}

test('numeric lookup/comparison is independent of arithmetic; measurement spans require shortest sufficient slot',()=>{
 assert.match(DROP_ANSWER_CONTRACT,/looked up directly, selected by comparison\/ranking, or computed/);
 assert.match(DROP_ANSWER_CONTRACT,/How many <unit>/);assert.match(DROP_ANSWER_CONTRACT,/SHORTEST sufficient/);assert.match(DROP_ANSWER_CONTRACT,/omit the following event\/object name/);
});

test('evidence labels retain both producer identities and values without mutating native data',()=>{
 const d=structuredClone(BASELINE_DEFINITION),bindings=[{ref:['nodes','context','items']},{from:'node',nodeId:'solve',view:'answer'}];
 const values=[[{content:'A public fact'}],'42'],before=structuredClone(values);
 const text=presentEvidence(bindings,values,d.graphs);
 assert.match(text,/"nodeId":"context"/);assert.match(text,/"nodeType":"CONTEXT.LOAD"/);assert.match(text,/"nodeId":"solve"/);assert.match(text,/A public fact/);assert.match(text,/42/);assert.deepEqual(values,before);
});

test('reserved direction requires a changed native worker and rejects SAMPLE growth',()=>{
 const extra=structuredClone(BASELINE_DEFINITION);extra.graphs[0]!.nodes.push({id:'compute',type:'INFER.REASONING.SAMPLE',dependencies:['solve'],config:{instruction:'Compute again'}});
 assert.throws(()=>validateExploration(BASELINE_DEFINITION,extra,'interaction'),/At most one SAMPLE/);
 const renamed=structuredClone(BASELINE_DEFINITION);renamed.graphs[0]!.nodes[1]!.config.instruction='Use tools mentally';
 assert.throws(()=>validateExploration(BASELINE_DEFINITION,renamed,'interaction'),/requires an added or changed native operation/);
 assert.deepEqual(validateExploration(BASELINE_DEFINITION,child('interaction'),'interaction'),['find']);
 assert.deepEqual(Array.from({length:5},(_,i)=>directionForRound(i+1)),['interaction','context-retrieval','native-reasoning','memory-cache','interaction']);
});

test('one direction exhaustion leaves other provider reservations available',async()=>{
 const budget=createDirectionBudget({maxCalls:5,maxTokens:500});
 const input:any={messages:[],model:{provider:'mock',model:'mock'}};
 await budget.beforeProviderCall(input,'interaction');
 await budget.afterProviderCall({input,output:{message:{role:'assistant',content:'ok'},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}},diagnostics:[]} as any);
 await assert.rejects(budget.beforeProviderCall({...input},'interaction'),(error:any)=>error.code==='SEARCH_DIRECTION_BUDGET');
 await budget.beforeProviderCall({...input},'context-retrieval');
 assert.equal(budget.snapshot().interaction.providerCalls,1);assert.equal(budget.snapshot()['context-retrieval'].providerCalls,1);assert.equal(budget.snapshot()['memory-cache'].providerCalls,0);
});

test('search gives every native direction a protected turn and records actual execution before accepting candidates',async()=>{
 const directions:string[]=[];
 const runtime={async run(_g:unknown,input:{request:string}){
  const request=JSON.parse(input.request),direction=request.exploration.direction;directions.push(direction);
  return{proposal:{status:'success',output:{message:{content:JSON.stringify({rationale:'Test the protected native direction',definition:child(direction)})}}}};
 }} as Pick<DittoRuntime,'run'>;
 const result=await searchUnifiedWorkflows({runtime,model:{provider:'mock',model:'mock'},dataset:'drop',publicTasks:[task],expectedRepeats:1,maxValidEvaluations:5,maxDesignRounds:4,maxProposalAttempts:1,evaluate:async d=>summary(d)});
 assert.deepEqual(directions,['interaction','context-retrieval','native-reasoning','memory-cache']);assert.equal(result.state.validEvaluations,5);
 assert(result.state.history.slice(1).every(h=>h.explorationDirection));
});

test('a direction resource stop preserves partial checkpoint eligibility rules and moves to the next family',async()=>{
 const directions:string[]=[];
 const runtime={async run(_g:unknown,input:{request:string}){const direction=JSON.parse(input.request).exploration.direction;directions.push(direction);return{proposal:{status:'success',output:{message:{content:JSON.stringify({rationale:'Native hypothesis',definition:child(direction)})}}}};}} as Pick<DittoRuntime,'run'>;
 const result=await searchUnifiedWorkflows({runtime,model:{provider:'mock',model:'mock'},dataset:'drop',publicTasks:[task],expectedRepeats:1,maxValidEvaluations:2,maxDesignRounds:2,maxProposalAttempts:1,evaluate:async(d,_id,_ref,context)=>{
  if(context?.direction==='interaction')throw Object.assign(new Error('isolated quota stop'),{code:'SEARCH_DIRECTION_BUDGET'});return summary(d);
 }});
 assert.deepEqual(directions,['interaction','context-retrieval']);assert.equal(result.state.history[1]!.status,'resource-stopped');assert.equal(result.state.engineeringFailures,0);assert.equal(result.state.validEvaluations,2);
});

test('native optimizer NodeResult cannot erase a protected budget stop and abort other directions',async()=>{
 const shared=createExperimentRuntime({baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:1,timeoutMs:1000},{
  beforeProviderCall:async input=>{const request=JSON.parse(String(input.messages[1]!.content));if(request.exploration.direction==='interaction')throw Object.assign(new Error('SEARCH_DIRECTION_BUDGET: injected exhausted family'),{code:'SEARCH_DIRECTION_BUDGET'});},
  provider:{async invoke(input){const direction=JSON.parse(String(input.messages[1]!.content)).exploration.direction;return{message:{role:'assistant',content:JSON.stringify({rationale:'Use a native context operation',definition:child(direction)})},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}}
 });
 try{const result=await searchUnifiedWorkflows({runtime:shared.runtime,model:{provider:shared.providerName,model:shared.model},dataset:'drop',publicTasks:[task],expectedRepeats:1,maxValidEvaluations:2,maxDesignRounds:2,maxProposalAttempts:1,evaluate:async d=>summary(d)});
  assert.equal(result.state.history[1]!.status,'resource-stopped');assert.equal(result.state.history[2]!.explorationDirection,'context-retrieval');assert.equal(result.state.validEvaluations,2);
 }finally{await shared.close();}
});

test('declared model JSON failure stays a quality zero even when it prevents the downstream tool from running',async()=>{
 const runtime={async run(){return{proposal:{status:'success',output:{message:{content:JSON.stringify({rationale:'Test native interaction',definition:child('interaction')})}}}};}} as Pick<DittoRuntime,'run'>;
 const result=await searchUnifiedWorkflows({runtime,model:{provider:'mock',model:'mock'},dataset:'drop',publicTasks:[task],expectedRepeats:1,maxValidEvaluations:2,maxDesignRounds:1,evaluate:async(d,id)=>{
  const value=summary(d);if(id==='unified-0001')return value;
  return{...value,score:0,results:value.results.map(r=>({...r,score:0})),publicTraces:[{rawNodeOutputs:{context:{},solve:{}},modelFailure:{kind:'model-output',code:'MODEL_OUTPUT_FORMAT'}}]};
 }});
 assert.equal(result.state.validEvaluations,2);assert.equal(result.state.engineeringFailures,0);assert.equal(result.state.history[1]!.evaluation!.score,0);
});
