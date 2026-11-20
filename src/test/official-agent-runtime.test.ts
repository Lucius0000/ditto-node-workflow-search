import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentDefinition} from '@codesoul-co/ditto/runtime';
import type {BenchmarkTask} from '../domain.js';
import {runOfficialAgent,OfficialAgentContractError} from '../official-agent/executor.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {withWorkflowTimeBudget} from '../execution/time-budget.js';
import {NODE_SYSTEM_PROMPT} from '../graph-agent/system.js';
import {bfclScope} from '../benchmark/bfcl.js';

const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:2,timeoutMs:3000};
const task:BenchmarkTask={id:'official-public-fixture',dataset:'drop',prompt:'Passage: Team A scored 21, then scored another 21.\nQuestion: How many total?',outputInstruction:'Return only the numeric answer.',metadata:{}};
const ref=(path:string)=>({$ref:path});
const messages=()=>({$op:'concat',args:[ref('input.host.messages'),[{role:'user',content:'Return the requested final answer.'}]]});
const solve=(id='solve',dependsOn:string[]=[])=>({id,type:'INFER.REASONING.SAMPLE',dependsOn,input:{messages:messages(),model:ref('input.host.model'),generation:ref('input.host.generation')}});
const base=():any=>({version:1,id:'official-fixture',graphs:{main:{nodes:[solve()],output:ref('nodes.solve.output.message.content')}}});
async function execute(definition:AgentDefinition,respond:(input:any,index:number)=>any=()=>({message:{role:'assistant',content:'42'},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}})){
 const calls:any[]=[];
 const shared=createExperimentRuntime(settings,{provider:{async invoke(input){calls.push(structuredClone(input));return respond(input,calls.length);}}});
 try{return{result:await withWorkflowTimeBudget({requestMs:3000,workflowMs:5000},()=>runOfficialAgent(definition,task,shared,settings)),calls};}finally{await shared.close();}
}

test('official compiler executes a native SAMPLE with host messages and real usage accounting',async()=>{
 const {result,calls}=await execute(base());
 assert.equal(result.answer,'42');assert.equal(result.totalTokens,3);assert.deepEqual(result.executedNodeIds,['main/solve']);
 assert.equal(calls[0].messages.find((m:any)=>m.role==='system').content,NODE_SYSTEM_PROMPT);
 assert.match(JSON.stringify(calls[0].messages),/Team A scored 21/);assert.match(JSON.stringify(calls[0].messages),/Task output requirements/);
 assert.equal(result.sourceMap.main!.solve!.nodeId,'solve');assert.equal(result.rawNodeOutputs['main/solve'].output.message.content,'42');
});

test('host rejects provider-incompatible message content with a public field path before any paid call',async()=>{
 for(const content of [['plain string array'],{unexpected:'JSON object'},42]){
  const definition=base();definition.graphs.main.nodes[0].input.messages={$op:'concat',args:[ref('input.host.messages'),[{role:'user',content}]]};
  let calls=0;
  await assert.rejects(execute(definition,()=>{calls++;throw Error('Provider must not be called');}),(error:any)=>error instanceof OfficialAgentContractError&&/\/input\/messages\/2\/content/.test(error.publicIssue.path)&&/HOST.DATA.TRANSFORM/.test(error.publicMessage));
  assert.equal(calls,0);
 }
 const definition=base();definition.graphs.main.nodes[0].input.messages={$op:'concat',args:[ref('input.host.messages'),[{role:'user',content:[{type:'text',text:'Public evidence'}]}]]};
 const {result,calls}=await execute(definition);assert.equal(result.answer,'42');assert.equal(calls.length,1);
 assert.deepEqual(calls[0].messages[2].content,[{type:'text',text:'Public evidence'}]);
});

