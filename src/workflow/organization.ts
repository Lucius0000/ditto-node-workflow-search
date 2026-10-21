import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentPlanSpec, GraphTransition, WorkflowNodeSpec } from '../domain.js';
import { GENERATION } from '../protocol.js';
import type { OrganizationSpec } from './organization-types.js';
import { validateNode as validateWorkflowNode } from './spec.js';
import { validateCheckerCriteria, validateCheckerDependencies } from './checker-policy.js';
import { baselinePrompts } from '../benchmark/baseline-prompts.js';
import { EXPERIMENT_EXECUTION } from '../model-profile.js';

export const ORGANIZATION_VERSION = 'sampled-parent-staged-configuration-v4';
export const AUTOMATION_INSTRUCTION = `Complete the requested business workflow in the official simulated APIs.
Discover precise endpoints with api_search; read each endpoint's method, parameter names and response schema before api_fetch.
api_fetch params and body must be JSON-encoded strings or null, never JSON objects. api_search requires an integer top_k. When a tool reports invalid arguments, correct the request and retry its intended action; preserve already successful effects.
Resolve names to real record IDs; follow pagination and cross-application identifiers. Keep filters, exact values, recipients, formatting, dates and conditions from the user's task.
Copy source field values exactly, including punctuation in phone numbers and identifiers. Do not normalize or reformat values unless the task explicitly requests it. Verify documented response field names before treating an absent or differently named field as a failed write.
Inspect current state before writes; every agent shares this task's world. Reuse completed work, never recreate records or repeat successful sends.
After each consequential write, inspect the resulting state and verify every requested postcondition. Repair concrete missing effects; do not replace tool execution with prose.
Only API observations and the user's request are evidence. Grading references and hidden world snapshots are unavailable. Summarize completed effects, identifiers and any specific blocker concisely. Planning, role-design and ranking stages must follow their requested control format, propose concrete dependencies and checks, and never claim unexecuted effects.`;
export interface NodeTemplate {
  readonly type: WorkflowNodeSpec['type'];
  readonly config: Readonly<Record<string, unknown>>;
  readonly description: string;
}
/** Config fields follow the existing workflow Node contracts; generation is fixed. */
export function nodeCatalog(dataset: OrganizationSpec['dataset']): Readonly<Record<string, NodeTemplate>> {
  if (!['humaneval', 'mbpp','automationbench'].includes(dataset)) throw Error('Organization supports only HumanEval, MBPP and AutomationBench');
  const generation = GENERATION;
  const reflect = (mode: string): NodeTemplate => ({type:'INFER.REASONING.REFLECT', config:{generation,mode,criteria:[dataset==='automationbench'?'Check the public task and observed tool evidence without claiming unobserved effects.':'Check the public task requirements against the supplied code; do not invent requirements.']},description:'Assess or revise the explicitly wired target; no execution or private tests.'});
  const deliberate = (mode: string): NodeTemplate => ({type:'INFER.REASONING.DELIBERATE',config:{generation,mode},description:'Compare at least two explicitly wired answer results.'});
  return {
    context:{type:'CONTEXT.LOAD',config:{includeTaskMetadata:false},description:'Load the original public task.'},
    sample:{type:'INFER.REASONING.SAMPLE',config:{generation,role:'solver',instruction:dataset==='automationbench'?AUTOMATION_INSTRUCTION:baselinePrompts(dataset)!.agent},description:'Generate an answer from the public task and explicitly wired evidence.'},
    cot:{type:'INFER.REASONING.TRAJECTORY',config:{generation,instruction:dataset==='automationbench'?'Reason about the original public automation task using actual supplied observations; do not claim unexecuted effects.':'Solve the original public coding task using the supplied evidence.',strategy:'cot',options:{rounds:1},maxSteps:EXPERIMENT_EXECUTION.maxSteps},description:'Choose any supported reasoning strategy and its legal options; no tools.'},
    critique:reflect('critique'),verify:reflect('verify'),revise:reflect('revise'),
    select:deliberate('select'),merge:deliberate('merge'),consensus:deliberate('consensus'),debate:deliberate('debate'),
    ...(dataset==='automationbench'?{
      actor:{type:'INFER.REASONING.SAMPLE' as const,config:{generation,role:'solver',instruction:AUTOMATION_INSTRUCTION},description:'Infer with the fixed official tool schemas and explicitly bound context.'},
      act:{type:'INTERACTION.ACT.TOOL' as const,config:{template:'act'},description:'Execute one directly wired pending official action once.'},
      observe:{type:'INTERACTION.OBSERVE' as const,config:{template:'observe'},description:'Convert the real ACT result, retaining its callId.'},
      update:{type:'CONTEXT.UPDATE' as const,config:{template:'update'},description:'Append directly wired assistant requests and real observations to context.'},
      output:{type:'INTERACTION.OUTPUT' as const,config:{template:'output'},description:'Deliver the explicitly wired result without scoring the world.'},
    }:{}),
  };
}

