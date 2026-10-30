import {bindingReferences} from './bindings.js';
import {sources,type DefinitionGraph} from './schema.js';

export const EVIDENCE_PRESENTATION_VERSION='native-evidence-provenance-v1';
/** Presentation metadata never changes native values, binding paths or final outputs. */
export function evidenceSources(binding:unknown,graphs:readonly DefinitionGraph[]){
 const nodes=new Map(graphs.flatMap(g=>g.nodes.map(n=>[n.id,{node:n,graph:g.id}] as const)));
 const refs=[...bindingReferences(binding).map(r=>({namespace:r.namespace,nodeId:r.nodeId,path:[...r.path]})),
  ...sources(binding).filter(s=>s.from==='node'||s.from==='previous').map(s=>({namespace:s.from==='previous'?'prior':'nodes',nodeId:(s as any).nodeId,view:(s as any).view}))];
 const seen=new Set<string>();
 return refs.filter(r=>{const key=JSON.stringify(r);if(seen.has(key))return false;seen.add(key);return true;}).map(r=>{
  const producer=nodes.get(r.nodeId);return{...r,...(producer?{graphId:producer.graph,nodeType:producer.node.type,purpose:String(producer.node.config.instruction??'').slice(0,180)}:{})};
 });
}
export function presentEvidence(bindings:readonly unknown[],values:readonly unknown[],graphs:readonly DefinitionGraph[]):string{
 return bindings.map((binding,i)=>`[Evidence ${i+1}]\nSource: ${JSON.stringify(evidenceSources(binding,graphs))}\nValue:\n${typeof values[i]==='string'?values[i]:JSON.stringify(values[i])}`).join('\n\n');
}