test('optional first-task presentation happens once per attempt and final contract follows user strategy',async()=>{
 const definition=base();definition.config={firstTaskRepeat:true};definition.graphs.main.nodes[0].input.messages={$op:'concat',args:[ref('input.host.messages'),[{role:'user',content:'An editable user strategy.'}]]};
 definition.loop={entry:'again',maxIterations:2,state:{round:0,result:''},steps:{again:{graph:'main',input:ref('input'),assign:{round:{$op:'add',args:[ref('state.round'),1]},result:ref('result')},transitions:[{when:{$op:'gte',args:[ref('state.round'),2]},end:'completed'},{next:'again'}]}},output:ref('state.result')};
 const {calls}=await execute(definition);
 const originalCount=(call:any)=>call.messages.filter((m:any)=>m.role==='user'&&m.content.startsWith('Original task:')).length;
 assert.deepEqual(calls.map(originalCount),[2,1]);
 for(const call of calls){assert.equal(call.messages.filter((m:any)=>m.role==='system').length,1);assert.match(call.messages.at(-1).content,/Fixed public task output requirements/);}
});

test('official Subgraph expansion and Loop repeats keep distinct actual invocation traces',async()=>{
 const definition:any={version:1,id:'official-repeated-subgraph',graphs:{
  main:{nodes:[{id:'solver',kind:'subgraph',graph:'answer',input:ref('input')}],output:ref('nodes.solver')},
  answer:{nodes:[solve()],output:ref('nodes.solve.output.message.content')},
 },loop:{entry:'repeat',maxIterations:2,state:{round:0,answer:null},steps:{repeat:{graph:'main',input:ref('input'),assign:{round:{$op:'add',args:[ref('state.round'),1]},answer:ref('result')},transitions:[{when:{$op:'gte',args:[ref('state.round'),2]},end:'completed'},{next:'repeat'}]}},output:ref('state.answer')}};
 const {result,calls}=await execute(definition,(_input,index)=>({message:{role:'assistant',content:String(index*21)},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}}));
 assert.equal(result.answer,'42');assert.equal(calls.length,2);assert.equal(result.totalTokens,6);
 assert.deepEqual(result.executedNodeIds,['main/solver/solve','main/solver/solve']);assert.deepEqual(result.executedGraphIds,['main','main']);
 assert.equal(result.sourceMap.main!['solver/solve']!.graphId,'answer');assert.equal(result.state.round,2);
});

test('host policy rejects dynamic system, model and dropped-task mutations before a provider call',async()=>{
 for(const change of [
  (d:any)=>{d.graphs.main.nodes[0].input.messages=[{role:'system',content:'Unfrozen system'},ref('input.host.originalTaskMessage')];},
  (d:any)=>{d.graphs.main.nodes[0].input.model={provider:'deepseek',model:'another-model'};},
  (d:any)=>{d.graphs.main.nodes[0].input.messages=[{role:'system',content:ref('input.host.system')},{role:'user',content:'Replacement task'}];},
 ]){
  const definition=base();change(definition);let calls=0;
  await assert.rejects(execute(definition,()=>{calls++;throw Error('Unexpected provider call');}),(error:any)=>error instanceof OfficialAgentContractError&&typeof error.publicIssue.path==='string');assert.equal(calls,0);
 }
});

test('native task-local Memory write/search is consumed without global output unwrapping',async()=>{
 const definition=base(),node=definition.graphs.main.nodes[0];node.dependsOn=['recall'];node.input.messages={$op:'concat',args:[ref('input.host.messages'),[{role:'user',content:ref('nodes.evidence')}]]};node.dependsOn=['evidence'];
 definition.graphs.main.nodes.unshift(
  {id:'remember',type:'MEMORY.WRITE',input:{memories:[{key:'passage',content:ref('input.task.prompt')}]}},
  {id:'recall',type:'MEMORY.SEARCH',dependsOn:['remember'],input:{query:ref('input.task.prompt'),limit:1}},
  {id:'evidence',type:'HOST.DATA.TRANSFORM',dependsOn:['recall'],input:{operation:'evidence',value:ref('nodes.recall.output')}},
 );
 const {result,calls}=await execute(definition);assert.equal(result.answer,'42');assert.match(JSON.stringify(calls[0].messages),/Team A scored 21/);
 assert.match(JSON.stringify(calls[0].messages),/Artifact provenance/);assert.match(JSON.stringify(calls[0].messages),/HOST.DATA.TRANSFORM/);
 assert(Array.isArray(result.rawNodeOutputs['main/remember'].output));assert(Array.isArray(result.rawNodeOutputs['main/recall'].output));
});

