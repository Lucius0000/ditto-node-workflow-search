import assert from 'node:assert/strict';
import test from 'node:test';
import type {ModelProvider} from '@codesoul-co/ditto/worker/infer';
import {BASELINE_DEFINITION,GRAPH_AGENT_POLICY,validateDefinition,validateDefinitionChange,definitionShape,type GraphDefinition,type Source,type DefinitionNode} from '../graph-agent/schema.js';
import {runGraphAgent} from '../graph-agent/executor.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {withWorkflowTimeBudget} from '../execution/time-budget.js';
import {evaluateTasks} from '../benchmark/evaluator.js';
import {searchGraphWorkflows} from '../graph-agent/search.js';
import {GRAPH_OPTIMIZER_PROMPT} from '../graph-agent/search.js';

const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:3,timeoutMs:3000};
const task={id:'b-fixture',dataset:'math' as const,prompt:'Compute twice 21.',outputInstruction:'Return a number.',metadata:{}};
const ref=(nodeId:string,view:Extract<Source,{from:'node'}>['view']='answer'):Source=>({from:'node',nodeId,view});
const literal=(value:any):Source=>({from:'literal',value});
async function execute(definition:GraphDefinition,respond:(input:any,index:number)=>any=()=>({message:{role:'assistant',content:'42'},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}})){
 const calls:any[]=[];const shared=createExperimentRuntime(settings,{provider:{async invoke(input){calls.push(structuredClone(input));return respond(input,calls.length);}}});
 try{return {result:await withWorkflowTimeBudget({requestMs:3000,workflowMs:5000},()=>runGraphAgent(definition,task,shared,settings)),calls};}finally{await shared.close();}
}
const root=()=>structuredClone(BASELINE_DEFINITION.graphs[0]!.nodes[0]!);
const solve=(dependencies:string[]=[],evidence:Source[]=[]):DefinitionNode=>({id:'solve',type:'INFER.REASONING.SAMPLE',dependencies,config:{instruction:'Return the number.',evidence}});
const single=(nodes:DefinitionNode[],output='solve'):GraphDefinition=>({version:1,graphs:[{id:'agent',nodes}],loop:{entryGraphId:'agent',maxGraphRuns:4,transitions:{agent:{kind:'end'}}},output:{nodeId:output,view:'answer'}});

test('SAMPLE firstUser adds public material once per attempt and an empty slot preserves messages',async()=>{
 const baseline=structuredClone(BASELINE_DEFINITION),empty=structuredClone(baseline);empty.graphs[0]!.nodes[1]!.config.firstUser={literal:''};
 assert.deepEqual((await execute(baseline)).calls[0].messages,(await execute(empty)).calls[0].messages);
 const repeated=structuredClone(empty);repeated.graphs[0]!.nodes[1]!.config.firstUser={literal:'FIRST_VISIT_ONLY'};
 repeated.loop.maxGraphRuns=2;repeated.loop.transitions.agent={kind:'repeat',graphId:'agent',maxVisits:2,until:{left:{literal:false},operator:'truthy'}};
 const a=await execute(repeated),b=await execute(repeated);assert.equal(a.calls.length,2);
 for(const run of [a,b]){assert.equal(run.calls[0].messages.filter((m:any)=>m.content==='FIRST_VISIT_ONLY').length,1);assert.equal(run.calls[1].messages.filter((m:any)=>m.content==='FIRST_VISIT_ONLY').length,0);assert.deepEqual(run.calls[0].messages.filter((m:any)=>m.role==='system'),run.calls[1].messages.filter((m:any)=>m.role==='system'));}
});

test('B baseline runs native Ditto and records actual usage and node traces',async()=>{
 const {result,calls}=await execute(BASELINE_DEFINITION);assert.equal(result.answer,'42');assert.equal(calls.length,1);assert.equal(result.totalTokens,3);
 assert.deepEqual(result.executedNodeIds,['context','solve']);assert.equal(result.trace.length,2);
});

