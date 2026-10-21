import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateTasks} from '../benchmark/evaluator.js';
import {CODE_SEARCH_PROTOCOL} from '../code-search.js';
import {AUTOMATION_EXECUTION_BUDGET} from '../workflow/automation-budget.js';
import type {CaseResult,BenchmarkTask} from '../domain.js';

const task:BenchmarkTask={id:'humaneval:retry-fixture',dataset:'humaneval',prompt:'offline',outputInstruction:'',metadata:{}};
const scorer={expectedLabel:()=>'',score:async(_id:string,prediction:string)=>({score:0,expected:'',prediction,normalizedExpected:'',normalizedPrediction:'',method:'offline-only'})};
const run=async()=>({answer:'saved',executedNodeIds:[],executedGraphIds:[],inputTokens:0,outputTokens:0,totalTokens:0,usageKnown:true});
function prior(count:number):CaseResult{return {caseId:task.id+'#1',valid:false,score:0,expected:'',prediction:'saved',normalizedExpected:'',normalizedPrediction:'',method:'fixture',usageKnown:true,inputTokens:0,outputTokens:0,totalTokens:0,error:'HTTP 503 fixture',failureKind:'provider',latencyMs:0,
  attempts:Array.from({length:count},(_,i)=>({attempt:i+1,error:'HTTP 503 fixture',failureKind:'provider' as const,usageKnown:true}))};}
for(const count of [4,5])test(`staged recovery with ${count} prior failures permits exactly ${5-count} further workflow attempts`,async()=>{
  assert.equal(CODE_SEARCH_PROTOCOL.workflowRetryScope,'case-repeat');let calls=0;
  const result=await evaluateTasks([task],scorer,async()=>{calls++;throw Error('HTTP 503 fixture');},{priorCases:[prior(count)],retryAttempts:5,workflowRetryScope:CODE_SEARCH_PROTOCOL.workflowRetryScope});
  assert.equal(calls,5-count);assert.equal(result.valid,false);assert.equal(result.results[0]!.attempts!.length,5);
  if(count===5)assert.match(result.results[0]!.error!,/budget exhausted/);
});
test('valid normal zero remains reusable without another workflow call',async()=>{
  let calls=0;const first=await evaluateTasks([task],scorer,run,{retryAttempts:5,workflowRetryScope:'case-repeat'});
  const result=await evaluateTasks([task],scorer,async()=>{calls++;return run();},{priorCases:first.results,retryAttempts:5,workflowRetryScope:'case-repeat'});
  assert.equal(calls,0);assert.equal(result.valid,true);assert.equal(result.score,0);
});
test('judge-only recovery bypasses exhausted workflow attempts and legacy callers retain their default',async()=>{
  let calls=0;const p={...prior(5),failureKind:'judge' as const,judgeRecovery:{fixture:true}};
  const result=await evaluateTasks([task],scorer,async()=>{calls++;return run();},{priorCases:[p],retryAttempts:5,workflowRetryScope:'case-repeat'});
  assert.equal(calls,0);assert.equal(result.valid,true);assert.equal(result.results[0]!.prediction,'saved');assert.equal(result.results[0]!.attempts!.length,5);
  const legacy=await evaluateTasks([task],scorer,async()=>{calls++;return run();},{priorCases:[prior(5)],retryAttempts:5});
  assert.equal(calls,1);assert.equal(legacy.valid,true);
});
test('staged judge failure without a scoring checkpoint never regenerates an answer',async()=>{
  let calls=0;const p={...prior(4),failureKind:'judge' as const};
  const result=await evaluateTasks([task],scorer,async()=>{calls++;return run();},{priorCases:[p],retryAttempts:5,workflowRetryScope:'case-repeat'});
  assert.equal(calls,0);assert.equal(result.valid,false);assert.match(result.results[0]!.error!,/saved scoring checkpoint/);assert.equal(result.results[0]!.attempts!.length,4);
});
test('staged unexpired budget without case-result attempt evidence refuses a fresh runner',async()=>{
  let calls=0;const automation={...task,id:'automationbench:retry-fixture',dataset:'automationbench' as const};
  let saved={policy:AUTOMATION_EXECUTION_BUDGET,startedAt:Date.now(),actorCalls:1};
  const persistence={load:()=>saved,save:(_id:string,p:typeof saved)=>{saved=p;}};
  const result=await evaluateTasks([automation],scorer,async()=>{calls++;return run();},{retryAttempts:5,workflowRetryScope:'case-repeat',automationBudgetPersistence:persistence});
  assert.equal(calls,0);assert.equal(result.valid,false);assert.match(result.results[0]!.error!,/no case-result attempt evidence/);assert.equal(result.results[0]!.automationBudgetProgress!.actorCalls,1);
  const legacy=await evaluateTasks([automation],scorer,async()=>{calls++;return run();},{retryAttempts:5,automationBudgetPersistence:persistence});
  assert.equal(calls,1);assert.equal(legacy.valid,true);
});
