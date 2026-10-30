import assert from 'node:assert/strict';
import test from 'node:test';
import type {BenchmarkTask,EvaluationSummary} from '../domain.js';
import type {DittoRuntime} from '@codesoul-co/ditto/runtime';
import {DROP_ANSWER_CONTRACT,publicAnswerContract,taskOutputRequirements} from '../benchmark/answer-contract.js';
import {BASELINE_DEFINITION,DefinitionError,validateDefinition,type GraphDefinition} from '../graph-agent/schema.js';
import {runGraphAgent} from '../graph-agent/executor.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {NODE_SYSTEM_PROMPT} from '../graph-agent/system.js';
import {buildUnifiedFeedback} from '../unified/feedback.js';
import {searchUnifiedWorkflows} from '../unified/search.js';

const task:BenchmarkTask={id:'public-fixture',dataset:'drop',prompt:'Passage: A red team and a blue team used a 12-mile route.\nQuestion: Which teams used the route?\nAnswer:',outputInstruction:'',metadata:{}};
const settings={baseUrl:'https://example.invalid',model:'fixture',apiKey:'offline',concurrency:1,timeoutMs:3000};
function summary():EvaluationSummary{return{valid:true,score:.5,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,wrongRuns:0,timeoutRuns:0,inputTokens:1,outputTokens:1,totalTokens:2,durationMs:0,
 results:[{caseId:task.id+'#1',valid:true,score:.5,prediction:'red | blue',expected:'PRIVATE-GOLD',normalizedExpected:'PRIVATE-GOLD',normalizedPrediction:'red',method:'fixture',latencyMs:0,inputTokens:1,outputTokens:1,totalTokens:2}]};}

test('actual DROP provider requests retain frozen system, public target categories, intermediate JSON and raw final output',async()=>{
 const captured:any[]=[];
 const shared=createExperimentRuntime(settings,{provider:{async invoke(input){captured.push(structuredClone(input));return{message:{role:'assistant',content:input.metadata?.nodeId==='extract'?' {"entities":["red team","blue team"]} ':'red team and blue team'},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}}});
 const d=structuredClone(BASELINE_DEFINITION);
 d.graphs[0]!.nodes.splice(1,0,{id:'extract',type:'INFER.REASONING.SAMPLE',dependencies:['context'],config:{instruction:'Extract requested entities as JSON only.',outputFormat:'json'}});
 const solve=d.graphs[0]!.nodes.at(-1)!;solve.dependencies=['context','extract'];solve.config={instruction:'Use the extraction. Strip every unit.',user:{literal:'An optional candidate preference, not a replacement of the task contract.'},evidence:[{ref:['nodes','extract','message','content']}]};
 try{
  const result=await runGraphAgent(d,task,shared,settings);
  assert.equal(result.answer,'red team and blue team');assert.equal(result.finalPrediction,result.modelResponses.at(-1)!.rawContent);
  assert.equal(captured.length,2);
  for(const input of captured){
   assert.deepEqual(input.messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content),[NODE_SYSTEM_PROMPT]);
   const user=input.messages.filter((m:any)=>m.role==='user').map((m:any)=>m.content).join('\n');
   assert.match(user,/NUMERIC VALUE/);assert.match(user,/ENTITY OR ENTITY SET/);assert.match(user,/PASSAGE SPAN WITH UNITS/);assert.match(user,/An intermediate node explicitly asked to produce JSON/);
   assert.doesNotMatch(user,/multiple answer spans may be separated with/);
  }
  assert.match(captured[0].messages.at(-1).content,/return strict JSON only/);
  const finalUser=captured[1].messages.filter((m:any)=>m.role==='user').map((m:any)=>m.content).join('\n');
  assert(finalUser.lastIndexOf(DROP_ANSWER_CONTRACT)>finalUser.indexOf('Strip every unit'));
  assert(finalUser.lastIndexOf(DROP_ANSWER_CONTRACT)>finalUser.indexOf('An optional candidate preference'));
 }finally{await shared.close();}
 assert.equal(publicAnswerContract('math'),undefined);assert.equal(taskOutputRequirements({dataset:'math',outputInstruction:'boxed'}),'boxed');
});

