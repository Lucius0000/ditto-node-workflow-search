import {createHash} from 'node:crypto';
import {CODING_EXECUTION_POLICY,CODING_MUTATION_POLICY,dependencyEditBudget} from '../coding/policy.js';
import type {ModuleShape} from '../coding/module.js';
import {validateModuleSyntax} from '../coding/source-guard.js';
import {parseExpressionAt} from 'acorn';
import {validateBinding,bindingReferences,validatePath} from './bindings.js';

export const GRAPH_AGENT_POLICY='ditto-unified-graph-agent-v1';
export const NODE_TYPES=['CONTEXT.LOAD','CONTEXT.SELECT','CONTEXT.UPDATE','CONTEXT.COMPRESS',
 'MEMORY.WRITE','MEMORY.GET','MEMORY.SEARCH','MEMORY.QUERY','MEMORY.UPDATE','MEMORY.DELETE',
 'INFER.REASONING.SAMPLE','INFER.REASONING.TRAJECTORY','INFER.REASONING.REFLECT','INFER.REASONING.DELIBERATE',
 'INFER.CACHE.LOOKUP','INFER.CACHE.WRITE','INFER.CACHE.INVALIDATE','INTERACTION.ACT.TOOL','INTERACTION.OBSERVE','RETRIEVAL.SEARCH'] as const;
export type NodeType=typeof NODE_TYPES[number];
export type View='answer'|'evidence'|'context'|'assessment'|'external-result'|'memory-ids'|'memory-records'|'cache';
export type SemanticSource={from:'task';field:'prompt'|'outputInstruction';extract?:{kind:'decimal-number';index:number}}
 |{from:'node';nodeId:string;view:View}|{from:'previous';nodeId:string;view:View;fallback:Source}
 |{from:'literal';value:any}|{from:'join';parts:Source[];separator:string};
export type Source=SemanticSource|({from?:never}&Record<string,any>);
export interface DefinitionNode {id:string;type:NodeType;dependencies:string[];config:Record<string,any>}
export interface DefinitionGraph {id:string;nodes:DefinitionNode[]}
export interface Condition {source?:Source;left?:Source;right?:Source;path?:string[];operator:'equals'|'not-equals'|'truthy'|'falsy'|'gt'|'gte'|'lt'|'lte';value?:any}
export type Transition={kind:'end'}|{kind:'next';graphId:string}|{kind:'repeat';graphId:string;maxVisits:number;until:Condition;nextGraphId?:string}
 |{kind:'switch';cases:{when:Condition;graphId:string}[];defaultGraphId?:string};
