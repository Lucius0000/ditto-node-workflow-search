import {SeededRandom} from '../search/random.js';
import {comparableTokens} from '../unified/policy.js';
import type {MeasuredPrompt} from './feedback.js';
import {artifactHash} from '../unified/store.js';
import type {GraphDefinition} from '../graph-agent/schema.js';
export function selectPromptParent<T extends MeasuredPrompt>(records:readonly T[],random:SeededRandom):T{
 const pool=records.filter(r=>r.evaluation.valid).slice().sort((a,b)=>b.evaluation.score-a.evaluation.score||comparableTokens(a.evaluation)-comparableTokens(b.evaluation)).slice(0,4);
 if(!pool.length)throw Error('No complete prompt parent');const max=pool[0]!.evaluation.score,weights=pool.map(r=>Math.exp(20*(r.evaluation.score-max))),total=weights.reduce((a,b)=>a+b,0),draw=random.next();let sum=0;
 for(let i=0;i<pool.length;i++){sum+=.3/pool.length+.7*weights[i]!/total;if(draw<=sum)return pool[i]!;}return pool.at(-1)!;
}
export function confirmationEligible(record:MeasuredPrompt,baseline:MeasuredPrompt,dataset:string):boolean{
 const delta=record.evaluation.score-baseline.evaluation.score;return record.id!==baseline.id&&record.evaluation.valid===true&&delta>0&&(dataset==='drop'?delta>=.01-1e-12:delta*record.evaluation.examples>=1-1e-12);
}
export interface ProposalStatistics {independentProposals:number;logicalCalls:number;reservedCalls:number;repairCalls:number;validArtifacts:number;firstPassValidArtifacts:number;formatRejections:number;scopeRejections:number;duplicateRejections:number}
export interface SystemComparison {dataset:string;baseline:number;arms:Record<'S0'|'S1',{scores:number[];statistics:ProposalStatistics}>}
/** Relative-to-baseline evidence and direct arm comparisons are different questions. Selection stays reviewed. */
export function comparePromptSystems(comparisons:readonly SystemComparison[]){
 if(comparisons.length!==4||new Set(comparisons.map(c=>c.dataset)).size!==4||comparisons.some(c=>c.arms.S0.scores.length!==2||c.arms.S1.scores.length!==2))throw Error('Four complete two-step system comparisons required');
 const rows=comparisons.map(c=>{const arm=(name:'S0'|'S1')=>{const a=c.arms[name],gains=a.scores.map(s=>s-c.baseline),meanGain=(gains[0]!+gains[1]!)/2;return{...a,stepBaselineGains:gains,meanBaselineGain:meanGain,baselineDirection:meanGain>1e-12?'positive':meanGain< -1e-12?'negative':'unchanged',legalArtifactRate:a.statistics.independentProposals?a.statistics.validArtifacts/a.statistics.independentProposals:null,firstPassLegalRate:a.statistics.independentProposals?a.statistics.firstPassValidArtifacts/a.statistics.independentProposals:null};};const S0=arm('S0'),S1=arm('S1');return{dataset:c.dataset,baseline:c.baseline,arms:{S0,S1},directMeanDifferenceS1MinusS0:S1.meanBaselineGain-S0.meanBaselineGain};});
 const count=(arm:'S0'|'S1',direction:string)=>rows.filter(r=>r.arms[arm].baselineDirection===direction).length;
 return{comparisons:rows,baselineDirections:{S0:{positive:count('S0','positive'),negative:count('S0','negative'),unchanged:count('S0','unchanged')},S1:{positive:count('S1','positive'),negative:count('S1','negative'),unchanged:count('S1','unchanged')}},
  directComparison:{S0Higher:rows.filter(r=>r.directMeanDifferenceS1MinusS0< -1e-12).length,S1Higher:rows.filter(r=>r.directMeanDifferenceS1MinusS0>1e-12).length},
  performanceWinner:null,reviewRequired:true,reviewRules:'Inspect at least three positive baseline directions, both full step paths, direct differences, legality/repairs, and weak effects. Direct wins with two negative arms are not positive evidence.',
  engineeringTieBreak:'S1 for interface teaching when no stable superiority; use S0 if reviewed S1 repeatedly adds scope/repair violations. This is not a performance claim.'};
}
export interface FinalEvidenceReview {identity:string;reviewedBy:string;decision:'admit'|'reject';analysis:string;groupsReviewed:readonly string[];checks:{scopeValid:boolean;noBenchmarkExploit:boolean;budgetUnchanged:boolean};artifacts:readonly string[]}
export function evidenceReviewIdentity(candidate:MeasuredPrompt&{definition?:GraphDefinition},baseline:MeasuredPrompt):string{
 return artifactHash({candidateId:candidate.id,definition:candidate.definition??null,evaluation:candidate.evaluation,evidence:candidate.evidence.map(e=>({caseId:e.caseId,attempt:e.attempt,sha256:e.sha256})),baselineId:baseline.id,baselineEvaluation:baseline.evaluation});
}
export function reviewedForConfirmation(candidate:MeasuredPrompt&{definition?:GraphDefinition},baseline:MeasuredPrompt,dataset:string,review:FinalEvidenceReview|undefined):boolean{
 return confirmationEligible(candidate,baseline,dataset)&&review?.identity===evidenceReviewIdentity(candidate,baseline)&&review.decision==='admit'&&typeof review.reviewedBy==='string'&&Boolean(review.reviewedBy.trim())&&typeof review.analysis==='string'&&Boolean(review.analysis.trim())&&Array.isArray(review.groupsReviewed)&&['improved','regressed','persistentFailure','successControl'].every(g=>review.groupsReviewed.includes(g))&&review.checks?.scopeValid===true&&review.checks?.noBenchmarkExploit===true&&review.checks?.budgetUnchanged===true&&Array.isArray(review.artifacts)&&review.artifacts.length>0&&review.artifacts.every(path=>typeof path==='string'&&Boolean(path.trim()));
}
/** Resample task clusters; repeats of the same task never become independent rows. */
export function pairedInterval(baseline:readonly number[],candidate:readonly number[],seed=42){
 if(!baseline.length||baseline.length!==candidate.length)throw Error('Paired task means required');
 const differences=baseline.map((v,i)=>candidate[i]!-v),random=new SeededRandom(seed),draws=[];
 for(let b=0;b<2000;b++){let sum=0;for(let i=0;i<differences.length;i++)sum+=differences[Math.floor(random.next()*differences.length)]!;draws.push(sum/differences.length);}draws.sort((a,b)=>a-b);
 return{mean:differences.reduce((a,b)=>a+b,0)/differences.length,lower:draws[49],upper:draws[1949],scope:'Exploratory Search task-paired bootstrap; selection bias remains; repeats averaged within task'};
}
export function passageClusterDiagnostic(prompts:readonly string[],baseline:readonly number[],candidate:readonly number[]){
 const groups=new Map<string,number[]>();prompts.forEach((prompt,i)=>{const passage=prompt.split(/\nQuestion:/)[0]!;groups.set(passage,[...(groups.get(passage)??[]),i]);});
 const clusters=[...groups.values()],random=new SeededRandom(43),draws:number[]=[];
 for(let b=0;b<2000;b++){let sum=0,count=0;for(let g=0;g<clusters.length;g++){const ids=clusters[Math.floor(random.next()*clusters.length)]!;for(const i of ids){sum+=candidate[i]!-baseline[i]!;count++;}}draws.push(sum/count);}draws.sort((a,b)=>a-b);
 return{method:'Exploratory passage-cluster bootstrap, preserving all sampled questions within a passage',groups:clusters.length,tasks:prompts.length,maxQuestionsPerPassage:Math.max(...clusters.map(ids=>ids.length)),lower:draws[49],upper:draws[1949],limitation:'Passage identity inferred from exact public text before Question; Search selection bias remains'};
}