/** Resolve a binding with the same field/behavior constraints as the main Node path. */
export function nodeDefinition(dataset:OrganizationSpec['dataset'], binding:OrganizationSpec['nodes'][number], graphId:string):WorkflowNodeSpec {
  const template=nodeCatalog(dataset)[binding.template];
  if(!template)throw Error('Unknown node template');
  if(binding.config!==undefined&&(!object(binding.config)))throw Error('Node config must be an object');
  const config={...structuredClone(template.config),...structuredClone(binding.config??{})};
  if(!template.type.startsWith('INFER.')&&template.type!=='CONTEXT.LOAD'){
    if(dataset!=='automationbench'||!isDeepStrictEqual(config,template.config))throw Error('Fixed tool/context operation configuration cannot change');
    return {id:binding.id,type:template.type,config,dependencies:[...binding.dependencies],graphId} as unknown as WorkflowNodeSpec;
  }
  const fields:Record<string,readonly string[]>={
    'CONTEXT.LOAD':['includeTaskMetadata'],
    'INFER.REASONING.SAMPLE':['role','instruction','generation'],
    'INFER.REASONING.TRAJECTORY':['instruction','strategy','options','generation','maxSteps'],
    'INFER.REASONING.REFLECT':['mode','criteria','generation'],
    'INFER.REASONING.DELIBERATE':['mode','generation'],
  };
  keys(config,fields[template.type]!);
  if(template.type==='CONTEXT.LOAD'){
    if(typeof config.includeTaskMetadata!=='boolean'||binding.dependencies.length)throw Error('Invalid CONTEXT.LOAD configuration');
  }else if(!isDeepStrictEqual(config.generation,GENERATION))throw Error('Generation parameters are fixed by the code-search protocol');
  if(template.type==='INFER.REASONING.SAMPLE'&&(!['solver','finalizer'].includes(config.role as string)||typeof config.instruction!=='string'))throw Error('Invalid SAMPLE configuration');
  if(template.type==='INFER.REASONING.TRAJECTORY'&&(typeof config.instruction!=='string'||!object(config.options)))throw Error('Invalid TRAJECTORY configuration');
  if(template.type==='INFER.REASONING.REFLECT'&&(!Array.isArray(config.criteria)||config.criteria.some(c=>typeof c!=='string')))throw Error('Invalid REFLECT criteria');
  const validationGraph=template.type==='CONTEXT.LOAD'?'prepare':template.type==='INFER.REASONING.REFLECT'?'refine':'solve';
  validateWorkflowNode({id:binding.id,type:template.type,config,dependencies:binding.dependencies,graphId:validationGraph} as unknown as WorkflowNodeSpec);
  if(template.type==='INFER.REASONING.REFLECT')validateCheckerCriteria(dataset,config.criteria as string[]);
  return {id:binding.id,type:template.type,config,dependencies:[...binding.dependencies],graphId} as unknown as WorkflowNodeSpec;
}
export function bindingMode(dataset:OrganizationSpec['dataset'],binding:OrganizationSpec['nodes'][number]):string|undefined {
  return ({...nodeCatalog(dataset)[binding.template]!.config,...binding.config}).mode as string|undefined;
}
export function guaranteesResult(dataset:OrganizationSpec['dataset'],binding:OrganizationSpec['nodes'][number]):boolean {
  const type=nodeCatalog(dataset)[binding.template]!.type;
  return ['INFER.REASONING.SAMPLE','INFER.REASONING.TRAJECTORY','INFER.REASONING.DELIBERATE','INTERACTION.OUTPUT'].includes(type)||type==='INFER.REASONING.REFLECT'&&bindingMode(dataset,binding)==='revise';
}

