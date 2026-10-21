import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { graph, graphStep, loop, type DittoRuntime } from '@codesoul-co/ditto/runtime';
import type { Context, ContextItem, ExternalResult, Observation, ToolCall } from '@codesoul-co/ditto/contracts';
import type { Message, ModelConfig, ReflectOutput, SampleOutput, Usage } from '@codesoul-co/ditto/worker/infer';
import {applyCheckerSemantics,type ReflectionBinding} from './checker-semantics.js';
import {checkerContract} from './checker-policy.js';
import type { AgentPlanSpec, AgentRunResult, BenchmarkTask, GraphTransition, OutputCondition } from '../domain.js';
import { automationScope } from '../benchmark/automation.js';
import { captureProviderDiagnostics, summarizeProviderDiagnostics } from '../ditto/provider-diagnostics.js';
import { nodeCatalog, nodeDefinition, validateOrganizationPlan } from './organization.js';
import type { OrganizationSpec } from './organization-types.js';
import {AutomationBudget,AUTOMATION_EXECUTION_BUDGET,automationBudgetScope} from './automation-budget.js';

type Output = Record<string, any>;
type Node = OrganizationSpec['nodes'][number];
interface State { outputs: Record<string, Output>; consumed: Set<string>; executedNodeIds: string[]; executedGraphIds: string[]; visits: Record<string, number>; loopTrace:Array<NonNullable<AgentRunResult['loopTrace']>[number]>; usage: {inputTokens:number;outputTokens:number;totalTokens:number}; usageKnown: boolean; }
interface Input { prior: Readonly<Record<string, Output>>; consumed: ReadonlySet<string>; }
interface Builder { node(id: string, type: string, deps: readonly string[], bind: (input: Input, outputs: Record<string, unknown>) => unknown): Builder; }
const isContext = (o: Output | undefined): o is Context => !!o && Array.isArray(o.items);
const message = (o: Output): Message | undefined => o.checkerAudit?o.message:o.revisedResult ?? o.result ?? o.message;
// Assessment is dependency evidence, never a replacement for the answer being assessed.
const evidence = (o: Output): Message | undefined => o.assessment !== undefined
  ? {role:'user',content:JSON.stringify({assessment:o.assessment,issues:o.issues,...(message(o) ? {result:message(o)} : {})})}
  : message(o);
const text = (m: Message): string => typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
function unwrap(type: string, value: unknown): Output {
  if (!value || typeof value !== 'object') throw new Error('Node returned no output');
  if (!type.startsWith('INFER.')) return value as Output;
  const result = value as Output;
  if (result.status !== 'success' || !result.output) throw new Error(`Node failed [${result.error?.code ?? result.status}]: ${result.error?.message ?? 'no output'}`);
  if (['error','cancelled'].includes(result.output.finishReason) || ['error','cancelled','timeout'].includes(result.output.stopReason)) throw new Error('Node did not complete a model response');
  return result.output;
}

