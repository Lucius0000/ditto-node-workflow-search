import assert from 'node:assert/strict';
import test from 'node:test';
import {validateFixedEngineeringProtocol} from '../unified/fixed-engineering.js';

const protocol=()=>({version:1,approved:true,endpoint:'https://ark.cn-beijing.volces.com/api/plan/v3',model:'deepseek-v4.1-flash',accounts:['ACCOUNT_A','ACCOUNT_B','ACCOUNT_C'],overageDisabledConfirmed:true,authorizationSource:'Explicit offline fixture authorization',dataDirectories:{humaneval:'/fixture',mbpp:'/fixture',drop:'/fixture',automationbench:'/fixture'},dockerImage:'python@sha256:'+'a'.repeat(64),requestMs:180000,workflowMs:300000,automationWorkflowMs:600000,maxActorCalls:60,workflowAttempts:5,sdkAttempts:3,repeats:1});
test('fixed engineering rejects endpoint fallback, secret fields, sampling/repeats and absent authorization before provider creation',()=>{
 assert.equal(validateFixedEngineeringProtocol(protocol()).endpoint,protocol().endpoint);
 for(const change of [{endpoint:'https://api.deepseek.com'},{endpoint:'https://ark.cn-beijing.volces.com/api/v3'},{model:'deepseek-flash'},{apiKey:'offline-value'},{approved:false},{overageDisabledConfirmed:false},{repeats:3},{maxActorCalls:61},{accounts:['ACCOUNT_A','ACCOUNT_A','ACCOUNT_C']},{dockerImage:'python:latest'}]){
  assert.throws(()=>validateFixedEngineeringProtocol({...protocol(),...change}));
 }
});