test('declared malformed model JSON stays a quality failure, while host binding errors stay engineering failures',async()=>{
 const definition=base();definition.graphs.main.nodes.push({id:'parsed',type:'HOST.DATA.TRANSFORM',dependsOn:['solve'],input:{operation:'parse',sourceKind:'model-json',value:ref('nodes.solve.output.message.content')}});definition.graphs.main.output=ref('nodes.parsed.answer');
 const {result}=await execute(definition,()=>({message:{role:'assistant',content:'not JSON'},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}}));
 assert.equal(result.answer,'');assert.equal(result.modelFailure?.kind,'model-output');assert.equal(result.totalTokens,3);
 const wrong=base();wrong.graphs.main.output=ref('nodes.solve.missing');
 await assert.rejects(execute(wrong),(error:any)=>error instanceof OfficialAgentContractError&&(error as any).partialRun?.modelResponses.length===1);
});

test('provider errors preserve their original infrastructure identity and partial native evidence',async()=>{
 await assert.rejects(execute(base(),()=>{throw Object.assign(new Error('Injected provider quota failure'),{code:'SEARCH_DIRECTION_BUDGET'});}),(error:any)=>error.code==='SEARCH_DIRECTION_BUDGET'&&error.infrastructureFailure===true&&error.partialRun!==undefined);
});

test('ordinary registered tool errors remain actual observations for a following solver',async()=>{
 const definition=base(),solver=definition.graphs.main.nodes[0];
 definition.graphs.main.nodes.unshift({id:'arith',type:'INTERACTION.ACT.TOOL',input:{call:{id:'bad-expression',name:'bounded_arithmetic',arguments:{expression:'not arithmetic'}}}},
  {id:'observation',type:'INTERACTION.OBSERVE',dependsOn:['arith'],input:{result:ref('nodes.arith')}},
  {id:'evidence',type:'HOST.DATA.TRANSFORM',dependsOn:['observation'],input:{operation:'json',value:ref('nodes.observation')}});
 solver.dependsOn=['evidence'];solver.input.messages={$op:'concat',args:[ref('input.host.messages'),[{role:'user',content:ref('nodes.evidence')}]]};
 const {result,calls}=await execute(definition);assert.equal(result.answer,'42');assert.equal(result.rawNodeOutputs['main/arith'].status,'failed');assert.match(JSON.stringify(calls[0].messages),/unsupported characters/);
});

test('official-world infrastructure failures cannot become normal tool observations or quality zero',async()=>{
 const definition:any={version:1,id:'world-fault',graphs:{main:{nodes:[{id:'state',type:'INTERACTION.ACT.TOOL',input:{call:{id:'read',name:'bfcl_state',arguments:{}}}}],output:'unused'}}};
 const failure=Object.assign(new Error('Official bridge disconnected'),{code:'OFFICIAL_WORLD_DISCONNECTED'});let failed=false;
 const fakeWorld:any={tools:[{name:'bfcl_state',description:'Current public state',inputSchema:{type:'object',properties:{}}}],assertHealthy(){if(failed)throw failure;},async call(){failed=true;throw failure;}};
 const shared=createExperimentRuntime(settings,{provider:{async invoke(){throw Error('No model call expected');}}});
 try{await assert.rejects(bfclScope.run(fakeWorld,()=>runOfficialAgent(definition,{...task,dataset:'bfcl'},shared,settings)),(error:any)=>error===failure&&error.infrastructureFailure&&error.partialRun!==undefined);}finally{await shared.close();}
});

