import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import type {AgentPlanSpec, EvaluationSummary, SearchTreeNode, WorkflowNodeSpec} from '../domain.js';
import type {OrganizationSpec} from '../workflow/organization-types.js';
import {buildOrganizationPlan, nodeCatalog, organizationHash, requireExplicitReflectionTargets,nodeDefinition,guaranteesResult} from '../workflow/organization.js';

export type Binding = OrganizationSpec['nodes'][number];
export type Assembly = Pick<OrganizationSpec,'graphs'|'entryGraphId'|'transitions'|'outputNodeId'|'outputByGraph'>;
export interface ConstructionBranch {
  readonly id:string;
  readonly baseBranchId:string|null;
  readonly leafVertexId:string;
  readonly nodes:readonly Binding[];
  readonly vertexByNode:Readonly<Record<string,string>>;
  readonly assembly?:Assembly;
}
export interface NodeExpansion {
  readonly baseBranchId:string;
  readonly anchorNodeId:string;
  readonly operation:'add'|'replace'|'rewire'|'remove'|'organize';
  readonly node?:Binding;
  readonly removeNodeId?:string;
  /** Omit while constructing. Supply the complete Graph/Loop wiring to evaluate. */
  readonly assembly?:Assembly;
}
export interface WorkflowEvaluation {
  readonly id:string;
  readonly branchId:string;
  readonly leafVertexId:string;
  readonly nodeVertexIds:readonly string[];
  readonly plan:AgentPlanSpec;
  readonly topologyHash:string;
  readonly evaluation:EvaluationSummary;
}
export interface NodeConstructionState {
  readonly version:1;
  readonly dataset:OrganizationSpec['dataset'];
  readonly branches:readonly ConstructionBranch[];
  readonly evaluations:readonly WorkflowEvaluation[];
  readonly bestEvaluationId:string;
  readonly nextVertex:number;
  readonly nextBranch:number;
  readonly nextEvaluation:number;
  readonly constructionStepsSinceEvaluation:number;
  readonly pending?:{readonly branchId:string;readonly plan:AgentPlanSpec};
}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const allowed=(v:Record<string,any>,keys:readonly string[])=>{if(Object.keys(v).some(k=>!keys.includes(k)))throw Error('Unsupported construction field; only fixed node bindings and assembly are allowed');};
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(v);

export function validateExpansion(value:unknown):asserts value is NodeExpansion {
  if(!object(value))throw Error('Expansion must be an object');
  allowed(value,['baseBranchId','anchorNodeId','operation','node','removeNodeId','assembly']);
  if(!validId(value.baseBranchId)||!validId(value.anchorNodeId)||!['add','replace','rewire','remove','organize'].includes(value.operation))throw Error('Invalid construction branch/anchor/operation');
  if(['add','replace','rewire'].includes(value.operation)){
    if(!object(value.node))throw Error('Node operation requires exactly one real node binding');
    allowed(value.node,['id','template','dependencies','feedback','targetNodeId','config']);
    if(!validId(value.node.id)||typeof value.node.template!=='string'||!Array.isArray(value.node.dependencies)||value.node.dependencies.some((d:unknown)=>!validId(d)))throw Error('Invalid fixed node binding');
    for(const key of ['dependencies','feedback'])if(value.node[key]!==undefined&&(!Array.isArray(value.node[key])||value.node[key].some((d:unknown)=>!validId(d))||new Set(value.node[key]).size!==value.node[key].length))throw Error('Invalid/duplicate node dependencies or feedback');
    if(value.node.targetNodeId!==undefined&&!validId(value.node.targetNodeId))throw Error('Invalid reflection target');
    if(value.removeNodeId!==undefined)throw Error('Cannot combine node and removal operations');
  }else if(value.node!==undefined)throw Error('Only add/replace/rewire creates a node version');
  if(value.operation==='remove'&&!validId(value.removeNodeId))throw Error('remove requires removeNodeId');
  if(value.operation!=='remove'&&value.removeNodeId!==undefined)throw Error('Unexpected removal');
  if(value.operation==='organize'&&value.assembly===undefined)throw Error('organize requires complete assembly');
  if(value.assembly!==undefined){
    if(!object(value.assembly))throw Error('Invalid Graph/Loop assembly');
    allowed(value.assembly,['graphs','entryGraphId','transitions','outputNodeId','outputByGraph']);
  }
}

