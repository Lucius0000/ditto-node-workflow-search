import {DefinitionError,digest,type GraphDefinition,type NodeType} from '../graph-agent/schema.js';

export const MULTI_WORKER_POLICY='protected-worker-directions-v1';
export const EXPLORATION_DIRECTIONS=['interaction','context-retrieval','native-reasoning','memory-cache'] as const;
export type ExplorationDirection=typeof EXPLORATION_DIRECTIONS[number];
const types:Record<ExplorationDirection,readonly NodeType[]>={
 interaction:['INTERACTION.ACT.TOOL','INTERACTION.OBSERVE'],
 'context-retrieval':['CONTEXT.SELECT','CONTEXT.UPDATE','CONTEXT.COMPRESS','RETRIEVAL.SEARCH'],
 'native-reasoning':['INFER.REASONING.TRAJECTORY','INFER.REASONING.REFLECT','INFER.REASONING.DELIBERATE'],
 'memory-cache':['MEMORY.WRITE','MEMORY.GET','MEMORY.UPDATE','MEMORY.SEARCH','MEMORY.QUERY','MEMORY.DELETE','INFER.CACHE.LOOKUP','INFER.CACHE.WRITE','INFER.CACHE.INVALIDATE'],
};
export function directionForRound(round:number):ExplorationDirection{return EXPLORATION_DIRECTIONS[(round-1)%EXPLORATION_DIRECTIONS.length]!;}
export function explorationInstruction(direction:ExplorationDirection){
 const hints:Record<ExplorationDirection,string>={
  interaction:'Test an actual ACT.TOOL/OBSERVE data path. Prefer registered bounded_arithmetic or literal_text_find where adequate. A single existing SAMPLE may produce explicitly declared JSON for a pure helper; final output may read structuredContent.result from a generated tool. Do not redeclare registered tools, and do not use Function/eval. Do not add a second SAMPLE to format the answer.',
  'context-retrieval':'Test actual Context SELECT/UPDATE/COMPRESS or task-public RETRIEVAL.SEARCH. Feed its native output into the existing solver as evidence; LOAD alone is not exploration. Retrieval searches this task only. Do not add another SAMPLE.',
  'native-reasoning':'Use native TRAJECTORY, REFLECT or DELIBERATE instead of implementing another reasoning/checking/selecting step as SAMPLE. A revise checker has optional revisedResult; use an explicit fallback. TRAJECTORY returns result.content; REFLECT returns revisedResult.content in revise mode, not message.content. Preserve final/intermediate contracts.',
  'memory-cache':'Test actual task-local Memory or Cache write/read consumption. WRITE/GET can store and recover the public passage before the existing solver. Cache WRITE/LOOKUP can carry an answer across a bounded Loop. Values never cross task attempts. Custom Graph/Loop control remains allowed, but do not add another SAMPLE.',
 };
 return{policy:MULTI_WORKER_POLICY,direction,allowedOperations:types[direction],maxSampleNodes:1,
  allocation:'One protected design opportunity per direction before a direction repeats; engineering repairs stay in that direction. Unused directions do not lose their allocation to another direction.',
  instruction:hints[direction],evidenceRule:'The changed operation must execute and its data/control result must be consumed. Declaring an unused worker or renaming a SAMPLE compute/select does not satisfy this direction.'};
}
export function validateExploration(parent:GraphDefinition,child:GraphDefinition,direction:ExplorationDirection):string[]{
 const nodes=child.graphs.flatMap(g=>g.nodes),prior=new Map(parent.graphs.flatMap(g=>g.nodes).map(n=>[n.id,n]));
 if(nodes.filter(n=>n.type==='INFER.REASONING.SAMPLE').length>1)throw new DefinitionError('At most one SAMPLE is allowed; use native workers/tools instead of adding SAMPLE compute/select/classify nodes.','graphs','Reuse or edit the existing SAMPLE. Implement this direction using its listed native operations.');
 const changed=nodes.filter(n=>types[direction].includes(n.type)&&(!prior.has(n.id)||digest(prior.get(n.id))!==digest(n)));
 if(!changed.length)throw new DefinitionError(`Direction ${direction} requires an added or changed native operation: ${types[direction].join(', ')}`,'exploration.direction','Change a connected operation from the protected direction; renaming or rewriting SAMPLE alone is insufficient.');
 return changed.map(n=>n.id);
}
export function executedDirectionNodes(definition:GraphDefinition,direction:ExplorationDirection,traces:readonly unknown[]):string[]{
 const eligible=new Set(definition.graphs.flatMap(g=>g.nodes).filter(n=>types[direction].includes(n.type)).map(n=>n.id)),found=new Set<string>();
 for(const item of traces){const run=item as {rawNodeOutputs?:Record<string,unknown>;executedNodeIds?:string[]};for(const id of [...Object.keys(run.rawNodeOutputs??{}),...(run.executedNodeIds??[])])if(eligible.has(id))found.add(id);}
 return [...found];
}
