import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {evaluateTasks} from '../benchmark/evaluator.js';
import type {BenchmarkTask,AgentRunResult} from '../domain.js';
import type {PrivateScorer} from '../benchmark/types.js';
import {AutomationBudget,automationBudgetScope,AutomationActorBudgetExceeded} from '../execution/automation-budget.js';
import {AutomationBudgetRecovery} from '../run/automation-budget-recovery.js';
import {createExperimentRuntime,applyModelProfile} from '../ditto/runtime.js';
import {runGraphAgent} from '../graph-agent/executor.js';
import {BASELINE_DEFINITION,validateDefinition,type GraphDefinition} from '../graph-agent/schema.js';
import {evaluateBinding,ModelOutputFormatError,MissingBindingPath} from '../graph-agent/bindings.js';
import {automationBaseline,validateAutomationDecision} from '../graph-agent/automation-baseline.js';
import {automationScope,type AutomationSession} from '../benchmark/automation.js';

const task:BenchmarkTask={id:'automationbench:offline',dataset:'automationbench',prompt:'Public task',outputInstruction:'',metadata:{}};
const result:AgentRunResult={answer:'original prediction',executedNodeIds:[],executedGraphIds:[],inputTokens:10,outputTokens:3,totalTokens:13};
const label=()=> 'private';

test('provider finish_reason=error remains an infrastructure failure and can recover without becoming a quality zero',async()=>{
 let calls=0;
 const profile=applyModelProfile({async invoke(){calls++;return{message:{role:'assistant',content:'incomplete paid text'},finishReason:'error',usage:{inputTokens:10,outputTokens:3,totalTokens:13}};}},'math');
 const scorer:PrivateScorer={expectedLabel:label,async score(){throw Error('unreachable');}};
 const summary=await evaluateTasks([{...task,dataset:'mbpp'}],scorer,async()=>{await profile.invoke({messages:[{role:'user',content:'public'}],model:{model:'fixture'}},{signal:new AbortController().signal});return result;},{retryAttempts:1});
 assert.equal(calls,1);assert.equal(summary.valid,false);assert.equal(summary.results[0]!.failureKind,'provider');assert.match(summary.results[0]!.error!,/finish_reason=error/);
});

test('generic JSON get preserves missing paths and coalesce defaults, including outside Automation',()=>{
 const env={task:{},nodes:{decide:{message:{content:'{"tool":"api_fetch","arguments":{}}'}}},prior:{},state:{},nodeOutput:(_id:string,value:any)=>value,isModelNode:(id:string)=>id==='decide'};
 const argument={get:{value:{get:{value:{parse:{ref:['nodes','decide','message','content']}},path:['arguments']}},path:['body']}};
 assert.throws(()=>evaluateBinding(argument,env),MissingBindingPath);
 assert.equal(evaluateBinding({coalesce:[argument,{literal:5}]},env),5);
 const unknown={get:{value:{parse:{ref:['nodes','decide','message','content']}},path:['notDeclaredByModelInstruction']}};
 assert.throws(()=>evaluateBinding(unknown,env),MissingBindingPath);
 assert.throws(()=>evaluateBinding({get:{value:{literal:{}},path:['body']}},env),MissingBindingPath);
 env.nodes.decide.message.content='{"arguments":{"body":null}}';assert.equal(evaluateBinding(argument,env),null);
});

