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
  readonly operation:'add'|'replace'|'rewire'|'remove'|'organize'|'submit';
  readonly node?:Binding;
  readonly removeNodeId?:string;
  /** Assembly alone never submits a candidate. */
  readonly assembly?:Assembly;
  readonly submit?:boolean;
}
export interface WorkflowEvaluation {
  readonly id:string;
  readonly branchId:string;
  readonly leafVertexId:string;
  readonly nodeVertexIds:readonly string[];
  readonly plan:AgentPlanSpec;
  readonly topologyHash:string;
  readonly evaluation:EvaluationSummary;
  readonly parentEvaluationId?:string;
}
export interface ParentSelection {
  readonly parentEvaluationId:string;
  readonly parentBranchId:string;
  readonly pool:readonly {readonly id:string;readonly score:number;readonly probability:number}[];
  readonly randomBefore:number;
  readonly randomAfter:number;
  readonly sample:number;
}
export interface CandidateDraft {
  readonly selection:ParentSelection;
  readonly branchId:string;
  readonly edits:readonly NodeExpansion[];
  readonly submitted:boolean;
}
export interface NodeConstructionState {
  readonly version:2;
  readonly dataset:OrganizationSpec['dataset'];
  readonly branches:readonly ConstructionBranch[];
  readonly evaluations:readonly WorkflowEvaluation[];
  readonly bestEvaluationId:string;
  readonly nextVertex:number;
  readonly nextBranch:number;
  readonly nextEvaluation:number;
  readonly constructionStepsSinceEvaluation:number;
  readonly pending?:{readonly branchId:string;readonly plan:AgentPlanSpec};
  readonly draft?:CandidateDraft;
}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const allowed=(v:Record<string,any>,keys:readonly string[])=>{if(Object.keys(v).some(k=>!keys.includes(k)))throw Error('Unsupported construction field; only fixed node bindings and assembly are allowed');};
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(v);

export function validateExpansion(value:unknown):asserts value is NodeExpansion {
  if(!object(value))throw Error('Expansion must be an object');
  allowed(value,['baseBranchId','anchorNodeId','operation','node','removeNodeId','assembly','submit']);
  if(!validId(value.baseBranchId)||!validId(value.anchorNodeId)||!['add','replace','rewire','remove','organize','submit'].includes(value.operation))throw Error('Invalid construction branch/anchor/operation');
  if(value.submit!==undefined&&typeof value.submit!=='boolean')throw Error('submit must be boolean');
  if(value.operation==='submit'&&(value.submit!==true||value.assembly!==undefined))throw Error('Standalone submit requires submit:true and uses the existing draft assembly');
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
    const a=value.assembly;
    if(!Array.isArray(a.graphs)||a.graphs.length>24||!validId(a.entryGraphId)||!validId(a.outputNodeId)||!object(a.transitions))throw Error('Invalid draft assembly shape');
    for(const g of a.graphs){
      if(!object(g))throw Error('Invalid draft graph');allowed(g,['id','nodeIds']);
      if(!validId(g.id)||!Array.isArray(g.nodeIds)||g.nodeIds.some((id:unknown)=>!validId(id))||new Set(g.nodeIds).size!==g.nodeIds.length)throw Error('Invalid draft graph members');
    }
    const condition=(c:unknown)=>{
      if(!object(c))throw Error('Invalid draft condition');allowed(c,['sourceNodeId','operator','path','value']);
      if(!validId(c.sourceNodeId)||!['equals','not-equals','truthy','falsy','has-pending-actions','no-pending-actions'].includes(c.operator)||c.path!==undefined&&(!Array.isArray(c.path)||c.path.some((p:unknown)=>typeof p!=='string'||['__proto__','prototype','constructor'].includes(p))))throw Error('Invalid draft condition fields');
    };
    for(const [id,t] of Object.entries(a.transitions)){
      if(!validId(id)||!object(t))throw Error('Invalid draft transition');
      if(t.kind==='end')allowed(t,['kind']);
      else if(t.kind==='next'){allowed(t,['kind','graphId']);if(!validId(t.graphId))throw Error('Invalid draft next target');}
      else if(t.kind==='switch'){
        allowed(t,['kind','cases','defaultGraphId']);if(!Array.isArray(t.cases)||t.cases.length>24)throw Error('Invalid draft switch');
        for(const c of t.cases){if(!object(c))throw Error('Invalid draft switch case');allowed(c,['when','graphId']);condition(c.when);if(!validId(c.graphId))throw Error('Invalid draft switch target');}
        if(t.defaultGraphId!==undefined&&!validId(t.defaultGraphId))throw Error('Invalid draft default target');
      }else if(t.kind==='repeat'){
        allowed(t,['kind','graphId','maxVisits','until','nextGraphId']);condition(t.until);
        if(!validId(t.graphId)||!Number.isSafeInteger(t.maxVisits)||t.maxVisits<1||t.nextGraphId!==undefined&&!validId(t.nextGraphId))throw Error('Invalid draft repeat');
      }else throw Error('Invalid draft transition kind');
    }
    if(a.outputByGraph!==undefined&&(!object(a.outputByGraph)||Object.entries(a.outputByGraph).some(([g,n])=>!validId(g)||!validId(n))))throw Error('Invalid draft delivery mapping');
  }
}

