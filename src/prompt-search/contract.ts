import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {DatasetName} from '../domain.js';
import {BASELINE_DEFINITION,validateDefinition,digest,type GraphDefinition} from '../graph-agent/schema.js';
import {automationBaseline,AUTOMATION_DECISION_INSTRUCTION} from '../graph-agent/automation-baseline.js';
import {parsePromptJSON} from './json-recovery.js';

export const PROMPT_PROTOCOL='prompt-only-exploratory-v1';
export const CONFIRMATION_PROTOCOL='prompt-only-confirmation-v1';
export type SystemArm='S0'|'S1';
const hashes={S0:'c94264fde13c2ec02b6917703ea9591eeb3e6b51118efd9dae7ac2e037aadd92',S1:'2f5a3c55cdafdbbd062c9090ed4566c732563e7023bc28942c8aad10b62b4ed4'};
export const SYSTEMS=Object.freeze(Object.fromEntries((['S0','S1'] as const).map(arm=>{
 const text=readFileSync(new URL(`../../prompts/prompt-only-${arm.toLowerCase()}.en.md`,import.meta.url),'utf8').replace(/\r\n/g,'\n');
 if(createHash('sha256').update(text).digest('hex')!==hashes[arm])throw Error('Approved prompt-only system text changed: '+arm);
 return[arm,{text,sha256:hashes[arm]}];
})) as Record<SystemArm,{text:string;sha256:string}>);
export const NATIVE_TEMPLATE_MANIFEST=Object.freeze(['sample/node.js','trajectory/node.js','reflect/node.js','deliberate/node.js',...['cot','tot','got','self-consistency'].map(name=>`trajectory/strategies/${name}.js`)].map(name=>{
 const path='node_modules/@codesoul-co/ditto/dist/worker/infer/reasoning/'+name,source=readFileSync(new URL('../../'+path,import.meta.url),'utf8').replace(/\r\n/g,'\n');return{package:'@codesoul-co/ditto@0.1.1',path,sha256:createHash('sha256').update(source).digest('hex'),source};
}));
export const PROMPT_GUIDE='Return the entire supplied version:2 definition. Only editableText.paths may change, each to a string of at most 8000 characters. All unlisted values, property presence, array order, references, operators, graph/control/tool settings and host contracts must remain identical. instruction and the dedicated strategy literal are user text, never system content. The read-only firstUser slot is reserved for the predefined historical presentation comparison. Use measured public feedback to change one reusable strategy mechanism. No Graph edits, new tools, executable text or benchmark-specific answer rules are authorized.';
export function promptBaseline(dataset:DatasetName):GraphDefinition{
 const definition=dataset==='automationbench'?automationBaseline(60):structuredClone(BASELINE_DEFINITION);
 const sample=definition.graphs[0]!.nodes.find(node=>node.type==='INFER.REASONING.SAMPLE')!;
 sample.config.firstUser={literal:''};
 if(dataset==='automationbench')sample.config.user={concat:[{literal:''},sample.config.user]};
 return validateDefinition(definition);
}
export function editablePaths(dataset:DatasetName):readonly string[]{
 return[dataset==='automationbench'?'/graphs/0/nodes/0/config/user/concat/0/literal':'/graphs/0/nodes/1/config/instruction'];
}
function access(value:any,path:string):{parent:any;key:string}{
 const pieces=path.split('/').slice(1);let parent=value;
 for(const key of pieces.slice(0,-1)){if(!parent||!Object.hasOwn(parent,key))throw Error('Editable path is absent: '+path);parent=parent[key];}
 const key=pieces.at(-1)!;if(!parent||!Object.hasOwn(parent,key))throw Error('Editable value is absent: '+path);return{parent,key};
}
export function immutableProjection(definition:GraphDefinition,paths:readonly string[]):string{
 const value=structuredClone(definition);for(const path of paths){const slot=access(value,path);slot.parent[slot.key]='<EDITABLE-TEXT>';}
 return digest(value);
}
export function strategyHash(definition:GraphDefinition):string{const copy=structuredClone(definition);delete copy.mutation;return digest(copy);}
export function validatePromptChange(parent:GraphDefinition,child:unknown,dataset:DatasetName):GraphDefinition{
 const definition=validateDefinition(child),paths=editablePaths(dataset);
 for(const path of paths){const slot=access(definition,path);if(typeof slot.parent[slot.key]!=='string'||slot.parent[slot.key].length>8000)throw Error('Editable text must be a string of at most 8000 characters: '+path);}
 if(immutableProjection(parent,paths)!==immutableProjection(definition,paths))throw Error('Prompt-only scope violation: an unlisted field, reference, array or host contract changed');
 if(dataset==='automationbench'&&definition.graphs[0]!.nodes[0]!.config.instruction!==AUTOMATION_DECISION_INSTRUCTION)throw Error('Automation decision contract changed');
 if(strategyHash(parent)===strategyHash(definition))throw Error('Duplicate unchanged strategy');return definition;
}
export function historicalPresentation(baseline:GraphDefinition):GraphDefinition{
 const definition=structuredClone(baseline),sample=definition.graphs.flatMap(g=>g.nodes).find(n=>n.type==='INFER.REASONING.SAMPLE')!;
 sample.config.firstUser={ref:['task','prompt']};return validateDefinition(definition);
}
export function parsePromptProposal(text:string,parent:GraphDefinition,dataset:DatasetName){
 const {value:raw,syntax}=parsePromptJSON(text),value=raw as any;if(!value||Array.isArray(value)||Object.keys(value).sort().join()!=='definition,rationale'||typeof value.rationale!=='string'||!value.rationale.trim()||value.rationale.length>8000)throw Error('Return exactly rationale and definition');
 return{rationale:value.rationale as string,definition:validatePromptChange(parent,value.definition,dataset),syntax};
}
/** Reject explicit per-task rules in editable strategy text, never scan public task inputs or ordinary numbers. */
export function validateTaskIdRules(definition:GraphDefinition,dataset:DatasetName,taskIds:readonly string[]):void{
 for(const path of editablePaths(dataset)){const slot=access(definition,path),text=slot.parent[slot.key] as string;
  for(const taskId of taskIds){if(!/^(?:drop|mbpp|humaneval|automationbench):/.test(taskId))continue;
   const aliases=[taskId,...(/^humaneval:HumanEval\/\d+$/.test(taskId)?[taskId.slice('humaneval:'.length)]:[])];
   for(const id of aliases){
   const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   const mention=new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_/#.-])`,'ig');
   for(const match of text.matchAll(mention)){const before=text.slice(Math.max(0,match.index!-60),match.index!),after=text.slice(match.index!+match[0].length,match.index!+match[0].length+80);
    if(/(?:\b(?:if|when|case|for(?:\s+(?:task|question))?|task\s*id\s*(?:is|equals|=|:))\b|如果|当|题目)[^.!?\n]{0,45}$/i.test(before)||/^\s*[,;:]?\s*(?:then\s+)?(?:return\b|answer\b|output\b|=>|返回|答案)/i.test(after))throw Error('Task-ID-specific rule is outside reusable prompt scope: '+id);
   }
   }
  }
 }
}