const toolPlan=():GraphDefinition=>({...single([root(),
 {id:'compute',type:'INTERACTION.ACT.TOOL',dependencies:['context'],config:{tool:'generated_double',arguments:{value:literal(21)}}},
 solve(['compute'],[ref('compute','evidence')])]),tools:[{name:'generated_double',description:'Double a finite number.',inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false},executeSource:'function(args){return args.value*2;}'}]});

test('B routes a real generated-tool result as evidence without LLM-written binding code',async()=>{
 const {result,calls}=await execute(toolPlan());assert.equal(result.answer,'42');assert.equal(result.candidateFailure,undefined);assert.equal(calls.length,1);
 assert.equal(result.rawNodeOutputs.compute.structuredContent.result,42);assert.match(JSON.stringify(calls[0].messages),/42/);
 assert.deepEqual(result.executedNodeIds,['context','compute','solve']);
});

test('tool-as-answer misuse is rejected before any provider or tool execution',()=>{
 const bad=toolPlan();bad.graphs[0]!.nodes.at(-1)!.config.evidence=[ref('compute','answer')];assert.throws(()=>validateDefinition(bad),/tools are evidence/);
 const output=toolPlan();output.output.nodeId='compute';assert.throws(()=>validateDefinition(output),/Output must be an Infer/);
});

test('actual ACT to OBSERVE to repeated LOAD to Infer compiles with typed ports',async()=>{
 const definition=toolPlan(),nodes=definition.graphs[0]!.nodes;
 nodes.splice(2,0,{id:'observed',type:'INTERACTION.OBSERVE',dependencies:['compute'],config:{result:ref('compute','external-result')}},
  {id:'loaded',type:'CONTEXT.LOAD',dependencies:['observed'],config:{sources:[ref('observed','evidence')]}});
 nodes.at(-1)!.dependencies=['loaded'];nodes.at(-1)!.config.evidence=[ref('loaded','context')];
 const {result,calls}=await execute(definition);assert.equal(result.answer,'42');assert.match(JSON.stringify(calls[0].messages),/42/);
 assert.equal(result.nodeInputs.observed.result.callId,result.rawNodeOutputs.compute.callId);
});

function reflected(mode='verify'):GraphDefinition {return single([root(),solve(['context']),
 {id:'check',type:'INFER.REASONING.REFLECT',dependencies:['solve'],config:{target:ref('solve'),mode,criteria:['Check demonstrated correctness only.']}}],'check');}
const reflectionResponse=(options:{passed?:boolean;issues?:any[];revised?:string;finishReason?:string}={})=>(input:any)=>({
 message:{role:'assistant',content:input.metadata.nodeType==='INFER.REASONING.REFLECT'?JSON.stringify({assessment:{passed:options.passed??true,summary:'Checked public evidence.'},issues:options.issues??[],...(options.revised?{revisedResult:{role:'assistant',content:options.revised}}:{})}):'42'},
 finishReason:input.metadata.nodeType==='INFER.REASONING.REFLECT'?options.finishReason??'stop':'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3},
});

test('verify without revisedResult preserves its exact target and actual token costs',async()=>{
 const {result,calls}=await execute(reflected(),reflectionResponse());assert.equal(result.answer,'42');assert.equal(result.candidateFailure,undefined);assert.equal(result.totalTokens,6);
 assert.equal(result.checkerAudits?.[0]?.decision,'check-only');assert.equal(result.rawNodeOutputs.check.output.revisedResult,undefined);
 assert.match(JSON.stringify(calls[1].messages),/computed answers need not be verbatim spans|preserve a correct answer/i);
});

test('verify/critique never adopt optional revisedResult, including warning-only rejection',async()=>{
 for(const mode of ['verify','critique']){
  const {result}=await execute(reflected(mode),reflectionResponse({passed:false,issues:[{severity:'warning',description:'Style only.'}],revised:'WRONG_REPLACEMENT'}));
  assert.equal(result.answer,'42');assert.equal(result.rawNodeOutputs.check.output.revisedResult.content,'WRONG_REPLACEMENT');
  assert.equal(result.checkerAudits?.[0]?.proposedAnswer,'WRONG_REPLACEMENT');assert.equal(result.checkerAudits?.[0]?.decision,'check-only');
 }
});