export interface ToolDefinition {name:string;description:string;inputSchema:Record<string,any>;executeSource:string}
export interface GraphDefinition {
 version:1|2;graphs:DefinitionGraph[];
 loop:{entryGraphId:string;maxGraphRuns:number;transitions:Record<string,Transition>;state?:Record<string,any>;stateUpdates?:Record<string,Record<string,Source>>};
 output:{nodeId?:string;view?:'answer';answer?:Source};tools?:ToolDefinition[];
 mutation?:{primaryNodeId:string;auxiliary:{nodeId:string;reason:string}[]};
}
export class DefinitionError extends Error {readonly code='B_DEFINITION';}
export const digest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)).digest('hex');
const check=(yes:unknown,message:string):void=>{if(!yes)throw new DefinitionError(message);};
const record=(v:any):boolean=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function object(v:any):void{check(record(v),'Expected JSON object');}
function keys(v:any,allowed:readonly string[]):void{object(v);for(const k of Object.keys(v))check(allowed.includes(k),`Unknown field ${k}`);}
function id(v:any):void{check(typeof v==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v),'Invalid graph/node ID');}
function positive(v:any,name:string,max=Number.MAX_SAFE_INTEGER):void{check(Number.isSafeInteger(v)&&v>=1&&v<=max,`Invalid ${name}`);}
function text(v:any,name:string,empty=false):void{check(typeof v==='string'&&(empty||v.trim().length>0)&&v.length<=8000,`Invalid ${name}`);}
function json(v:any,seen=new Set<any>()):void{
 check(v===null||['string','boolean','number','object'].includes(typeof v),'Definition must be finite JSON without functions');
 if(typeof v==='number')check(Number.isFinite(v),'Non-finite JSON number');
 if(v&&typeof v==='object'){check(!seen.has(v),'Cyclic JSON');seen.add(v);for(const [k,x]of Object.entries(v)){check(!['constructor','prototype','__proto__'].includes(k),'Unsafe JSON property');json(x,seen);}seen.delete(v);}
}
export function sources(v:any):SemanticSource[]{
 if(!v||typeof v!=='object')return [];
 if(v.from){if(v.from==='literal')return[v];if(v.from==='join')return[v,...v.parts.flatMap(sources)];if(v.from==='previous')return[v,...sources(v.fallback)];return[v];}
 if(Object.hasOwn(v,'literal'))return [];
 return Object.values(v).flatMap(sources);
}
const views:View[]=['answer','evidence','context','assessment','external-result','memory-ids','memory-records','cache'];
export function validateSource(v:any):void{
 if(!record(v)||!v.from){validateBinding(v);return;}
 switch(v.from){
  case'literal':keys(v,['from','value']);check(Object.hasOwn(v,'value'),'Literal requires value');json(v.value);break;
  case'task':keys(v,['from','field','extract']);check(['prompt','outputInstruction'].includes(v.field),'Only public task fields are available');if(v.extract){keys(v.extract,['kind','index']);check(v.extract.kind==='decimal-number'&&Number.isSafeInteger(v.extract.index)&&v.extract.index>=0,'Invalid public numeric extraction');}break;
  case'node':keys(v,['from','nodeId','view']);id(v.nodeId);check(views.includes(v.view),'Unknown output view');break;
  case'previous':keys(v,['from','nodeId','view','fallback']);id(v.nodeId);check(views.includes(v.view),'Unknown previous output view');check(Object.hasOwn(v,'fallback'),'Previous output requires first-visit fallback');validateSource(v.fallback);break;
  case'join':keys(v,['from','parts','separator']);check(Array.isArray(v.parts)&&v.parts.length>0&&v.parts.length<=256,'Invalid joined source');text(v.separator,'separator',true);v.parts.forEach(validateSource);break;
  default:throw new DefinitionError('Unknown source kind');
 }
}
const fields:Record<NodeType,string[]>={
 'CONTEXT.LOAD':['sources'],'CONTEXT.SELECT':['context','query','limit','maxTokens'],'CONTEXT.UPDATE':['context','add','removeIds'],'CONTEXT.COMPRESS':['context','maxItems','maxTokens'],
 'MEMORY.WRITE':['content'],'MEMORY.GET':['ids'],'MEMORY.SEARCH':['query','limit'],'MEMORY.QUERY':['filter','limit'],'MEMORY.UPDATE':['ids','content'],'MEMORY.DELETE':['ids'],
 'INFER.REASONING.SAMPLE':['instruction','user','evidence','outputFormat'],'INFER.REASONING.TRAJECTORY':['instruction','user','evidence','strategy','options','maxSteps','outputFormat'],
 'INFER.REASONING.REFLECT':['target','mode','criteria','feedback','instruction','user'],'INFER.REASONING.DELIBERATE':['candidates','mode','instruction','user'],
 'INFER.CACHE.LOOKUP':['key'],'INFER.CACHE.WRITE':['key','value','ttlMs'],'INFER.CACHE.INVALIDATE':['key'],
 'INTERACTION.ACT.TOOL':['tool','arguments'],'INTERACTION.OBSERVE':['result'],'RETRIEVAL.SEARCH':['query','target','limit']};
