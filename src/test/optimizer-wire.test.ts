import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {promptBaseline} from '../prompt-search/contract.js';
import {textEditInput} from '../prompt-search/text-edits.js';
import {createTaskMemory} from '../ditto/task-memory.js';

test('real Python SDK wire preserves optimizer JSON modes and roles while execution profiles force original text',async()=>{
 const bodies:any[]=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;bodies.push(JSON.parse(body));res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:'{}'}}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 try{for(const profile of ['optimizer','math','automationbench'] as const){const runtime=createExperimentRuntime({baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'offline',model:'fixture',concurrency:1,timeoutMs:10000},{profile,...(profile==='automationbench'?{memory:createTaskMemory()}:{})});
   try{for(const format of ['json_object','json_schema'] as const){const input=textEditInput({dataset:'drop',parent:promptBaseline('drop'),feedback:{public:true},initialization:null,format,repair:{assistant:'invalid',publicError:'Synthetic public scope rejection'}});await runtime.provider.invoke(input,{signal:new AbortController().signal});const wire=bodies.at(-1);assert.equal(wire.response_format.type,profile==='optimizer'?format:'text');if(profile==='optimizer')assert.deepEqual(wire.response_format,input.model.providerOptions!.response_format);assert.deepEqual(wire.messages,input.messages);assert.equal(wire.temperature,0);assert.equal(wire.max_tokens,393216);assert.equal(wire.n,1);assert.deepEqual(wire.thinking,{type:'disabled'});assert.equal(wire.stream,true);for(const key of ['top_p','seed','reasoning_effort'])assert.ok(!(key in wire));}}finally{await runtime.close();}
  }
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