test('REFLECT preserves a known correct target on passed no-change without inventing an answer',async()=>{
 const definition=base();definition.graphs.main.nodes.push({id:'check',type:'INFER.REASONING.REFLECT',dependsOn:['solve'],input:{messages:messages(),model:ref('input.host.model'),generation:ref('input.host.generation'),target:{result:ref('nodes.solve.output.message')},mode:'revise',criteria:[{id:'correctness',description:'Check the arithmetic against the original passage.',weight:1}]}});definition.graphs.main.output=ref('nodes.check.output.message.content');
 const {result}=await execute(definition,request=>({message:{role:'assistant',content:request.metadata.nodeType==='INFER.REASONING.REFLECT'?JSON.stringify({assessment:{passed:true,summary:'Correct'},issues:[]}):'42'},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}}));
 assert.equal(result.answer,'42');assert.equal(result.checkerAudits?.[0]?.decision,'preserved-passed-or-no-error');assert.equal(result.reflectionResponses[0]?.preservedKnownTarget,true);
});


test('BFCL baseline supplies one structured observation and executes call, respond and completed transitions',async()=>{
 const {officialBaseline}=await import('../official-agent/baselines.js');
 const definition=officialBaseline('bfcl');let complete=false;const actions:string[]=[];const seen:any[]=[];
 const state=()=>({turn:0,complete,history:[{role:'user',content:'Add 20 and 22.'}],functions:[{name:'add',description:'Compute sum',parameters:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}}}}]});
 const fakeWorld:any={tools:['bfcl_state','bfcl_call','bfcl_respond'].map(name=>({name,description:name,inputSchema:{type:'object',additionalProperties:true}})),assertHealthy(){},async call(name:string,args:any){actions.push(name);if(name==='bfcl_respond'){complete=true;return state();}if(name==='bfcl_call'){assert.deepEqual(args.calls,[{name:'add',arguments:{a:20,b:22}}]);return{turn:0,observations:['42'],complete:false};}return state();}};
 const decisions=[{done:false,tool:'bfcl_call',arguments:{turn:0,calls:[{name:'add',arguments:{a:20,b:22}}]}},{done:false,tool:'bfcl_respond',arguments:{turn:0,message:'42'}},{done:true,tool:'',arguments:{}}];
 const shared=createExperimentRuntime(settings,{provider:{async invoke(input){seen.push(input);return{message:{role:'assistant',content:JSON.stringify(decisions[seen.length-1])},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};}}});
 try{const result=await bfclScope.run(fakeWorld,()=>runOfficialAgent(definition,{...task,dataset:'bfcl'},shared,settings));assert.equal(result.modelFailure,undefined);assert.deepEqual(actions,['bfcl_state','bfcl_call','bfcl_respond']);assert.equal(seen.length,2);assert(!result.executionBudget);assert.equal(JSON.stringify(seen[0].messages).split('Compute sum').length-1,1);assert.match(JSON.stringify(seen[1].messages),/42/);}finally{await shared.close();}
});


