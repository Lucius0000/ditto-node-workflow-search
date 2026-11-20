import {compileAgent,type AgentDefinition,type AgentNode,type AgentSubgraph} from '@codesoul-co/ditto/runtime';
import {BASELINE_DEFINITION,validateDefinition as validateLegacy,DefinitionError,digest,NODE_TYPES,type ToolDefinition} from '../graph-agent/schema.js';
import {dependencyEditBudget} from '../coding/policy.js';
import {validateOfficialNativeContracts} from './native-validation.js';
import {DATA_TRANSFORM_NODE} from './helpers.js';
import type {ExplorationDirection} from '../unified/exploration.js';
import {validateMutationExplanation} from './proposal-contract.js';

export type OfficialAgentDefinition=AgentDefinition;
export interface MutationExplanation{primaryNodeId:string;auxiliary:{nodeId:string;reason:string}[]}
export const OFFICIAL_AGENT_POLICY='ditto-official-agent-search-v1';
export const OFFICIAL_CAPABILITIES=[...NODE_TYPES,DATA_TRANSFORM_NODE] as readonly string[];
const groups:Record<ExplorationDirection,readonly string[]>={interaction:['INTERACTION.ACT.TOOL','INTERACTION.OBSERVE'],'context-retrieval':['CONTEXT.SELECT','CONTEXT.UPDATE','CONTEXT.COMPRESS','RETRIEVAL.SEARCH'],'native-reasoning':['INFER.REASONING.TRAJECTORY','INFER.REASONING.REFLECT','INFER.REASONING.DELIBERATE'],'memory-cache':['MEMORY.WRITE','MEMORY.GET','MEMORY.SEARCH','MEMORY.QUERY','MEMORY.UPDATE','MEMORY.DELETE','INFER.CACHE.LOOKUP','INFER.CACHE.WRITE','INFER.CACHE.INVALIDATE']};
const check=(ok:unknown,message:string,path:string,hint?:string):void=>{if(!ok)throw new DefinitionError(message,path,hint);};
export const officialNodes=(d:AgentDefinition)=>Object.entries(d.graphs).flatMap(([graph,g])=>g.nodes.filter((n):n is AgentNode=>n.kind!=='subgraph').map(node=>({graph,id:`${graph}/${node.id}`,node})));
export function validateToolArtifacts(tools:readonly ToolDefinition[]=[]):ToolDefinition[]{
 check(Array.isArray(tools),'toolArtifacts must be an array','/toolArtifacts');
 try{return validateLegacy({...structuredClone(BASELINE_DEFINITION),tools:[...tools]}).tools??[];}catch(error){if(error instanceof DefinitionError)throw new DefinitionError(error.detail,error.path.replace(/^tools/,'toolArtifacts'),error.repairHint);throw error;}
}
export function validateOfficialDefinition(source:unknown,tools:readonly ToolDefinition[]=[]):AgentDefinition{
 let compiled:ReturnType<typeof compileAgent>;
 try{compiled=compileAgent(source);}catch(error){const d=(error as any).diagnostic;if(d)throw new DefinitionError(d.message,d.path,`Correct official Agent JSON (${d.code}); graph=${d.graphId??'-'}, node=${d.nodeId??'-'}.`);throw error;}
 const d=compiled.definition,nodes=officialNodes(d);validateToolArtifacts(tools);
 const refs=(v:any):string[]=>!v||typeof v!=='object'?[]:Object.hasOwn(v,'$literal')?[]:[...(typeof v.$ref==='string'?[v.$ref]:[]),...Object.values(v).flatMap(refs)];
 check(!refs(d).some(r=>r==='input.task.id'||r.startsWith('input.task.id.')),'Task IDs are audit metadata, not searchable solution inputs','/graphs');
 const firstLoad=nodes.find(n=>n.node.type==='CONTEXT.LOAD')?.id;
 for(const [graph,g]of Object.entries(d.graphs)){
  const consumed=new Set([...refs(g.output),...g.nodes.flatMap(n=>refs(n.input))].filter(r=>r.startsWith('nodes.')).map(r=>r.split('.')[1]));
  for(const node of g.nodes){const type='type'in node?node.type:'';
   check(g.output===undefined||consumed.has(node.id)||`${graph}/${node.id}`===firstLoad||['MEMORY.WRITE','MEMORY.UPDATE','MEMORY.DELETE','INFER.CACHE.WRITE','INFER.CACHE.INVALIDATE'].includes(type),'Declared node output must feed real data/control, not only scheduling',`/graphs/${graph}/nodes/${node.id}`);
  }
 }
 check(nodes.length<=24,'At most 24 logical leaf nodes are allowed','/graphs');
 check(nodes.filter(n=>n.node.type==='INFER.REASONING.SAMPLE').length<=1,'At most one SAMPLE declaration is allowed; use other native Workers','/graphs');
 for(const {graph,node}of nodes){
  check(OFFICIAL_CAPABILITIES.includes(node.type),'Node type is not registered in this experiment',`/graphs/${graph}/nodes/${node.id}/type`);
  if(node.type.startsWith('INFER.REASONING.')){
   const input=node.input as any;
   check(input&&typeof input==='object'&&!Array.isArray(input),'Infer input must be a declared native input object',`/graphs/${graph}/nodes/${node.id}/input`);
   for(const field of ['model','generation'])check(input[field]===undefined||digest(input[field])===digest({$ref:`input.host.${field}`}),`${field} must use the immutable host reference`,`/graphs/${graph}/nodes/${node.id}/input/${field}`);
  }
  const input=node.input as any;
  if(node.type===DATA_TRANSFORM_NODE&&(input?.sourceKind==='model-json'||['decision','decision-attempt'].includes(input?.operation))){
   const ref=input?.value?.$ref,match=typeof ref==='string'?/^nodes\.([^.]+)\.output\.(message|result)\.content$/.exec(ref):null;
   const producer=match?d.graphs[graph]?.nodes.find(n=>n.id===match[1]):undefined;
   check(producer&&'type'in producer&&producer.type.startsWith('INFER.REASONING.')&&node.dependsOn?.includes(producer.id),'Model-format classification requires direct native Infer content and an explicit dependency',`/graphs/${graph}/nodes/${node.id}/input/value`);
  }
 }
 for(const [graph,plan]of Object.entries(compiled.graphs)){
  check(plan.tasks.length<=24,'Expanded Graph exceeds 24 nodes',`/graphs/${graph}`);
  check(plan.tasks.filter(n=>n.node==='INFER.REASONING.SAMPLE').length<=1,'Subgraph reuse expands SAMPLE more than once in one Graph',`/graphs/${graph}`);
 }
 const deployment=d.deployment;
 check(!deployment?.workers?.some(w=>w.services!==undefined),'Search cannot select service/permission profiles','/deployment/workers');
 const allowedWorkers=new Set(['context','infer','memory','interaction','retrieval','host-data']);
 check(!deployment?.workers?.some(w=>!allowedWorkers.has(w.use)),'Unknown host Worker registration','/deployment/workers');
 validateOfficialNativeContracts(d);
 return d;
}
export function officialArtifactHash(d:AgentDefinition,tools:readonly ToolDefinition[]=[]):string{return digest({definition:d,toolArtifacts:tools});}
export function expandedOfficialNodes(d:AgentDefinition){const c=compileAgent(d);return Object.entries(c.graphs).flatMap(([graph,g])=>g.tasks.map(n=>({id:`${graph}/${n.id}`,type:String(n.node),dependencies:n.dependencies.map(dep=>`${graph}/${dep}`)})));}
export const OFFICIAL_MUTATION_LIMITS=Object.freeze({policy:'one-functional-node-prompts-separate-v3',maxFunctionalNodeChanges:1,maxAddedCompanions:0,maxDeclaredNodes:24,maxToolChanges:1,
 counting:'added + removed + functional modifications <= 1; preserve ID when replacing a node; user prompt changes and necessary reference/dependency wiring do not count',promptChangesCountAsFunctional:false,promptScope:'Infer user messages and objective; system remains frozen; tool arguments, native strategy and constraints remain functional',dependencyEdgeEdits:'max(12,4*N), N=max(parent,child nodes); reversal costs two'});
