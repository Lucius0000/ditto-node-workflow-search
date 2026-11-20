import {parseExpressionAt} from 'acorn';
import {ModelOutputFormatError} from '../graph-agent/bindings.js';
import {BFCL_TOOLS} from '../benchmark/bfcl.js';
import {HOST_TOOL_CONTRACTS} from './native-contracts.js';
import {validateNativeLiteral} from './native-validation.js';

export const DECISION_PROTOCOL_VERSION='single-action-protocol-v1';
type ObjectValue=Record<string,any>;
const object=(v:any):v is ObjectValue=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function fail(message:string):never{throw new ModelOutputFormatError(message);}

/** Parse data only. Duplicate keys cannot silently discard another proposed action. */
function json(source:string):any{
 const value=JSON.parse(source),tree=parseExpressionAt(source,0,{ecmaVersion:2025}) as any;
 const visit=(node:any):void=>{
  if(!node||typeof node!=='object')return;
  if(node.type==='ObjectExpression'){
   const seen=new Set<string>();
   for(const property of node.properties){const key=String(property.key.value);if(seen.has(key))fail('Duplicate decision JSON key: '+key);seen.add(key);}
  }
  for(const child of Object.values(node))if(Array.isArray(child))child.forEach(visit);else if(child&&typeof child==='object')visit(child);
 };visit(tree);return value;
}

function validate(value:any,allowedTools:readonly string[]){
 if(!object(value)||typeof value.done!=='boolean'||typeof value.tool!=='string'||!object(value.arguments))fail('Decision requires done:boolean, tool:string and arguments:object');
 if(value.done?value.tool!=='':!allowedTools.includes(value.tool))fail('Decision tool must be one permitted official tool, or empty when done');
 return{done:value.done,tool:value.tool,arguments:value.arguments,finalAnswer:typeof value.finalAnswer==='string'?value.finalAnswer:'End of declared agent execution.'};
}

function dsml(source:string):ObjectValue{
 const wrapper=/^<｜｜DSML｜｜ calls>\s*([\s\S]*?)\s*<\/｜｜DSML｜｜ calls>$/.exec(source);
 if(!wrapper)fail('Unrecognized decision protocol');
 const invoke=/^<｜｜DSML｜｜ invoke name="([A-Za-z_][A-Za-z0-9_]*)">\s*([\s\S]*?)\s*<\/｜｜DSML｜｜ invoke>$/.exec(wrapper[1]!);
 if(!invoke||invoke[2]!.includes('<｜｜DSML｜｜ invoke'))fail('Expected exactly one complete DSML tool invocation');
 const parameters:ObjectValue={};let remaining=invoke[2]!.trim();
 while(remaining){
  const parameter=/^<｜｜DSML｜｜ parameter name="([A-Za-z_][A-Za-z0-9_]*)" string="(true|false)">([\s\S]*?)<\/｜｜DSML｜｜ parameter>/.exec(remaining);
  if(!parameter)fail('Malformed DSML parameter');
  const key=parameter[1]!;if(Object.hasOwn(parameters,key)||['__proto__','constructor','prototype'].includes(key))fail('Duplicate or invalid DSML parameter: '+key);
  parameters[key]=parameter[2]==='true'?parameter[3]!:json(parameter[3]!);
  remaining=remaining.slice(parameter[0].length).trim();
 }
 let args:Record<string,unknown>;
 if(Object.hasOwn(parameters,'arguments')){
  if(!object(parameters.arguments)||Object.keys(parameters).some(k=>!['arguments','tool'].includes(k)))fail('Ambiguous nested DSML arguments');
  if(parameters.tool!==undefined&&parameters.tool!==invoke[1])fail('DSML tool names disagree');
  args=parameters.arguments;
 }else args=parameters;
 return{done:false,tool:invoke[1],arguments:args};
}

/** A structural conversion only: no tool execution, semantic repair or extra LLM call. */
export function decodeAutomationDecision(source:unknown,allowedTools:readonly string[]){
 if(typeof source!=='string')fail('Decision content must be text');
 const text=(source as string).trim();let value:any,format='json';
 if(text.startsWith('<｜｜DSML｜｜ calls>')){value=dsml(text);format='dsml-single-call';}
 else{
  let payload=text;
  const fenced=/^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if(fenced){payload=fenced[1]!;format='json-fence';}
  else if(!text.startsWith('{')){
   const start=text.indexOf('{');
   // Plain explanatory prose may precede one complete JSON object. Do not choose
   // between multiple proposals, arrays, fences or DSML invocations.
   if(start<0||/[\[\]{}]|```|DSML/.test(text.slice(0,start)))fail('No unambiguous single JSON decision');
   payload=text.slice(start);format='prose-plus-json';
  }
  try{value=json(payload);}catch(error){if(error instanceof ModelOutputFormatError)throw error;fail('Decision JSON is incomplete, ambiguous or malformed');}
 }
 return{...validate(value,allowedTools),valid:true as const,protocol:{version:DECISION_PROTOCOL_VERSION,format,recovered:format!=='json'}};
}

export function automationDecisionAttempt(source:unknown,allowedTools:readonly string[]){
 try{return decodeAutomationDecision(source,allowedTools);}catch(error){
  const failure=error instanceof ModelOutputFormatError?error:new ModelOutputFormatError(error instanceof Error?error.message:String(error));
  return{done:false,tool:'',arguments:{},finalAnswer:'',valid:false as const,protocol:{version:DECISION_PROTOCOL_VERSION,format:'unrecognized',recovered:false,error:{code:failure.code,message:failure.message},rawContent:source}};
 }
}

/** BFCL accepts only a single complete DSML action, under the same public tool contract. */
export function decodeBfclDsml(source:unknown){
 if(typeof source!=='string'||!source.trimStart().startsWith('<｜｜DSML｜｜ calls>'))return undefined;
 const decision=automationDecisionAttempt(source,BFCL_TOOLS);
 if(!decision.valid||decision.protocol.format!=='dsml-single-call')fail('error' in decision.protocol?decision.protocol.error.message:'Invalid BFCL DSML action');
 try{
  validateNativeLiteral(decision.arguments,HOST_TOOL_CONTRACTS[decision.tool]!.inputSchema,'/decision/arguments');
 }catch{fail('DSML action arguments do not meet the public BFCL interface');}
 const {done,tool,arguments:args,finalAnswer}=decision;
 return {done,tool,arguments:args,finalAnswer};
}