const safeId = /^[a-z][a-z0-9-]{0,63}$/;
const operators = new Set(['equals', 'not-equals', 'truthy', 'falsy','has-pending-actions','no-pending-actions']);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: Record<string, any>, allowed: readonly string[]): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Organization contains an unsupported field');
}

export function validateOrganization(value: unknown): asserts value is OrganizationSpec {
  if (!object(value)) throw new Error('Organization must be an object');
  keys(value, ['version', 'dataset', 'nodes', 'graphs', 'entryGraphId', 'transitions', 'outputNodeId', 'outputByGraph']);
  if (value.version !== 1 || !['humaneval', 'mbpp','automationbench'].includes(value.dataset)) throw new Error('Unknown organization protocol');
  const catalog = nodeCatalog(value.dataset);
  if (!Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 24) throw new Error('Organization needs 1..24 real nodes');
  const nodes = new Map<string, OrganizationSpec['nodes'][number]>();
  for (const n of value.nodes) {
    if (!object(n)) throw new Error('Invalid node'); keys(n, ['id', 'template', 'dependencies', 'feedback', 'targetNodeId', 'config']);
    if (typeof n.id !== 'string' || !safeId.test(n.id) || nodes.has(n.id) || !Object.hasOwn(catalog, n.template)) throw new Error('Invalid/duplicate node or template');
    if (!Array.isArray(n.dependencies) || n.dependencies.some((d: unknown) => typeof d !== 'string') || new Set(n.dependencies).size !== n.dependencies.length) throw new Error('Invalid dependencies');
    if (n.feedback !== undefined && (!Array.isArray(n.feedback) || n.feedback.some((d: unknown) => typeof d !== 'string') || new Set(n.feedback).size !== n.feedback.length)) throw new Error('Invalid previous-iteration feedback');
    nodeDefinition(value.dataset,n as OrganizationSpec['nodes'][number],'validation');
    nodes.set(n.id, n as OrganizationSpec['nodes'][number]);
  }
  for (const n of nodes.values()) if (n.feedback?.some(d => !nodes.has(d))) throw new Error('Unknown feedback source');
  for(const n of nodes.values())if(n.targetNodeId!==undefined){
    if(catalog[n.template]!.type!=='INFER.REASONING.REFLECT'||typeof n.targetNodeId!=='string'||!n.dependencies.includes(n.targetNodeId))
      throw new Error('Reflection target must name a direct dependency of a verify/revise node');
    if((!nodes.has(n.targetNodeId)||!guaranteesResult(value.dataset,nodes.get(n.targetNodeId)!)))
      throw new Error('Reflection target must guarantee a result; assessments and optional revisions are evidence only');
  }
  if (!nodes.has(value.outputNodeId) || !guaranteesResult(value.dataset,nodes.get(value.outputNodeId)!)) throw new Error('Output must name a result-producing node');
  if (!Array.isArray(value.graphs) || value.graphs.length < 1 || value.graphs.length > 24) throw new Error('Invalid graphs');
  const owner = new Map<string, string>(); const graphIds = new Set<string>();
  for (const g of value.graphs) {
    if (!object(g)) throw new Error('Invalid graph'); keys(g, ['id', 'nodeIds']);
    if (!safeId.test(g.id) || graphIds.has(g.id) || !Array.isArray(g.nodeIds) || !g.nodeIds.length) throw new Error('Invalid/duplicate graph');
    if(g.nodeIds.filter((id:string)=>nodes.get(id)?.template==='act').length>1)throw Error('Sequential ACT operations require separate Graph commits to consume pending callIds exactly once');
    graphIds.add(g.id); const seen = new Set<string>();
    for (const id of g.nodeIds) {
      const n = nodes.get(id); if (!n || owner.has(id)) throw new Error('Unknown or multiply assigned node');
      for (const d of n.dependencies) if (!nodes.has(d)) throw new Error('Unknown dependency');
      for (const d of n.dependencies) if (g.nodeIds.includes(d) && !seen.has(d)) throw new Error('Local dependencies must precede their consumer');
      owner.set(id, g.id); seen.add(id);
    }
  }
  if (owner.size !== nodes.size || !graphIds.has(value.entryGraphId) || !object(value.transitions)) throw new Error('Incomplete graph/entry assignments');
  const missingTransitions = [...graphIds].filter(id => !Object.hasOwn(value.transitions, id));
  const undeclaredTransitionGraphs = Object.keys(value.transitions).filter(id => !graphIds.has(id));
  if (missingTransitions.length || undeclaredTransitionGraphs.length) throw new Error(`Exactly one transition per graph is required; missing transitions for declared graphs: ${JSON.stringify(missingTransitions)}; transitions reference undeclared graphs: ${JSON.stringify(undeclaredTransitionGraphs)}. Declare each referenced graph with nonempty nodeIds or remove/rewire its transition.`);
  const edges = new Map<string, string[]>();
  const condition = (c: unknown): void => {
    if (!object(c)) throw new Error('Invalid condition'); keys(c, ['sourceNodeId', 'path', 'operator', 'value']);
    if (!nodes.has(c.sourceNodeId) || !operators.has(c.operator) || (c.path !== undefined && (!Array.isArray(c.path) || c.path.length > 8 || c.path.some((p: unknown) => typeof p !== 'string' || ['__proto__','constructor','prototype'].includes(p))))) throw new Error('Invalid condition source/operator/path');
    const sourceTemplate = nodes.get(c.sourceNodeId)!.template;
    if(['has-pending-actions','no-pending-actions'].includes(c.operator)&&(value.dataset!=='automationbench'||sourceTemplate!=='actor'||c.path!==undefined||c.value!==undefined))throw Error('Pending-action conditions require the directly observed Automation actor');
    if (catalog[sourceTemplate]!.type==='INFER.REASONING.REFLECT' && c.path?.length) {
      if (!['assessment','issues','revisedResult','usage'].includes(c.path[0]))
        throw new Error(`Unknown REFLECT output path ${JSON.stringify(c.path)} on ${c.sourceNodeId}; the pass flag is at ["assessment","passed"], not ["passed"].`);
      if (c.path[0] === 'assessment' && c.path.length > 1 && (!['passed','summary'].includes(c.path[1]) || c.path.length > 2))
        throw new Error(`Unknown REFLECT assessment path ${JSON.stringify(c.path)}; use ["assessment","passed"] for the boolean decision.`);
    }
  };
  for (const [id, t] of Object.entries(value.transitions)) {
    if (!graphIds.has(id) || !object(t)) throw new Error('Invalid transition source');
    const targets: string[] = [];
    if (t.kind === 'end') keys(t, ['kind']);
    else if (t.kind === 'next') { keys(t, ['kind','graphId']); targets.push(t.graphId); }
    else if (t.kind === 'switch') {
      keys(t, ['kind','cases','defaultGraphId']);
      if (!Array.isArray(t.cases) || t.cases.length > 24) throw new Error('Invalid switch');
      for (const c of t.cases) { if (!object(c)) throw new Error('Invalid switch case'); keys(c, ['when','graphId']); condition(c.when); targets.push(c.graphId); }
      if (t.defaultGraphId !== undefined) targets.push(t.defaultGraphId);
    } else if (t.kind === 'repeat') {
      keys(t, ['kind','graphId','maxVisits','until','nextGraphId']); condition(t.until);
      if (!Number.isSafeInteger(t.maxVisits) || t.maxVisits < 1) throw new Error('Invalid repeat bound');
      targets.push(t.graphId); if (t.nextGraphId !== undefined) targets.push(t.nextGraphId);
    } else throw new Error('Unsupported transition');
    if (targets.some(target => !graphIds.has(target))) throw new Error(`Unknown transition target from ${id}: ${JSON.stringify(targets.filter(target => !graphIds.has(target)))}. Every target must be declared in graphs with nonempty nodeIds.`);
    edges.set(id, targets);
  }
  if (value.outputByGraph !== undefined) {
    if (!object(value.outputByGraph)) throw new Error('Invalid outputByGraph');
    for (const [graphId, nodeId] of Object.entries(value.outputByGraph)) {
      const t = value.transitions[graphId];
      if (!graphIds.has(graphId) || !t || !(t.kind === 'end' || t.kind === 'switch' && !t.defaultGraphId || t.kind === 'repeat' && !t.nextGraphId))
        throw new Error(`Branch output must belong to a potentially terminating graph: outputByGraph[${graphId}] is invalid because its transition is ${JSON.stringify(t)}. Only end, switch without defaultGraphId, or repeat without nextGraphId can terminate. outputByGraph selects a result when execution terminates; it does not stop a next/switch transition or prevent graph re-execution.`);
      if (typeof nodeId !== 'string' || !nodes.has(nodeId) || !guaranteesResult(value.dataset,nodes.get(nodeId)!))
        throw new Error('Branch output must guarantee a result, never an optional checker revision');
    }
  }
  const noProgress = new Set(value.graphs.filter((g: any) => !g.nodeIds.some((id: string) => catalog[nodes.get(id)!.template]!.type.startsWith('INFER.')||nodes.get(id)!.template==='act')).map((g: any) => g.id));
  const active = new Set<string>(), done = new Set<string>();
  const checkCycle = (id: string): void => {
    if (!noProgress.has(id) || done.has(id)) return;
    if (active.has(id)) throw new Error('A cycle must contain a model execution node');
    active.add(id); for (const target of edges.get(id) ?? []) checkCycle(target); active.delete(id); done.add(id);
  };
  for (const id of graphIds) checkCycle(id);
  const reachable = new Set<string>(); const visit = (id: string): void => { if (reachable.has(id)) return; reachable.add(id); for (const target of edges.get(id) ?? []) visit(target); };
  visit(value.entryGraphId); if (reachable.size !== graphIds.size) throw new Error('Unreachable graph');
  // Definite availability at graph entry: intersect all predecessors, including cycles.
  const predecessors = new Map([...graphIds].map(id => [id, [...edges].filter(([, targets]) => targets.includes(id)).map(([from]) => from)]));
  const available = new Map([...graphIds].map(id => [id, id === value.entryGraphId ? new Set<string>() : new Set(nodes.keys())]));
  let changed = true;
  while (changed) { changed = false; for (const id of graphIds) {
    if (id === value.entryGraphId) continue;
    const pred = predecessors.get(id)!;
    const sets = pred.map(p => new Set([...available.get(p)!, ...value.graphs.find((g: any) => g.id === p)!.nodeIds]));
    const next = new Set([...nodes.keys()].filter(n => sets.length && sets.every(set => set.has(n))));
    if (next.size !== available.get(id)!.size) { available.set(id, next); changed = true; }
  } }
  for (const g of value.graphs) {
    validateCheckerDependencies(g.nodeIds.map((id:string)=>nodeDefinition(value.dataset,nodes.get(id)!,g.id)));
    const known = new Set(available.get(g.id));
    for (const id of g.nodeIds) {
      const n = nodes.get(id)!;
      if (n.dependencies.some(d => !known.has(d))) throw new Error(`Node ${id} has an unavailable dependency`);
      if (catalog[n.template]!.type==='INFER.REASONING.REFLECT' && !n.dependencies.some(id=>guaranteesResult(value.dataset,nodes.get(id)!))) throw new Error('Reflection requires an explicit result dependency');
      if (catalog[n.template]!.type==='INFER.REASONING.DELIBERATE' && n.dependencies.filter(id=>guaranteesResult(value.dataset,nodes.get(id)!)).length < 2) throw new Error('Deliberation requires two explicit results');
      const types=n.dependencies.map(id=>nodes.get(id)!.template);
      if(n.template==='act'&&!types.includes('actor'))throw Error('ACT requires a directly wired actor');
      if(n.template==='observe'&&types.filter(t=>t==='act').length!==1)throw Error('OBSERVE requires exactly one directly wired ACT');
      if(n.template==='update'&&!types.some(t=>t==='context'||t==='update'))throw Error('UPDATE requires a directly wired context');
      if(n.template==='output'&&!n.dependencies.some(id=>guaranteesResult(value.dataset,nodes.get(id)!)&&nodes.get(id)!.template!=='output'))throw Error('OUTPUT requires a directly wired answer');
      known.add(id);
    }
    const t = value.transitions[g.id];
    const conditions = t.kind === 'switch' ? t.cases.map((c: any) => c.when) : t.kind === 'repeat' ? [t.until] : [];
    if (conditions.some((c: any) => !known.has(c.sourceNodeId))) throw new Error('Transition condition source is unavailable');
    if ((t.kind === 'end' || t.kind === 'switch' && !t.defaultGraphId || t.kind === 'repeat' && !t.nextGraphId) && !known.has(value.outputByGraph?.[g.id] ?? value.outputNodeId)) throw new Error('A terminating graph must have the declared output available');
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)]));
  return value;
}
function normalized(spec: OrganizationSpec): OrganizationSpec {
  return canonical({...spec,nodes:[...spec.nodes].sort((a,b)=>a.id.localeCompare(b.id)),graphs:[...spec.graphs].sort((a,b)=>a.id.localeCompare(b.id))}) as OrganizationSpec;
}
export function organizationHash(spec: OrganizationSpec): string {
  return createHash('sha256').update(JSON.stringify(normalized(spec))).digest('hex');
}
/** New search proposals cannot delegate target choice to dependency order.
 * Legacy plans remain readable under their original execution identity.
 */
