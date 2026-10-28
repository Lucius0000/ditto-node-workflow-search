import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {checkedReflectionOutput,answerValue,projectValue} from '../dist/graph-agent/executor.js';

const run=resolve(process.argv[2]??'runs/ditto-drop-v10-20261027-small-01');
const out=resolve(process.argv[3]??'runs/scheme-b-frozen-contract-replay-20261027');
await mkdir(out,{recursive:true});
const records=[];
for(const [id,round]of [['search-004',3],['search-006',5],['search-007',6]]){
 const executions=join(run,'discovery',id,'executions');
 for(const file of await readdir(executions)){
  const old=JSON.parse(await readFile(join(executions,file),'utf8'));
  if(round===3){
   assert.equal(old.nodeOutputs.compute.status,'success');
   const evidence=projectValue({from:'node',nodeId:'compute',view:'evidence'},old.nodeOutputs.compute);
   assert.deepEqual(evidence,old.nodeOutputs.compute.structuredContent);
   records.push({round,file,oldCrash:Boolean(old.candidateFailure),newContractResolved:true,toolEvidence:evidence,
    answerScore:'not measured: original final solver never ran'});
  }else{
   const input=old.nodeInputs.verify,target=input.target.result;
   const checked=checkedReflectionOutput({id:'verify',config:{mode:input.mode}},old.nodeOutputs.verify,
    {target,targetNodeId:'solve',feedback:[],criteria:input.criteria.map(item=>item.description)});
   const answer=answerValue(checked,'verify');assert.equal(answer,target.content);
   records.push({round,file,oldCrash:Boolean(old.candidateFailure),newContractResolved:true,originalSolverAnswer:target.content,newAnswer:answer,
    rawRevision:old.nodeOutputs.verify.output.revisedResult?.content??null,decision:checked.output.checkerAudit.decision});
  }
 }
}
assert.equal(records.length,72);assert.equal(records.filter(r=>r.oldCrash).length,62);
assert.equal(records.filter(r=>r.round>3&&r.newAnswer===r.originalSolverAnswer).length,48);
const summary={experiment:'Ditto scheme B typed-contract replay',newProviderCalls:0,freshSearch:false,newF1Measured:false,
 originalRun:run,inspectedFrozenRows:72,previousInterfaceCrashes:62,previousCrashesResolvedAtContractBoundary:62,
 reflectionAnswersPreserved:48,optionalVerifyRevisionsNotAdopted:records.filter(r=>r.round>3&&r.rawRevision!==null).length,
 toolEvidenceProjections:24,records};
await writeFile(join(out,'report.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({...summary,records:undefined},null,2));
