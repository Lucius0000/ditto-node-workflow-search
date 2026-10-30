import type {SampleInput} from '@codesoul-co/ditto/worker/infer';
import type {ProviderInvocationEvent} from '../ditto/runtime.js';
import {createProviderBudget,ProviderBudgetExceeded,type ProviderBudgetSnapshot} from './provider-budget.js';
import {EXPLORATION_DIRECTIONS,type ExplorationDirection} from './exploration.js';

export type BudgetDirection='baseline'|ExplorationDirection;
/** Isolated buckets: an expensive family cannot consume another family's reservation. */
export function createDirectionBudget(options:{maxCalls:number;maxTokens:number;restored?:Partial<Record<BudgetDirection,ProviderBudgetSnapshot>>;onChange?:(value:Record<BudgetDirection,ProviderBudgetSnapshot>)=>void|Promise<void>}){
 const names=['baseline',...EXPLORATION_DIRECTIONS] as const;
 const buckets=Object.fromEntries(names.map(name=>[name,createProviderBudget({maxCalls:Math.max(1,Math.floor(options.maxCalls/names.length)),maxTokens:Math.max(1,Math.floor(options.maxTokens/names.length)),...(options.restored?.[name]?{restored:options.restored[name]}:{})})])) as Record<BudgetDirection,ReturnType<typeof createProviderBudget>>;
 const routes=new WeakMap<object,BudgetDirection>();
 const snapshot=()=>Object.fromEntries(names.map(name=>[name,buckets[name].snapshot()])) as Record<BudgetDirection,ProviderBudgetSnapshot>;
 return{snapshot,async beforeProviderCall(input:SampleInput,direction:BudgetDirection){
  try{await buckets[direction].beforeProviderCall(input);routes.set(input,direction);await options.onChange?.(snapshot());}
  catch(error){if(error instanceof ProviderBudgetExceeded&&direction!=='baseline')throw Object.assign(new Error(`SEARCH_DIRECTION_BUDGET: protected ${direction} provider quota exhausted; other direction quotas remain available`),{code:'SEARCH_DIRECTION_BUDGET',infrastructureFailure:true,direction});throw error;}
 },async afterProviderCall(event:ProviderInvocationEvent){const direction=routes.get(event.input);if(direction){await buckets[direction].afterProviderCall(event);await options.onChange?.(snapshot());}}};
}
