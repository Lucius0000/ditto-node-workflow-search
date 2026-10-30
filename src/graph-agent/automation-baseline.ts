import {AUTOMATION_TOOLS} from '../benchmark/automation.js';
import {validateDefinition,type DefinitionNode,type GraphDefinition,type Source} from './schema.js';
import type {ActionDescriptor} from '@codesoul-co/ditto/worker/infer';
import {BindingContractError,ModelOutputFormatError} from './bindings.js';

export const AUTOMATION_DECISION_INSTRUCTION='Complete the original task using the official tools. Each turn return strict JSON: {"done":false,"tool":"api_search|api_fetch|base64_encode","arguments":{...}}; once the requested changes are complete return {"done":true,"tool":"","arguments":{}}. For api_fetch always supply method, url, params and body; use actual JSON null for absent params/body, otherwise JSON-encoded strings. Discover endpoint contracts using api_search. Use returned observations for the next decision. Do not claim completion without performing required actions.';

/** Only this exact, host-owned instruction establishes this response contract. */
export function usesAutomationDecisionContract(node:DefinitionNode):boolean {
 return node.type==='INFER.REASONING.SAMPLE'&&node.config.outputFormat==='json'&&node.config.instruction===AUTOMATION_DECISION_INSTRUCTION;
}
export function validateAutomationDecision(content:string,nodeId:string,tools:readonly ActionDescriptor[]):void {
 const fail=(field:string):never=>{throw new ModelOutputFormatError(`Automation decision omitted or invalidated required field ${field}`,nodeId);};
 let decision:any;try{decision=JSON.parse(content);}catch{fail('JSON');}
 if(!decision||typeof decision!=='object'||Array.isArray(decision))fail('decision object');
 if(typeof decision.done!=='boolean')fail('done');
 if(typeof decision.tool!=='string')fail('tool');
 if(!decision.arguments||typeof decision.arguments!=='object'||Array.isArray(decision.arguments))fail('arguments');
 if(decision.done){if(decision.tool!=='')fail('tool (empty when done)');return;}
 if(!(AUTOMATION_TOOLS as readonly string[]).includes(decision.tool))fail('tool (registered official name)');
 const descriptor=tools.find(tool=>tool.name===decision.tool);
 if(!descriptor||!Array.isArray(descriptor.inputSchema?.required))throw new BindingContractError('Official Automation tool required-field schema is unavailable');
 // api_search.top_k has an explicit host default. api_fetch's four fields are
 // explicitly required by the instruction, including nullable params/body.
 const required=new Set<string>((descriptor.inputSchema.required as unknown[]).filter((field):field is string=>typeof field==='string'));
 if(decision.tool==='api_search')required.delete('top_k');
 if(decision.tool==='api_fetch')for(const field of ['method','url','params','body'])required.add(field);
 for(const field of required)if(!Object.hasOwn(decision.arguments,field))fail(`arguments.${field}`);
}

/** Engineering baseline: one model decision and its declared tool/observation loop. */
export function automationBaseline(maxDecisions:number):GraphDefinition {
 if(!Number.isSafeInteger(maxDecisions)||maxDecisions<1)throw Error('Invalid Automation decision budget');
 const decision:Source={parse:{ref:['nodes','decide','message','content']}};
 const property=(name:string):Source=>({get:{value:decision,path:[name]}});
 const argumentsFor:Record<string,Record<string,Source>>={
  api_search:{query:{get:{value:property('arguments'),path:['query']}},top_k:{coalesce:[{get:{value:property('arguments'),path:['top_k']}},{literal:5}]}},
  api_fetch:Object.fromEntries(['method','url','params','body'].map(key=>[key,{get:{value:property('arguments'),path:[key]}}])),
  base64_encode:{text:{get:{value:property('arguments'),path:['text']}}},
 };
 const graphs=AUTOMATION_TOOLS.map((tool,index)=>{
  const id=`action-${index}`,act=`call-${index}`,observe=`observe-${index}`;
  return{id,nodes:[{id:act,type:'INTERACTION.ACT.TOOL' as const,dependencies:[],config:{tool,arguments:argumentsFor[tool]}},
   {id:observe,type:'INTERACTION.OBSERVE' as const,dependencies:[act],config:{result:{from:'node',nodeId:act,view:'external-result'}}}]};
 });
 return validateDefinition({version:2,graphs:[{id:'decision',nodes:[{id:'decide',type:'INFER.REASONING.SAMPLE',dependencies:[],config:{
  instruction:AUTOMATION_DECISION_INSTRUCTION,
  user:{concat:[{literal:'Prior decisions and official observations:\n'},{json:{ref:['state','history']}}]},outputFormat:'json',
 }}]},...graphs],loop:{entryGraphId:'decision',maxGraphRuns:maxDecisions*2,state:{history:[]},
  transitions:{decision:{kind:'switch',cases:AUTOMATION_TOOLS.map((tool,index)=>({when:{left:property('tool'),operator:'equals',value:tool},graphId:`action-${index}`}))},
   ...Object.fromEntries(graphs.map(g=>[g.id,{kind:'next',graphId:'decision'}]))},
  stateUpdates:Object.fromEntries(graphs.map((g,index)=>[g.id,{history:{append:[{ref:['state','history']},{decision,observation:{ref:['nodes',`observe-${index}`]}}]}}])),
 },output:{nodeId:'decide',view:'answer'}});
}
