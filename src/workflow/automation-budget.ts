import {AsyncLocalStorage} from 'node:async_hooks';
export const automationBudgetScope=new AsyncLocalStorage<AutomationBudget>();
export const AUTOMATION_EXECUTION_BUDGET=Object.freeze({id:'automation-workflow-budget-v1',maxActorCalls:60,wallClockMs:600000,scope:'case-repeat-including-workflow-retries'});
export interface AutomationBudgetProgress {readonly policy:typeof AUTOMATION_EXECUTION_BUDGET;readonly startedAt:number;readonly actorCalls:number;}
export interface AutomationBudgetPersistence {
  load(caseId:string):AutomationBudgetProgress|undefined;
  save(caseId:string,progress:AutomationBudgetProgress):void;
}
export class AutomationBudget {
  readonly startedAt:number;
  readonly controller=new AbortController();
  readonly #timer:ReturnType<typeof setTimeout>;
  actorCalls=0;
  constructor(readonly now:()=>number=Date.now,prior?:AutomationBudgetProgress,readonly persist?:(progress:AutomationBudgetProgress)=>void){
    if(prior&&(JSON.stringify(prior.policy)!==JSON.stringify(AUTOMATION_EXECUTION_BUDGET)||!Number.isFinite(prior.startedAt)||!Number.isSafeInteger(prior.actorCalls)||prior.actorCalls<0||prior.actorCalls>60))throw Error('Invalid persisted Automation budget');
    this.startedAt=prior?.startedAt??now();this.actorCalls=prior?.actorCalls??0;
    this.persist?.(this.progress());
    this.#timer=setTimeout(()=>this.controller.abort(Error('AUTOMATION_WALL_CLOCK_BUDGET')),Math.max(0,AUTOMATION_EXECUTION_BUDGET.wallClockMs-(now()-this.startedAt)));
    this.#timer.unref();
  }
  progress():AutomationBudgetProgress{return {policy:AUTOMATION_EXECUTION_BUDGET,startedAt:this.startedAt,actorCalls:this.actorCalls};}
  get wallExpired():boolean{
    if(this.now()-this.startedAt>=AUTOMATION_EXECUTION_BUDGET.wallClockMs&&!this.controller.signal.aborted)this.controller.abort(Error('AUTOMATION_WALL_CLOCK_BUDGET'));
    return this.controller.signal.aborted;
  }
  beforeGraph(actorSlots:number,hasInference:boolean,pendingActions:number):'actor-call-limit'|'wall-clock-limit'|undefined{
    if(this.wallExpired&&(hasInference||pendingActions===0))return 'wall-clock-limit';
    // Admit the whole graph's potential actor group; no graph can overshoot by fan-out.
    if(this.actorCalls+actorSlots>AUTOMATION_EXECUTION_BUDGET.maxActorCalls)return 'actor-call-limit';
    return undefined;
  }
  claimActor():void{
    if(this.wallExpired)throw Error('AUTOMATION_WALL_CLOCK_BUDGET');
    if(this.actorCalls>=AUTOMATION_EXECUTION_BUDGET.maxActorCalls)throw Error('AUTOMATION_ACTOR_CALL_BUDGET');
    const progress={...this.progress(),actorCalls:this.actorCalls+1};
    this.persist?.(progress); // A failed checkpoint must prevent Provider dispatch.
    this.actorCalls=progress.actorCalls;
  }
  close():void{clearTimeout(this.#timer);}
}