/** An explicit commit of an unchanged binding is submission, never a new edit. */
export function normalizeDraftSubmission(base:ConstructionBranch,draft:CandidateDraft|undefined,proposal:NodeExpansion):NodeExpansion {
  validateExpansion(proposal);
  if(proposal.operation!=='replace'||proposal.submit!==true||proposal.assembly!==undefined||proposal.removeNodeId!==undefined
    ||!draft||draft.submitted||draft.edits.length===0||draft.branchId!==base.id||proposal.baseBranchId!==base.id
    ||base.id===draft.selection.parentBranchId||!Object.hasOwn(base.vertexByNode,proposal.anchorNodeId)
    ||!isDeepStrictEqual(proposal.node,base.nodes.find(n=>n.id===proposal.anchorNodeId)))return proposal;
  return {baseBranchId:proposal.baseBranchId,anchorNodeId:proposal.anchorNodeId,operation:'submit',submit:true};
}

export function organizationFor(dataset:OrganizationSpec['dataset'],branch:ConstructionBranch):OrganizationSpec {
  if(!branch.assembly)throw Error('Construction is not assembled into an executable workflow');
  const a=branch.assembly;
  return {version:1,dataset,nodes:branch.nodes,graphs:a.graphs,entryGraphId:a.entryGraphId,transitions:a.transitions,outputNodeId:a.outputNodeId,...(a.outputByGraph?{outputByGraph:a.outputByGraph}:{})};
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
  return organizationHash({...spec,nodes:spec.nodes.map(n=>({...n,template:nodeCatalog(spec.dataset)[n.template]!.type,
    // Actor and plain SAMPLE share a Core contract/config but bind different
    // capabilities and pending-action semantics in the Automation executor.
    ...(n.template==='actor'?{bindingCapability:'fixed-official-tool-actor'}:{}),
    config:nodeDefinition(spec.dataset,n,'hash').config,id:ns.get(n.id)!,dependencies:n.dependencies.map(d=>ns.get(d)!),
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
    const type=catalog[n.template]!.type;
    if(type==='INFER.REASONING.REFLECT'&&(!n.targetNodeId||!n.dependencies.includes(n.targetNodeId)))throw Error('Reflection requires an explicit direct targetNodeId');
    if(type==='INFER.REASONING.REFLECT'&&sources.some(d=>d!==undefined&&d.id===n.targetNodeId&&!guaranteesResult(dataset,d)))throw Error('Reflection target must guarantee an answer');
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
    ...(proposal.assembly??base.assembly?{assembly:structuredClone(proposal.assembly??base.assembly!)}:{})};
  // Unassembled states can contain dangling links during a multi-step rewrite;
  // complete assembly must pass every original execution/availability check.
  let plan:AgentPlanSpec|undefined;
  if(branch.assembly){
    const spec=organizationFor(dataset,branch);
    try{plan=buildOrganizationPlan(spec);requireExplicitReflectionTargets(spec);}
    catch(error){if(proposal.submit)throw error;}
  }
  if(proposal.submit&&!plan)throw Error('Cannot submit an unclosed draft: complete valid Graph/Loop assembly is required');
  return {branch,...(definition?{node:definition,parentVertexId}:{}),...(plan?{plan}:{})};
}

export const constructionHash=(branch:ConstructionBranch):string=>createHash('sha256').update(JSON.stringify({nodes:branch.nodes,assembly:branch.assembly})).digest('hex');
export type RealNodeVertex = SearchTreeNode;
