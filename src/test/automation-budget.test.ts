import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateTasks} from '../benchmark/evaluator.js';
import {automationBudgetScope,AutomationBudget} from '../workflow/automation-budget.js';
import type {BenchmarkTask} from '../domain.js';

const task:BenchmarkTask={id:'automationbench:fixture',dataset:'automationbench',prompt:'offline',outputInstruction:'',metadata:{}};
const scorer={expectedLabel:()=>'',score:async()=>({score:0,expected:'',prediction:'',normalizedExpected:'',normalizedPrediction:'',method:'offline-only'})};
const result=()=>({answer:'partial',executedNodeIds:[],executedGraphIds:[],inputTokens:0,outputTokens:0,totalTokens:0,usageKnown:true});

test('workflow retries share the case budget and a fresh independent repeat receives a fresh budget',async()=>{
  let calls=0;const starts:number[]=[];
  const summary=await evaluateTasks([task],scorer,async()=>{
    const budget=automationBudgetScope.getStore()!;starts.push(budget.actorCalls);calls++;
    for(let i=0;i<30;i++)budget.claimActor();
    if(calls%2===1)throw Error('HTTP 503 transient fixture');
    return result();
  },{repeats:2,retryAttempts:5});
  assert.deepEqual(starts,[0,30,0,30]);assert.equal(summary.valid,true);assert.equal(summary.results[0]!.automationBudgetProgress!.actorCalls,60);assert.equal(summary.results[1]!.automationBudgetProgress!.actorCalls,60);
});

test('an unresolved service fault at an exhausted budget stays invalid and persisted recovery cannot grant sixty more calls',async()=>{
  let calls=0;
  const first=await evaluateTasks([task],scorer,async()=>{
    calls++;const budget=automationBudgetScope.getStore()!;for(let i=0;i<60;i++)budget.claimActor();throw Error('HTTP 503 real fixture failure');
  },{retryAttempts:5});
  assert.equal(first.valid,false);assert.equal(calls,1);assert.equal(first.results[0]!.attempts!.length,1);
  const recovered=await evaluateTasks([task],scorer,async()=>{calls++;return result();},{priorCases:first.results,retryAttempts:5});
  assert.equal(calls,1);assert.equal(recovered.valid,false);assert.match(recovered.results[0]!.error!,/Unresolved.*exhausted/);assert.equal(recovered.results[0]!.automationBudgetProgress!.actorCalls,60);
  const saved=first.results[0]!.automationBudgetProgress!;
  const restored=new AutomationBudget(()=>saved.startedAt+600001,saved);
  try{assert.equal(restored.wallExpired,true);assert.equal(restored.actorCalls,60);}finally{restored.close();}
});