function required(c:any,key:string):Source{check(Object.hasOwn(c,key),`Missing ${key}`);validateSource(c[key]);return c[key];}
function view(c:any,key:string,want:View):void{const s=required(c,key);if(s?.from)check(s.from==='node'&&s.view===want,`${key} requires node view=${want}`);}
function validateNode(n:DefinitionNode):void{
 keys(n,['id','type','dependencies','config']);id(n.id);check(NODE_TYPES.includes(n.type),'Unsupported Ditto node type');
 check(Array.isArray(n.dependencies)&&n.dependencies.every(d=>typeof d==='string')&&new Set(n.dependencies).size===n.dependencies.length,'Invalid dependencies');
 const c=n.config;keys(c,fields[n.type]);
 if(c.instruction!==undefined)text(c.instruction,'instruction',true);if(c.user!==undefined)validateSource(c.user);if(c.outputFormat!==undefined)check(['text','json'].includes(c.outputFormat),'outputFormat must be text or json');
 switch(n.type){
  case'CONTEXT.LOAD':check(Array.isArray(c.sources)&&c.sources.length>0&&c.sources.length<=64,'LOAD sources required');c.sources.forEach(validateSource);break;
  case'CONTEXT.SELECT':case'CONTEXT.UPDATE':case'CONTEXT.COMPRESS':view(c,'context','context');if(c.query!==undefined)validateSource(c.query);if(c.add!==undefined)validateSource(c.add);if(c.removeIds)check(Array.isArray(c.removeIds)&&c.removeIds.every((x:any)=>typeof x==='string'),'removeIds must be strings');break;
  case'MEMORY.WRITE':required(c,'content');break;
  case'MEMORY.GET':case'MEMORY.DELETE':view(c,'ids','memory-ids');break;
  case'MEMORY.UPDATE':view(c,'ids','memory-ids');required(c,'content');break;
  case'MEMORY.SEARCH':required(c,'query');if(c.limit!==undefined)positive(c.limit,'memory search limit',1000);break;
  case'MEMORY.QUERY':if(c.filter!==undefined)object(c.filter);break;
  case'INFER.REASONING.SAMPLE':case'INFER.REASONING.TRAJECTORY':text(c.instruction,'instruction',true);if(c.evidence!==undefined){check(Array.isArray(c.evidence)&&c.evidence.length<=24,`${n.id}.config.evidence must be Binding[] (at most 24); wrap a single binding in [binding], e.g. [{"ref":["nodes","upstream","message","content"]}]`);c.evidence.forEach(validateSource);}
   if(n.type.endsWith('TRAJECTORY')){check(['cot','long-cot','tot','got','self-consistency'].includes(c.strategy),'Unknown reasoning strategy');if(c.options!==undefined){const allowed=c.strategy==='self-consistency'?['candidates']:c.strategy==='tot'?['breadth','depth','beamWidth']:c.strategy==='got'?['breadth','depth']:['rounds'];keys(c.options,allowed);for(const[k,v]of Object.entries(c.options))positive(v,k,c.strategy==='self-consistency'?7:8);}if(c.maxSteps!==undefined)positive(c.maxSteps,'maxSteps');}break;
  case'INFER.REASONING.REFLECT':view(c,'target','answer');check(['verify','critique','revise'].includes(c.mode),'Invalid reflection mode');check(Array.isArray(c.criteria)&&c.criteria.length>0&&c.criteria.length<=8,'Criteria required');c.criteria.forEach((x:any)=>text(x,'criterion'));if(c.feedback!==undefined){check(Array.isArray(c.feedback),`${n.id}.config.feedback must be an array of prior checker references, not instruction text; put prose in instruction, or omit feedback/use []`);c.feedback.forEach((s:any)=>{validateSource(s);if(s?.from)check(s.from==='node'&&s.view==='assessment','feedback must be a checker assessment');});}break;
  case'INFER.REASONING.DELIBERATE':check(['select','merge','consensus','debate'].includes(c.mode),'Invalid deliberation mode');check(Array.isArray(c.candidates)&&c.candidates.length>=2&&c.candidates.length<=8,'At least two candidates required');c.candidates.forEach((s:any)=>{validateSource(s);if(s?.from)check(s.from==='node'&&s.view==='answer','Candidates must be answer nodes');});break;
  case'INTERACTION.ACT.TOOL':text(c.tool,'tool name');object(c.arguments);Object.values(c.arguments).forEach(validateSource);break;
  case'INTERACTION.OBSERVE':view(c,'result','external-result');break;
  case'INFER.CACHE.LOOKUP':case'INFER.CACHE.INVALIDATE':required(c,'key');break;
  case'INFER.CACHE.WRITE':required(c,'key');required(c,'value');if(c.ttlMs!==undefined)positive(c.ttlMs,'ttlMs');break;
  case'RETRIEVAL.SEARCH':required(c,'query');check(c.target===undefined||c.target==='task-public','Retrieval target must be host-authorized task-public');if(c.limit!==undefined)positive(c.limit,'retrieval limit',100);break;
 }
 for(const key of ['limit','maxTokens','maxItems'])if(c[key]!==undefined)positive(c[key],key);
}
export function topologicalNodes(g:DefinitionGraph):DefinitionNode[]{const done:DefinitionNode[]=[],pending=new Map(g.nodes.map(n=>[n.id,n]));while(pending.size){const n=[...pending.values()].find(n=>n.dependencies.every(d=>done.some(x=>x.id===d)));check(n,'Graph dependencies contain a cycle or unavailable local node');done.push(n!);pending.delete(n!.id);}return done;}
export function targets(t:Transition):string[]{switch(t.kind){case'end':return[];case'next':return[t.graphId];case'repeat':return[t.graphId,...t.nextGraphId?[t.nextGraphId]:[]];case'switch':return[...t.cases.map(c=>c.graphId),...t.defaultGraphId?[t.defaultGraphId]:[]];}}
const conditions=(t:Transition):Condition[]=>t.kind==='repeat'?[t.until]:t.kind==='switch'?t.cases.map(c=>c.when):[];
function validateCondition(c:Condition):void{
 keys(c,['source','left','right','path','operator','value']);check(['equals','not-equals','truthy','falsy','gt','gte','lt','lte'].includes(c.operator),'Invalid condition operator');
 check((c.source!==undefined)!==(c.left!==undefined),'Condition requires exactly source or left');validateSource(c.source??c.left);if(c.right!==undefined)validateSource(c.right);
 if(c.path!==undefined){validatePath(c.path);check(c.path.length<=8,'Condition path too long');}
}
const nativeRoots:Partial<Record<NodeType,string[]>>={
 'CONTEXT.LOAD':['items'],'CONTEXT.SELECT':['context','selectedItemIds','purpose'],'CONTEXT.UPDATE':['items'],'CONTEXT.COMPRESS':['items'],
 'INFER.REASONING.SAMPLE':['message','finishReason','actionRequests','usage','generationOutcome'],'INFER.REASONING.TRAJECTORY':['result','steps','status','stopReason','usage','generationOutcome'],
 'INFER.REASONING.REFLECT':['assessment','issues','revisedResult','usage','checkerAudit','message','generationOutcome'],'INFER.REASONING.DELIBERATE':['result','selectedCandidateIds','assessments','decisionSummary','usage','generationOutcome'],
 'INFER.CACHE.LOOKUP':['hit','value'],'INFER.CACHE.WRITE':['written','key'],'INFER.CACHE.INVALIDATE':['invalidated'],
 'RETRIEVAL.SEARCH':['candidates','strategy','target','metadata'],
 'INTERACTION.ACT.TOOL':['callId','source','status','content','structuredContent','error'],'INTERACTION.OBSERVE':['callId','source','status','message','structuredContent','error']};