export function organizationFor(dataset:OrganizationSpec['dataset'],branch:ConstructionBranch):OrganizationSpec {
  if(!branch.assembly)throw Error('Construction is not assembled into an executable workflow');
  return {version:1,dataset,nodes:branch.nodes,...branch.assembly};
}

/** Ignore cosmetic instance/graph renames, retain dependency order and control semantics. */
export function executionTopologyHash(spec:OrganizationSpec):string {
  const graphOrder:string[]=[];
  const visit=(id:string)=>{
    if(graphOrder.includes(id))return;graphOrder.push(id);
    const t=spec.transitions[id]!;
    if(t.kind==='next')visit(t.graphId);
    if(t.kind==='switch'){for(const c of t.cases)visit(c.graphId);if(t.defaultGraphId)visit(t.defaultGraphId);}
    if(t.kind==='repeat'){visit(t.graphId);if(t.nextGraphId)visit(t.nextGraphId);}
  };
  visit(spec.entryGraphId);
  const gs=new Map(graphOrder.map((id,i)=>[id,`g${i}`]));
  const nodeOrder=graphOrder.flatMap(id=>spec.graphs.find(g=>g.id===id)!.nodeIds);
  const ns=new Map(nodeOrder.map((id,i)=>[id,`n${i}`]));
  const condition=(c:any)=>({...c,sourceNodeId:ns.get(c.sourceNodeId)});
  const transitions=Object.fromEntries(graphOrder.map(id=>{
    const t=spec.transitions[id]!;let v:any;
    if(t.kind==='end')v=t;
    else if(t.kind==='next')v={...t,graphId:gs.get(t.graphId)};
    else if(t.kind==='switch')v={...t,cases:t.cases.map(c=>({...c,when:condition(c.when),graphId:gs.get(c.graphId)})),...(t.defaultGraphId?{defaultGraphId:gs.get(t.defaultGraphId)}:{})};
    else v={...t,graphId:gs.get(t.graphId),until:condition(t.until),...(t.nextGraphId?{nextGraphId:gs.get(t.nextGraphId)}:{})};
    return [gs.get(id)!,v];
  }));
  return organizationHash({...spec,nodes:spec.nodes.map(n=>({...n,template:nodeCatalog(spec.dataset)[n.template]!.type,config:nodeDefinition(spec.dataset,n,'hash').config,id:ns.get(n.id)!,dependencies:n.dependencies.map(d=>ns.get(d)!),
    ...(n.feedback?{feedback:n.feedback.map(d=>ns.get(d)!)}:{}),...(n.targetNodeId?{targetNodeId:ns.get(n.targetNodeId)!}:{})})),
    graphs:graphOrder.map(id=>({id:gs.get(id)!,nodeIds:spec.graphs.find(g=>g.id===id)!.nodeIds.map(n=>ns.get(n)!)})),
    entryGraphId:gs.get(spec.entryGraphId)!,transitions,outputNodeId:ns.get(spec.outputNodeId)!,
    ...(spec.outputByGraph?{outputByGraph:Object.fromEntries(Object.entries(spec.outputByGraph).map(([g,n])=>[gs.get(g)!,ns.get(n)!]))}:{})});
}