test('explicit revise adopts only actionable errors; passing or warning-only checks preserve target',async()=>{
 const adopted=await execute(reflected('revise'),reflectionResponse({passed:false,issues:[{severity:'error',description:'Concrete arithmetic error.'}],revised:'43'}));assert.equal(adopted.result.answer,'43');
 const preserved=await execute(reflected('revise'),reflectionResponse({passed:false,issues:[{severity:'warning',description:'Style only.'}],revised:'43'}));assert.equal(preserved.result.answer,'42');
});

test('custom graph names and cross-Graph evidence are compiled through one native Loop',async()=>{
 const definition:GraphDefinition={version:1,graphs:[{id:'collect',nodes:[root()]},{id:'custom-reason',nodes:[solve([],[ref('context','context')])]}],
  loop:{entryGraphId:'collect',maxGraphRuns:3,transitions:{collect:{kind:'next',graphId:'custom-reason'},'custom-reason':{kind:'end'}}},output:{nodeId:'solve',view:'answer'}};
 const {result}=await execute(definition);assert.equal(result.answer,'42');assert.deepEqual(result.executedGraphIds,['collect','custom-reason']);
});

test('repeat control uses typed actual output and records repeated native node completions',async()=>{
 const definition=single([root(),solve(['context'])]);definition.loop.maxGraphRuns=4;
 definition.loop.transitions.agent={kind:'repeat',graphId:'agent',maxVisits:3,until:{source:ref('solve'),operator:'equals',value:'DONE'}};
 const {result,calls}=await execute(definition,(_input,index)=>({message:{role:'assistant',content:index===2?'DONE':'CONTINUE'},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}}));
 assert.equal(result.answer,'DONE');assert.equal(calls.length,2);assert.deepEqual(result.executedGraphIds,['agent','agent']);assert.equal(result.trace.length,4);assert.equal(result.totalTokens,6);
});

test('native Memory write/read/update uses real IDs and per-attempt resources',async()=>{
 const definition=single([root(),
  {id:'written',type:'MEMORY.WRITE',dependencies:[],config:{content:literal('old public evidence')}},
  {id:'updated',type:'MEMORY.UPDATE',dependencies:['written'],config:{ids:ref('written','memory-ids'),content:literal('new public evidence')}},
  {id:'read',type:'MEMORY.GET',dependencies:['written','updated'],config:{ids:ref('written','memory-ids')}},solve(['read'],[ref('read','evidence')])]);
 const {result,calls}=await execute(definition);assert.equal(result.answer,'42');assert.match(JSON.stringify(calls[0].messages),/new public evidence/);assert.doesNotMatch(JSON.stringify(calls[0].messages),/old public evidence/);
});

test('invalid source kinds, dangling/cyclic dependencies, and executable binding fields reject statically',()=>{
 const bad=structuredClone(BASELINE_DEFINITION);bad.graphs[0]!.nodes[1]!.config.bind='api.answer(...)';assert.throws(()=>validateDefinition(bad),/Unknown field bind/);
 const wrong=structuredClone(BASELINE_DEFINITION);wrong.graphs[0]!.nodes[1]!.dependencies=['missing'];assert.throws(()=>validateDefinition(wrong),/Dependencies are local/);
 const cycle=structuredClone(BASELINE_DEFINITION);cycle.graphs[0]!.nodes[0]!.dependencies=['solve'];assert.throws(()=>validateDefinition(cycle),/cycle/);
 const hidden=structuredClone(BASELINE_DEFINITION);hidden.graphs[0]!.nodes[1]!.config.evidence=[{from:'task',field:'reference'}];assert.throws(()=>validateDefinition(hidden),/Only public/);
});

