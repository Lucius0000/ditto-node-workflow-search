import type {BenchmarkTask,CaseResult,EvaluationSummary} from '../domain.js';
import {publicAnswerWarnings,taskOutputRequirements} from '../benchmark/answer-contract.js';
import type {DefinitionIssue} from '../graph-agent/schema.js';

export interface FeedbackEvaluation extends EvaluationSummary {
  readonly qualityPruned?:boolean;
  readonly stage?:number;
  readonly publicTraces?:readonly unknown[];
  readonly engineeringIssues?:readonly {readonly code:string;readonly message:string}[];
}
export interface FeedbackRecord {
  readonly id:string;
  readonly parentId:string|null;
  readonly status:string;
  readonly rationale?:string;
  readonly evaluation?:FeedbackEvaluation;
  /** Application-owned public contract errors only; never CaseResult.error. */
  readonly publicErrors?:readonly string[];
  readonly publicIssues?:readonly DefinitionIssue[];
}

const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const mean=(values:readonly number[]):number|null=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const clipped=(text:string,maximum:number)=>({text:text.slice(0,maximum),truncated:text.length>maximum,originalLength:text.length});
const sensitive=(key:string)=>/(?:secret|password|credential|apikey|authorization)/i.test(key)
  || /^(?:expected|normalizedexpected|reference|referenceanswer|references|gold|goldanswer|labels?|testsource|assertions?|private.*)$/i.test(key.replace(/[^a-z0-9]/gi,''));

function promptSnippet(text:string,maximum:number){
  if(text.length<=maximum)return clipped(text,maximum);
  const marker='\n[...truncated...]\n',available=maximum-marker.length,tail=Math.min(available,Math.max(500,Math.floor(available*.45)));
  return {text:text.slice(0,available-tail)+marker+text.slice(-tail),truncated:true,originalLength:text.length};
}

/** Trace values originate in runtime nodes; strip even accidentally attached scorer/secret fields. */
function traceValue(value:unknown,maximum=1200):unknown {
  let remaining=maximum;
  const seen=new Set<object>();
  function visit(item:unknown,depth:number):unknown {
    if(remaining<=0)return '[truncated]';
    if(typeof item==='string'){const text=item.slice(0,remaining);remaining-=text.length;return text;}
    if(item===null||typeof item==='boolean'||finite(item))return item;
    if(depth>8||typeof item!=='object'||item===null)return '[omitted]';
    if(seen.has(item))return '[cycle]';seen.add(item);
    if(Array.isArray(item))return item.slice(0,30).map(child=>visit(child,depth+1));
    const result:Record<string,unknown>={};
    for(const [key,child]of Object.entries(item).slice(0,40)){
      if(sensitive(key)||key==='error'||key==='previousResults')continue;
      result[key]=visit(child,depth+1);
    }
    return result;
  }
  return visit(value,0);
}

