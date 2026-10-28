import {UNIFIED_DEFINITION_GUIDE,UNIFIED_OPTIMIZER_SYSTEM} from '../unified/prompts.js';
import {searchCodingWorkflows,type CodingSearchOptions} from '../coding/search.js';
import {BASELINE_DEFINITION,GRAPH_AGENT_POLICY,definitionShape,parseDefinition,validateDefinition,validateDefinitionChange,NODE_TYPES,DefinitionError} from './schema.js';

/** The unified system is loaded from its versioned, hash-checked project Markdown. */
export {UNIFIED_OPTIMIZER_SYSTEM_SHA256 as GRAPH_OPTIMIZER_PROMPT_SHA256} from '../unified/prompts.js';
export const GRAPH_DEFINITION_GUIDE=UNIFIED_DEFINITION_GUIDE;
export const GRAPH_OPTIMIZER_PROMPT=UNIFIED_OPTIMIZER_SYSTEM;
export const GRAPH_ARTIFACT_ADAPTER:NonNullable<CodingSearchOptions['artifactAdapter']>={
 policy:GRAPH_AGENT_POLICY,systemPrompt:GRAPH_OPTIMIZER_PROMPT,baselineSource:JSON.stringify(BASELINE_DEFINITION),
 async inspect(source){return definitionShape(parseDefinition(source));},
 validateChange:validateDefinitionChange,
 parentArtifact(source){return {definition:parseDefinition(source)};},
 parse(content){const value=JSON.parse(content.trim());
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['rationale','definition'].includes(k))||typeof value.rationale!=='string'||!value.rationale.trim()||value.rationale.length>8000)throw new DefinitionError('Return exactly rationale and definition');
  return {rationale:value.rationale,source:JSON.stringify(validateDefinition(value.definition))};
 },
};
export function searchGraphWorkflows(options:Omit<CodingSearchOptions,'artifactAdapter'>){return searchCodingWorkflows({...options,artifactAdapter:GRAPH_ARTIFACT_ADAPTER});}
