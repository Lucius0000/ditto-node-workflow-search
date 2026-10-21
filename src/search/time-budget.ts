/** Operational stopping only; complete evaluations remain the sole ranking input. */
export interface SearchTimeBudget {
  readonly deadlineAt:string;
  readonly guardAt:string;
  readonly minimumCandidateMs:number;
  readonly reserveMs:number;
  readonly safetyFactor:number;
}
export function validateTimeBudget(value:SearchTimeBudget):void {
  if(!value||Object.keys(value).sort().join(',')!=='deadlineAt,guardAt,minimumCandidateMs,reserveMs,safetyFactor'
    ||!Number.isFinite(Date.parse(value.deadlineAt))||!Number.isFinite(Date.parse(value.guardAt))
    ||Date.parse(value.guardAt)>Date.parse(value.deadlineAt)
    ||!Number.isSafeInteger(value.minimumCandidateMs)||value.minimumCandidateMs<1
    ||!Number.isSafeInteger(value.reserveMs)||value.reserveMs<0
    ||!Number.isFinite(value.safetyFactor)||value.safetyFactor<1)throw Error('Invalid Search time budget');
}
export function timeBudgetDecision(policy:SearchTimeBudget,durations:readonly number[],completedRounds:number,now=Date.now()) {
  validateTimeBudget(policy);
  if(!durations.length||durations.some(v=>!Number.isFinite(v)||v<0))throw Error('Time stopping requires complete evaluation durations');
  const estimateMs=Math.ceil(Math.max(policy.minimumCandidateMs,...durations)*policy.safetyFactor)+policy.reserveMs;
  const deadlineMs=Date.parse(policy.deadlineAt),guardMs=Date.parse(policy.guardAt);
  const reason=now>=deadlineMs?'deadline-reached':now>=guardMs&&now+estimateMs>=deadlineMs?'insufficient-safe-window':undefined;
  return reason?{policy,checkedAt:new Date(now).toISOString(),completedRounds,evaluations:durations.length,estimateMs,reason}:undefined;
}
export type TimeBudgetStop=NonNullable<ReturnType<typeof timeBudgetDecision>>;