test('BFCL missing capability reply reveals new tools without automatic business calls and keeps public evidence once',async()=>{
 const {officialBaseline}=await import('../official-agent/baselines.js');
 const {transformOfficialData}=await import('../official-agent/helpers.js');
 let turn=0;let complete=false;const seen:any[]=[];const actions:string[]=[];
 const state=()=>({turn,complete,history:[{role:'user',content:'PUBLIC_REQUEST'},...(turn?[{role:'assistant',content:'Cannot run it without the function.'},{role:'user',content:'NEW_PUBLIC_FUNCTION'}]:[])],functions:[{name:'status',description:'INITIAL_SCHEMA'},...(turn?[{name:'perform',description:'ADDED_SCHEMA'}]:[])]});
 const fakeWorld:any={tools:['bfcl_state','bfcl_call','bfcl_respond'].map(name=>({name,description:name,inputSchema:{type:'object',additionalProperties:true}})),assertHealthy(){},async call(name:string,args:any){actions.push(name);if(name==='bfcl_respond'){assert.equal(args.turn,turn);turn++;complete=turn===2;return state();}if(name==='bfcl_call'){assert.equal(turn,1);assert.equal(args.calls[0].name,'perform');return{turn,complete:false,observations:['ACTUAL_SUCCESS']};}return state();}};
 const decisions=[{done:false,tool:'bfcl_respond',arguments:{turn:0,message:'Cannot run it without the function.'}},{done:false,tool:'bfcl_call',arguments:{turn:1,calls:[{name:'perform',arguments:{}}]}},{done:false,tool:'bfcl_respond',arguments:{turn:1,message:'Done based on ACTUAL_SUCCESS'}},{done:true,tool:'',arguments:{}}];
 const shared=createExperimentRuntime(settings,{provider:{async invoke(input){seen.push(input);return{message:{role:'assistant',content:JSON.stringify(decisions[seen.length-1])},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};}}});
 try{const definition=officialBaseline('bfcl');const result=await bfclScope.run(fakeWorld,()=>runOfficialAgent(definition,{...task,dataset:'bfcl'},shared,settings));assert.equal(result.modelFailure,undefined);assert.deepEqual(actions,['bfcl_state','bfcl_respond','bfcl_call','bfcl_respond']);assert.doesNotMatch(JSON.stringify(seen[0].messages),/ADDED_SCHEMA/);assert.match(JSON.stringify(seen[1].messages),/ADDED_SCHEMA/);assert.equal(JSON.stringify(seen[1].messages).split('INITIAL_SCHEMA').length-1,1);assert.equal(JSON.stringify(seen[1].messages).split('PUBLIC_REQUEST').length-1,1);assert.match(JSON.stringify(seen[2].messages),/ACTUAL_SUCCESS/);assert.match(JSON.stringify(seen[0].messages),/Calling bfcl_state does not advance/);}finally{await shared.close();}
 const first=transformOfficialData({operation:'bfcl-history',value:{error:'Stale turn'},evidence:'ERROR_EVIDENCE',history:[]}).history;
 const next=transformOfficialData({operation:'bfcl-history',value:{turn:1,history:[],functions:[]},evidence:'FULL_SNAPSHOT',history:[...first,{role:'user',content:'OLD_SNAPSHOT'}]}).history;
 assert.match(next[0].content,/ERROR_EVIDENCE/);assert.match(next[1].content,/FULL_SNAPSHOT/);assert.equal(next.length,2);
 const read=transformOfficialData({operation:'bfcl-history',tool:'bfcl_state',value:{turn:1,history:[],functions:[]},evidence:'FULL_SNAPSHOT',history:next}).history;
 const repeated=transformOfficialData({operation:'bfcl-history',tool:'bfcl_state',value:{turn:1,history:[],functions:[]},evidence:'FULL_SNAPSHOT',history:read}).history;assert.match(repeated.at(-1).content,/unchanged public state: 2/);assert.equal(repeated.length,2);
});


test('official BFCL forced completion ends the loop before another model request',async()=>{
 const {officialBaseline}=await import('../official-agent/baselines.js');let calls=0;let actions=0;
 const fakeWorld:any={tools:['bfcl_state','bfcl_call','bfcl_respond'].map(name=>({name,description:name,inputSchema:{type:'object',additionalProperties:true}})),assertHealthy(){},async call(name:string){actions++;return name==='bfcl_state'?{turn:0,complete:false,history:[],functions:[]}:{turn:0,observations:['official step limit reached'],complete:true,forced:true};}};
 const shared=createExperimentRuntime(settings,{provider:{async invoke(){calls++;assert.equal(calls,1,'No paid request after official completion');return{message:{role:'assistant',content:JSON.stringify({done:false,tool:'bfcl_call',arguments:{turn:0,calls:[{name:'available',arguments:{}}]}})},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};}}});
 try{const result=await bfclScope.run(fakeWorld,()=>runOfficialAgent(officialBaseline('bfcl'),{...task,dataset:'bfcl'},shared,settings));assert.equal(actions,2);assert.equal(calls,1);assert.equal(result.executionBudget,undefined);assert.equal(result.rawNodeOutputs['action/observe'].structuredContent.forced,true);}finally{await shared.close();}
});