/** The only driver interprets searched graphs/transitions. No fixed post-plan tool loop. */
export async function runOrganization(runtime: DittoRuntime, model: ModelConfig, plan: AgentPlanSpec, task: BenchmarkTask, signal?: AbortSignal, clockBudget?:AutomationBudget): Promise<AgentRunResult> {
  const scoped=automationBudgetScope.getStore();
  const budget=task.dataset==='automationbench'?(clockBudget??scoped??new AutomationBudget()):undefined;
  try{return await executeOrganization(runtime,model,plan,task,signal,budget);}
  finally{if(!scoped||clockBudget)budget?.close();}
}
async function executeOrganization(runtime: DittoRuntime, model: ModelConfig, plan: AgentPlanSpec, task: BenchmarkTask, signal?: AbortSignal,budget?:AutomationBudget): Promise<AgentRunResult> {
  validateOrganizationPlan(plan);
  const spec = plan.organization!;
  if (task.dataset !== spec.dataset) throw new Error('Organization belongs to a different task family');
  const session = automationScope.getStore();
  if (task.dataset === 'automationbench' && !session) throw new Error('Automation requires an initialized official world');
  const catalog = nodeCatalog(spec.dataset); const nodes = new Map(spec.nodes.map(n => [n.id,n]));
  const reflectionBindings=new Map<string,ReflectionBinding>();
  const outputIds = new WeakMap<Output,string>();
  const outputId = (out:Output):string => {let id=outputIds.get(out);if(!id){id=randomUUID();outputIds.set(out,id);}return id;};
  const normalized = (id:string,raw:unknown):Output => {
    const out=unwrap(catalog[nodes.get(id)!.template]!.type,raw);
    if(nodes.get(id)!.template==='actor'&&out.actionRequests&&new Set(out.actionRequests.map((c:ToolCall)=>c.id)).size!==out.actionRequests.length)throw Error('Actor returned duplicate action callIds within one pending batch');
    const binding=reflectionBindings.get(id),definition=nodeDefinition(spec.dataset,nodes.get(id)!,'normalize');
    return binding&&definition.type==='INFER.REASONING.REFLECT'?applyCheckerSemantics(definition,out as ReflectOutput,binding):out;
  };
  const compiled = new Map(spec.graphs.map(g => {
    let builder = graph<Input>(`${plan.id}:${g.id}`) as unknown as Builder;
    for (const id of g.nodeIds) {
      const n = nodes.get(id)!;
      const local = n.dependencies.filter(d => g.nodeIds.includes(d));
      builder = builder.node(id, catalog[n.template]!.type, local, (input, outputs) => {
        const deps: Record<string, Output> = {};
        for (const d of n.dependencies) {
          const result = Object.hasOwn(outputs,d) ? normalized(d,outputs[d]) : input.prior[d];
          if (!result) throw new Error(`Missing declared dependency ${d} for ${id}`); deps[d] = result;
        }
        // Feedback is explicitly searched and reads only committed earlier graph runs.
        for (const d of n.feedback ?? []) if (input.prior[d]) deps[d] = input.prior[d];
        const consumed = new Set(input.consumed);
        for (const d of local) if (nodes.get(d)!.template === 'actor') {
          for (const call of deps[d]?.actionRequests ?? []) consumed.delete(`${d}\0${call.id}`);
        }
        if(n.template==='actor')budget?.claimActor();
        return bind(n, deps, consumed, task, model, spec, session?.tools ?? [], outputId,reflectionBindings);
      });
    }
    return [g.id, builder] as const;
  }));
  return captureProviderDiagnostics(async records => {
    const state: State = {outputs:{},consumed:new Set(),executedNodeIds:[],executedGraphIds:[],visits:{},loopTrace:[],usage:{inputTokens:0,outputTokens:0,totalTokens:0},usageKnown:true};
    const budgetDrainVisits=new Set<string>();
    const pending=()=>Object.entries(state.outputs).flatMap(([id,out])=>nodes.get(id)?.template==='actor'?(out.actionRequests??[]).filter((call:ToolCall)=>!state.consumed.has(`${id}\0${call.id}`)).map((call:ToolCall)=>call.id):[]);
    const budgetResult=(reason:'actor-call-limit'|'wall-clock-limit',cancelledInFlightModel=false,blockedGraphActorSlots=0):AgentRunResult=>{
      const executionBudget={policy:AUTOMATION_EXECUTION_BUDGET,reason,actorCalls:budget!.actorCalls,elapsedMs:Math.max(0,budget!.now()-budget!.startedAt),cancelledInFlightModel,pendingActionIds:pending(),...(blockedGraphActorSlots?{blockedGraphActorSlots}:{}),outputKind:'supervisor-budget-not-model-final' as const};
      session?.record({kind:'execution-budget-stop',...executionBudget});
      return {answer:`Execution stopped at the declared ${reason} workflow budget. This is a supervisor termination record, not a model final answer or proof of completed tool effects. Pending action requests: ${executionBudget.pendingActionIds.length}.`,executionBudget,
        executedNodeIds:state.executedNodeIds,executedGraphIds:state.executedGraphIds,nodeOutputs:structuredClone(state.outputs),loopTrace:state.loopTrace,checkerAudits:Object.values(state.outputs).flatMap(o=>o.checkerAudit?[o.checkerAudit]:[]),...state.usage,usageKnown:state.usageKnown&&!cancelledInFlightModel};
    };
    const definition = loop<BenchmarkTask, AgentRunResult>({ id:`${plan.id}:loop`, maxIterations:Number.MAX_SAFE_INTEGER,
      *plan() {
        let graphId: string | undefined = spec.entryGraphId;
        let deliveredNodeId = spec.outputNodeId;
        while (graphId !== undefined) {
          signal?.throwIfAborted(); session?.assertHealthy();
          const g = spec.graphs.find(g => g.id === graphId)!;
          const hasInference=g.nodeIds.some(id=>catalog[nodes.get(id)!.template]!.type.startsWith('INFER.'));
          const budgetReason=budget?.beforeGraph(g.nodeIds.filter(id=>nodes.get(id)!.template==='actor').length,hasInference,pending().length);
          if(budgetReason)return budgetResult(budgetReason,false,budgetReason==='actor-call-limit'?g.nodeIds.filter(id=>nodes.get(id)!.template==='actor').length:0);
          if(budget?.wallExpired){
            const key=JSON.stringify([graphId,pending()]);
            if(budgetDrainVisits.has(key))return budgetResult('wall-clock-limit');
            budgetDrainVisits.add(key);
          }
          // Once an actor has requested tools, declared non-inference graphs can
          // drain that existing group; the budget never starts another actor.
          const graphSignal=budget&&hasInference?AbortSignal.any([...(signal?[signal]:[]),budget.controller.signal]):signal;
          const raw: Record<string, unknown> = yield* graphStep(compiled.get(graphId)! as any, {prior:{...state.outputs},consumed:new Set(state.consumed)}, graphSignal ? {signal:graphSignal} : {});
          state.executedGraphIds.push(graphId); state.visits[graphId] = (state.visits[graphId] ?? 0) + 1;
          for (const id of g.nodeIds) {
            const n = nodes.get(id)!; const out = normalized(id,raw[id]); state.outputs[id] = out;
            state.executedNodeIds.push(id);
            if (n.template === 'actor') for (const call of out.actionRequests ?? []) state.consumed.delete(`${id}\0${call.id}`);
            if (n.template === 'act') for (const d of n.dependencies) {
              if (nodes.get(d)!.template === 'actor' && state.outputs[d]?.actionRequests?.some((call:ToolCall)=>call.id===out.callId)) state.consumed.add(`${d}\0${out.callId}`);
            }
            const usage = out.usage as Usage | undefined;
            if (catalog[n.template]!.type.startsWith('INFER.')) {
              state.usageKnown &&= usage?.inputTokens !== undefined && usage.outputTokens !== undefined;
              state.usage.inputTokens += usage?.inputTokens ?? 0; state.usage.outputTokens += usage?.outputTokens ?? 0;
              state.usage.totalTokens += usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
            }
            session?.record({kind:'organization-node',planId:plan.id,graphId,nodeId:id,nodeType:catalog[n.template]!.type,output:out});
          }
          session?.assertHealthy();
          const successor = next(spec.transitions[graphId]!, state);
          if (successor === undefined) deliveredNodeId = spec.outputByGraph?.[graphId] ?? spec.outputNodeId;
          state.loopTrace.push({graphId,visit:state.visits[graphId]!,...(successor?{nextGraphId:successor}:{}),outputNodeId:deliveredNodeId,nodeOutputs:structuredClone(Object.fromEntries(g.nodeIds.map(id=>[id,state.outputs[id]])))});
          session?.record({kind:'organization-transition',graphId,successor:successor??null,transition:spec.transitions[graphId],visits:state.visits[graphId],deliveredNodeId});
          graphId = successor;
        }
        const output = state.outputs[deliveredNodeId];
        const answer = output && resultMessage(output, nodes.get(deliveredNodeId)!, state.outputs);
        if (!answer) throw new Error('Organization ended without its declared output');
        return {answer:text(answer),executedNodeIds:state.executedNodeIds,executedGraphIds:state.executedGraphIds,nodeOutputs:structuredClone(state.outputs),loopTrace:state.loopTrace,checkerAudits:Object.values(state.outputs).flatMap(o=>o.checkerAudit?[o.checkerAudit]:[]),...state.usage,usageKnown:state.usageKnown};
      },
    });
    try {
      const result = await runtime.loop(definition, task, signal ? {signal} : {});
      return records.length ? {...result,...summarizeProviderDiagnostics(records)} : result;
    } catch (error) {
      const message=error instanceof Error?error.message:String(error);
      // A real service/bridge error stays invalid even when near the time limit.
      if(budget?.wallExpired&&!signal?.aborted&&!/HTTP \d{3}|broken|environment|bridge exited/i.test(message)&&/cancel|abort|AUTOMATION_WALL_CLOCK_BUDGET/i.test(message)){
        session?.assertHealthy();
        const result=budgetResult('wall-clock-limit',true);
        return records.length?{...result,...summarizeProviderDiagnostics(records)}:result;
      }
      throw Object.assign(new Error(error instanceof Error?error.message:String(error),{cause:error}),summarizeProviderDiagnostics(records));
    }
  });
}

