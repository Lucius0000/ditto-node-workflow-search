import {AsyncLocalStorage} from 'node:async_hooks';

export interface AutomationBudgetPolicy {readonly maxActorCalls:number;readonly wallClockMs:number}
export interface AutomationBudgetProgress {readonly policy:AutomationBudgetPolicy;readonly startedAt:number;readonly actorCalls:number;readonly attempts:number}
export interface AutomationBudgetPersistence {load(caseId:string):AutomationBudgetProgress|undefined;save(caseId:string,progress:AutomationBudgetProgress):void}
export class AutomationActorBudgetExceeded extends Error {
 readonly outcome;
 constructor(limit:number,used:number){super('Declared Automation actor-call budget exhausted');this.outcome={scope:'actor-calls' as const,limit,used};}
}
export const automationBudgetScope=new AsyncLocalStorage<AutomationBudget>();
/** A durable reservation precedes every attempt and every admitted provider call. */
export class AutomationBudget {
 private value:AutomationBudgetProgress;
 constructor(policy:AutomationBudgetPolicy,prior?:AutomationBudgetProgress,private readonly persist?:(value:AutomationBudgetProgress)=>void,private readonly now=Date.now){
  if(![policy.maxActorCalls,policy.wallClockMs].every(value=>Number.isSafeInteger(value)&&value>0))throw Error('Invalid Automation budget policy');
  if(prior&&(JSON.stringify(prior.policy)!==JSON.stringify(policy)||!Number.isFinite(prior.startedAt)||prior.startedAt>now()||![prior.actorCalls,prior.attempts].every(value=>Number.isSafeInteger(value)&&value>=0)||prior.actorCalls>policy.maxActorCalls))throw Error('Invalid persisted Automation budget');
  this.value=prior??{policy,startedAt:now(),actorCalls:0,attempts:0};
 }
 progress():AutomationBudgetProgress{return structuredClone(this.value);}
 get remainingMs():number{return Math.max(0,this.value.policy.wallClockMs-(this.now()-this.value.startedAt));}
 private update(patch:Partial<AutomationBudgetProgress>):void{const next={...this.value,...patch};this.persist?.(next);this.value=next;}
 claimAttempt(limit:number):void{
  if(this.value.attempts>=limit)throw Error('Automation cumulative workflow attempt budget exhausted; no fresh world dispatched');
  if(this.remainingMs===0)throw Error('Unresolved Automation recovery has exhausted its cumulative wall-clock budget');
  this.update({attempts:this.value.attempts+1});
 }
 claimActor():void{
  if(this.value.actorCalls>=this.value.policy.maxActorCalls)throw new AutomationActorBudgetExceeded(this.value.policy.maxActorCalls,this.value.actorCalls);
  this.update({actorCalls:this.value.actorCalls+1});
 }
}