test('BFCL next decisions retain executed function arguments, raw None and errors through snapshot replacement',async()=>{
 const {officialBaseline}=await import('../official-agent/baselines.js');
 const actions:string[]=[];const publicHistory:any[]=[{role:'user',content:'Write the requested report.'}];let complete=false;let requests=0;
 const write={done:false,tool:'bfcl_call',arguments:{turn:0,calls:[{name:'echo',arguments:{file_name:'report.txt',content:'exact-public-content'}}]}};
 const failed={done:false,tool:'bfcl_call',arguments:{turn:0,calls:[{name:'read_report',arguments:{file_name:'unavailable.txt'}}]}};
 const decisions=[write,failed,{done:false,tool:'bfcl_state',arguments:{}},{done:false,tool:'bfcl_respond',arguments:{turn:0,message:'The write returned None; the other read was unavailable.'}}];
 const state=()=>({turn:0,complete,history:structuredClone(publicHistory),functions:[{name:'echo',description:'Write report; may return no value.'},{name:'read_report',description:'Read a report.'}]});
 const fakeWorld:any={tools:['bfcl_state','bfcl_call','bfcl_respond'].map(name=>({name,description:name,inputSchema:{type:'object',additionalProperties:true}})),assertHealthy(){},async call(name:string,args:any){
  actions.push(name);
  if(name==='bfcl_respond'){complete=true;return state();}
  if(name==='bfcl_state')return state();
  if(args.calls[0].name==='echo'){assert.deepEqual(args,write.arguments);publicHistory.push({role:'assistant',calls:args.calls},{role:'tool',name:'echo',content:'None'});return{turn:0,complete:false,observations:['None']};}
  assert.deepEqual(args,failed.arguments);return{turn:0,error:'Requested report is unavailable'};
 }};
 const shared=createExperimentRuntime(settings,{provider:{async invoke(input){
  const step=requests++;assert(step<decisions.length,'Official completion needs no further model request');
  const messages=input.messages as any[];
  if(step===1){const index=messages.findIndex(m=>m.role==='assistant');assert(index>=0);assert.deepEqual(JSON.parse(messages[index].content),write);assert.match(messages[index+1].content,/"observations":\["None"\]/);assert.match(messages[index+1].content,/proves neither failure nor successful completion/);}
  if(step===2||step===3){const index=messages.findIndex(m=>m.role==='assistant'&&JSON.parse(m.content).arguments.calls?.[0]?.name==='read_report');assert(index>=0);assert.deepEqual(JSON.parse(messages[index].content),failed);assert.match(messages[index+1].content,/Requested report is unavailable/);}
  return{message:{role:'assistant',content:JSON.stringify(decisions[step])},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};
 }}});
 try{const result=await bfclScope.run(fakeWorld,()=>runOfficialAgent(officialBaseline('bfcl'),{...task,dataset:'bfcl'},shared,settings));assert.equal(result.modelFailure,undefined);assert.equal(requests,4);assert.deepEqual(actions,['bfcl_state','bfcl_call','bfcl_call','bfcl_state','bfcl_respond']);assert.equal(result.executionBudget,undefined);}finally{await shared.close();}
});

test('BFCL identical business-call feedback records every actual action and distinguishes arguments and results',async()=>{
 const {transformOfficialData}=await import('../official-agent/helpers.js');
 const decision={done:false,tool:'bfcl_call',arguments:{turn:0,calls:[{name:'echo',arguments:{file_name:'report.txt',content:'A'}}]}};
 let history:any[]=[];
 const append=(d:any,value:any)=>{const result=transformOfficialData({operation:'bfcl-history',tool:d.tool,decision:d,value,evidence:JSON.stringify(value),history});history=result.history;return result;};
 for(let count=1;count<=3;count++){append(decision,{turn:0,complete:false,observations:['None']});assert.equal(history.at(-1).metadata.bfclObservation.identicalExecutions,count);}
 assert.equal(history.filter(m=>m.role==='assistant').length,3);
 for(const message of history.filter(m=>m.role==='assistant'))assert.deepEqual(JSON.parse(message.content),decision);
 assert.match(history.at(-1).content,/same returned observation: 3/);assert.match(history.at(-1).content,/real executions, not cached/);assert.match(history.at(-1).content,/"None"/);
 const different=structuredClone(decision);different.arguments.calls[0]!.arguments.content='B';append(different,{turn:0,complete:false,observations:['None']});assert.equal(history.at(-1).metadata.bfclObservation.identicalExecutions,1);
 append(different,{turn:0,complete:false,observations:['Changed observation']});assert.equal(history.at(-1).metadata.bfclObservation.identicalExecutions,1);
 assert.throws(()=>transformOfficialData({operation:'bfcl-history',tool:'bfcl_respond',decision,value:{turn:0,complete:false},evidence:'actual',history}),/BFCL history decision/);
});