const automationTools=[
 {name:'api_search',inputSchema:{type:'object',properties:{query:{type:'string'},top_k:{type:'integer'}},required:['query','top_k']}},
 {name:'api_fetch',inputSchema:{type:'object',properties:{method:{type:'string'},url:{type:'string'},params:{type:['string','null']},body:{type:['string','null']}},required:['method','url','params','body']}},
 {name:'base64_encode',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}},
];
test('Automation contract checks only declared required fields and accepts nullable API arguments',()=>{
 assert.doesNotThrow(()=>validateAutomationDecision('{"done":false,"tool":"api_search","arguments":{"query":"test"}}','decide',automationTools));
 assert.doesNotThrow(()=>validateAutomationDecision('{"done":false,"tool":"api_fetch","arguments":{"method":"GET","url":"public","params":null,"body":null}}','decide',automationTools));
 assert.throws(()=>validateAutomationDecision('{"done":false,"tool":"api_fetch","arguments":{"method":"GET","url":"public","params":null}}','decide',automationTools),ModelOutputFormatError);
});
test('Automation optional top_k reaches the tool as 5, missing required fields are model loss, and a misspelled binding stays engineering-invalid',async()=>{
 const settings={baseUrl:'https://offline.invalid',apiKey:'offline',model:'fixture',concurrency:1,timeoutMs:3000};
 async function execute(response:any,mutate?:(definition:GraphDefinition)=>void){
  const calls:any[]=[],runtime=createExperimentRuntime(settings,{provider:{async invoke(){return{message:{role:'assistant',content:JSON.stringify(calls.length?{done:true,tool:'',arguments:{}}:response)},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}}});
  const session:AutomationSession={tools:automationTools,assertHealthy(){},record(){},async call(name,args){calls.push({name,args});return{content:'official observation'};}};
  const definition=automationBaseline(3);mutate?.(definition);
  try{return{run:await automationScope.run(session,()=>runGraphAgent(definition,task,runtime,settings)),calls};}finally{await runtime.close();}
 }
 const search=await execute({done:false,tool:'api_search',arguments:{query:'test'}});
 assert.equal(search.calls[0].args.top_k,5);assert.equal(search.run.modelFailure,undefined);
 const nullable=await execute({done:false,tool:'api_fetch',arguments:{method:'GET',url:'public',params:null,body:null}});
 assert.equal(nullable.calls[0].args.params,null);assert.equal(nullable.calls[0].args.body,null);
 const missing=await execute({done:false,tool:'api_fetch',arguments:{method:'GET',url:'public',params:null}});
 assert.equal(missing.calls.length,0);assert.equal(missing.run.modelFailure?.code,'MODEL_OUTPUT_FORMAT');assert.equal(missing.run.answer,'');
 const graded=await evaluateTasks([task],{expectedLabel:label,async score(_id,prediction){return{score:prediction===''?0:1,expected:'fixture',prediction,normalizedExpected:'fixture',normalizedPrediction:prediction,method:'offline-format-fixture'};}},async()=>missing.run,{retryAttempts:1});
 assert.equal(graded.valid,true);assert.equal(graded.score,0);
 await assert.rejects(()=>execute({done:false,tool:'api_search',arguments:{query:'test'}},definition=>{
  definition.graphs[1]!.nodes[0]!.config.arguments.query={get:{value:{parse:{ref:['nodes','decide','message','content']}},path:['notDeclaredByModelInstruction']}};
 }),error=>(error as any).failureKind==='execution'&&/notDeclaredByModelInstruction/.test(String(error)));
});

test('judge-only recovery reuses the original prediction, checkpoint and usage without running an actor',async()=>{
 let actors=0,grades=0;
 const saved={caseId:task.id+'#1',world:{private:'saved'}};
 const scorer:PrivateScorer={expectedLabel:label,recoveryData:()=>saved,async score(_id,prediction,prior){
  assert.equal(prediction,result.answer);
  if(++grades===1)throw Error('judge unavailable');
  assert.deepEqual(prior?.judgeRecovery,saved);
  return{score:1,expected:'private',prediction,normalizedExpected:'pass',normalizedPrediction:'pass',method:'fixture'};
 }};
 const runner=async()=>{actors++;return result;};
 const first=await evaluateTasks([task],scorer,runner,{retryAttempts:1});
 assert.equal(first.valid,false);assert.equal(first.results[0]!.failureKind,'judge');
 const recovered=await evaluateTasks([task],scorer,runner,{retryAttempts:1,priorCases:first.results});
 assert.equal(recovered.valid,true);assert.equal(actors,1);assert.equal(recovered.totalTokens,13);assert.equal(recovered.results[0]!.previousResults?.length,1);
 const {judgeRecovery:_removed,...missing}=first.results[0]!;
 const refused=await evaluateTasks([task],scorer,runner,{retryAttempts:1,priorCases:[missing]});
 assert.equal(refused.valid,false);assert.equal(actors,1);assert.match(refused.results[0]!.error!,/regeneration is refused/);
});

test('cumulative retries and interrupted write-ahead records stay invalid without new actor calls',async()=>{
 let actors=0;
 const scorer:PrivateScorer={expectedLabel:label,async score(){throw Error('unreachable');}};
 const runner=async()=>{actors++;throw Error('HTTP 503 unavailable');};
 const first=await evaluateTasks([task],scorer,runner,{retryAttempts:1,cumulativeRetries:true});
 const recovered=await evaluateTasks([task],scorer,runner,{retryAttempts:1,cumulativeRetries:true,priorCases:first.results});
 assert.equal(actors,1);assert.equal(recovered.valid,false);assert.match(recovered.results[0]!.error!,/attempt budget exhausted/);
 const policy={maxActorCalls:3,wallClockMs:30000};
 const interrupted=await evaluateTasks([task],scorer,runner,{retryAttempts:2,automationBudget:policy,automationBudgetPersistence:{load:()=>({policy,startedAt:Date.now(),actorCalls:1,attempts:1}),save(){}}});
 assert.equal(interrupted.valid,false);assert.equal(actors,1);assert.match(interrupted.results[0]!.error!,/no result evidence/);
});

test('Automation budgets reserve before admission, persist across recovery and reject regressed identity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ditto-budget-'));
 try{
  const persistence=new AutomationBudgetRecovery(root,'a'.repeat(64));
  const policy={maxActorCalls:2,wallClockMs:10000};
  const budget=new AutomationBudget(policy,undefined,value=>persistence.save(task.id+'#1',value));
  budget.claimAttempt(2);budget.claimActor();budget.claimActor();
  assert.throws(()=>budget.claimActor(),AutomationActorBudgetExceeded);
  assert.equal(persistence.load(task.id+'#1')!.actorCalls,2);
  const restored=new AutomationBudget(policy,persistence.load(task.id+'#1'));
  assert.throws(()=>restored.claimActor(),AutomationActorBudgetExceeded);
  assert.throws(()=>new AutomationBudget({...policy,maxActorCalls:3},persistence.load(task.id+'#1')),/persisted/);
  const failed=new AutomationBudget(policy,undefined,()=>{throw Error('checkpoint write failed');});
  assert.throws(()=>failed.claimActor(),/checkpoint write failed/);assert.equal(failed.progress().actorCalls,0);
  let calls=0;
  const settings={baseUrl:'https://offline.invalid',apiKey:'offline',model:'fixture',concurrency:1,timeoutMs:3000};
  const runtime=createExperimentRuntime(settings,{provider:{async invoke(){calls++;return{message:{role:'assistant',content:'ok'},finishReason:'stop'};}}});
  try{await assert.rejects(()=>automationBudgetScope.run(restored,()=>runtime.provider.invoke({messages:[{role:'user',content:'public'}],model:{provider:'deepseek',model:'fixture'}},{signal:new AbortController().signal})),AutomationActorBudgetExceeded);assert.equal(calls,0);}finally{await runtime.close();}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Retrieval candidates actually reach downstream inference, with empty hits, denied target and task isolation',async()=>{
 const settings={baseUrl:'https://offline.invalid',apiKey:'offline',model:'fixture',concurrency:1,timeoutMs:3000};
 const calls:any[]=[];
 const runtime=createExperimentRuntime(settings,{provider:{async invoke(input){calls.push(input);return{message:{role:'assistant',content:'final'},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}}});
 const definition:GraphDefinition={version:2,graphs:[{id:'agent',nodes:[{id:'retrieve',type:'RETRIEVAL.SEARCH',dependencies:[],config:{query:{literal:'ambercode'},target:'task-public'}},{id:'solve',type:'INFER.REASONING.SAMPLE',dependencies:['retrieve'],config:{instruction:'Use the retrieved public evidence.',evidence:[{json:{ref:['nodes','retrieve','candidates']}}]}}]}],loop:{entryGraphId:'agent',maxGraphRuns:1,transitions:{agent:{kind:'end'}}},output:{nodeId:'solve',view:'answer'}};
 try{
  const first=await runGraphAgent(definition,{...task,id:'retrieval-1',dataset:'drop',prompt:'The ambercode is amber-isolation-evidence-731. Other material.'},runtime,settings);
  assert.ok(calls[0].messages.some((m:any)=>String(m.content).includes('task-segment-0')));
  assert.equal(first.executedNodeIds.includes('retrieve'),true);
  assert.ok(JSON.stringify(first.nodeOutputs).includes('amber-isolation-evidence-731'));
  const second=await runGraphAgent(definition,{...task,id:'retrieval-2',dataset:'drop',prompt:'A separate unrelated public paragraph.'},runtime,settings);
  assert.deepEqual(second.rawNodeOutputs.retrieve.output.candidates,[]);
  assert.equal(JSON.stringify(second.nodeOutputs).includes('amber-isolation-evidence-731'),false);
  const denied=structuredClone(definition);denied.graphs[0]!.nodes[0]!.config.target='private-gold';
  assert.throws(()=>validateDefinition(denied),/host-authorized/);assert.equal(calls.length,2);
 }finally{await runtime.close();}
});
