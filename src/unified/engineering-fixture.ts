import {readFile} from 'node:fs/promises';
import type {DatasetName,BenchmarkTask} from '../domain.js';
import type {LoadedBenchmark,BenchmarkIdentity} from '../benchmark/types.js';
import {evaluateTasks} from '../benchmark/evaluator.js';
import {searchSubset} from '../benchmark/search-subset.js';
import {automationScope} from '../benchmark/automation.js';
import {artifactHash} from './store.js';

/** Explicit CLI engineering harness: no official data, credentials or external endpoint. */
export async function loadEngineeringFixture(path:string,dataset:DatasetName,split:'validate'|'test'){
 const value=JSON.parse(await readFile(path,'utf8'));
 if(Object.keys(value).sort().join()!=='dataset,provider,purpose,schemaVersion,tasks'||value.schemaVersion!==1||value.purpose!=='cli-engineering-only'||value.dataset!==dataset||!Array.isArray(value.tasks)||value.tasks.length<1||value.tasks.length>8)throw Error('Invalid isolated CLI engineering fixture');
 if(!value.provider||Object.keys(value.provider).sort().join()!=='baseUrl,model')throw Error('Engineering fixture provider contains unknown fields');
 const endpoint=new URL(value.provider?.baseUrl);if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||value.provider.model!=='fixture')throw Error('Engineering fixture provider must be loopback-only with model fixture');
 const references=new Map<string,string>();
 const tasks:BenchmarkTask[]=value.tasks.map((row:any)=>{if(Object.keys(row).sort().join()!=='answer,id,prompt'||typeof row.id!=='string'||!row.id.startsWith('fixture-')||typeof row.prompt!=='string'||!row.prompt||typeof row.answer!=='string'||references.has(row.id))throw Error('Invalid or duplicate synthetic fixture task');references.set(row.id,row.answer);return{id:row.id,dataset,prompt:row.prompt,outputInstruction:'Synthetic engineering output only.',metadata:{split,engineeringFixture:true}};});
 const hash=artifactHash(value),identity:BenchmarkIdentity={protocol:'fixture',dataMode:'fixture',baselineRepository:'engineering-fixture',baselineCommit:'synthetic',upstreamCommit:'synthetic',sourceFile:path,rawSha256:hash,sourceCount:tasks.length,selectedCount:tasks.length,splitRole:split==='test'?'test':'search',verified:true,knownPromptOverlaps:[]};
 const scorer={expectedLabel:(id:string)=>references.get(id)!,async score(id:string,prediction:string){const expected=references.get(id)!;return{score:prediction===expected?1:0,expected,prediction,normalizedExpected:expected,normalizedPrediction:prediction,method:'synthetic-engineering-equality'};}};
 const session={tools:[{name:'api_search',inputSchema:{type:'object',required:['query']}},{name:'api_fetch',inputSchema:{type:'object',required:['method','url','params','body']}},{name:'base64_encode',inputSchema:{type:'object',required:['text']}}],assertHealthy(){},async call(){return{content:'{"fixtureObservation":"synthetic endpoint"}'};}};
 const evaluate=(selected:readonly BenchmarkTask[],runner:Parameters<LoadedBenchmark['evaluate']>[0],options:Parameters<LoadedBenchmark['evaluate']>[1])=>evaluateTasks(selected,scorer,t=>dataset==='automationbench'?automationScope.run(session as any,()=>runner(t)):runner(t),options);
 const benchmark:LoadedBenchmark={dataset,split,tasks,identity,evaluate:(runner,options)=>evaluate(tasks,runner,options),evaluateSearchSubset:(ids,runner,options)=>evaluate(searchSubset(split,tasks,ids),runner,options)};
 return{benchmark,provider:{baseUrl:endpoint.href.replace(/\/$/,''),model:'fixture',apiKey:'offline-fixture'},hash};
}