test('Automation Loop preserves actual endpoint arguments paired with errors and observations before the next decision',async()=>{
 const {officialBaseline}=await import('../official-agent/baselines.js');const {automationScope}=await import('../benchmark/automation.js');
 const decisions=[{done:false,tool:'api_fetch',arguments:{method:'GET',url:'https://service.invalid/wrong',params:null,body:null}},{done:false,tool:'api_search',arguments:{query:'create record',top_k:1}},{done:false,tool:'api_fetch',arguments:{method:'POST',url:'https://service.invalid/records',params:null,body:'{"Name":"PublicName"}'}},{done:true,tool:'',arguments:{},finalAnswer:'Created the record returned as rec-public.'}];
 const bodies=['{"error":"Endpoint unavailable","complete":true}','{"results":[{"url":"https://service.invalid/records","method":"POST"}]}','{"id":"rec-public","complete":true}'];
 const invoked:any[]=[];let requests=0;
 const fakeWorld:any={tools:['api_search','api_fetch','base64_encode'].map(name=>({name,description:name,inputSchema:{type:'object',additionalProperties:true}})),assertHealthy(){},record(){},async call(name:string,args:any){const index=invoked.length;invoked.push({tool:name,arguments:args});assert.deepEqual(invoked[index],{tool:decisions[index]!.tool,arguments:decisions[index]!.arguments});return{content:bodies[index]};}};
 const shared=createExperimentRuntime(settings,{provider:{async invoke(input){
  const step=requests++;assert(step<decisions.length,'No unrequested extra model call');const messages=input.messages as any[];
  const recorded=messages.filter(m=>m.role==='assistant');assert.equal(recorded.length,step);
  for(let index=0;index<recorded.length;index++){const expected=decisions[index]!;assert.deepEqual(JSON.parse(recorded[index].content),{done:false,tool:expected.tool,arguments:expected.arguments});const position=messages.indexOf(recorded[index]);const evidence=messages[position+1];assert.equal(evidence.role,'user');assert.match(evidence.content,/Evidence supplied by declared upstream nodes/);assert(evidence.content.includes(JSON.stringify(bodies[index])),'Exact raw tool response stays paired with its originating endpoint and arguments');}
  return{message:{role:'assistant',content:JSON.stringify(decisions[step])},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};
 }}});
 try{const result=await automationScope.run(fakeWorld,()=>runOfficialAgent(officialBaseline('automationbench'),{...task,dataset:'automationbench',prompt:'Discover the API and create the requested public record.',outputInstruction:'Use the official tools.'},shared,settings));assert.equal(result.modelFailure,undefined);assert.equal(result.executionBudget,undefined);assert.equal(result.answer,decisions[3]!.finalAnswer);assert.equal(requests,4,'Business complete fields must not be used as official conversation termination');assert.equal(invoked.length,3);assert.equal(result.rawNodeOutputs['action/history'].complete,false);}finally{await shared.close();}
});

