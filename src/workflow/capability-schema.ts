import { createHash } from 'node:crypto';
import type { AgentPlanSpec, DatasetName } from '../domain.js';
import { createRootNode, createInitialSampleNode, validateNode } from './spec.js';
import { baselinePrompts } from '../benchmark/baseline-prompts.js';
import { validateCheckerDependencies } from './checker-policy.js';
import { EXPERIMENT_EXECUTION } from '../model-profile.js';

export const CAPABILITY_NODE_TYPES = ['CONTEXT.LOAD','CONTEXT.SELECT','CONTEXT.UPDATE','CONTEXT.COMPRESS','MEMORY.WRITE','MEMORY.GET','MEMORY.SEARCH','INTERACTION.ACT.TOOL','INTERACTION.OBSERVE','INFER.REASONING.SAMPLE','INFER.REASONING.TRAJECTORY','INFER.REASONING.REFLECT','INFER.REASONING.DELIBERATE'] as const;
export type CapabilityNodeType = typeof CAPABILITY_NODE_TYPES[number];
export const GRAPH_ORDER = ['prepare','solve','refine'] as const;
export type CapabilitySource = {readonly from:'task';readonly field:'prompt'|'outputInstruction';readonly extract?:{readonly kind:'decimal-number';readonly index:number}} | {readonly from:'node';readonly nodeId:string;readonly view:'context'|'memory-records'|'memory-ids'|'external-result'|'observation'|'answer-text'} | {readonly from:'literal';readonly value:unknown};
/** Runtime-compiled node configs are checked below before entering the dynamic Graph boundary. */
export interface CapabilityNode {readonly id:string;readonly type:CapabilityNodeType;readonly graphId:typeof GRAPH_ORDER[number];readonly dependencies:readonly string[];readonly config:Readonly<Record<string, any>>;}
export interface CapabilityPlan extends Omit<AgentPlanSpec,'nodes'> {readonly nodes:readonly CapabilityNode[];}
export interface CapabilityProposal {readonly node:Omit<CapabilityNode,'id'>;readonly rationale:string;}
export const CAPABILITY_SCHEMA_GUIDE = Object.freeze({
 proposal:{rationale:'nonempty string',node:{type:CAPABILITY_NODE_TYPES,graphId:GRAPH_ORDER,dependencies:'earlier same-Graph IDs only',config:'exact matching config below; omit id'}},
 source:{task:{from:'task',field:['prompt','outputInstruction'],extract:'optional {kind:"decimal-number",index:nonnegative integer}; public strings ≤65536 chars'},node:{from:'node',nodeId:'earlier visible node ID',view:['context','memory-records','memory-ids','external-result','observation','answer-text']},literal:{from:'literal',value:'finite JSON'}},
 configs:{
  'CONTEXT.LOAD':{sourcesSource:'Source from existing node; not original context-load'},
  'CONTEXT.SELECT':{contextSource:'node Source view=context',strategy:'optional default only',purpose:'optional infer only',querySource:'optional Source',limit:'optional positive integer',maxTokens:'optional positive integer'},
  'CONTEXT.UPDATE':{contextSource:'node Source view=context',addSource:'Source',removeIds:'optional string[]'},
  'CONTEXT.COMPRESS':{contextSource:'node Source view=context',maxItems:'optional positive integer',maxTokens:'optional positive integer'},
  'MEMORY.WRITE':{contentSource:'Source; actual written records become answer evidence'},
  'MEMORY.GET':{idsSource:'node Source view=memory-ids from earlier WRITE'},
  'MEMORY.SEARCH':{querySource:'Source',limit:'optional positive integer; visible earlier WRITE must be dependency if same Graph'},
  'INTERACTION.ACT.TOOL':{tool:['bounded_arithmetic','literal_text_find'],arguments:{bounded_arithmetic:{tokens:'1..256 Sources, joined with spaces; e.g. task decimal-number index0, literal "*", task decimal-number index1'},literal_text_find:{text:'Source',needle:'Source'}}},
  'INTERACTION.OBSERVE':{resultSource:'node Source view=external-result from actual ACT'},
  'INFER.REASONING.SAMPLE':{role:['solver','finalizer'],instruction:'nonempty ≤4000 chars',generation:{temperature:'0..2',maxTokens:'64..historical max'}},
  'INFER.REASONING.TRAJECTORY':{instruction:'nonempty ≤4000 chars',strategy:['cot','long-cot','tot','got','self-consistency'],options:'historical strategy options',generation:'same generation object',maxSteps:'positive integer'},
  'INFER.REASONING.REFLECT':{mode:['verify','critique','revise'],criteria:'1..8 nonempty strings',generation:'same generation object'},
  'INFER.REASONING.DELIBERATE':{mode:['select','merge','consensus','debate'],generation:'same generation object'},
 },
 rules:['Return a complete workflow snapshot; nodes may be inserted, removed or rewired within the fixed stage order.','Node Sources in same Graph must be dependencies; previous Graph outputs are committed Loop state.','Every node must have a content path to final answer. Evidence-only tails without existing later answer consumers are rejected.','DELIBERATE requires two local solver dependencies; Context/Memory/tool outputs never count as candidates.','REFLECT is refine-only, targets latest available answer, and revise must depend on previous local checker.','Model-produced tool mode is disabled; arithmetic answer-text tokens are rejected.','No arbitrary paths, namespaces, code, regex, network, files, labels, grader fields, or secrets.'],
});
export const isAnswerNode = (node:CapabilityNode):boolean => node.type.startsWith('INFER.REASONING.');
export const isSolverNode = (node:CapabilityNode):boolean => ['INFER.REASONING.SAMPLE','INFER.REASONING.TRAJECTORY','INFER.REASONING.DELIBERATE'].includes(node.type);
export function hasCapabilities(nodes: readonly {type:string;config:object}[]): boolean {
 return nodes.some(node=>!node.type.startsWith('INFER.')&&(node.type!=='CONTEXT.LOAD'||'sourcesSource' in node.config));
}
/** Shared full-snapshot validation; the caller's search method remains unchanged. */
export function capabilityPlan(id:string,nodes:readonly CapabilityNode[]):CapabilityPlan {
 return materialize(nodes,id);
}
const allowed:Record<string,readonly string[]> = {
 'CONTEXT.LOAD':['sourcesSource'], 'CONTEXT.SELECT':['contextSource','strategy','purpose','querySource','limit','maxTokens'],
 'CONTEXT.UPDATE':['contextSource','addSource','removeIds'], 'CONTEXT.COMPRESS':['contextSource','maxItems','maxTokens'],
 'MEMORY.WRITE':['contentSource'], 'MEMORY.GET':['idsSource'], 'MEMORY.SEARCH':['querySource','limit'],
 'INTERACTION.ACT.TOOL':['tool','arguments'], 'INTERACTION.OBSERVE':['resultSource'],
};
function keys(value:object,names:readonly string[]):void {for(const name of Object.keys(value)) if(!names.includes(name))throw Error(`Unknown field ${name}`);}
function object(value:unknown):asserts value is Record<string,any> {if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected object');}
function positive(value:unknown,name:string):void {if(!Number.isSafeInteger(value)||Number(value)<1)throw Error(`Invalid ${name}`);}
export function sourcesIn(value:unknown):CapabilitySource[] {if(!value||typeof value!=='object')return [];if('from' in value)return [value as CapabilitySource];return Object.values(value).flatMap(sourcesIn);}
function validateSource(value:unknown):void {
 object(value);
 if(value.from==='task'){keys(value,['from','field','extract']);if(!['prompt','outputInstruction'].includes(value.field))throw Error('Invalid public task field');if(value.extract){object(value.extract);keys(value.extract,['kind','index']);if(value.extract.kind!=='decimal-number'||!Number.isSafeInteger(value.extract.index)||value.extract.index<0)throw Error('Invalid extraction');}}
 else if(value.from==='node'){keys(value,['from','nodeId','view']);if(typeof value.nodeId!=='string'||!['context','memory-records','memory-ids','external-result','observation','answer-text'].includes(value.view))throw Error('Invalid node projection');}
 else if(value.from==='literal'){keys(value,['from','value']);const inspect=(v:unknown):void=>{if(typeof v==='number'&&!Number.isFinite(v))throw Error('Non-finite JSON');if(v===undefined||typeof v==='function'||typeof v==='bigint')throw Error('Not JSON');if(v&&typeof v==='object')Object.values(v).forEach(inspect);};inspect(value.value);}
 else throw Error('Unknown source');
}
export function parseProposal(value:unknown):CapabilityProposal {
 object(value);keys(value,['node','rationale']);object(value.node);keys(value.node,['type','graphId','dependencies','config']);
 if(typeof value.rationale!=='string'||!value.rationale.trim()||value.rationale.length>4000)throw Error('Invalid rationale');
 const proposal=structuredClone(value) as CapabilityProposal;validateCapabilityNode({...proposal.node,id:'proposal-node'});return proposal;
}
export function validateCapabilityNode(node:CapabilityNode):void {
 if(!/^[a-z][a-z0-9-]{0,63}$/.test(node.id)||!CAPABILITY_NODE_TYPES.includes(node.type)||!GRAPH_ORDER.includes(node.graphId))throw Error('Invalid node identity/type/stage');
 if(!Array.isArray(node.dependencies)||node.dependencies.some(id=>typeof id!=='string')||new Set(node.dependencies).size!==node.dependencies.length)throw Error('Invalid dependencies');object(node.config);
 if(isAnswerNode(node)){
  const inferFields:Record<string,string[]>={'INFER.REASONING.SAMPLE':['role','instruction','generation'],'INFER.REASONING.TRAJECTORY':['instruction','strategy','options','generation','maxSteps'],'INFER.REASONING.REFLECT':['mode','criteria','generation'],'INFER.REASONING.DELIBERATE':['mode','generation']};
  keys(node.config,inferFields[node.type]!);validateNode(node as any);return;
 }
 if('includeTaskMetadata' in node.config){if(node.type!=='CONTEXT.LOAD'||node.graphId!=='prepare'||node.dependencies.length||typeof node.config.includeTaskMetadata!=='boolean')throw Error('Invalid historical root');keys(node.config,['includeTaskMetadata']);return;}
 keys(node.config,allowed[node.type]!);
 const required:Record<string,string[]>={'CONTEXT.LOAD':['sourcesSource'],'CONTEXT.SELECT':['contextSource'],'CONTEXT.UPDATE':['contextSource','addSource'],'CONTEXT.COMPRESS':['contextSource'],'MEMORY.WRITE':['contentSource'],'MEMORY.GET':['idsSource'],'MEMORY.SEARCH':['querySource'],'INTERACTION.OBSERVE':['resultSource']};
 for(const key of required[node.type]??[])if(!(key in node.config))throw Error(`Missing ${key}`);
 for(const source of sourcesIn(node.config))validateSource(source);
 for(const [key,value] of Object.entries(node.config))if(key.endsWith('Source'))validateSource(value);
 if(node.config.contextSource&&!(node.config.contextSource.from==='node'&&node.config.contextSource.view==='context'))throw Error('Context transformation requires an existing Context');
 if(node.type==='CONTEXT.LOAD'&&node.config.sourcesSource.from!=='node')throw Error('Additional LOAD requires a declared upstream source');
 for(const key of ['limit','maxTokens','maxItems'])if(key in node.config)positive(node.config[key],key);
 if(node.type==='CONTEXT.SELECT'&&((node.config.strategy??'default')!=='default'||(node.config.purpose??'infer')!=='infer'))throw Error('Only default infer selection is enabled');
 if(node.type==='CONTEXT.SELECT'&&node.config.querySource){const query=node.config.querySource;if(query.from==='literal'&&typeof query.value!=='string'||query.from==='node'&&query.view!=='answer-text')throw Error('SELECT query must project public text');}
 if(node.type==='CONTEXT.UPDATE'&&node.config.removeIds!==undefined&&(!Array.isArray(node.config.removeIds)||node.config.removeIds.some((id:unknown)=>typeof id!=='string')))throw Error('Invalid removeIds');
 if(node.type==='INTERACTION.ACT.TOOL'){
  object(node.config.arguments);
  if(node.config.tool==='bounded_arithmetic'){keys(node.config.arguments,['tokens']);if(!Array.isArray(node.config.arguments.tokens)||!node.config.arguments.tokens.length||node.config.arguments.tokens.length>256)throw Error('Expected bounded tokens');node.config.arguments.tokens.forEach(validateSource);}
  else if(node.config.tool==='literal_text_find'){keys(node.config.arguments,['text','needle']);validateSource(node.config.arguments.text);validateSource(node.config.arguments.needle);}
  else throw Error('Unapproved tool');
  if(sourcesIn(node.config.arguments).some(s=>s.from==='node'&&s.view==='answer-text'))throw Error('Model-produced tool requests are disabled');
 }
}
function viewMatches(source:CapabilitySource,node:CapabilityNode):boolean {if(source.from!=='node')return true;switch(source.view){case 'context':return node.type.startsWith('CONTEXT.');case 'memory-records':case 'memory-ids':return node.type.startsWith('MEMORY.');case 'external-result':return node.type==='INTERACTION.ACT.TOOL';case 'observation':return node.type==='INTERACTION.OBSERVE';case 'answer-text':return isAnswerNode(node);}}
export function validatePlan(plan:CapabilityPlan):ReadonlyMap<string,CapabilityNode> {
 if(!plan.id.trim())throw Error('Missing plan ID');if(plan.nodes.length<2||plan.nodes.length>24)throw Error('Expected 2..24 nodes');const seen=new Map<string,CapabilityNode>();let stage=-1;
 for(const node of plan.nodes){validateCapabilityNode(node);if(seen.has(node.id))throw Error('Duplicate node');const rank=GRAPH_ORDER.indexOf(node.graphId);if(rank<stage)throw Error('Invalid stage order');stage=rank;
  for(const id of node.dependencies)if(!seen.has(id)||seen.get(id)!.graphId!==node.graphId)throw Error('Unknown/forward/cross-Graph dependency');
  for(const source of sourcesIn(node.config))if(source.from==='node'){const producer=seen.get(source.nodeId);if(!producer||!viewMatches(source,producer))throw Error('Invalid source producer/view');if(producer.graphId===node.graphId&&!node.dependencies.includes(producer.id))throw Error('Local source requires explicit dependency');}
  if(node.type==='MEMORY.GET'&&!(node.config.idsSource?.from==='node'&&node.config.idsSource.view==='memory-ids'&&seen.get(node.config.idsSource.nodeId)?.type==='MEMORY.WRITE'))throw Error('GET requires earlier WRITE IDs');
  if(node.type==='MEMORY.SEARCH'&&![...seen.values()].some(n=>n.type==='MEMORY.WRITE'&&(n.graphId!==node.graphId||node.dependencies.includes(n.id))))throw Error('SEARCH requires visible earlier WRITE');
  if(node.type==='INTERACTION.OBSERVE'&&!(node.config.resultSource?.from==='node'&&node.config.resultSource.view==='external-result'))throw Error('OBSERVE requires an actual ACT result');
  const answers=[...seen.values()].filter(n=>isAnswerNode(n)&&(n.graphId!==node.graphId||node.dependencies.includes(n.id)));
  if(node.type==='INFER.REASONING.REFLECT'&&!answers.length)throw Error('REFLECT requires an answer');
  if(node.type==='INFER.REASONING.DELIBERATE'&&node.dependencies.filter(id=>isSolverNode(seen.get(id)!)).length<2)throw Error('DELIBERATE requires two local solver candidates');
  seen.set(node.id,node);
 }
 if(plan.nodes[0]?.type!=='CONTEXT.LOAD'||!('includeTaskMetadata' in plan.nodes[0].config)||plan.nodes.filter(n=>'includeTaskMetadata' in n.config).length!==1)throw Error('One leading task Context is required');
 validateCheckerDependencies(plan.nodes.filter(isAnswerNode) as any);
 if(!seen.get(plan.outputNodeId)||!isAnswerNode(seen.get(plan.outputNodeId)!))throw Error('Output must be an answer node');
 // Fixed stage-tail insertion means every evidence output needs a later actual consumer.
 const consumed=new Set<string>();const visit=(id:string):void=>{if(consumed.has(id))return;consumed.add(id);const node=seen.get(id)!;for(const dep of node.dependencies)visit(dep);for(const source of sourcesIn(node.config))if(source.from==='node')visit(source.nodeId);if(isAnswerNode(node))for(const earlier of plan.nodes){if(GRAPH_ORDER.indexOf(earlier.graphId)<GRAPH_ORDER.indexOf(node.graphId))visit(earlier.id);}};visit(plan.outputNodeId);
 for(const node of plan.nodes)if(!consumed.has(node.id))throw Error(`Unused node: ${node.id}`);
 const expected=GRAPH_ORDER.map(id=>({id,nodeIds:plan.nodes.filter(n=>n.graphId===id).map(n=>n.id)})).filter(g=>g.nodeIds.length);
 if(JSON.stringify(expected)!==JSON.stringify(plan.graphs))throw Error('Graph membership differs from node stages');
 if(plan.loop.entryGraphId!==expected[0]?.id||plan.loop.maxGraphRuns<expected.length)throw Error('Invalid fixed loop');
 expected.forEach((g,i)=>{const expectedTransition=expected[i+1]?{kind:'next',graphId:expected[i+1]!.id}:{kind:'end'};if(JSON.stringify(plan.loop.transitions[g.id])!==JSON.stringify(expectedTransition))throw Error('Only historical fixed stage loop is allowed');});
 return seen;
}
function materialize(nodes:readonly CapabilityNode[],id:string):CapabilityPlan {const graphs=GRAPH_ORDER.map(stage=>({id:stage,nodeIds:nodes.filter(n=>n.graphId===stage).map(n=>n.id)})).filter(g=>g.nodeIds.length);const plan:CapabilityPlan={id,leafSearchNodeId:id,nodes:structuredClone(nodes),graphs,loop:{entryGraphId:graphs[0]!.id,maxGraphRuns:EXPERIMENT_EXECUTION.maxIterations,transitions:Object.fromEntries(graphs.map((g,i)=>[g.id,graphs[i+1]?{kind:'next',graphId:graphs[i+1]!.id}:{kind:'end'}]))},outputNodeId:[...nodes].reverse().find(isAnswerNode)!.id};validatePlan(plan);return plan;}
export function createBaseline(dataset:DatasetName):CapabilityPlan {return materialize([createRootNode(),createInitialSampleNode(baselinePrompts(dataset as "drop"|"gsm8k"|"math")?.agent??'')],'baseline');}
export function extendPlan(parent:CapabilityPlan,proposal:CapabilityProposal,id:string):CapabilityPlan {validatePlan(parent);const node:CapabilityNode={...proposal.node,id};validateCapabilityNode(node);const nodes=[...parent.nodes];const next=nodes.findIndex(n=>GRAPH_ORDER.indexOf(n.graphId)>GRAPH_ORDER.indexOf(node.graphId));nodes.splice(next<0?nodes.length:next,0,node);return materialize(nodes,`plan-${createHash('sha256').update(JSON.stringify(nodes)).digest('hex').slice(0,16)}`);}