export function validateDefinition(input:unknown):GraphDefinition{
 json(input);const d=structuredClone(input) as GraphDefinition;keys(d,['version','graphs','loop','output','tools','mutation']);check(d.version===1||d.version===2,'Unsupported definition version');
 check(Array.isArray(d.graphs)&&d.graphs.length>0&&d.graphs.length<=24,'Expected 1..24 Graphs');
 const graphIds=new Set<string>(),nodes=new Map<string,{node:DefinitionNode;graph:string}>();
 for(const g of d.graphs){keys(g,['id','nodes']);id(g.id);check(!graphIds.has(g.id),'Duplicate Graph');graphIds.add(g.id);check(Array.isArray(g.nodes)&&g.nodes.length>0,'Empty Graph');for(const n of g.nodes){validateNode(n);check(!nodes.has(n.id),'Node IDs must be unique across Graphs');nodes.set(n.id,{node:n,graph:g.id});}}
 check(nodes.size>=2&&nodes.size<=CODING_EXECUTION_POLICY.maxDeclaredNodes,'Expected 2..24 nodes');
 for(const g of d.graphs){for(const n of g.nodes)for(const dep of n.dependencies)check(nodes.get(dep)?.graph===g.id,'Dependencies are local; cross-Graph values use Sources/Loop');topologicalNodes(g);}
 keys(d.loop,['entryGraphId','maxGraphRuns','transitions','state','stateUpdates']);check(graphIds.has(d.loop.entryGraphId),'Unknown entry Graph');positive(d.loop.maxGraphRuns,'maxGraphRuns',d.version===1?12:Number.MAX_SAFE_INTEGER);object(d.loop.transitions);if(d.loop.state!==undefined)object(d.loop.state);
 for(const key of Object.keys(d.loop.transitions))check(graphIds.has(key),'Transition for unknown Graph');
 for(const g of d.graphs){const t=d.loop.transitions[g.id]!;check(t,'Every Graph needs a transition');switch(t.kind){case'end':keys(t,['kind']);break;case'next':keys(t,['kind','graphId']);break;case'repeat':keys(t,['kind','graphId','maxVisits','until','nextGraphId']);positive(t.maxVisits,'maxVisits',d.version===1?12:Number.MAX_SAFE_INTEGER);validateCondition(t.until);break;case'switch':keys(t,['kind','cases','defaultGraphId']);check(Array.isArray(t.cases)&&t.cases.length>0&&t.cases.length<=8,'Invalid switch cases');for(const c of t.cases){keys(c,['when','graphId']);validateCondition(c.when);}break;default:throw new DefinitionError('Unknown Loop transition');}for(const target of targets(t))check(graphIds.has(target),'Unknown Loop target');}
 const reachable=new Set<string>();const visit=(g:string):void=>{if(reachable.has(g))return;reachable.add(g);targets(d.loop.transitions[g]!).forEach(visit);};visit(d.loop.entryGraphId);check(reachable.size===graphIds.size,'Unreachable Graph');
 const exits=d.graphs.filter(g=>{const t=d.loop.transitions[g.id]!;return t.kind==='end'||t.kind==='repeat'&&!t.nextGraphId||t.kind==='switch'&&!t.defaultGraphId;});check(exits.length>0,'Loop needs a possible exit');
 const dom=new Map([...graphIds].map(g=>[g,new Set(g===d.loop.entryGraphId?[g]:graphIds)]));let changed=true;while(changed){changed=false;for(const g of graphIds){if(g===d.loop.entryGraphId)continue;const parents=[...graphIds].filter(p=>targets(d.loop.transitions[p]!).includes(g));const next=new Set([g,...[...graphIds].filter(x=>parents.every(p=>dom.get(p)!.has(x)))]);if([...next].sort().join()!==[...dom.get(g)!].sort().join()){dom.set(g,next);changed=true;}}}
 const references=(value:any,g:string,consumer?:DefinitionNode):void=>{
  for(const s of sources(value)){if(s.from!=='node'&&s.from!=='previous')continue;const p=nodes.get(s.nodeId);check(p,'Unknown source node');if(s.from==='node'){if(p!.graph===g){if(consumer)check(consumer.dependencies.includes(s.nodeId),'Local source must be a dependency');}else check(dom.get(g)!.has(p!.graph),'Cross-Graph source is not available on every incoming route');}const t=p!.node.type;check(s.view!=='answer'||t.startsWith('INFER.REASONING.'),'Answer view requires an Infer answer; tools are evidence');check(s.view!=='context'||t.startsWith('CONTEXT.'),'Context view requires a Context producer');check(s.view!=='assessment'||t==='INFER.REASONING.REFLECT','Assessment requires REFLECT');check(s.view!=='external-result'||t==='INTERACTION.ACT.TOOL','External result requires ACT.TOOL');check(!['memory-ids','memory-records'].includes(s.view)||t.startsWith('MEMORY.'),'Memory view requires Memory producer');check(s.view!=='cache'||t.startsWith('INFER.CACHE.'),'Cache view requires Cache producer');}
  for(const r of bindingReferences(value)){const p=nodes.get(r.nodeId);check(p,'Unknown native output source node');if(r.namespace==='nodes'&&!r.optional){if(p!.graph===g){if(consumer)check(consumer.dependencies.includes(r.nodeId),'Local native reference requires a dependency');}else check(dom.get(g)!.has(p!.graph),'Cross-Graph native source is not available on every incoming route');}if(r.namespace==='prior')check(r.optional,'prior references need a coalesce first-visit fallback');const roots=nativeRoots[p!.node.type];if(r.path.length&&roots)check(roots.includes(String(r.path[0])),`Unknown native output field ${String(r.path[0])} for ${p!.node.type}`);if(r.path[0]==='revisedResult'&&!r.optional)check(p!.node.config.mode==='revise','Optional revisedResult requires coalesce or a guarded route');}
 };
 for(const{node,graph}of nodes.values())references(node.config,graph,node);
 if(d.loop.stateUpdates!==undefined){object(d.loop.stateUpdates);for(const[g,patch]of Object.entries(d.loop.stateUpdates)){check(graphIds.has(g),'State update references unknown Graph');object(patch);for(const[k,value]of Object.entries(patch)){check(Object.hasOwn(d.loop.state??{},k),'State update requires a declared initial key');validateSource(value);references(value,g);}}}
 for(const g of d.graphs)for(const c of conditions(d.loop.transitions[g.id]!)){references(c.source??c.left,g.id);if(c.right!==undefined)references(c.right,g.id);}
 keys(d.output,['nodeId','view','answer']);const outputIds:string[]=[];
 if(Object.hasOwn(d.output,'answer')){check(d.version===2,'Native output binding requires version 2');check(d.output.nodeId===undefined&&d.output.view===undefined,'Choose answer binding OR nodeId/view');validateSource(d.output.answer);outputIds.push(...bindingReferences(d.output.answer).filter(r=>!r.optional).map(r=>r.nodeId),...sources(d.output.answer).filter(s=>s.from==='node').map(s=>(s as Extract<SemanticSource,{from:'node'}>).nodeId));for(const exit of exits)references(d.output.answer,exit.id);}
 else{check(d.output.view==='answer','Final output must be answer view');const output=nodes.get(d.output.nodeId!);check(output&&output.node.type.startsWith('INFER.REASONING.'),'Output must be an Infer node');outputIds.push(d.output.nodeId!);for(const exit of exits)check(dom.get(exit.id)!.has(output!.graph),'Output node may be skipped on an ending route');}
 if(d.tools!==undefined){check(Array.isArray(d.tools)&&d.tools.length<=6,'At most six tools');const names=new Set<string>();for(const t of d.tools){keys(t,['name','description','inputSchema','executeSource']);check((d.version===1?/^generated_[a-z][\w-]{0,55}$/:/^[a-z][a-z0-9_-]{0,63}$/).test(t.name)&&!names.has(t.name),'Invalid/duplicate generated tool name');names.add(t.name);text(t.description,'tool description');check(record(t.inputSchema),`${t.name}.inputSchema is required and must be a JSON object schema, e.g. {"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}`);check(t.inputSchema.type==='object','Tool inputSchema must be an object schema');text(t.executeSource,'tool source');validateModuleSyntax(`export const execute=(${t.executeSource});`);const fn:any=parseExpressionAt(t.executeSource,0,{ecmaVersion:'latest'});check(['FunctionExpression','ArrowFunctionExpression'].includes(fn.type)&&!fn.async&&!fn.generator,'Generated tool must be a synchronous pure function');}}
 const builtins=['bounded_arithmetic','literal_text_find'];const available=new Set([...builtins,...(d.tools??[]).map(t=>t.name)]);check(!(d.tools??[]).some(t=>builtins.includes(t.name)),'Cannot redefine a host tool');for(const{node}of nodes.values())if(node.type==='INTERACTION.ACT.TOOL')check(available.has(node.config.tool),'Tool is not registered');
 const refs=(v:any):string[]=>[...sources(v).filter(s=>s.from==='node'||s.from==='previous').map(s=>(s as Extract<SemanticSource,{from:'node'}>).nodeId),...bindingReferences(v).map(r=>r.nodeId)];
 // State writers are genuine consumers even when a later lookup connects through a key,
 // rather than an explicit source edge back to the write node.
 const stateWriters=new Set(['MEMORY.WRITE','MEMORY.UPDATE','MEMORY.DELETE','INFER.CACHE.WRITE','INFER.CACHE.INVALIDATE']);
 const consumed=new Set([...outputIds,...[...nodes.values()].filter(({node})=>stateWriters.has(node.type)).map(({node})=>node.id)]);refs(d.output.answer).forEach(x=>consumed.add(x));for(const g of d.graphs){for(const c of conditions(d.loop.transitions[g.id]!))refs(c.source??c.left).concat(refs(c.right)).forEach(x=>consumed.add(x));for(const v of Object.values(d.loop.stateUpdates?.[g.id]??{}))refs(v).forEach(x=>consumed.add(x));}
 const follow=(nodeId:string):void=>{for(const source of refs(nodes.get(nodeId)?.node.config))if(!consumed.has(source)){consumed.add(source);follow(source);}};for(const nodeId of [...consumed])follow(nodeId);
 const firstLoad=[...nodes.values()].find(x=>x.node.type==='CONTEXT.LOAD')?.node.id;for(const{node}of nodes.values())check(consumed.has(node.id)||node.id===firstLoad||['MEMORY.WRITE','MEMORY.UPDATE','MEMORY.DELETE','INFER.CACHE.WRITE','INFER.CACHE.INVALIDATE'].includes(node.type),`Unused node ${node.id}`);
 if(d.mutation){keys(d.mutation,['primaryNodeId','auxiliary']);id(d.mutation.primaryNodeId);check(nodes.has(d.mutation.primaryNodeId),'Unknown primary mutation node');check(Array.isArray(d.mutation.auxiliary),'Auxiliary mutation declarations required');const seen=new Set<string>();for(const a of d.mutation.auxiliary){keys(a,['nodeId','reason']);id(a.nodeId);text(a.reason,'auxiliary reason');check(nodes.has(a.nodeId)&&a.nodeId!==d.mutation.primaryNodeId&&!seen.has(a.nodeId),'Invalid auxiliary mutation node');seen.add(a.nodeId);}}
 return d;
}
export function parseDefinition(text:string):GraphDefinition{return validateDefinition(JSON.parse(text));}
export function definitionShape(d:GraphDefinition):ModuleShape{validateDefinition(d);return{nodes:d.graphs.flatMap(g=>topologicalNodes(g).map(n=>({id:n.id,type:n.type,graphId:g.id,dependencies:n.dependencies,bindingHash:digest({type:n.type,config:n.config})}))),tools:(d.tools??[]).map(t=>({name:t.name,sourceHash:digest(t)})),controlHash:digest({loop:d.loop,output:d.output}),sourceHash:digest(d),environmentHash:GRAPH_AGENT_POLICY};}
export function validateDefinitionChange(parentText:string,childText:string):void{
 const pd=parseDefinition(parentText),cd=parseDefinition(childText),p=definitionShape(pd),c=definitionShape(cd),old=new Map(p.nodes.map(n=>[n.id,n]));const added=c.nodes.filter(n=>!old.has(n.id)),removed=p.nodes.filter(n=>!c.nodes.some(x=>x.id===n.id));
 if(cd.version===1)check(added.length<=1&&removed.length<=1&&!(added.length&&removed.length),'At most ONE added node, or one deletion without adding');
 else{check(removed.length<=1,'A deletion-only change may remove one node; preserve unrelated parent nodes');if(added.length>1){const m=cd.mutation;check(m&&added.some(n=>n.id===m.primaryNodeId),'Multiple additions require one added primaryNodeId');const names=new Set(m!.auxiliary.map(a=>a.nodeId));check(names.size===added.length-1&&added.every(n=>n.id===m!.primaryNodeId||names.has(n.id)),'Every extra added node needs an auxiliary reason');
   const before=new Map(c.nodes.map(n=>[n.id,new Set<string>()])),after=new Map(c.nodes.map(n=>[n.id,new Set<string>()]));for(const n of cd.graphs.flatMap(g=>g.nodes)){const references=[...n.dependencies,...sources(n.config).filter(s=>s.from==='node'||s.from==='previous').map(s=>(s as Extract<SemanticSource,{from:'node'}>).nodeId),...bindingReferences(n.config).map(r=>r.nodeId)];for(const other of references){before.get(n.id)!.add(other);after.get(other)?.add(n.id);}}
   const traverse=(links:Map<string,Set<string>>):Set<string>=>{const reached=new Set<string>();const visit=(id:string):void=>{if(reached.has(id))return;reached.add(id);for(const next of links.get(id)??[])visit(next);};visit(m!.primaryNodeId);return reached;};const ancestors=traverse(before),descendants=traverse(after);check(added.every(n=>ancestors.has(n.id)||descendants.has(n.id)),'Auxiliary nodes must be predecessors or successors of the primary node; shared consumers are insufficient');}}
 check(c.nodes.filter(n=>old.has(n.id)&&(n.bindingHash!==old.get(n.id)!.bindingHash||n.graphId!==old.get(n.id)!.graphId)).length<=CODING_MUTATION_POLICY.maxExistingContentChanges,'At most FIVE existing content/bindings may change');
 const edges=(s:ModuleShape)=>new Set(s.nodes.flatMap(n=>n.dependencies.map(dep=>`${dep}->${n.id}`))),a=edges(p),b=edges(c);check([...a].filter(e=>!b.has(e)).length+[...b].filter(e=>!a.has(e)).length<=dependencyEditBudget(Math.max(p.nodes.length,c.nodes.length)),'Dependency edit budget exceeded');
 check([...new Set([...p.tools,...c.tools].map(t=>t.name))].filter(name=>p.tools.find(t=>t.name===name)?.sourceHash!==c.tools.find(t=>t.name===name)?.sourceHash).length<=1,'At most ONE tool change');check(p.sourceHash!==c.sourceHash,'Duplicate unchanged definition');
}
export const BASELINE_DEFINITION:GraphDefinition={version:2,graphs:[{id:'agent',nodes:[{id:'context',type:'CONTEXT.LOAD',dependencies:[],config:{sources:[{from:'task',field:'prompt'}]}},{id:'solve',type:'INFER.REASONING.SAMPLE',dependencies:['context'],config:{instruction:''}}]}],loop:{entryGraphId:'agent',maxGraphRuns:Number.MAX_SAFE_INTEGER,transitions:{agent:{kind:'end'}}},output:{nodeId:'solve',view:'answer'}};