test('failed runtime binding is engineering-invalid rather than a scored model zero',async()=>{
 const definition=single([root(),{id:'compute',type:'INTERACTION.ACT.TOOL',dependencies:[],config:{tool:'bounded_arithmetic',arguments:{expression:{from:'task',field:'prompt',extract:{kind:'decimal-number',index:999}}}}},solve(['compute'],[ref('compute','evidence')])]);
 await assert.rejects(execute(definition),(error:any)=>error.code==='B_AGENT_CONTRACT'&&error.partialRun.modelResponses.length===0);
 const summary=await evaluateTasks([task],{expectedLabel:()=> '42',async score(){throw Error('An engineering-invalid execution must not be graded');}},async()=>(await execute(definition)).result,{repeats:1,retryAttempts:1});
 assert.equal(summary.valid,false);assert.equal(summary.candidateFailureRuns,0);assert.equal(summary.results[0]?.failureKind,'execution');
});

test('provider infrastructure errors do not turn into candidate zeros',async()=>{
 await assert.rejects(execute(BASELINE_DEFINITION,()=>{throw Error('HTTP 503 provider unavailable');}),/503|provider/i);
});

test('B retains shared program Top-K selection, JSON-only proposals and private-feedback exclusion',async()=>{
 let invoked=0;
 const runtime={async run(_g:any,input:any){invoked++;assert.match(input.systemPrompt,/scheme B/);const request=JSON.parse(input.request);
  assert(request.parent.definition);assert.equal(request.parent.source,undefined);assert.doesNotMatch(input.request,/PRIVATE-GOLD|PRIVATE-SCORER-ERROR/);
  const definition=structuredClone(BASELINE_DEFINITION);definition.graphs[0]!.nodes[1]!.config.instruction='Improve general reasoning.';
  return {proposal:{status:'success',output:{message:{content:JSON.stringify({rationale:'One prompt change',definition})}}}};
 }};
 const summary={valid:true,score:.5,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,timeoutRuns:0,wrongRuns:0,inputTokens:0,outputTokens:0,totalTokens:0,durationMs:0,results:[{caseId:'case#1',valid:true,score:.5,expected:'PRIVATE-GOLD',prediction:'public',normalizedExpected:'PRIVATE-GOLD',normalizedPrediction:'public',method:'fixture',latencyMs:0,inputTokens:0,outputTokens:0,totalTokens:0}]};
 const result=await searchGraphWorkflows({runtime:runtime as any,model:{provider:'mock',model:'mock'},rounds:1,evaluate:async()=>summary});
 assert.equal(invoked,1);assert.equal(result.state.policy,GRAPH_AGENT_POLICY);assert.equal(result.state.history.length,2);
});

test('B mutation rules retain at most one added node with independent dependency budget',()=>{
 const parent=BASELINE_DEFINITION,child=reflected();validateDefinitionChange(JSON.stringify(parent),JSON.stringify(child));
 const extra=structuredClone(child);extra.graphs[0]!.nodes.splice(1,0,{id:'select',type:'CONTEXT.SELECT',dependencies:['context'],config:{context:ref('context','context')}});
 extra.graphs[0]!.nodes.find(n=>n.id==='solve')!.dependencies=['select'];extra.graphs[0]!.nodes.find(n=>n.id==='solve')!.config.evidence=[ref('select','context')];
 assert.throws(()=>validateDefinitionChange(JSON.stringify(parent),JSON.stringify(extra)),/ONE added/);
 assert.equal(definitionShape(parent).nodes.length,2);
});

test('Cache WRITE and LOOKUP pass native cache contracts and task-local results to Infer',async()=>{
 const definition=single([root(),
  {id:'saved',type:'INFER.CACHE.WRITE',dependencies:[],config:{key:literal('public-key'),value:literal('PUBLIC_CACHE_EVIDENCE')}},
  {id:'looked',type:'INFER.CACHE.LOOKUP',dependencies:['saved'],config:{key:literal('public-key')}},solve(['looked'],[ref('looked','cache')])]);
 const {result,calls}=await execute(definition);assert.equal(result.answer,'42');assert.equal(result.rawNodeOutputs.looked.output.hit,true);assert.match(JSON.stringify(calls[0].messages),/PUBLIC_CACHE_EVIDENCE/);
});

