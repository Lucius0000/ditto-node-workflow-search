import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {AutomationBudgetRecovery} from '../run/automation-budget-recovery.js';
import {AutomationBudget,AUTOMATION_EXECUTION_BUDGET} from '../workflow/automation-budget.js';
import {evaluateTasks} from '../benchmark/evaluator.js';

const identity='a'.repeat(64),caseId='automationbench:fixture#1';
function fixture(){const directory=mkdtempSync(join(tmpdir(),'ditto-budget-'));return {directory,close(){assert.ok(resolve(directory).startsWith(resolve(tmpdir())));rmSync(directory,{recursive:true,force:true});}};}
test('write-ahead actor budget survives a child process exiting before its case result',()=>{
  const f=fixture();
  try{
    const script=`import {AutomationBudgetRecovery} from ${JSON.stringify(new URL('../run/automation-budget-recovery.js',import.meta.url).href)};
      import {AutomationBudget} from ${JSON.stringify(new URL('../workflow/automation-budget.js',import.meta.url).href)};
      import {writeFileSync} from 'node:fs';
      const s=new AutomationBudgetRecovery(${JSON.stringify(f.directory)},${JSON.stringify(identity)});
      const b=new AutomationBudget(()=>1000,undefined,p=>s.save(${JSON.stringify(caseId)},p));
      b.claimActor();writeFileSync(${JSON.stringify(join(f.directory,'fixture-dispatched.json'))},JSON.stringify(s.load(${JSON.stringify(caseId)})));
      process.exit(77);`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',windowsHide:true});
    assert.equal(child.status,77,child.stderr);
    const store=new AutomationBudgetRecovery(f.directory,identity),saved=store.load(caseId)!;
    assert.equal(saved.actorCalls,1);assert.equal(saved.startedAt,1000);
    assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'fixture-dispatched.json'),'utf8')),saved);
    const resumed=new AutomationBudget(()=>2000,saved,p=>store.save(caseId,p));
    try{resumed.claimActor();assert.equal(store.load(caseId)!.actorCalls,2);assert.equal(resumed.startedAt,1000);}finally{resumed.close();}
    const expired=new AutomationBudget(()=>601001,store.load(caseId));
    try{assert.equal(expired.wallExpired,true);assert.throws(()=>expired.claimActor(),/WALL_CLOCK/);assert.equal(expired.actorCalls,2);}finally{expired.close();}
  }finally{f.close();}
});
test('expired incomplete checkpoint remains invalid without opening a fresh workflow',async()=>{
  const f=fixture();let calls=0;
  try{
    const store=new AutomationBudgetRecovery(f.directory,identity);
    store.save(caseId,{policy:AUTOMATION_EXECUTION_BUDGET,startedAt:Date.now()-600001,actorCalls:1});
    const summary=await evaluateTasks([{id:'automationbench:fixture',dataset:'automationbench',prompt:'fixture',outputInstruction:'',metadata:{}}],{
      expectedLabel:()=>'',async score(){throw Error('No grading of an unresolved crash');},
    },async()=>{calls++;throw Error('No fresh world');},{repeats:1,retryAttempts:1,automationBudgetPersistence:store});
    assert.equal(calls,0);assert.equal(summary.valid,false);assert.match(summary.results[0]!.error!,/Unresolved Automation infrastructure fault/);
    assert.equal(summary.results[0]!.automationBudgetProgress!.actorCalls,1);
  }finally{f.close();}
});
test('checkpoint failure prevents actor admission and foreign bindings are refused',()=>{
  const f=fixture();
  try{
    const store=new AutomationBudgetRecovery(f.directory,identity);let fail=false;
    const budget=new AutomationBudget(()=>1000,undefined,p=>{if(fail)throw Error('checkpoint disk failure');store.save(caseId,p);});
    try{fail=true;assert.throws(()=>budget.claimActor(),/disk failure/);assert.equal(budget.actorCalls,0);assert.equal(store.load(caseId)!.actorCalls,0);}finally{budget.close();}
    const other=new AutomationBudgetRecovery(f.directory,'b'.repeat(64));assert.equal(other.load(caseId),undefined);
    const file=join(store.directory,createHash('sha256').update(caseId).digest('hex')+'.json');
    const value=JSON.parse(readFileSync(file,'utf8'));value.caseId='foreign';writeFileSync(file,JSON.stringify(value));
    assert.throws(()=>store.load(caseId),/binding differs/);
    value.caseId=caseId;delete value.progress;writeFileSync(file,JSON.stringify(value));
    assert.throws(()=>store.load(caseId),/progress is missing/);
  }finally{f.close();}
});