function resultMessage(out: Output, n: Node, outputs: Record<string, Output>): Message | undefined {
  if (n.template === 'output' || n.template === 'verify') {
    const own = message(out); if (own) return own;
    for (const d of [...n.dependencies].reverse()) if (outputs[d] && message(outputs[d])) return message(outputs[d]);
    return undefined;
  }
  return message(out);
}

function bind(n: Node, deps: Record<string, Output>, consumed: ReadonlySet<string>, task: BenchmarkTask, model: ModelConfig, spec: OrganizationSpec, tools: readonly unknown[], outputId:(out:Output)=>string,bindings:Map<string,ReflectionBinding>): unknown {
  const definition = nodeCatalog(spec.dataset)[n.template]!; const config = nodeDefinition(spec.dataset,n,'bind').config as unknown as Record<string,any>;
  const values = Object.values(deps);
  const context = values.filter(isContext).at(-1);
  const metadata = {dataset:task.dataset,taskId:task.id,nodeId:n.id,nodeType:definition.type,planRole:n.template};
  const messages: Message[] = context ? context.items.map(item => contextMessage(item)) : [{role:'user',content:task.prompt}];
  const contextMessages = new Set(messages.map(m => JSON.stringify(m)));
  const targetEntry = definition.type==='INFER.REASONING.REFLECT'
    ? n.targetNodeId ? [n.targetNodeId,deps[n.targetNodeId]!] as const
      : Object.entries(deps).filter(([,out])=>!!message(out)).at(-1) : undefined;
  for (const [id, out] of Object.entries(deps)) {
    if (isContext(out) || nodesTemplate(spec,id) === 'act') continue;
    // Core serializes target.result separately. Include the full answer only there.
    if (id === targetEntry?.[0]) {
      if (out.assessment !== undefined) messages.push({role:'user',content:`Assessment from ${id}:\n${JSON.stringify({assessment:out.assessment,issues:out.issues})}`});
      continue;
    }
    const m = evidence(out); if (!m || contextMessages.has(JSON.stringify(m))) continue;
    // Inference advice never impersonates a real tool observation.
    if (nodesTemplate(spec,id) === 'observe') messages.push({...m,metadata:{...m.metadata,actionRequestId:out.callId}});
    else messages.push({role:'user',content:`Result from ${id} (reasoning, not evidence of tool effects):\n${text(m)}`});
  }
  const request = {model,generation:config.generation,metadata,messages};
  switch (n.template) {
    case 'context': return {sources:[{id:`${task.id}:task`,content:task.prompt,metadata:{role:'user'}},...(config.includeTaskMetadata?[{id:`${task.id}:metadata`,content:task.metadata,metadata:{role:'user'}}]:[])]};
    case 'sample': case 'actor': {
      if(n.template==='actor')assertCompleteActionHistory(messages);
      return {...request,messages:[...(config.instruction ? [{role:'system',content:config.instruction}] : []),...messages], ...(n.template === 'actor' ? {actions:tools} : {})};
    }
    case 'cot': return {...request,objective:config.instruction,strategy:{name:config.strategy,options:config.options},constraints:{maxSteps:config.maxSteps}};
    case 'critique':case 'verify': case 'revise': {
      const target = targetEntry && message(targetEntry[1]); if (!target) throw new Error('No explicitly wired reflection target');
      const targetNodeId=targetEntry[1].answerSourceNodeId??targetEntry[0];
      const feedback=values.flatMap(out=>out.checkerAudit&&out.checkerAudit.mode!=='revise'&&out.checkerAudit.targetNodeId===targetNodeId&&out.checkerAudit.originalAnswer===text(target)?[out.checkerAudit]:[]);
      const criteria=[checkerContract(task.dataset),...config.criteria];
      bindings.set(n.id,{target,targetNodeId,feedback,criteria});
      return {...request,target:{result:target},mode:config.mode,criteria:criteria.map((description:string,i:number)=>({id:`criterion-${i}`,description,weight:1})),context:feedback.length?[{id:'checker-feedback',content:{originalAnswerNodeId:targetNodeId,originalAnswer:target,checks:feedback}}]:[]};
    }
    case 'select': case 'merge': case 'consensus':case 'debate': return {...request,mode:config.mode,candidates:Object.entries(deps).filter(([,out])=>!!message(out)).map(([id,out])=>({id,result:message(out)}))};
    case 'act': {
      const calls = Object.entries(deps).filter(([id])=>nodesTemplate(spec,id)==='actor').flatMap(([id,out])=>(out.actionRequests ?? []).map((call:ToolCall)=>({id,call})));
      const call = calls.find(({id,call}) => !consumed.has(`${id}\0${call.id}`))?.call; if (!call) throw new Error('ACT has no pending explicitly wired action');
      return {call};
    }
    case 'observe': { const external = values.find(out => typeof out.callId === 'string' && !out.message); if (!external) throw new Error('OBSERVE missing real tool result'); return {result:external}; }
    case 'update': {
      if (!context) throw new Error('UPDATE missing context');
      const add: ContextItem[] = [];
      const existing = new Set(context.items.map(item=>item.id));
      for (const [id,out] of Object.entries(deps)) {
        if (isContext(out)) continue;
        const m = evidence(out); if (!m) continue;
        const isObservation = nodesTemplate(spec,id) === 'observe';
        const key = `${id}:${outputId(out)}`; if (existing.has(key)) continue;
        const meta: Record<string,any> = {role:m.role,...m.metadata,...(isObservation?{actionRequestId:out.callId}:{})};
        if (out.actionRequests?.length) { meta.provider='openai-compatible'; meta.actionRequests=out.actionRequests; }
        add.push({id:key,content:m.content as ContextItem["content"],metadata:meta});
      }
      return {context,add};
    }
    case 'output': { const m = values.map(message).filter(Boolean).at(-1); if (!m) throw new Error('OUTPUT missing result'); return {deliveryId:`${task.id}:${n.id}:${randomUUID()}`,message:m}; }
    default: throw new Error('Unknown fixed node template');
  }
}
function nodesTemplate(spec: OrganizationSpec, id: string): string { return spec.nodes.find(n=>n.id===id)!.template; }
function assertCompleteActionHistory(messages:readonly Message[]):void {
  let pending=new Set<string>();
  for(const m of messages){
    if(m.role==='assistant'){
      if(pending.size)throw Error('Missing tool observations before the next actor turn');
      const calls=m.metadata?.actionRequests as ToolCall[]|undefined;
      pending=new Set(calls?.map(c=>c.id)??[]);
    }else if(m.role==='tool'){
      const id=m.metadata?.actionRequestId;
      if(typeof id!=='string'||!pending.delete(id))throw Error('Tool observation lacks its pending actor callId or was duplicated');
    }
  }
  if(pending.size)throw Error('Missing tool observations before the next actor turn');
}
function contextMessage(item: ContextItem): Message { return {role:(item.metadata?.role ?? 'user') as Message['role'],content:(typeof item.content === "string" || Array.isArray(item.content) ? item.content : JSON.stringify(item.content)),...(item.metadata?{metadata:item.metadata}:{})}; }
function matches(c: OutputCondition, state: State): boolean {
  const out = state.outputs[c.sourceNodeId];
  if (c.operator === 'has-pending-actions' || c.operator === 'no-pending-actions') {
    const pending = (out?.actionRequests as ToolCall[]|undefined)?.some(call=>!state.consumed.has(`${c.sourceNodeId}\0${call.id}`)) ?? false;
    return c.operator === 'has-pending-actions' ? pending : !pending;
  }
  let value: unknown = out;
  for (const part of c.path ?? []) { value = value && typeof value === 'object' && Object.hasOwn(value,part) ? (value as Output)[part] : undefined; }
  if (c.operator === 'truthy') return !!value; if (c.operator === 'falsy') return !value;
  return c.operator === 'equals' ? isDeepStrictEqual(value,c.value) : !isDeepStrictEqual(value,c.value);
}
function next(t: GraphTransition, state: State): string | undefined {
  if (t.kind === 'end') return undefined;
  if (t.kind === 'next') return t.graphId;
  if (t.kind === 'switch') return t.cases.find(c=>matches(c.when,state))?.graphId ?? t.defaultGraphId;
  return matches(t.until,state) || (state.visits[t.graphId]??0) >= t.maxVisits ? t.nextGraphId : t.graphId;
}
