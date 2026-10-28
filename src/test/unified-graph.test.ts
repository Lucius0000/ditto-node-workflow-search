import assert from 'node:assert/strict';
import test from 'node:test';
import {BASELINE_DEFINITION,validateDefinition,validateDefinitionChange,type GraphDefinition,type DefinitionNode} from '../graph-agent/schema.js';
import {runGraphAgent} from '../graph-agent/executor.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {withWorkflowTimeBudget} from '../execution/time-budget.js';
import {NODE_SYSTEM_PROMPT} from '../graph-agent/system.js';

const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:3,timeoutMs:3000};
const task={id:'unified-fixture',dataset:'math' as const,prompt:'Alice has 21 apples. Bob has 42 oranges.',outputInstruction:'Return a number.',metadata:{}};
const ref=(id:string,...path:(string|number)[])=>({ref:['nodes',id,...path]});
async function run(definition:GraphDefinition,content:any='42'){
 const calls:any[]=[];const shared=createExperimentRuntime(settings,{provider:{async invoke(input){calls.push(structuredClone(input));return{message:{role:'assistant',content:typeof content==='function'?content(calls.length):content},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};}}});
 try{return{result:await withWorkflowTimeBudget({requestMs:3000,workflowMs:5000},()=>runGraphAgent(definition,task,shared,settings)),calls};}finally{await shared.close();}
}
test('unified native output bindings preserve legal MessageParts and frozen system',async()=>{
 const d=structuredClone(BASELINE_DEFINITION);d.output={answer:ref('solve','message','content')};
 const a=await run(d,[{type:'text',text:'42'}]);assert.equal(a.result.answer,'42');assert.equal(a.result.finalPrediction,'42');assert.equal(a.calls[0].messages[0].content,NODE_SYSTEM_PROMPT);assert.deepEqual(a.result.modelResponses[0]?.rawContent,[{type:'text',text:'42'}]);
 d.graphs[0]!.nodes[1]!.config.instruction='Another reusable user strategy';const b=await run(d);assert.equal(b.calls[0].messages[0].content,NODE_SYSTEM_PROMPT);assert.match(JSON.stringify(b.calls[0].messages),/Another reusable user strategy/);
 const injected=structuredClone(d);injected.graphs[0]!.nodes[1]!.config.messages=[{role:'system',content:'override'}];assert.throws(()=>validateDefinition(injected),/Unknown field messages/);
});
test('real Retrieval Worker searches only the task-public target and supplies native candidates',async()=>{
 const d=structuredClone(BASELINE_DEFINITION);d.graphs[0]!.nodes.splice(1,0,{id:'retrieved',type:'RETRIEVAL.SEARCH',dependencies:[],config:{query:{literal:'oranges'},limit:1}});
 d.graphs[0]!.nodes[2]!.dependencies=['retrieved'];d.graphs[0]!.nodes[2]!.config.evidence=[ref('retrieved','candidates')];const {result,calls}=await run(d);
 assert.equal(result.rawNodeOutputs.retrieved.status,'success');assert.equal(result.rawNodeOutputs.retrieved.output.candidates.length,1);assert.match(JSON.stringify(calls[0].messages),/Bob has 42 oranges/);assert.equal(result.nodeInputs.retrieved.target.name,'task-public');
 d.graphs[0]!.nodes[1]!.config.target='other-task';assert.throws(()=>validateDefinition(d),/host-authorized/);
});
test('state updates are simultaneous and prior references have first-visit fallback',async()=>{
 const d=structuredClone(BASELINE_DEFINITION);d.loop.maxGraphRuns=3;d.loop.state={history:[]};d.graphs[0]!.nodes[1]!.config.user={coalesce:[{ref:['prior','solve','message','content']},{literal:'FIRST'}]};
 d.loop.stateUpdates={agent:{history:{append:[{ref:['state','history']},ref('solve','message','content')]}}};d.loop.transitions.agent={kind:'repeat',graphId:'agent',maxVisits:3,until:{left:{get:{value:{ref:['state','history']},path:['length']}},operator:'gte',right:{literal:2}}};
 const {result,calls}=await run(d,(n:number)=>String(n));assert.equal(result.answer,'2');assert.deepEqual(result.state.history,['1','2']);assert.match(JSON.stringify(calls[0].messages),/FIRST/);assert.match(JSON.stringify(calls[1].messages),/Additional user material|"content":"1"/);
});
test('one primary capability may add its required tool/observe/context chain',async()=>{
 const d=structuredClone(BASELINE_DEFINITION),nodes=d.graphs[0]!.nodes;
 const extra:DefinitionNode[]=[{id:'compute',type:'INTERACTION.ACT.TOOL',dependencies:[],config:{tool:'bounded_arithmetic',arguments:{expression:{literal:'21*2'}}}},{id:'observe',type:'INTERACTION.OBSERVE',dependencies:['compute'],config:{result:ref('compute')}},{id:'load-result',type:'CONTEXT.LOAD',dependencies:['observe'],config:{sources:[ref('observe','message')]}}];
 nodes.splice(1,0,...extra);nodes.at(-1)!.dependencies=['load-result'];nodes.at(-1)!.config.evidence=[ref('load-result','items')];d.mutation={primaryNodeId:'compute',auxiliary:[{nodeId:'observe',reason:'Normalize the tool observation'},{nodeId:'load-result',reason:'Load the actual observation as working context'}]};
 validateDefinitionChange(JSON.stringify(BASELINE_DEFINITION),JSON.stringify(d));const {result}=await run(d);assert.equal(result.answer,'42');assert(result.executedNodeIds.includes('observe'));
});
test('parallel unrelated solvers cannot masquerade as predecessor/successor companions',()=>{
 const d=structuredClone(BASELINE_DEFINITION);d.graphs[0]!.nodes.splice(1,0,...['first','second'].map(id=>({id,type:'INFER.REASONING.SAMPLE' as const,dependencies:['context'],config:{instruction:'Independent solve'}})));
 d.graphs[0]!.nodes.at(-1)!.dependencies=['first','second'];d.graphs[0]!.nodes.at(-1)!.config.evidence=[ref('first','message','content'),ref('second','message','content')];d.mutation={primaryNodeId:'first',auxiliary:[{nodeId:'second',reason:'An unrelated parallel solve'}]};
 assert.throws(()=>validateDefinitionChange(JSON.stringify(BASELINE_DEFINITION),JSON.stringify(d)),/predecessors or successors/);
});
test('only an explicit JSON output contract makes invalid model JSON a quality zero',async()=>{
 const d=structuredClone(BASELINE_DEFINITION);d.output={answer:{json:{parse:ref('solve','message','content')}}};
 await assert.rejects(run(d,'plain answer'),(e:any)=>e.code==='B_AGENT_CONTRACT'&&e.partialRun.modelResponses[0].rawContent==='plain answer');
 d.graphs[0]!.nodes[1]!.config.outputFormat='json';const {result}=await run(d,'not JSON');assert.equal(result.answer,'');assert.equal(result.modelFailure?.code,'MODEL_OUTPUT_FORMAT');assert.equal(result.candidateFailure,undefined);
});
test('wrong field conversion remains engineering-invalid with the original model evidence',async()=>{
 const d=structuredClone(BASELINE_DEFINITION);d.output={answer:ref('solve','message','missing')};await assert.rejects(run(d,'42'),(e:any)=>e.code==='B_AGENT_CONTRACT'&&e.partialRun.rawNodeOutputs.solve.output.message.content==='42'&&e.partialRun.modelFailure===undefined);
});