test('malformed tool and node declarations identify exact field and actionable repair',()=>{
 const d=structuredClone(BASELINE_DEFINITION) as GraphDefinition;
 d.tools=[{name:'helper',description:'Transform text',executeSource:'function(args){return args.raw;}'} as any];
 assert.throws(()=>validateDefinition(d),(error:unknown)=>{
  assert(error instanceof DefinitionError);assert.equal(error.issue.path,'tools[0].inputSchema');assert.match(error.issue.message,/received missing/);assert.match(error.issue.repairHint,/actual argument names/);return true;
 });
 delete d.tools;d.graphs[0]!.nodes[1]!.config.evidence={ref:['nodes','context','items']};
 assert.throws(()=>validateDefinition(d),(error:unknown)=>{assert(error instanceof DefinitionError);assert.equal(error.issue.path,'graphs[0].nodes[1].config.evidence');assert.match(error.issue.repairHint,/array/);return true;});
 d.graphs[0]!.nodes[1]!.config=null as any;
 assert.throws(()=>validateDefinition(d),/graphs\[0\].nodes\[1\].config: Expected JSON object; received null/);
 const unsafe=structuredClone(BASELINE_DEFINITION);
 unsafe.tools=[{name:'unsafe_math',description:'Evaluate supplied expression',inputSchema:{type:'object',properties:{raw:{type:'string'}},required:['raw']},executeSource:'function(args){return Function("return ("+args.raw+")")();}'}];
 assert.throws(()=>validateDefinition(unsafe),(error:unknown)=>{assert(error instanceof DefinitionError);assert.equal(error.issue.path,'tools[0].executeSource');assert.match(error.issue.repairHint,/Remove Function\/eval/);assert.match(error.issue.repairHint,/bounded_arithmetic/);return true;});
});

test('a rejected tool receives exact schema diagnostics in the next optimizer repair request',async()=>{
 let calls=0;
 const candidate=structuredClone(BASELINE_DEFINITION);
 candidate.graphs[0]!.nodes.splice(1,0,{id:'helper',type:'INTERACTION.ACT.TOOL',dependencies:[],config:{tool:'text_helper',arguments:{raw:{ref:['task','prompt']}}}});
 candidate.graphs[0]!.nodes.at(-1)!.dependencies=['context','helper'];candidate.graphs[0]!.nodes.at(-1)!.config.evidence=[{ref:['nodes','helper','structuredContent']}];
 candidate.tools=[{name:'text_helper',description:'Copy supplied text',executeSource:'function(args){return {text:args.raw};}'} as any];
 const runtime={async run(_graph:unknown,input:{request:string}){
  const request=JSON.parse(input.request);calls++;
  assert.equal(request.immutableProtocol.publicAnswerContract.text,DROP_ANSWER_CONTRACT);
  assert.match(request.interfaceGuide,/inputSchema is REQUIRED/);
  if(calls===2){
   assert.equal(request.mode,'ENGINEERING REPAIR');assert.equal(request.contractRepair.issues[0].path,'tools[0].inputSchema');assert.match(request.contractRepair.issues[0].repairHint,/actual argument names/);
   candidate.tools![0]!.inputSchema={type:'object',properties:{raw:{type:'string'}},required:['raw']};
  }
  assert.doesNotMatch(input.request,/PRIVATE-GOLD/);
  return{proposal:{status:'success',output:{message:{content:JSON.stringify({rationale:'Add a connected public text helper.',definition:candidate})}}}};
 }} as Pick<DittoRuntime,'run'>;
 const result=await searchUnifiedWorkflows({runtime,exploration:false,model:{provider:'mock',model:'fixture'},dataset:'drop',publicTasks:[task],expectedRepeats:1,maxValidEvaluations:2,maxDesignRounds:1,maxProposalAttempts:2,evaluate:async()=>summary()});
 assert.equal(calls,2);assert.deepEqual(result.state.history.map(x=>x.status),['valid','invalid-proposal','valid']);assert.equal(result.state.validEvaluations,2);
});

test('quality feedback labels parent predictions honestly and flags only observable public separator errors',()=>{
 const value=buildUnifiedFeedback([{id:'parent',parentId:null,status:'valid',evaluation:summary()},{id:'child',parentId:'parent',status:'valid',evaluation:summary()}],[task]);
 const text=JSON.stringify(value);assert.doesNotMatch(text,/PRIVATE-GOLD|normalizedExpected|"reference":/);
 assert.match(text,/parentOutcome/);assert.match(text,/ANSWER_ALTERNATIVE_SEPARATOR/);assert.match(text,/not reference answers/);
 assert.match(text,/ENTITY OR ENTITY SET/);
});
