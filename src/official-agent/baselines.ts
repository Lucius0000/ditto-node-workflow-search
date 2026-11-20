import type {AgentDefinition,AgentNode} from '@codesoul-co/ditto/runtime';
import type {DatasetName} from '../domain.js';
import {BFCL_DECISION_STRATEGY,BFCL_HOST_GRAPH_RUN_LIMIT} from './bfcl-strategy.js';
import {OFFICIAL_BASELINE,officialNodes} from './schema.js';
import {DATA_TRANSFORM_NODE} from './helpers.js';
import {DefinitionError,digest} from '../graph-agent/schema.js';
import {AUTOMATION_DECISION_INSTRUCTION} from '../graph-agent/automation-baseline.js';

/** One native decision SAMPLE, explicit tool/observation data flow and an outer official Loop. */
export function officialBaseline(dataset:DatasetName):AgentDefinition{
 if(dataset==='bfcl')return bfclBaseline();
 if(dataset!=='automationbench')return structuredClone(OFFICIAL_BASELINE);
 const decision:AgentNode[]=[decisionNode(),{id:'decision',type:'HOST.DATA.TRANSFORM',dependsOn:['decide'],input:{operation:'decision',value:{$ref:'nodes.decide.output.message.content'},allowedTools:['api_search','api_fetch','base64_encode']}}];
 const action:AgentNode[]=[...actionNodes(),{id:'render',type:'HOST.DATA.TRANSFORM',dependsOn:['observe'],input:{operation:'evidence',value:{$ref:'nodes.observe'}}},
  {id:'history',type:'HOST.DATA.TRANSFORM',dependsOn:['observe','render'],input:{operation:'tool-history',tool:{$ref:'input.decision.tool'},decision:{$ref:'input.decision'},value:{$ref:'nodes.observe'},evidence:{$ref:'nodes.render'},history:{$ref:'input.history'}}}];
 return{version:1,id:`ditto-${dataset}`,config:{strategy:AUTOMATION_DECISION_INSTRUCTION},
  graphs:{main:{nodes:decision,output:{$ref:'nodes.decision'}},action:{nodes:action,output:{$ref:'nodes.history'}}},
  loop:{entry:'decision',maxIterations:120,state:{history:[],decision:null,final:''},steps:{
   decision:{graph:'main',input:graphInput,assign:{decision:{$ref:'result'},final:{$ref:'result.finalAnswer'}},transitions:[{when:{$ref:'result.done'},end:'completed'},{next:'action'}]},
   action:{graph:'action',input:{...graphInput,decision:{$ref:'state.decision'}},assign:{history:{$ref:'result.history'}},transitions:[{next:'decision'}]}},output:{$ref:'state.final'}}};
}

const graphInput={task:{$ref:'input.task'},host:{$ref:'input.host'},history:{$ref:'state.history'}};

function decisionNode():AgentNode{
 return {id:'decide',type:'INFER.REASONING.SAMPLE',input:{model:{$ref:'input.host.model'},generation:{$ref:'input.host.generation'},
  messages:{$op:'concat',args:[{$ref:'input.host.messages'},{$op:'concat',args:[{$ref:'input.history'},[{role:'user',content:{$ref:'config.strategy'}}]]}]}}};
}

function actionNodes():AgentNode[]{
 return [{id:'act',type:'INTERACTION.ACT.TOOL',input:{call:{id:'official-action',name:{$ref:'input.decision.tool'},arguments:{$ref:'input.decision.arguments'}}}},
  {id:'observe',type:'INTERACTION.OBSERVE',dependsOn:['act'],input:{result:{$ref:'nodes.act'}}}];
}

export const BFCL_BOUNDARY_PROTOCOL='bfcl-public-conversation-boundary-v2';

function bfclBaseline():AgentDefinition{
 return {version:1,id:'ditto-bfcl',config:{strategy:BFCL_DECISION_STRATEGY,bfclBoundaryProtocol:BFCL_BOUNDARY_PROTOCOL},graphs:{
  main:{nodes:[{id:'state',type:'INTERACTION.ACT.TOOL',input:{call:{id:'initial-state',name:'bfcl_state',arguments:{}}}}],output:{$ref:'nodes.state.structuredContent'}},
  decision:{nodes:[decisionNode()],output:{$ref:'nodes.decide.output.message.content'}},
  action:{nodes:actionNodes(),output:{$ref:'nodes.observe.structuredContent'}}},
  loop:{entry:'bootstrap',maxIterations:BFCL_HOST_GRAPH_RUN_LIMIT,state:{history:[],decision:null,final:'',complete:false},steps:{
   bootstrap:{graph:'main',input:graphInput,transitions:[{when:{$ref:'state.complete'},end:'completed'},{next:'decision'}]},
   decision:{graph:'decision',input:graphInput,transitions:[{when:{$ref:'state.complete'},end:'completed'},{next:'action'}]},
   action:{graph:'action',input:{...graphInput,decision:{$ref:'state.decision'}},transitions:[{when:{$ref:'state.complete'},end:'completed'},{next:'decision'}]}},
   output:{$ref:'state.final'}}};
}

export function validateBfclSearchGraph(definition:AgentDefinition):void{
 const baseline=bfclBaseline();
 const check=(condition:unknown,message:string,path:string)=>{if(!condition)throw new DefinitionError(message,path);};
 check((definition.config as Record<string,unknown>|undefined)?.bfclBoundaryProtocol===BFCL_BOUNDARY_PROTOCOL,'Preserve the fixed BFCL boundary protocol','/config/bfclBoundaryProtocol');
 check(!definition.deployment?.workers?.some(worker=>worker.use==='host-data'),'BFCL cannot select the host data Worker','/deployment/workers');
 check(digest(definition.loop??null)===digest(baseline.loop),'Preserve the fixed BFCL world Loop','/loop');
 for(const phase of ['main','action'] as const){
  const actual=definition.graphs[phase],expected=baseline.graphs[phase]!;
  check(actual&&digest(actual.output??null)===digest(expected.output),'Preserve the official BFCL observation output',`/graphs/${phase}/output`);
  for(const node of expected.nodes)check(digest(actual?.nodes.find(n=>n.id===node.id)??null)===digest(node),'Preserve the fixed BFCL world interface node',`/graphs/${phase}/nodes/${node.id}`);
 }
 const output=definition.graphs.decision?.output as {$ref?:string}|undefined;
 const decision=typeof output?.$ref==='string'?/^nodes\.([^.]+)\.output\.(message|result|revisedResult)\.content$/.exec(output.$ref):null;
 check(decision&&officialNodes(definition).some(n=>n.graph==='decision'&&n.node.id===decision[1]&&n.node.type.startsWith('INFER.REASONING.')),
  'Project one native Infer content string to the fixed BFCL decision decoder','/graphs/decision/output');
 for(const {id,node} of officialNodes(definition)){
  check(node.type!==DATA_TRANSFORM_NODE,'HOST.DATA.TRANSFORM is outside the approved BFCL Search Node catalogue',`/graphs/${id}/type`);
  if(node.type==='INTERACTION.ACT.TOOL'&&id!=='main/state'&&id!=='action/act'){
   const name=(node.input as {call?:{name?:unknown}})?.call?.name;
   check(typeof name==='string'&&!name.startsWith('bfcl_'),'Extra tool nodes must name a registered non-world tool literally',`/graphs/${id}/input/call/name`);
  }
 }
}
