import assert from 'node:assert/strict';
import test from 'node:test';
import { createDitto } from '@codesoul-co/ditto/runtime';
import { createContextWorker } from '@codesoul-co/ditto/worker/context';
import { createInferWorker, type ModelProvider } from '@codesoul-co/ditto/worker/infer';
import { createMemoryWorker } from '@codesoul-co/ditto/worker/memory';
import { createInteractionWorker } from '@codesoul-co/ditto/worker/interaction';
import type { BenchmarkTask } from '../domain.js';
import { CapabilityExecutor } from '../workflow/capability-executor.js';
import { createBaseline, extendPlan, parseProposal, GRAPH_ORDER, type CapabilityNode, type CapabilityPlan, type CapabilityProposal, type CapabilitySource } from '../workflow/capability-schema.js';
import { createTaskMemory } from '../ditto/task-memory.js';
import { createBenchmarkTools, closeBenchmarkTools } from '../ditto/benchmark-tools.js';
import { WorkflowExecutor } from '../workflow/executor.js';
import { createRootNode, createInitialSampleNode, materializeAgentPlan } from '../workflow/spec.js';
import { baselinePrompts } from '../benchmark/baseline-prompts.js';

const task:BenchmarkTask={id:'fixture',dataset:'math',prompt:'12 bags with 8 items each',outputInstruction:'Return a boxed answer.',metadata:{split:'fixture'}};
const source=(nodeId:string,view:Extract<CapabilitySource,{from:'node'}>['view']='context'):CapabilitySource=>({from:'node',nodeId,view});
const proposal=(type:CapabilityProposal['node']['type'],config:Record<string,unknown>,dependencies:readonly string[]=[],graphId:CapabilityProposal['node']['graphId']='prepare'):CapabilityProposal=>parseProposal({rationale:'Exercise actual public evidence binding.',node:{type,graphId,dependencies,config}});
async function execute(plan:CapabilityPlan,publicTask=task,respond?:(input:Parameters<ModelProvider['invoke']>[0])=>string){
 const calls:Parameters<ModelProvider['invoke']>[0][]=[];const tools=createBenchmarkTools();const runtime=createDitto({sandbox:{tools:tools.map(t=>t.name)},workers:[createContextWorker(),createMemoryWorker(createTaskMemory()),createInteractionWorker({tools}),createInferWorker({defaultProvider:'fixture',providers:{fixture:{async invoke(input){calls.push(structuredClone(input));return {message:{role:'assistant',content:respond?respond(input):'96'},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};}}}})]});
 try{return {result:await new CapabilityExecutor(runtime,'fixture','fixture').run(plan,publicTask),calls};}finally{await runtime.close();await closeBenchmarkTools(tools);}
}
test('B P0 actual provider requests exactly match historical no-B baseline for all three datasets',async()=>{
 for(const dataset of ['drop','gsm8k','math'] as const){const t={...task,dataset};const actual=await execute(createBaseline(dataset),t);let request:unknown;const runtime=createDitto({workers:[createContextWorker(),createInferWorker({defaultProvider:'fixture',providers:{fixture:{async invoke(input){request=input;return {message:{role:'assistant',content:'96'},finishReason:'stop'};}}}})]});try{await new WorkflowExecutor(runtime,'fixture','fixture').run(materializeAgentPlan('baseline',[createRootNode(),createInitialSampleNode(baselinePrompts(dataset)?.agent??'')]),t);assert.deepEqual(actual.calls[0],request);}finally{await runtime.close();}}
});
test('P0→SELECT→COMPRESS→UPDATE are independently runnable and only Context leaves reach original solver',async()=>{
 let plan=createBaseline('math');const before=structuredClone(plan);
 plan=extendPlan(plan,proposal('CONTEXT.SELECT',{contextSource:source('context-load'),strategy:'default',purpose:'infer',limit:1},['context-load']),'select-1');
 assert.deepEqual(before,createBaseline('math'));let observed=await execute(plan);assert.match(JSON.stringify(observed.calls[0]?.messages),/Working evidence/);assert.ok(observed.result.nodeOutputs?.['select-1']);
 plan=extendPlan(plan,proposal('CONTEXT.COMPRESS',{contextSource:source('select-1'),maxItems:1},['select-1']),'compress-1');observed=await execute(plan);assert.match(JSON.stringify(observed.calls[0]?.messages),/compress-1/);assert.doesNotMatch(JSON.stringify(observed.calls[0]?.messages),/\[select-1:/);
 plan=extendPlan(plan,proposal('CONTEXT.UPDATE',{contextSource:source('compress-1'),addSource:{from:'task',field:'outputInstruction'}},['compress-1']),'update-1');observed=await execute(plan);assert.match(JSON.stringify(observed.calls[0]?.messages),/Return a boxed answer/);
 const changed=await execute(plan,{...task,outputInstruction:'Unique public requirement XYZ'});assert.notDeepEqual(observed.calls[0]?.messages,changed.calls[0]?.messages);assert.match(JSON.stringify(changed.calls[0]?.messages),/XYZ/);
});
test('WRITE→GET and WRITE→SEARCH use actual same-attempt stored content and suppress duplicate records',async()=>{
 const write=extendPlan(createBaseline('math'),proposal('MEMORY.WRITE',{contentSource:source('context-load')},['context-load']),'write-1');
 let observed=await execute(write);const written=(observed.result.nodeOutputs?.['write-1'] as any).records;assert.equal(written[0].content.includes('12 bags'),true);
 const get=extendPlan(write,proposal('MEMORY.GET',{idsSource:source('write-1','memory-ids')},['write-1']),'get-1');observed=await execute(get);const outputs=observed.result.nodeOutputs as any;assert.deepEqual(outputs['get-1'].records,outputs['write-1'].records);assert.doesNotMatch(JSON.stringify(observed.calls[0]?.messages),/\[write-1:/);assert.match(JSON.stringify(observed.calls[0]?.messages),/\[get-1:/);
 const search=extendPlan(write,proposal('MEMORY.SEARCH',{querySource:{from:'task',field:'prompt'},limit:3},['write-1']),'search-1');observed=await execute(search);assert.ok((observed.result.nodeOutputs?.['search-1'] as any).records.length>0);
 const empty=extendPlan(write,proposal('MEMORY.SEARCH',{querySource:{from:'literal',value:'nevermatchingzz'},limit:3},['write-1']),'search-empty');observed=await execute(empty);assert.deepEqual((observed.result.nodeOutputs?.['search-empty'] as any).records,[]);assert.match(JSON.stringify(observed.calls[0]?.messages),/results/);
});
function toolPlan():CapabilityPlan {return extendPlan(createBaseline('math'),proposal('INTERACTION.ACT.TOOL',{tool:'bounded_arithmetic',arguments:{tokens:[{from:'task',field:'prompt',extract:{kind:'decimal-number',index:0}},{from:'literal',value:'*'},{from:'task',field:'prompt',extract:{kind:'decimal-number',index:1}}]}}),'act-1');}
test('ACT→OBSERVE→LOAD are independent one-node extensions with real call identity and solver consumption',async()=>{
 let plan=toolPlan();let observed=await execute(plan);assert.deepEqual((observed.result.nodeOutputs?.['act-1'] as any).structuredContent,{result:96});assert.match(JSON.stringify(observed.calls[0]?.messages),/96/);
 plan=extendPlan(plan,proposal('INTERACTION.OBSERVE',{resultSource:source('act-1','external-result')},['act-1']),'observe-1');observed=await execute(plan);assert.equal((observed.result.nodeOutputs?.['act-1'] as any).callId,(observed.result.nodeOutputs?.['observe-1'] as any).callId);assert.doesNotMatch(JSON.stringify(observed.calls[0]?.messages),/\[act-1\]/);
 plan=extendPlan(plan,proposal('CONTEXT.LOAD',{sourcesSource:source('observe-1','observation')},['observe-1']),'load-observation');observed=await execute(plan);assert.match(JSON.stringify(observed.calls[0]?.messages),/load-observation/);assert.doesNotMatch(JSON.stringify(observed.calls[0]?.messages),/\[observe-1\]/);
 const changed=await execute(plan,{...task,prompt:'5 bags with 7 items each'});assert.deepEqual((changed.result.nodeOutputs?.['act-1'] as any).structuredContent,{result:35});assert.notDeepEqual(observed.calls[0]?.messages,changed.calls[0]?.messages);
});
test('static validation rejects hidden IDs, unknown fields, fake tool observations, unbound sources and evidence tails',()=>{
 assert.throws(()=>parseProposal({rationale:'x',node:{id:'model-owned',type:'CONTEXT.SELECT',graphId:'prepare',dependencies:[],config:{}}}),/Unknown field/);
 assert.throws(()=>extendPlan(createBaseline('math'),proposal('INTERACTION.OBSERVE',{resultSource:source('sample-1','answer-text')},[]),'observe-fake'),/OBSERVE|source/);
 assert.throws(()=>extendPlan(createBaseline('math'),proposal('CONTEXT.SELECT',{contextSource:source('context-load')},[]),'select-bad'),/explicit dependency/);
 assert.throws(()=>extendPlan(createBaseline('math'),proposal('MEMORY.WRITE',{contentSource:{from:'task',field:'prompt'}},[],'refine'),'write-dead'),/Unused/);
 assert.throws(()=>extendPlan(createBaseline('math'),proposal('CONTEXT.SELECT',{contextSource:source('context-load'),mystery:1},['context-load']),'select-unknown'),/Unknown field/);
});
test('mixed answer/evidence dependency orders preserve REFLECT target and checker pass-through',async()=>{
 for(const dependencies of [['final-1','write-refine'],['write-refine','final-1']]){
  const base=createBaseline('math');
  const nodes:CapabilityNode[]=[...base.nodes,
   {...proposal('INFER.REASONING.SAMPLE',{role:'finalizer',instruction:'Keep answer.',generation:{temperature:0,maxTokens:128}},[],'refine').node,id:'final-1'},
   {...proposal('MEMORY.WRITE',{contentSource:{from:'task',field:'prompt'}},[],'refine').node,id:'write-refine'},
   {...proposal('INFER.REASONING.REFLECT',{mode:'verify',criteria:['Check arithmetic'],generation:{temperature:0,maxTokens:128}},dependencies,'refine').node,id:'reflect-1'}];
  const observed=await execute(fixturePlan(nodes),task,input=>input.metadata?.nodeId==='reflect-1'?JSON.stringify({assessment:{passed:true,summary:'correct'},issues:[]}):input.metadata?.nodeId==='final-1'?'FINAL_ANSWER':'CapabilityASE_ANSWER');
  const reflectCall=observed.calls.find(call=>call.metadata?.nodeId==='reflect-1')!;const payload=JSON.parse(reflectCall.messages[1]!.content as string);assert.equal(payload.target.result.content,'FINAL_ANSWER');assert.equal(observed.result.answer,'FINAL_ANSWER');assert.equal(observed.result.checkerAudits?.[0]?.targetNodeId,'final-1');assert.match(JSON.stringify(payload.context),/12 bags/);
 }
});
function fixturePlan(nodes:readonly CapabilityNode[]):CapabilityPlan {const base=createBaseline('math');const graphs=GRAPH_ORDER.map(id=>({id,nodeIds:nodes.filter(n=>n.graphId===id).map(n=>n.id)})).filter(g=>g.nodeIds.length);return {...base,id:'mixed-evidence-fixture',nodes,graphs,outputNodeId:nodes.at(-1)!.id,loop:{...base.loop,transitions:Object.fromEntries(graphs.map((g,i)=>[g.id,graphs[i+1]?{kind:'next',graphId:graphs[i+1]!.id}:{kind:'end'}]))}};}
test('DELIBERATE receives only two local solver candidates even with actual tool evidence among dependencies',async()=>{
 for(const deps of [['sample-1','act-1','sample-2'],['act-1','sample-1','sample-2']]){
  const base=createBaseline('math');const act={...toolPlan().nodes.find(n=>n.id==='act-1')!,graphId:'solve' as const};
  const nodes:CapabilityNode[]=[...base.nodes,{...proposal('INFER.REASONING.SAMPLE',{role:'solver',instruction:'Independent solve.',generation:{temperature:0,maxTokens:128}},['sample-1'],'solve').node,id:'sample-2'},act,{...proposal('INFER.REASONING.DELIBERATE',{mode:'select',generation:{temperature:0,maxTokens:128}},deps,'solve').node,id:'deliberate-1'}];
  const observed=await execute(fixturePlan(nodes),task,input=>input.metadata?.nodeId==='deliberate-1'?JSON.stringify({selectedCandidateIds:['sample-2'],result:{role:'assistant',content:'SELECTED'},rationale:'consistent'}):input.metadata?.nodeId==='sample-2'?'SECOND':'FIRST');
  const request=observed.calls.find(call=>call.metadata?.nodeId==='deliberate-1')!;const payload=JSON.parse(request.messages[1]!.content as string);assert.deepEqual(payload.candidates.map((candidate:any)=>candidate.id),['sample-1','sample-2']);assert.match(JSON.stringify(payload.context),/96/);assert.equal(observed.result.answer,'SECOND');assert.equal(observed.result.executedNodeIds.includes('act-1'),true);
 }
});
test('declared tool parameter failure is a completed zero retaining real receipt and does not invoke solver',async()=>{
 const plan=extendPlan(createBaseline('math'),proposal('INTERACTION.ACT.TOOL',{tool:'bounded_arithmetic',arguments:{tokens:[{from:'literal',value:'1 / 0'}]}}),'act-bad');
 const observed=await execute(plan);assert.equal(observed.result.answer,'');assert.equal(observed.calls.length,0);assert.equal(observed.result.candidateFailure?.kind,'tool');assert.equal((observed.result.nodeOutputs?.['act-bad'] as any).status,'failed');assert.match(observed.result.candidateFailure!.code,/B_TOOL_INPUT|B_TOOL_LIMIT/);
});
test('binding failure after an actual solver preserves incurred usage and partial node evidence',async()=>{
 let plan=extendPlan(createBaseline('math'),proposal('INFER.REASONING.SAMPLE',{role:'finalizer',instruction:'Keep answer.',generation:{temperature:0,maxTokens:128}},[],'refine'),'final-1');
 plan=extendPlan(plan,proposal('INTERACTION.ACT.TOOL',{tool:'bounded_arithmetic',arguments:{tokens:[{from:'task',field:'prompt',extract:{kind:'decimal-number',index:999}}]}},['sample-1'],'solve'),'act-missing');
 const observed=await execute(plan);assert.equal(observed.result.answer,'');assert.equal(observed.result.candidateFailure?.kind,'binding');assert.equal(observed.calls.length,1);assert.equal(observed.result.totalTokens,3);assert.ok(observed.result.nodeOutputs?.['sample-1']);assert.equal(observed.result.executedNodeIds.includes('act-missing'),false);
});
test('old evolved SAMPLE and REFLECT request/checker behavior remains exactly historical with no B evidence',async()=>{
 let plan=extendPlan(createBaseline('gsm8k'),proposal('INFER.REASONING.SAMPLE',{role:'solver',instruction:'Check arithmetic.',generation:{temperature:0,maxTokens:128}},['sample-1'],'solve'),'sample-2');
 plan=extendPlan(plan,proposal('INFER.REASONING.REFLECT',{mode:'verify',criteria:['Check arithmetic.'],generation:{temperature:0,maxTokens:128}},[],'refine'),'reflect-1');
 const respond=(input:Parameters<ModelProvider['invoke']>[0])=>input.metadata?.nodeId==='reflect-1'?JSON.stringify({assessment:{passed:true,summary:'correct'},issues:[]}):'96';
 const actual=await execute(plan,{...task,dataset:'gsm8k'},respond);const calls:unknown[]=[];const runtime=createDitto({workers:[createContextWorker(),createInferWorker({defaultProvider:'fixture',providers:{fixture:{async invoke(input){calls.push(structuredClone(input));return {message:{role:'assistant',content:respond(input)},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};}}}})]});
 try{const historical=await new WorkflowExecutor(runtime,'fixture','fixture').run(plan as any,{...task,dataset:'gsm8k'});assert.deepEqual(actual.calls,calls);assert.deepEqual(actual.result.checkerAudits,historical.checkerAudits);assert.equal(actual.result.answer,historical.answer);}finally{await runtime.close();}
});