test('Loop switch executes the selected Graph and rejects cross-branch unavailable values',async()=>{
 const definition:GraphDefinition={version:1,graphs:[{id:'reason',nodes:[root(),solve(['context'])]},
  {id:'yes',nodes:[{id:'write-yes',type:'MEMORY.WRITE',dependencies:[],config:{content:literal('yes')}}]},
  {id:'no',nodes:[{id:'write-no',type:'MEMORY.WRITE',dependencies:[],config:{content:literal('no')}}]}],
  loop:{entryGraphId:'reason',maxGraphRuns:3,transitions:{reason:{kind:'switch',cases:[{when:{source:ref('solve'),operator:'equals',value:'42'},graphId:'yes'}],defaultGraphId:'no'},yes:{kind:'end'},no:{kind:'end'}}},output:{nodeId:'solve',view:'answer'}};
 const {result}=await execute(definition);assert.deepEqual(result.executedGraphIds,['reason','yes']);assert(!result.executedNodeIds.includes('write-no'));
 const invalid=structuredClone(definition);invalid.graphs[2]!.nodes[0]!.config.content=ref('write-yes','memory-records');assert.throws(()=>validateDefinition(invalid),/not available on every incoming/);
});

test('preflight interface failures repair the same candidate before a full evaluation',async()=>{
 let calls=0,evaluated=0,probed=0;
 const runtime={async run(_g:any,input:any){calls++;const request=JSON.parse(input.request);if(calls===2){assert.match(request.contractRepair.errors[0],/interface probe/);assert.equal(request.parent.id,'search-001');}
  const definition=structuredClone(BASELINE_DEFINITION);definition.graphs[0]!.nodes[1]!.config.instruction=calls===1?'first proposal':'repaired proposal';
  return {proposal:{status:'success',output:{message:{content:JSON.stringify({rationale:'Refine a public instruction',definition})}}}};
 }};
 const summary={valid:true,score:1,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,timeoutRuns:0,wrongRuns:0,inputTokens:0,outputTokens:0,totalTokens:0,durationMs:0,results:[{caseId:'case#1',valid:true,score:1,expected:'hidden',prediction:'answer',normalizedExpected:'hidden',normalizedPrediction:'answer',method:'fixture',latencyMs:0,inputTokens:0,outputTokens:0,totalTokens:0}]};
 const result=await searchGraphWorkflows({runtime:runtime as any,model:{provider:'mock',model:'mock'},rounds:1,preflight:async()=>{if(++probed===1)throw Error('interface probe rejected');},evaluate:async()=>{evaluated++;return summary;}});
 assert.equal(calls,2);assert.equal(evaluated,2);assert.equal(result.state.history[1]?.status,'invalid-proposal');
});

