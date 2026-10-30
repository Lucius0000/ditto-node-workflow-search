import {AUTOMATION_TOOLS} from '../benchmark/automation.js';
import {validateDefinition,type GraphDefinition,type Source} from './schema.js';

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
  instruction:'Complete the original task using the official tools. Each turn return strict JSON: {"done":false,"tool":"api_search|api_fetch|base64_encode","arguments":{...}}; once the requested changes are complete return {"done":true,"tool":"","arguments":{}}. For api_fetch always supply method, url, params and body; use actual JSON null for absent params/body, otherwise JSON-encoded strings. Discover endpoint contracts using api_search. Use returned observations for the next decision. Do not claim completion without performing required actions.',
  user:{concat:[{literal:'Prior decisions and official observations:\n'},{json:{ref:['state','history']}}]},outputFormat:'json',
 }}]},...graphs],loop:{entryGraphId:'decision',maxGraphRuns:maxDecisions*2,state:{history:[]},
  transitions:{decision:{kind:'switch',cases:AUTOMATION_TOOLS.map((tool,index)=>({when:{left:property('tool'),operator:'equals',value:tool},graphId:`action-${index}`}))},
   ...Object.fromEntries(graphs.map(g=>[g.id,{kind:'next',graphId:'decision'}]))},
  stateUpdates:Object.fromEntries(graphs.map((g,index)=>[g.id,{history:{append:[{ref:['state','history']},{decision,observation:{ref:['nodes',`observe-${index}`]}}]}}])),
 },output:{nodeId:'decide',view:'answer'}});
}
