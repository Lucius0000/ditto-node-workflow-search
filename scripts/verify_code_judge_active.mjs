import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {DockerPythonJudge} from '../dist/benchmark/docker-python-judge.js';

// Explicit bounded follow-up to verify_code_judge.mjs; requires docker-ready.
const run=promisify(execFile),image=process.env.CODE_JUDGE_IMAGE??'python:3.13-slim';
const imageIdentity=JSON.parse((await run('docker',['image','inspect',image],{windowsHide:true,timeout:10000})).stdout)[0];
const request={dataset:'humaneval',taskId:'active-judge-diagnostic',entryPoint:'answer',candidate:'while True:\n    pass',testSource:'def check(candidate):\n    assert candidate(2)==2',testImports:[]};
const judge=new DockerPythonJudge({image,programTimeoutMs:15000,timeoutMs:4000});
await judge.preflight();
const started=Date.now();
await assert.rejects(()=>judge.judge(request),error=>{
 assert.match(error.message,/host supervision timed out/);assert.equal(error.programStarted,true);
 return true;
});
const supervisorElapsedMs=Date.now()-started;
const cancel=new AbortController(),cancelJudge=new DockerPythonJudge({image,programTimeoutMs:15000,timeoutMs:20000});
const pending=cancelJudge.judge(request,cancel.signal);pending.catch(()=>{});
let activeProcessEvidence;
try {
 for(let poll=0;poll<50;poll++){
  const names=(await run('docker',['ps','--filter','name=ditto-python-','--format','{{.Names}}'],{windowsHide:true,timeout:1000})).stdout.trim().split(/\r?\n/).filter(Boolean);
  if(names.length===1){
   const top=(await run('docker',['top',names[0]],{windowsHide:true,timeout:1000})).stdout;
   if(top.split(/\r?\n/).some(line=>/python -I -B -\s*$/.test(line))){activeProcessEvidence={name:names[0],top};break;}
  }
  await delay(100);
 }
 assert.ok(activeProcessEvidence,'generated Python child must be alive before cancellation');
 cancel.abort(new Error('active candidate cancellation'));
 await assert.rejects(()=>pending,error=>{assert.match(error.message,/active candidate cancellation/);assert.equal(error.programStarted,true);return true;});
} finally {if(!cancel.signal.aborted)cancel.abort();await pending.catch(()=>{});}
const remaining=(await run('docker',['ps','-aq','--filter','name=ditto-python-'],{windowsHide:true,timeout:10000})).stdout.trim();
assert.equal(remaining,'');
console.log(JSON.stringify({image,imageId:imageIdentity.Id,repoDigests:imageIdentity.RepoDigests,programTimeoutMs:15000,supervisorTimeoutMs:4000,supervisorElapsedMs,programStartedBeforeWatchdog:true,activeProcessEvidence,cancellationAfterChildStarted:true,containersRemaining:0,modelCalls:0},null,2));