function validRows(record:FeedbackRecord,publicTasks:ReadonlyMap<string,BenchmarkTask>):Map<string,CaseResult>{
  const rows=new Map<string,CaseResult>();
  for(const row of record.evaluation?.results??[]){
    const taskId=row.caseId.replace(/#[1-9]\d*$/,'');
    if(!publicTasks.has(taskId)||row.valid!==true||row.error!==undefined||row.candidateFailure!==undefined||!finite(row.score)||row.score<0||row.score>1||typeof row.prediction!=='string')continue;
    rows.set(row.caseId,row);
  }
  return rows;
}

function publicTrace(record:FeedbackRecord,taskId:string){
  const runs=(record.evaluation?.publicTraces??[]).filter(value=>isObject(value)&&value.taskId===taskId);
  const selected=runs.slice(0,2).map(value=>{
    const run=value as Record<string,unknown>;
    const events=Array.isArray(run.events)?run.events:Array.isArray(run.trace)?run.trace:[];
    return {events:events.slice(0,6).map(event=>traceValue(event)),
      ...(isObject(run.nodeInputs)?{nodeInputs:traceValue(run.nodeInputs,2000)}:{}),
      ...(isObject(run.rawNodeOutputs)?{rawNodeOutputs:traceValue(run.rawNodeOutputs,2000)}:{}),
      truncated:events.length>6};
  });
  return {source:'public-runtime-events',runs:selected,originalRuns:runs.length,truncated:runs.length>selected.length||selected.some(run=>run.truncated)};
}

export interface FeedbackOptions {
  readonly maxCandidates?:number;
  readonly maxCases?:number;
  readonly maxCharacters?:number;
}

/** Never spread/stringify CaseResult: expected/normalizedExpected carry private labels. */
export function buildUnifiedFeedback(history:readonly FeedbackRecord[],tasks:readonly BenchmarkTask[],options:FeedbackOptions={}){
  const maxCandidates=options.maxCandidates??8,maxCases=options.maxCases??6,maxCharacters=options.maxCharacters??60000;
  if(!Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>40||!Number.isSafeInteger(maxCases)||maxCases<0||maxCases>6
    ||!Number.isSafeInteger(maxCharacters)||maxCharacters<6000||maxCharacters>200000)throw Error('Invalid public feedback bounds');
  const taskMap=new Map(tasks.map(task=>[task.id,task])),byId=new Map(history.map(row=>[row.id,row]));
  const ranked=history.filter(row=>row.status==='valid').sort((a,b)=>(b.evaluation?.score??0)-(a.evaluation?.score??0));
  const chosen=[...new Map([...history.slice(-Math.max(1,maxCandidates-4)),...ranked.slice(0,Math.min(4,maxCandidates))].map(row=>[row.id,row])).values()].slice(-maxCandidates);
  const chosenIds=new Set(chosen.map(row=>row.id));
  const candidateFeedback:Record<string,unknown>[]=[];
  for(const record of chosen){
    const rows=validRows(record,taskMap),reference=record.parentId?byId.get(record.parentId):undefined;
    const prior=reference?validRows(reference,taskMap):new Map<string,CaseResult>();
    const common=[...rows.values()].filter(row=>prior.has(row.caseId));
    const groups=new Map<string,CaseResult[]>();
    for(const row of rows.values()){const taskId=row.caseId.replace(/#[1-9]\d*$/,'');groups.set(taskId,[...(groups.get(taskId)??[]),row]);}
    const cases=[...groups].map(([taskId,outcomes])=>({taskId,outcomes,score:mean(outcomes.map(row=>row.score))!,
      delta:mean(outcomes.filter(row=>prior.has(row.caseId)).map(row=>row.score-prior.get(row.caseId)!.score))}));
    const selected:typeof cases=[];const ids=new Set<string>();
    const add=(item:typeof cases[number]|undefined)=>{if(item&&!ids.has(item.taskId)&&selected.length<maxCases){ids.add(item.taskId);selected.push(item);}};
    add(cases.filter(row=>row.delta!==null&&row.delta<0).sort((a,b)=>a.delta!-b.delta!)[0]);
    add([...cases].sort((a,b)=>a.score-b.score||a.taskId.localeCompare(b.taskId))[0]);
    add(cases.filter(row=>row.delta!==null&&row.delta>0).sort((a,b)=>b.delta!-a.delta!)[0]);
    add(cases.find(row=>row.score===1));
    for(const item of [...cases].sort((a,b)=>a.score-b.score||a.taskId.localeCompare(b.taskId)))add(item);
    const evaluation=record.evaluation;
    const feedback={id:record.id,parentId:record.parentId,status:record.status,rationale:clipped(record.rationale??'',1000),
      measurement:{scope:record.status==='valid'?'complete-prescribed-evaluation':'partial-or-unavailable',stage:evaluation?.stage??evaluation?.examples??null,
        observedTasks:groups.size,observedValidRuns:rows.size,declaredRepeats:evaluation?.repeats??null,
        fullScore:record.status==='valid'&&evaluation?.valid===true?evaluation.score:null,
        stageScore:evaluation?.valid===true?mean([...rows.values()].map(row=>row.score)):null},
      paired:{referenceId:reference?.id??null,scope:'common-valid-caseIds-only',overlapRuns:common.length,
        meanScoreDelta:mean(common.map(row=>row.score-prior.get(row.caseId)!.score)),
        improvedTasks:cases.filter(row=>row.delta!==null&&row.delta>1e-12).length,
        regressedTasks:cases.filter(row=>row.delta!==null&&row.delta< -1e-12).length,
        unchangedTasks:cases.filter(row=>row.delta!==null&&Math.abs(row.delta)<=1e-12).length},
      cost:{scope:'candidate-execution-excludes-optimizer',inputTokens:evaluation?.inputTokens??null,outputTokens:evaluation?.outputTokens??null,
        totalTokens:evaluation?.totalTokens??null,providerAttempts:evaluation?.providerAttemptCount??null,durationMs:evaluation?.durationMs??null,
        usageStatus:evaluation?.tokenUsageStatus??'unknown'},
      cases:selected.map((item,index)=>({taskId:item.taskId,prompt:promptSnippet(taskMap.get(item.taskId)!.prompt,4000),
        outputInstruction:clipped(taskOutputRequirements(taskMap.get(item.taskId)!),2600),pairedDelta:item.delta,
        outcomes:item.outcomes.slice(0,5).map(row=>({caseId:row.caseId,score:row.score,prediction:clipped(row.prediction,350),
          answerContractWarnings:publicAnswerWarnings(taskMap.get(item.taskId)!,row.prediction),
          parentOutcome:prior.has(row.caseId)?{candidateId:reference!.id,score:prior.get(row.caseId)!.score,prediction:clipped(prior.get(row.caseId)!.prediction,350)}:null})),
        outcomesTruncated:item.outcomes.length>5,...(index<3?{trace:publicTrace(record,item.taskId)}:{traceOmitted:true})})),
      engineering:{publicContractErrors:(record.publicErrors??[]).slice(-5).map(message=>clipped(message,700)),
        contractIssues:(record.publicIssues??[]).slice(-5).map(issue=>({code:issue.code,path:issue.path,message:clipped(issue.message,700),repairHint:clipped(issue.repairHint,700)})),
        issues:(evaluation?.engineeringIssues??[]).slice(0,5).map(issue=>({code:issue.code,message:clipped(issue.message,700)}))},
      truncation:{casesOmitted:Math.max(0,cases.length-selected.length),traceCaseLimit:3},
    };
    // Mark entire omitted candidates instead of silently leaking unbounded trace/context.
    if(JSON.stringify(candidateFeedback).length+JSON.stringify(feedback).length>maxCharacters)break;
    candidateFeedback.push(feedback);
  }
  const includedIds=new Set(candidateFeedback.map(row=>String(row.id)));
  return {source:'public-field-whitelist-v2',scoreInterpretation:'Scores and parentOutcome are measured candidate outputs, not reference answers. A low text-F1 score does not identify a reasoning error. Check the actual computation and requested answer type; contract warnings are observable hints, not gold-derived root-cause labels.',candidateCount:history.length,feedback:candidateFeedback,
    omittedCandidateIds:history.filter(row=>!chosenIds.has(row.id)||!includedIds.has(row.id)).map(row=>row.id),
    truncated:includedIds.size<history.length,maxCharacters};
}
