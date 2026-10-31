import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DockerPythonJudge,extractPythonCandidate} from '../dist/benchmark/docker-python-judge.js';

// Explicit real-container check. Run docker-ready successfully before invoking.
const image=process.env.CODE_JUDGE_IMAGE??'python:3.13-slim';
const options={image,programTimeoutMs:1200,timeoutMs:30000};
const judge=new DockerPythonJudge(options);
await judge.preflight();
const request=candidate=>({dataset:'humaneval',taskId:'judge-diagnostic',entryPoint:'answer',candidate,testSource:'def check(candidate):\n    assert candidate(2) == 2',testImports:[]});
const results=[];
async function check(name,candidate,passed,pattern){
  const result=await judge.judge(request(candidate));
  assert.equal(result.passed,passed,name);
  if(pattern)assert.match(result.diagnostics,pattern,name);
  results.push({name,...result});
}
await check('correct','def answer(x):\n    return x',true);
await check('wrong','def answer(x):\n    return 0',false,/AssertionError/);
await check('syntax','def answer(:',false,/SyntaxError/);
await check('fixed-marker-exit','import os\nprint("__DITTO_PRIVATE_TESTS_PASSED__", flush=True)\nos._exit(0)',false);
await check('early-exit','import sys\nsys.exit(0)',false);
await check('program-timeout','while True:\n    pass',false,/deadline exhausted/);
await check('candidate-exit-125','import sys\nsys.exit(125)',false,/exit=1/);
await check('candidate-infrastructure-text','raise RuntimeError("cannot connect to docker daemon")',false,/RuntimeError/);
const preamble='from math import sqrt\n\ndef helper(x):\n    return sqrt(x*x)';
await check('public-helper',extractPythonCandidate('def answer(x):\n    return helper(x)',`${preamble}\n\ndef answer(x):`,'answer'),true);
await check('multiple-blocks',extractPythonCandidate('```python\ndef helper(x):\n    return x\n```\n```python\ndef answer(x):\n    return helper(x)\n```','def answer(x):','answer'),true);
await check('indented-body',extractPythonCandidate('    if x:\n        return x\n    return 0','def answer(x):','answer'),true);
for(const stream of ['stdout','stderr']){
  const result=await new DockerPythonJudge({...options,outputLimitBytes:1024}).judge(request(`import sys\nsys.${stream}.write('x'*100000)\nsys.${stream}.flush()\ndef answer(x):\n    return x`));
  assert.equal(result.passed,false);assert.match(result.diagnostics,/exceeded its limit/);
  results.push({name:`output-limit-${stream}`,...result});
}
await assert.rejects(()=>new DockerPythonJudge({...options,timeoutMs:1}).judge(request('while True:\n    pass')),/host supervision timed out/);
results.push({name:'host-watchdog',rejected:true});
const missing=new DockerPythonJudge({...options,image:'ditto-missing-diagnostic-image:never'});
await assert.rejects(()=>missing.preflight(),/not ready/);
await assert.rejects(()=>missing.judge(request('def answer(x):\n    return x')),/infrastructure failed/);
results.push({name:'missing-image',rejected:true});
const cancel=new AbortController();
const pending=judge.judge(request('while True:\n    pass'),cancel.signal);
const timer=setTimeout(()=>cancel.abort(new Error('diagnostic cancellation')),400);
try {await assert.rejects(()=>pending,/diagnostic cancellation/);}finally{clearTimeout(timer);}
results.push({name:'cancellation',rejected:true});
const remaining=(await promisify(execFile)('docker',['ps','-aq','--filter','name=ditto-python-'],{windowsHide:true,timeout:10000})).stdout.trim();
assert.equal(remaining,'','diagnostic containers must be removed');
console.log(JSON.stringify({image,options,results,containersRemaining:0,modelCalls:0},null,2));