export const BFCL_MUTATION_LIMITS=Object.freeze({...OFFICIAL_MUTATION_LIMITS,policy:'bfcl-three-functional-nodes-per-proposal-v1',
 maxFunctionalNodeChanges:3,maxAddedCompanions:2,counting:'added + removed + functional modifications <= 3 per proposal against the same measured round parent'});
const OMIT=Symbol('wiring');
/** Separate reference wiring from literal prompts/operations; native validation still freezes host bindings. */
function functionalInput(value:any):any{
 if(value===null||typeof value!=='object')return value;
 if(typeof value.$ref==='string'){const fallback=Object.hasOwn(value,'default')?functionalInput(value.default):OMIT;return fallback===OMIT||fallback===null||fallback===''?OMIT:{__fallback:fallback};}
 if(value.role==='user'&&value.content&&functionalInput(value.content)===OMIT)return OMIT;
 if(Array.isArray(value)){const items=value.map(functionalInput).filter(v=>v!==OMIT);return items.length?items:OMIT;}
 if(value.$op==='concat'){
  const flatten=(v:any):any[]=>v===OMIT?[]:Array.isArray(v)?v.flatMap(flatten):v&&typeof v==='object'&&Object.keys(v).length===1&&Array.isArray(v.__concat)?v.__concat.flatMap(flatten):[v];
  const args=flatten(functionalInput(value.args));return args.length?{__concat:args}:OMIT;
 }
 const entries=Object.entries(value).map(([k,v])=>[k,functionalInput(v)] as const).filter(([,v])=>v!==OMIT);
 return entries.length?Object.fromEntries(entries):OMIT;
}
/** Only explicit Infer user messages are editable prompt data. System messages are never exempt. */
function withoutUserPrompts(value:any):any{
 if(value===null||typeof value!=='object')return value;
 if(value.role==='user')return OMIT;
 if(Array.isArray(value))return value.map(withoutUserPrompts).filter(v=>v!==OMIT);
 return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,withoutUserPrompts(v)] as const).filter(([,v])=>v!==OMIT));
}
function functionalNodeInput(node:AgentNode){
 const input=structuredClone(node.input) as any;
 if(node.type.startsWith('INFER.REASONING.')&&input&&typeof input==='object'&&!Array.isArray(input)){
  if(Object.hasOwn(input,'messages'))input.messages=withoutUserPrompts(input.messages);
  delete input.objective;
 }
 const normalized=functionalInput(input);return normalized===OMIT?null:normalized;
}
function promptSignature(node:AgentNode){return node.type.startsWith('INFER.REASONING.')?digest({messages:(node.input as any)?.messages,objective:(node.input as any)?.objective}):null;}
export function officialMutationDiff(parent:AgentDefinition,child:AgentDefinition){
 const unique=(id:string)=>[parent,child].every(d=>officialNodes(d).filter(n=>n.node.id===id).length<=1);
 const stable=(d:AgentDefinition)=>officialNodes(d).map(n=>({...n,id:unique(n.node.id)?n.node.id:n.id}));
 const before=stable(parent),after=stable(child),old=new Map(before.map(n=>[n.id,n]));
 const added=after.filter(n=>!old.has(n.id)).map(n=>n.id),removed=before.filter(n=>!after.some(v=>v.id===n.id)).map(n=>n.id);
 const signature=(node:AgentNode)=>digest({type:node.type,input:functionalNodeInput(node),require:node.require??null});
 const retained=after.filter(n=>old.has(n.id));
 const modified=retained.filter(n=>signature(n.node)!==signature(old.get(n.id)!.node)).map(n=>n.id);
 const promptChanges=retained.filter(n=>promptSignature(n.node)!==promptSignature(old.get(n.id)!.node)).map(n=>n.id);
 const wiringOnly=retained.filter(n=>!modified.includes(n.id)&&!promptChanges.includes(n.id)&&digest(n.node)!==digest(old.get(n.id)!.node)).map(n=>n.id);
 return{added,removed,modified,wiringOnly,promptChanges,count:added.length+removed.length+modified.length};
}
export function validateOfficialChange(parent:AgentDefinition,child:AgentDefinition,mutation?:MutationExplanation,parentTools:readonly ToolDefinition[]=[],childTools:readonly ToolDefinition[]=[],limits:typeof OFFICIAL_MUTATION_LIMITS|typeof BFCL_MUTATION_LIMITS=OFFICIAL_MUTATION_LIMITS):void{
 validateOfficialDefinition(child,childTools);
 if(mutation!==undefined)mutation=validateMutationExplanation(mutation,'/mutation',limits.maxAddedCompanions);
 const diff=officialMutationDiff(parent,child);
 check(diff.count<=limits.maxFunctionalNodeChanges,`Functional node limit exceeded: allowed=${limits.maxFunctionalNodeChanges} actual=${diff.count}; added=${JSON.stringify(diff.added)}; removed=${JSON.stringify(diff.removed)}; modified=${JSON.stringify(diff.modified)}; wiringOnly=${JSON.stringify(diff.wiringOnly)}; promptChangesExcluded=${JSON.stringify(diff.promptChanges)}`,'/mutation',
  'Keep the allowed number of added, removed or functionally modified nodes. Preserve IDs for replacements. User prompt edits and necessary wiring are separate.');
 const edgeSet=(d:AgentDefinition)=>new Set(expandedOfficialNodes(d).flatMap(n=>n.dependencies.map(dep=>`${dep}->${n.id}`))),a=edgeSet(parent),b=edgeSet(child);
 const removedEdges=[...a].filter(e=>!b.has(e)),addedEdges=[...b].filter(e=>!a.has(e)),edgeLimit=dependencyEditBudget(Math.max(expandedOfficialNodes(parent).length,expandedOfficialNodes(child).length,1));
 check(removedEdges.length+addedEdges.length<=edgeLimit,`Expanded dependency edit budget exceeded: allowed=${edgeLimit} actual=${removedEdges.length+addedEdges.length}; added=${JSON.stringify(addedEdges)}; removed=${JSON.stringify(removedEdges)}`,'/graphs','Restore excess dependency changes; a reversal counts as removal plus addition.');
 const names=new Set([...parentTools,...childTools].map(t=>t.name));check([...names].filter(name=>digest(parentTools.find(t=>t.name===name)??null)!==digest(childTools.find(t=>t.name===name)??null)).length<=1,'At most one tool artifact may change','/toolArtifacts');
 check(officialArtifactHash(parent,parentTools)!==officialArtifactHash(child,childTools),'Duplicate unchanged candidate','/definition');
}
export function validateOfficialExploration(parent:AgentDefinition,child:AgentDefinition,direction:ExplorationDirection){const prior=new Map(officialNodes(parent).map(n=>[n.id,n]));const changed=officialNodes(child).filter(n=>groups[direction].includes(n.node.type)&&digest(prior.get(n.id)?.node??null)!==digest(n.node));check(changed.length,`Protected direction requires changed ${groups[direction].join(', ')}`,'/exploration/direction');return changed.map(n=>n.id);}
export function executedOfficialDirectionNodes(d:AgentDefinition,direction:ExplorationDirection,traces:readonly unknown[]):string[]{const eligible=new Set(expandedOfficialNodes(d).filter(n=>groups[direction].includes(n.type)).map(n=>n.id));return [...new Set(traces.flatMap((t:any)=>[...Object.keys(t.rawNodeOutputs??{}),...(t.executedNodeIds??[])]).filter(id=>eligible.has(id)))];}
export const OFFICIAL_BASELINE:AgentDefinition={version:1,id:'ditto-agent',config:{strategy:''},graphs:{main:{nodes:[{id:'context',type:'CONTEXT.LOAD',input:{sources:[{role:'user',content:{$ref:'input.task.prompt'}}]}},{id:'solve',type:'INFER.REASONING.SAMPLE',dependsOn:['context'],input:{model:{$ref:'input.host.model'},generation:{$ref:'input.host.generation'},messages:{$op:'concat',args:[{$ref:'input.host.messages'},[{role:'user',content:{$ref:'config.strategy'}}]]}}}],output:{$ref:'nodes.solve.output.message.content'}}}};