export function prepareExpansion(dataset:OrganizationSpec['dataset'],base:ConstructionBranch,proposal:NodeExpansion,
  branchId:string,vertexId:string,maxNodes:number):{branch:ConstructionBranch;node?:WorkflowNodeSpec;parentVertexId?:string;plan?:AgentPlanSpec} {
  validateExpansion(proposal);
  if(proposal.baseBranchId!==base.id)throw Error(`Unknown baseBranchId ${proposal.baseBranchId}; selected construction is ${base.id}`);
  if(!Object.hasOwn(base.vertexByNode,proposal.anchorNodeId))throw Error(`anchorNodeId ${proposal.anchorNodeId} is not an active NODE INSTANCE ID in ${base.id}. Choose exactly one of ${JSON.stringify(Object.keys(base.vertexByNode))}. The mapped node-000xxx values are TREE VERTEX IDs, not anchorNodeId values.`);
  const catalog=nodeCatalog(dataset);const nodes=structuredClone([...base.nodes]);const vertices={...base.vertexByNode};
  let definition:WorkflowNodeSpec|undefined;
  const parentVertexId=vertices[proposal.anchorNodeId]!;
  if(proposal.node){
    const n=proposal.node;
    if(proposal.operation!=='add'&&n.id!==proposal.anchorNodeId)throw Error('replace/rewire must edit its selected anchor node');
    if(!Object.hasOwn(catalog,n.template))throw Error('Unknown fixed template');
    const index=nodes.findIndex(old=>old.id===n.id);
    if(proposal.operation==='add'&&index>=0)throw Error('add requires a new node ID');
    if(proposal.operation!=='add'&&index<0)throw Error('replace/rewire requires an existing node ID');
    if(proposal.operation==='rewire'&&nodes[index]!.template!==n.template)throw Error('rewire cannot change template; use replace');
    if(n.dependencies.includes(n.id))throw Error('A node cannot depend on its own current output');
    const sources=n.dependencies.map(id=>nodes.find(old=>old.id===id));
    if(sources.some(d=>!d))throw Error(`New node binding references unknown input ${JSON.stringify(n.dependencies.filter((_,i)=>!sources[i]))}; add required sources first or rewire a later node version`);
    const type=catalog[n.template]!.type;
    if(type==='INFER.REASONING.REFLECT'&&(!n.targetNodeId||!n.dependencies.includes(n.targetNodeId)))throw Error('Reflection requires an explicit direct targetNodeId');
    if(type==='INFER.REASONING.REFLECT'&&!guaranteesResult(dataset,nodes.find(d=>d.id===n.targetNodeId)!))throw Error('Reflection target must guarantee an answer');
    if(type==='INFER.REASONING.DELIBERATE'&&sources.filter(d=>guaranteesResult(dataset,d!)).length<2)throw Error('Deliberation requires two guaranteed answer sources');
    if(n.targetNodeId!==undefined&&type!=='INFER.REASONING.REFLECT')throw Error('Only reflection nodes have targetNodeId');
    const resolved=nodeDefinition(dataset,n,'unassembled');
    if(proposal.operation==='rewire'&&!isDeepStrictEqual(resolved.config,nodeDefinition(dataset,nodes[index]!,'unassembled').config))throw Error('rewire cannot change config; use replace');
    if(index>=0&&isDeepStrictEqual(nodes[index],n))throw Error('Node edit must change its configuration or inputs');
    if(index<0)nodes.push(structuredClone(n));else nodes[index]=structuredClone(n);
    vertices[n.id]=vertexId;
    const graphId=proposal.assembly?.graphs?.find(g=>g.nodeIds.includes(n.id))?.id??'unassembled';
    definition=nodeDefinition(dataset,n,graphId);
  }else if(proposal.operation==='remove'){
    const index=nodes.findIndex(n=>n.id===proposal.removeNodeId);
    if(index<0||proposal.removeNodeId===proposal.anchorNodeId)throw Error('Remove an existing node other than the retained anchor');
    nodes.splice(index,1);delete vertices[proposal.removeNodeId!];
  }
  if(nodes.length<1||nodes.length>maxNodes)throw Error(`Construction has ${nodes.length} active nodes, maximum ${maxNodes}. Assemble/evaluate an existing construction, remove nodes, or fork another branch instead of continuing to add.`);
  const branch:ConstructionBranch={id:branchId,baseBranchId:base.id,leafVertexId:definition?vertexId:parentVertexId,nodes,vertexByNode:vertices,
    ...(proposal.assembly?{assembly:structuredClone(proposal.assembly)}:{})};
  // Unassembled states can contain dangling links during a multi-step rewrite;
  // complete assembly must pass every original execution/availability check.
  let plan:AgentPlanSpec|undefined;
  if(branch.assembly){const spec=organizationFor(dataset,branch);plan=buildOrganizationPlan(spec);requireExplicitReflectionTargets(spec);}
  return {branch,...(definition?{node:definition,parentVertexId}:{}),...(plan?{plan}:{})};
}

export const constructionHash=(branch:ConstructionBranch):string=>createHash('sha256').update(JSON.stringify({nodes:branch.nodes,assembly:branch.assembly})).digest('hex');
export type RealNodeVertex = SearchTreeNode;
