import {DefinitionError,type ToolDefinition} from '../graph-agent/schema.js';
import type {MutationExplanation} from './schema.js';

export const OFFICIAL_PROPOSAL_CONTRACT_VERSION='official-proposal-envelope-v1';

const textSchema={type:'string',minLength:1,pattern:'\\S'};
/** Mutation metadata is not part of the native AgentDefinition. */
export const OFFICIAL_MUTATION_SCHEMA={
 type:'object',additionalProperties:false,required:['primaryNodeId','auxiliary'],
 properties:{primaryNodeId:textSchema,auxiliary:{type:'array',maxItems:0,items:{type:'object',additionalProperties:false,
  required:['nodeId','reason'],properties:{nodeId:textSchema,reason:textSchema}}}},
 description:'primaryNodeId identifies the one functional node change. auxiliary must be empty: companion additions are disabled. Added + removed + functionally modified nodes must total at most one; editable Infer user prompt changes and necessary reference/dependency wiring are separate and do not count. System templates remain frozen. Preserve the node ID for replacement.',
} as const;

/** Structural JSON schema only: native compiler and host policy remain authoritative. */
export const OFFICIAL_PROPOSAL_SCHEMA={
 $schema:'https://json-schema.org/draft/2020-12/schema',
 $id:'urn:ditto:workflow-search:official-proposal-envelope:v1',
 type:'object',additionalProperties:false,required:['rationale','definition'],
 properties:{
  rationale:{...textSchema,maxLength:8000,description:'One string containing public evidence, mechanism, change, supporting/contradicting observations and expected cost. Do not return an object of rationale sections.'},
  definition:{$ref:'#/$defs/agent'},mutation:OFFICIAL_MUTATION_SCHEMA,
  toolArtifacts:{type:'array',items:{type:'object',additionalProperties:false,required:['name','description','inputSchema','executeSource'],
   properties:{name:textSchema,description:{...textSchema,maxLength:8000},inputSchema:{type:'object',required:['type'],properties:{type:{const:'object'}},additionalProperties:true},executeSource:{...textSchema,maxLength:8000}}}},
 },
 $defs:{
  expression:{description:'JSON expression/literal accepted by the native compiler. References, operations and bindings are validated by compileAgent and the host catalogue.'},
  node:{oneOf:[
   {type:'object',additionalProperties:false,required:['id','type','input'],properties:{id:textSchema,kind:{const:'node'},type:textSchema,dependsOn:{type:'array',items:textSchema},input:{$ref:'#/$defs/expression'},require:{type:'object',additionalProperties:false,required:['path','equals'],properties:{path:textSchema,equals:{$ref:'#/$defs/expression'}}}}},
   {type:'object',additionalProperties:false,required:['id','kind','graph','input'],properties:{id:textSchema,kind:{const:'subgraph'},graph:textSchema,dependsOn:{type:'array',items:textSchema},input:{$ref:'#/$defs/expression'}}},
  ]},
  graph:{type:'object',additionalProperties:false,required:['nodes'],properties:{nodes:{type:'array',items:{$ref:'#/$defs/node'}},output:{$ref:'#/$defs/expression'}}},
  transition:{type:'object',additionalProperties:false,properties:{when:{$ref:'#/$defs/expression'},next:textSchema,end:textSchema},oneOf:[{required:['next'],not:{required:['end']}},{required:['end'],not:{required:['next']}}]},
  loop:{type:'object',additionalProperties:false,required:['entry','maxIterations','state','steps'],properties:{entry:textSchema,maxIterations:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},state:{$ref:'#/$defs/expression'},while:{$ref:'#/$defs/expression'},output:{$ref:'#/$defs/expression'},steps:{type:'object',minProperties:1,additionalProperties:{type:'object',additionalProperties:false,required:['graph','input','transitions'],properties:{graph:textSchema,input:{$ref:'#/$defs/expression'},assign:{type:'object',additionalProperties:{$ref:'#/$defs/expression'}},transitions:{type:'array',minItems:1,items:{$ref:'#/$defs/transition'}}}}}}},
  deployment:{type:'object',additionalProperties:false,properties:{workers:{type:'array',items:{type:'object',additionalProperties:false,required:['id','use'],properties:{id:textSchema,use:textSchema,services:textSchema}}},bindings:{type:'object',additionalProperties:{type:'object',additionalProperties:textSchema}}}},
  agent:{type:'object',additionalProperties:false,required:['version','id','graphs'],properties:{$schema:{type:'string'},version:{const:1},id:textSchema,entry:{const:'main'},config:{$ref:'#/$defs/expression'},graphs:{type:'object',required:['main'],additionalProperties:{$ref:'#/$defs/graph'}},loop:{$ref:'#/$defs/loop'},deployment:{$ref:'#/$defs/deployment'}}},
 },
} as const;