export function requireExplicitReflectionTargets(spec:OrganizationSpec):void {
  if(spec.nodes.some(n=>nodeCatalog(spec.dataset)[n.template]!.type==='INFER.REASONING.REFLECT'&&n.targetNodeId===undefined))
    throw new Error('New reflection proposals require targetNodeId naming a direct result dependency');
}
export function buildOrganizationPlan(spec: OrganizationSpec, leaf = 'search-001'): AgentPlanSpec {
  validateOrganization(spec);
  requireExplicitReflectionTargets(spec);
  spec = normalized(spec);
  const nodes = spec.nodes.map(n => nodeDefinition(spec.dataset,n,spec.graphs.find(g => g.nodeIds.includes(n.id))!.id));
  return { id: `plan-${organizationHash(spec).slice(0,16)}`, leafSearchNodeId: leaf, nodes, graphs: structuredClone(spec.graphs),
    loop: { entryGraphId: spec.entryGraphId, transitions: structuredClone(spec.transitions), maxGraphRuns: Number.MAX_SAFE_INTEGER }, outputNodeId: spec.outputNodeId, organization: structuredClone(spec) };
}
export function validateOrganizationPlan(plan: AgentPlanSpec): void {
  if (!plan.organization || !isDeepStrictEqual(plan, buildOrganizationPlan(plan.organization, plan.leafSearchNodeId))) throw new Error('Plan differs from its fixed capability catalog or declared organization');
}
export function initialOrganization(dataset: OrganizationSpec['dataset']): OrganizationSpec {
  if(dataset==='automationbench')return {version:1,dataset,nodes:[
    {id:'context',template:'context',dependencies:[]},{id:'actor',template:'actor',dependencies:['context'],feedback:['update']},
    {id:'act',template:'act',dependencies:['actor']},{id:'observe',template:'observe',dependencies:['act']},
    {id:'update',template:'update',dependencies:['context','actor','observe'],feedback:['update']},{id:'output',template:'output',dependencies:['actor']},
  ],graphs:[{id:'prepare',nodeIds:['context']},{id:'reason',nodeIds:['actor']},{id:'tools',nodeIds:['act','observe','update']},{id:'finish',nodeIds:['output']}],entryGraphId:'prepare',transitions:{
    prepare:{kind:'next',graphId:'reason'},reason:{kind:'switch',cases:[{when:{sourceNodeId:'actor',operator:'has-pending-actions'},graphId:'tools'}],defaultGraphId:'finish'},
    tools:{kind:'switch',cases:[{when:{sourceNodeId:'actor',operator:'has-pending-actions'},graphId:'tools'}],defaultGraphId:'reason'},finish:{kind:'end'},
  },outputNodeId:'output'};
  return {version:1,dataset,nodes:[{id:'context',template:'context',dependencies:[]},{id:'sample-1',template:'sample',dependencies:['context'],config:{instruction:baselinePrompts(dataset)!.agent}}],graphs:[{id:'solve',nodeIds:['context','sample-1']}],entryGraphId:'solve',transitions:{solve:{kind:'end'}},outputNodeId:'sample-1'};
}
