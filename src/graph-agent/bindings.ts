/** Pure, JSON-only bindings. Candidate code never receives the execution interface. */
export type BindingPath = readonly (string | number)[];
export class BindingContractError extends Error { readonly code = 'B_BINDING_CONTRACT'; }
export class MissingBindingPath extends BindingContractError { readonly missing = true; }
export class ModelOutputFormatError extends Error {
  readonly code = 'MODEL_OUTPUT_FORMAT';
  constructor(message:string, readonly nodeId?:string) { super(message); }
}
const OPERATORS = new Set(['literal','ref','get','json','parse','concat','coalesce','append']);
const FORBIDDEN = new Set(['__proto__','prototype','constructor']);
const own = (value:any,key:string|number):boolean => value !== null && ['object','string'].includes(typeof value) && Object.hasOwn(value,key);
export const isBindingOperator = (value:any):boolean => !!value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).some(k=>OPERATORS.has(k));
export function bindingReferences(value:any):{namespace:'nodes'|'prior';nodeId:string;path:BindingPath;optional:boolean}[] {
  const found:{namespace:'nodes'|'prior';nodeId:string;path:BindingPath;optional:boolean}[]=[];
  const visit=(v:any,optional=false):void=>{
    if(!v||typeof v!=='object')return;
    if(Object.hasOwn(v,'literal')||v.from==='literal')return;
    if(Array.isArray(v.ref)&&['nodes','prior'].includes(v.ref[0]))found.push({namespace:v.ref[0],nodeId:v.ref[1],path:v.ref.slice(2),optional});
    for(const [k,item]of Object.entries(v)) {
      if(k==='ref')continue;
      if(k==='coalesce'&&Array.isArray(item))item.forEach((x,i)=>visit(x,optional||i<item.length-1));
      else if(Array.isArray(item))item.forEach(x=>visit(x,optional));else visit(item,optional);
    }
  };visit(value);return found;
}
export function validateBinding(value:any,depth=0):void {
  if(depth>64)throw new BindingContractError('Binding nesting exceeds 64');
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))throw new BindingContractError('Binding number must be finite');return;}
  if(Array.isArray(value)){value.forEach(v=>validateBinding(v,depth+1));return;}
  if(!value||typeof value!=='object')throw new BindingContractError('Bindings must be JSON data');
  const keys=Object.keys(value);if(keys.some(k=>FORBIDDEN.has(k)))throw new BindingContractError('Unsafe binding property');
  const operators=keys.filter(k=>OPERATORS.has(k));
  if(!operators.length){Object.values(value).forEach(v=>validateBinding(v,depth+1));return;}
  if(keys.length!==1)throw new BindingContractError('A binding operator must occur alone; use literal for literal objects');
  const op=keys[0]!;
  if(op==='literal'){validateLiteral(value.literal,depth+1);return;}
  if(op==='ref'){
    const p=value.ref;if(!Array.isArray(p)||p.length<2||!['task','nodes','prior','state'].includes(p[0]))throw new BindingContractError('ref must start with task/nodes/prior/state');
    validatePath(p);if(p[0]==='task'&&!['id','dataset','prompt','outputInstruction'].includes(String(p[1])))throw new BindingContractError('Only public task fields may be referenced');
    if(['nodes','prior','state'].includes(String(p[0]))&&typeof p[1]!=='string')throw new BindingContractError('ref needs a named node or state key');return;
  }
  if(op==='get'){
    const g=value.get;if(!g||typeof g!=='object'||Object.keys(g).sort().join()!=='path,value')throw new BindingContractError('get requires exactly value and path');
    validatePath(g.path);validateBinding(g.value,depth+1);return;
  }
  if(['concat','coalesce','append'].includes(op)){
    const items=value[op];if(!Array.isArray(items)||!items.length||(op==='append'&&items.length!==2))throw new BindingContractError(`Invalid ${op} operands`);
    items.forEach(v=>validateBinding(v,depth+1));return;
  }
  validateBinding(value[op],depth+1);
}
function validateLiteral(v:any,depth:number):void {
  if(depth>64)throw new BindingContractError('Literal nesting exceeds 64');
  if(v===null||typeof v==='string'||typeof v==='boolean')return;
  if(typeof v==='number'&&Number.isFinite(v))return;
  if(Array.isArray(v)){v.forEach(x=>validateLiteral(x,depth+1));return;}
  if(v&&typeof v==='object'&&Object.keys(v).every(k=>!FORBIDDEN.has(k))){Object.values(v).forEach(x=>validateLiteral(x,depth+1));return;}
  throw new BindingContractError('Literal must be finite safe JSON');
}
export function validatePath(path:any):asserts path is (string|number)[] {
  if(!Array.isArray(path)||path.some(k=>!(typeof k==='string'&&!FORBIDDEN.has(k))&&!(Number.isSafeInteger(k)&&k>=0)))throw new BindingContractError('Unsafe or invalid property path');
}
export function readBindingPath(value:any,path:BindingPath):any {
  for(const key of path){if(!own(value,key))throw new MissingBindingPath(`Required binding path is absent: ${String(key)}`);value=value[key];}
  return value;
}
export interface BindingEnvironment {
  task:Record<string,any>;nodes:Record<string,any>;prior:Record<string,any>;state:Record<string,any>;
  /** Must return already normalized native output, not a NodeResult envelope. */
  nodeOutput(nodeId:string,value:any):any;
  isModelNode(nodeId:string):boolean;
}
export function evaluateBinding(value:any,env:BindingEnvironment):any {
  if(value===null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(v=>evaluateBinding(v,env));
  if(Object.hasOwn(value,'literal'))return structuredClone(value.literal);
  if(Object.hasOwn(value,'ref')){
    const [namespace,id,...path]=value.ref;
    const source=env[namespace as 'task'|'nodes'|'prior'|'state'];
    const item=readBindingPath(source,[id]);
    return readBindingPath(['nodes','prior'].includes(namespace)?env.nodeOutput(id,item):item,path);
  }
  if(Object.hasOwn(value,'get'))return readBindingPath(evaluateBinding(value.get.value,env),value.get.path);
  if(Object.hasOwn(value,'json'))return JSON.stringify(evaluateBinding(value.json,env));
  if(Object.hasOwn(value,'parse')){
    const text=evaluateBinding(value.parse,env);
    if(typeof text!=='string')throw new BindingContractError('parse requires a string');
    try{return JSON.parse(text);}catch{
      const reference=value.parse?.ref;
      if(Array.isArray(reference)&&['nodes','prior'].includes(reference[0])&&env.isModelNode(reference[1])&&['message','result'].includes(reference[2])&&reference[3]==='content')throw new ModelOutputFormatError('Model did not produce the JSON requested by its user instruction',reference[1]);
      throw new BindingContractError('parse received invalid JSON from a non-model or transformed source');
    }
  }
  if(Object.hasOwn(value,'concat'))return value.concat.map((v:any)=>{
    const item=evaluateBinding(v,env);if(item!==null&&typeof item==='object')throw new BindingContractError('concat requires scalar operands; use json for objects');return item==null?'':String(item);
  }).join('');
  if(Object.hasOwn(value,'coalesce')){
    for(const v of value.coalesce){try{const item=evaluateBinding(v,env);if(item!==null&&item!==undefined)return item;}catch(error){if(!(error instanceof MissingBindingPath))throw error;}}
    throw new MissingBindingPath('No coalesce alternative is available');
  }
  if(Object.hasOwn(value,'append')){
    const items=evaluateBinding(value.append[0],env);if(!Array.isArray(items))throw new BindingContractError('append requires an array as first operand');return [...items,evaluateBinding(value.append[1],env)];
  }
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,evaluateBinding(v,env)]));
}