function freeze<T>(value:T):T{
 if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
freeze(OFFICIAL_MUTATION_SCHEMA);freeze(OFFICIAL_PROPOSAL_SCHEMA);
export const BFCL_PROPOSAL_SCHEMA=freeze({...OFFICIAL_PROPOSAL_SCHEMA,$id:'urn:ditto:workflow-search:bfcl-proposal-envelope:v1',properties:{
 ...OFFICIAL_PROPOSAL_SCHEMA.properties,mutation:{...OFFICIAL_MUTATION_SCHEMA,
  description:'Up to three functional nodes per proposal measured against the fixed round parent. List the primary and up to two other changed nodes, each with a reason.',
  properties:{...OFFICIAL_MUTATION_SCHEMA.properties,auxiliary:{...OFFICIAL_MUTATION_SCHEMA.properties.auxiliary,maxItems:2}}}}});

export interface OfficialProposalEnvelope {
 readonly rationale:string;
 /** The caller must pass this through validateOfficialDefinition before use. */
 readonly definition:unknown;
 readonly mutation?:MutationExplanation;
 readonly toolArtifacts?:readonly ToolDefinition[];
}

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const kind=(value:unknown)=>value===null?'null':value===undefined?'missing':Array.isArray(value)?'array':typeof value;
const pointer=(base:string,key:string|number)=>base+'/'+String(key).replace(/~/g,'~0').replace(/\//g,'~1');
function fail(message:string,path:string,hint:string):never{throw new DefinitionError(message,path,hint);}
function record(value:unknown,path:string):asserts value is Record<string,unknown>{
 if(!object(value))fail(`Expected JSON object; received ${kind(value)}`,path,'Supply the documented object at this exact field, not a string, array or null.');
}
function fields(value:Record<string,unknown>,allowed:readonly string[],path:string):void{
 for(const key of Object.keys(value))if(!allowed.includes(key))fail(`Unknown field ${JSON.stringify(key)}; allowed fields: ${allowed.join(', ')}`,pointer(path,key),'Remove the unsupported field; do not rename or relocate unrelated working fields.');
}
function required(value:Record<string,unknown>,key:string,path:string):unknown{
 if(!Object.hasOwn(value,key))fail(`Required field ${key} is missing`,pointer(path,key),`Supply ${key} with the type and shape in proposalSchema.`);
 return value[key];
}
function text(value:unknown,path:string,maxLength?:number):asserts value is string{
 if(typeof value!=='string')fail(`Expected a nonempty string; received ${kind(value)}`,path,path==='/rationale'?'Put all rationale sections into one string; an object with publicEvidence/change fields is not accepted.':'Supply a nonempty string at this exact field.');
 if(!value.trim())fail('Expected a nonempty string; received empty or whitespace-only text',path,'Supply meaningful text instead of an empty placeholder.');
 if(maxLength!==undefined&&value.length>maxLength)fail(`String exceeds ${maxLength} characters`,path,`Shorten this field to at most ${maxLength} characters.`);
}

/** Shape validation also protects callers that invoke change validation without parsing a proposal. */
export function validateMutationExplanation(value:unknown,path='/mutation',maxCompanions=0):MutationExplanation{
 record(value,path);fields(value,['primaryNodeId','auxiliary'],path);
 const primary=required(value,'primaryNodeId',path);text(primary,pointer(path,'primaryNodeId'));
 const auxiliary=required(value,'auxiliary',path),auxPath=pointer(path,'auxiliary');
 if(!Array.isArray(auxiliary))fail(`Expected an array of {nodeId,reason}; received ${kind(auxiliary)}`,auxPath,'Use auxiliary:[]; companion additions are disabled by the one-functional-node policy.');
 const seen=new Set<string>();
 auxiliary.forEach((item,index)=>{
  const itemPath=pointer(auxPath,index);record(item,itemPath);fields(item,['nodeId','reason'],itemPath);
  const nodeId=required(item,'nodeId',itemPath);text(nodeId,pointer(itemPath,'nodeId'));
  const reason=required(item,'reason',itemPath);text(reason,pointer(itemPath,'reason'));
  if(nodeId===primary)fail('The primary node must not also appear in auxiliary',pointer(itemPath,'nodeId'),'Use primaryNodeId for the one functional change and auxiliary:[]; stage other changes in later candidates.');
  if(seen.has(nodeId))fail('Duplicate auxiliary nodeId',pointer(itemPath,'nodeId'),'List each auxiliary node exactly once with its own reason.');
  seen.add(nodeId);
 });
 if(auxiliary.length>maxCompanions)fail(`Too many companion nodes: allowed=${maxCompanions} actual=${auxiliary.length}; auxiliary=${JSON.stringify([...seen])}`,auxPath,maxCompanions?'List the primary and at most two companion changes.':'Use auxiliary:[] and restore all other functional nodes. Only one added, removed or functionally modified node is allowed.');
 return value as unknown as MutationExplanation;
}

/** Validate proposal data, never guess repairs or coerce a malformed rationale/mutation. */
export function validateProposalEnvelope(value:unknown,maxCompanions=0):OfficialProposalEnvelope{
 record(value,'');fields(value,['rationale','definition','mutation','toolArtifacts'],'');
 const rationale=required(value,'rationale','');text(rationale,'/rationale',8000);
 const definition=required(value,'definition','');record(definition,'/definition');
 fields(definition,['$schema','version','id','graphs','entry','config','loop','deployment'],'/definition');
 if(definition.version!==1)fail(`Official definition version must be 1; received ${JSON.stringify(definition.version)??'missing'}`,'/definition/version','Use the native AgentDefinition version:1; do not return the old custom graph format.');
 text(required(definition,'id','/definition'),'/definition/id');
 const graphs=required(definition,'graphs','/definition');record(graphs,'/definition/graphs');
 const main=required(graphs,'main','/definition/graphs');record(main,'/definition/graphs/main');
 const nodes=required(main,'nodes','/definition/graphs/main');if(!Array.isArray(nodes))fail(`Expected node array; received ${kind(nodes)}`,'/definition/graphs/main/nodes','Supply main:{nodes:[...],output:...}.');
 if(Object.hasOwn(value,'mutation'))validateMutationExplanation(value.mutation,'/mutation',maxCompanions);
 if(Object.hasOwn(value,'toolArtifacts')){
  const tools=value.toolArtifacts;if(!Array.isArray(tools))fail(`Expected toolArtifacts array; received ${kind(tools)}`,'/toolArtifacts','Use an array of {name,description,inputSchema,executeSource}, or omit toolArtifacts when no tools are proposed.');
  tools.forEach((tool,index)=>{
   const path=pointer('/toolArtifacts',index);record(tool,path);fields(tool,['name','description','inputSchema','executeSource'],path);
   for(const key of ['name','description','executeSource'])text(required(tool,key,path),pointer(path,key),key==='name'?undefined:8000);
   const inputSchema=required(tool,'inputSchema',path);record(inputSchema,pointer(path,'inputSchema'));
   if(inputSchema.type!=='object')fail('Tool inputSchema.type must be "object"',pointer(pointer(path,'inputSchema'),'type'),'Declare an object JSON Schema with the actual argument properties and required names.');
  });
 }
 return value as unknown as OfficialProposalEnvelope;
}
