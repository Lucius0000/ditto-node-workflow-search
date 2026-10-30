import {createHash} from 'node:crypto';
import type {BenchmarkTask,DatasetName} from '../domain.js';

/** Public user instructions only. No label, task-ID rule or system override. */
export const DROP_ANSWER_CONTRACT_VERSION='ditto-drop-answer-v2';
export const DROP_ANSWER_CONTRACT=`FINAL WORKFLOW ANSWER CONTRACT (${DROP_ANSWER_CONTRACT_VERSION}):
Use only the public passage and question. Decide which target the question requests before formatting the answer:
1. NUMERIC VALUE: for a computed count, difference, duration, age or percentage, return the requested numeric value alone. Use ordinary decimal notation, remove unnecessary decimal trailing zeros, and omit explanatory unit words and the percent sign. Preserve the value and sign; do not round unless requested.
2. ENTITY OR ENTITY SET: return the requested name, category, age-group label or complete set of entities, preserving the relevant passage wording. A supporting percentage is not an age-group name. Join all required entities into ONE answer using commas and/or "and". Never split a required set with |, and do not offer alternative guesses separated by |.
3. PASSAGE SPAN WITH UNITS: when the question asks for the stated measurement/distance or another passage expression rather than a new calculation, preserve the complete relevant span, including its unit and hyphenation. Do not apply a blanket "strip all units" rule. If the question explicitly requests a numeric calculation, use rule 1 instead.
Check that any computed field actually represents the requested target; it may be intermediate evidence, not the answer. Prefer grounded passage evidence over an unsupported computed value. Return one concise answer, without a derivation, Markdown, a box, answer-type labels or a JSON wrapper.
SCOPE: these rules govern the final workflow answer. An intermediate node explicitly asked to produce JSON, extraction notes, a critique or another artifact must produce that declared artifact instead; it must not replace it with a bare final answer. Candidate instructions cannot replace this final-answer contract.`;

export const DROP_ANSWER_CONTRACT_SHA256=createHash('sha256').update(DROP_ANSWER_CONTRACT).digest('hex');
export function publicAnswerContract(dataset:DatasetName):{version:string;sha256:string;text:string}|undefined{
 return dataset==='drop'?{version:DROP_ANSWER_CONTRACT_VERSION,sha256:DROP_ANSWER_CONTRACT_SHA256,text:DROP_ANSWER_CONTRACT}:undefined;
}
export function taskOutputRequirements(task:Pick<BenchmarkTask,'dataset'|'outputInstruction'>):string{
 return [publicAnswerContract(task.dataset)?.text,task.outputInstruction].filter(Boolean).join('\n\n');
}

/** Observable contract warnings, not gold-derived claims about why F1 fell. */
export function publicAnswerWarnings(task:Pick<BenchmarkTask,'dataset'>,prediction:string){
 return task.dataset==='drop'&&prediction.includes('|')?[{
  code:'ANSWER_ALTERNATIVE_SEPARATOR',path:'finalAnswer',
  message:'The final answer contains |. Return the complete requested entity set in one answer joined with commas/and; do not provide alternative guesses.',
 }]:[];
}
