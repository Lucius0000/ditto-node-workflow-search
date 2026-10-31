import {UnifiedRunStore} from '../unified/store.js';
import type {SampleOutput} from '@codesoul-co/ditto/worker/infer';
import type {ProviderBudgetSnapshot} from '../unified/provider-budget.js';
import {artifactHash} from '../unified/store.js';

export const ADMISSION_KEYS=(['S0','S1'] as const).flatMap(arm=>(['drop','automationbench'] as const).flatMap(dataset=>['normal','repair'].map(kind=>`${arm}-${dataset}-${kind}`)));
export interface AdmissionRecord {key:string;status:'prepared'|'inFlight'|'settled'|'unknown';payload:unknown;reserved?:true;response?:SampleOutput;valid?:boolean;error?:string}
export class AdmissionUnknown extends Error {readonly infrastructureFailure=true;}
const retainedResponse=(value:SampleOutput|undefined)=>Boolean(value?.message&&(typeof value.message.content==='string'||Array.isArray(value.message.content))&&typeof value.finishReason==='string');
/** A write-ahead reservation is never mistaken for a returned response or silently reissued. */
export async function runAdmissionSlot(store:UnifiedRunStore,key:string,payload:unknown,invoke:()=>Promise<{response:SampleOutput;valid:boolean;error?:string}>){
 if(!ADMISSION_KEYS.includes(key))throw Error('Admission key is outside the eight-call contract');
 const path='admission/'+key+'.json';let state=await store.optional<AdmissionRecord>(path);
 const transition=async(value:AdmissionRecord)=>{await store.append('admission/events.jsonl',{at:new Date().toISOString(),...value});await store.write(path,value);state=value;};
 if(state&&artifactHash(state.payload)!==artifactHash(payload))throw new AdmissionUnknown('Admission payload identity differs; no request reissued');
 if(state?.status==='settled'&&retainedResponse(state.response))return state;
 const dispatchEvidence=state?.status==='prepared'?(await store.lines<{admissionKey?:string}>('provider-requests.jsonl')).some(r=>r.admissionKey===key):false;
 if(state&&(state.status!=='prepared'||state.reserved||state.response||dispatchEvidence)){
  await transition({...state,status:'unknown',valid:false,error:'Interrupted or inconsistent admission; completion is unknown and must be reviewed'});
  throw new AdmissionUnknown('Unknown admission in flight; no new request admitted: '+key);
 }
 if(!state){state={key,status:'prepared',payload};await transition(state);}
 // This is a conservative reservation. Actual model admissions and HTTP attempts come from the provider ledger.
 await transition({...state,status:'inFlight',reserved:true});
 try{const outcome=await invoke();if(!retainedResponse(outcome.response))throw Error('Admission did not retain a complete response record');const settled:AdmissionRecord={...state!,status:'settled',...outcome};await transition(settled);return settled;}
 catch(error){await transition({...state!,status:'unknown',valid:false,error:String(error)});throw new AdmissionUnknown('Admission did not retain a complete response; preserve its reservation and review: '+key);}
}
export function admissionSummary(records:readonly AdmissionRecord[],requests:readonly {id?:unknown;admissionKey?:unknown}[],responses:readonly {id?:unknown;admissionKey?:unknown;output?:SampleOutput;diagnostics?:readonly {attempts?:number;unknownUsageAttempts?:number}[]}[],budget:ProviderBudgetSnapshot){
 const unique=new Map(records.map(r=>[r.key,r]));if(unique.size!==records.length||records.some(r=>!ADMISSION_KEYS.includes(r.key)))throw Error('Duplicate/unexpected admission records');
 const settled=records.filter(r=>r.status==='settled'&&retainedResponse(r.response)),unknown=records.filter(r=>r.status==='unknown'||r.status==='inFlight'||r.status==='settled'&&!retainedResponse(r.response));
 const linkedKeys=ADMISSION_KEYS.filter(key=>{const r=unique.get(key),req=requests.filter(p=>p.admissionKey===key),res=responses.filter(p=>p.admissionKey===key);return r?.response&&req.length===1&&typeof req[0]!.id==='string'&&res.length===1&&res[0]!.id===req[0]!.id&&res[0]!.output!==undefined&&artifactHash(res[0]!.output)===artifactHash(r.response);});
 const logical=requests.filter(r=>typeof r.admissionKey==='string'&&ADMISSION_KEYS.includes(r.admissionKey)).length,http=responses.filter(r=>typeof r.admissionKey==='string'&&ADMISSION_KEYS.includes(r.admissionKey)).reduce((sum,r)=>sum+(r.diagnostics??[]).reduce((s,d)=>s+(d.attempts??0),0),0),ledgerCoversAdmissions=budget.providerCalls>=logical&&budget.httpAttempts>=http;
 return{planned:8,notStarted:8-unique.size,prepared:records.filter(r=>r.status==='prepared').length,reservations:records.filter(r=>r.reserved).length,settled:settled.length,unknown:unknown.length,validSettled:settled.filter(r=>r.valid===true).length,
  logicalAdmittedFromProviderRequests:logical,httpAttemptsFromSettledDiagnostics:http,
  providerLinkedResponses:linkedKeys.length,providerLedger:budget,ledgerCoversAdmissions,passed:ADMISSION_KEYS.every(key=>{const r=unique.get(key);return r?.status==='settled'&&retainedResponse(r.response)&&r.valid===true&&linkedKeys.includes(key);})&&unknown.length===0&&ledgerCoversAdmissions&&budget.inFlight===0,
  results:records.map(({key,status,valid,error})=>({key,status,valid:valid??null,error:error??null})),counting:'Files/reservations are not completed calls. In-flight/unknown requests never reset the eight-slot bound; provider ledger retains unknown usage.'};
}