test('unusable length-stopped reflection remains an empty scored answer, never inherits an earlier result',async()=>{
 const {result}=await execute(reflected(),input=>({message:{role:'assistant',content:input.metadata.nodeType==='INFER.REASONING.REFLECT'?'{"assessment":':'42'},finishReason:input.metadata.nodeType==='INFER.REASONING.REFLECT'?'length':'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}}));
 assert.equal(result.answer,'');assert.equal(result.candidateFailure,undefined);assert.equal(result.generationOutcomes?.[0]?.usable,false);assert.equal(result.totalTokens,6);
});

test('typed definition rejects asynchronous or nonfunction generated tool sources',()=>{
 const asyncTool=toolPlan();asyncTool.tools![0]!.executeSource='async function(args){return args.value*2;}';assert.throws(()=>validateDefinition(asyncTool),/synchronous pure function/);
 const notFunction=toolPlan();notFunction.tools![0]!.executeSource='42';assert.throws(()=>validateDefinition(notFunction),/synchronous pure function/);
});

test('Loop can feed the preceding invocation back with an explicit first-visit fallback',async()=>{
 const definition=single([root(),solve(['context'],[{from:'previous',nodeId:'solve',view:'answer',fallback:literal('FIRST_VISIT_SENTINEL')}])]);
 definition.loop.transitions.agent={kind:'repeat',graphId:'agent',maxVisits:2,until:{source:ref('solve'),operator:'equals',value:'DONE'}};
 const {result,calls}=await execute(definition,(input,index)=>({message:{role:'assistant',content:index===1?'CONTINUE_SENTINEL':'DONE'},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}}));
 assert.equal(result.answer,'DONE');assert.match(JSON.stringify(calls[0].messages),/FIRST_VISIT_SENTINEL/);assert.match(JSON.stringify(calls[1].messages),/CONTINUE_SENTINEL/);
});

test('actual native optimizer provider receives scheme-B interface boundaries and only a parent definition',async()=>{
 const captured:any[]=[];const definition=structuredClone(BASELINE_DEFINITION);definition.graphs[0]!.nodes[1]!.config.instruction='A general prompt refinement.';
 const provider:ModelProvider={async invoke(input){captured.push(structuredClone(input));return {message:{role:'assistant',content:JSON.stringify({rationale:'Change a general instruction',definition})},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};}};
 const shared=createExperimentRuntime(settings,{provider});
 const summary={valid:true,score:1,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,timeoutRuns:0,wrongRuns:0,inputTokens:0,outputTokens:0,totalTokens:0,durationMs:0,results:[{caseId:'case#1',valid:true,score:1,expected:'PRIVATE-GOLD',prediction:'answer',normalizedExpected:'PRIVATE-GOLD',normalizedPrediction:'answer',method:'fixture',latencyMs:0,inputTokens:0,outputTokens:0,totalTokens:0}]};
 try{await searchGraphWorkflows({runtime:shared.runtime,model:{provider:shared.providerName,model:shared.model},rounds:1,evaluate:async()=>summary});}
 finally{await shared.close();}
 assert.equal(captured.length,1);assert.equal(captured[0].messages[0].content,GRAPH_OPTIMIZER_PROMPT);
 assert.match(captured[0].messages[0].content,/Do NOT generate createWorkflow, Graph\/Loop JavaScript/);
 assert.match(captured[0].messages[0].content,/host owns native interface adaptation/);
 assert.match(captured[0].messages[0].content,/system template.*frozen across datasets/);
 const request=JSON.parse(captured[0].messages[1].content);assert(request.parent.definition);assert.equal(request.parent.source,undefined);assert.doesNotMatch(JSON.stringify(request),/PRIVATE-GOLD/);
});

test('revise with a proven passed no-change decision preserves the known input without inventing a model answer',async()=>{
 const {result}=await execute(reflected('revise'),reflectionResponse({passed:true}));
 assert.equal(result.answer,'42');assert.equal(result.candidateFailure,undefined);
 assert.equal(result.reflectionResponses[0]?.preservedKnownTarget,true);
 assert.equal(JSON.parse(String(result.reflectionResponses[0]?.rawContent)).revisedResult,undefined);
 assert.equal(result.checkerAudits?.[0]?.proposedAnswer,undefined);
 assert.equal(result.checkerAudits?.[0]?.decision,'preserved-passed-or-no-error');
});

test('a model that omits required revised output receives a model-format zero',async()=>{
 const {result}=await execute(reflected('revise'),reflectionResponse({passed:false,issues:[{severity:'error',description:'Concrete error.'}]}));
 assert.equal(result.answer,'');assert.equal(result.modelFailure?.code,'MODEL_OUTPUT_FORMAT');assert.equal(result.candidateFailure,undefined);
});

test('duplicate verdict keys cannot authorize application known-target preservation',async()=>{
 const {result}=await execute(reflected('revise'),input=>({message:{role:'assistant',content:input.metadata.nodeType==='INFER.REASONING.REFLECT'?'{"assessment":{"passed":false,"passed":true,"summary":"Ambiguous"},"issues":[]}':'42'},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}}));
 assert.equal(result.answer,'');assert.equal(result.modelFailure?.code,'MODEL_OUTPUT_FORMAT');assert.equal(result.reflectionResponses.some(r=>r.preservedKnownTarget),false);
});