test('generic tool history preserves native failure evidence without inferring completion',async()=>{
 const {transformOfficialData}=await import('../official-agent/helpers.js');
 const decision={done:false,tool:'api_fetch',arguments:{url:'https://service.invalid/wrong',method:'GET'}};
 const observation={source:'api_fetch',callId:'public-call',status:'failed',message:{role:'tool',content:'failed: TOOL_INPUT: Bad parameters'},error:{code:'TOOL_INPUT',message:'Bad parameters'},structuredContent:{complete:true}};
 const args={operation:'tool-history',tool:'api_fetch',decision,value:observation,evidence:JSON.stringify(observation),history:[{role:'user',content:'existing public input'}]};
 const result=transformOfficialData(args);assert.equal(result.complete,false);assert.equal(result.history.length,3);assert.deepEqual(JSON.parse(result.history[1].content),decision);assert.equal(result.history[2].content,JSON.stringify(observation));assert.equal(args.history.length,1);
 assert.throws(()=>transformOfficialData({...args,tool:'api_search'}),/Tool history requires native observation/);
 assert.throws(()=>transformOfficialData({...args,decision:{...decision,done:true}}),/Tool history decision/);
});
test('BFCL accepts complete single-call DSML under its published interface',async()=>{
 const {decodeBfclDsml}=await import('../official-agent/decision-protocol.js');
 const dsml=(tool:string,args:unknown)=>[
  '<｜｜DSML｜｜ calls>',`<｜｜DSML｜｜ invoke name="${tool}">`,
  `<｜｜DSML｜｜ parameter name="arguments" string="false">${JSON.stringify(args)}</｜｜DSML｜｜ parameter>`,
  '</｜｜DSML｜｜ invoke>','</｜｜DSML｜｜ calls>',
 ].join('\n');
 const args={turn:1,calls:[{name:'read_status',arguments:{id:'public'}}]};
 assert.deepEqual(decodeBfclDsml(dsml('bfcl_call',args))?.arguments,args);
 assert.equal(decodeBfclDsml('{"done":true,"tool":"","arguments":{}}'),undefined);
 assert.throws(()=>decodeBfclDsml(dsml('bfcl_call',args).replace('</｜｜DSML｜｜ calls>','</tool_response>')),/Unrecognized/);
 assert.throws(()=>decodeBfclDsml(dsml('bfcl_call',{turn:1,calls:[]})),/public BFCL interface/);
 assert.throws(()=>decodeBfclDsml(dsml('outside_scope',args)),/permitted official tool/);
 assert.throws(()=>decodeBfclDsml(dsml('bfcl_call',args).replace('</｜｜DSML｜｜ calls>',dsml('bfcl_call',args))),/one complete/);
});

test('BFCL DSML reaches the native tool and the next decision sees its real observation',async()=>{
 const {officialBaseline}=await import('../official-agent/baselines.js');
 const executed:string[]=[];
 const fakeWorld:any={tools:['bfcl_state','bfcl_call','bfcl_respond'].map(name=>({name,inputSchema:{type:'object',additionalProperties:true}})),assertHealthy(){},
  async call(name:string){executed.push(name);return name==='bfcl_call'?{turn:0,observations:['STATUS_FROM_WORLD'],complete:false}:{turn:0,history:[],functions:[],complete:name==='bfcl_respond'};}};
 const dsml=['<｜｜DSML｜｜ calls>','<｜｜DSML｜｜ invoke name="bfcl_call">',
  '<｜｜DSML｜｜ parameter name="arguments" string="false">{"turn":0,"calls":[{"name":"read_status","arguments":{}}]}</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>','</｜｜DSML｜｜ calls>'].join('\n');
 let requests=0;
 const shared=createExperimentRuntime(settings,{provider:{async invoke(input){
  if(requests++)assert.match(JSON.stringify(input.messages),/STATUS_FROM_WORLD/);
  const content=requests===1?dsml:'{"done":false,"tool":"bfcl_respond","arguments":{"turn":0,"message":"Status confirmed"}}';
  return {message:{role:'assistant',content},finishReason:'stop',usage:{inputTokens:0,outputTokens:0,totalTokens:0}};
 }}});
 try{
  const result=await bfclScope.run(fakeWorld,()=>runOfficialAgent(officialBaseline('bfcl'),{...task,dataset:'bfcl'},shared,settings));
  assert.deepEqual(executed,['bfcl_state','bfcl_call','bfcl_respond']);
  assert.equal(result.modelFailure,undefined);
  assert.equal(requests,2);
 }finally{await shared.close();}
});
