import test from 'node:test';import assert from 'node:assert/strict';
import {artifactHash} from '../unified/store.js';
import {promptBaseline,editablePaths,strategyHash} from '../prompt-search/contract.js';
import {applyTextProposal,textEditInput} from '../prompt-search/text-edits.js';
import {ASSET_DATASETS,loadPromptAssets,setFirstPresentation} from '../prompt-search/assets.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {runGraphAgent} from '../graph-agent/executor.js';
import {automationScope} from '../benchmark/automation.js';

test('strict text replacements rebuild all four frozen parents and reject malformed, wrong-parent and arbitrary patch objects',()=>{
 for(const ds of ASSET_DATASETS){const parent=promptBaseline(ds),before=artifactHash(parent),proposal={parentHash:before,rationale:'One reusable strategy.',edits:[{path:editablePaths(ds)[0],value:'Read the public request and preserve supported results. "quoted" \\ newline\n'}]},serialize=(x:any)=>JSON.stringify(x);
  const result=applyTextProposal(serialize(proposal),parent,ds);assert.equal(artifactHash(parent),before);assert.equal(artifactHash(JSON.parse(result.serializedDefinition)),result.definitionHash);
  for(const invalid of [{...proposal,parentHash:'0'.repeat(64)},{...proposal,definition:parent},{...proposal,edits:[{path:'/output/nodeId',value:'other'}]},{...proposal,edits:[{path:editablePaths(ds)[0],value:1}]},{...proposal,edits:[{path:editablePaths(ds)[0],value:'x'.repeat(8001)}]},{...proposal,edits:[...proposal.edits,...proposal.edits]},{...proposal,edits:[{op:'replace',...proposal.edits[0]}]},{...proposal,rationale:''}])assert.throws(()=>applyTextProposal(serialize(invalid),parent,ds));
  for(const invalid of [serialize(proposal)+'}',serialize(proposal).slice(0,-1),'```json\n'+serialize(proposal)+'\n```',serialize(proposal)+'\n'+serialize(proposal)])assert.throws(()=>applyTextProposal(invalid,parent,ds));
  assert.throws(()=>applyTextProposal(serialize(proposal),parent,ds,{knownHashes:[strategyHash(result.definition)]}),/Duplicate/);
  const bad={...proposal,edits:[{path:editablePaths(ds)[0],value:`If ${ds}:123 then return 42`}]};assert.throws(()=>applyTextProposal(serialize(bad),parent,ds,{publicTaskIds:[ds+':123']}),/Task-ID/);
 }
});

test('guidance is a user-only frozen whitelist; metadata never enters optimizer guidance or execution strategies',async()=>{
 for(const ds of ASSET_DATASETS){const yes=await loadPromptAssets(ds),no=await loadPromptAssets(ds,{guidance:false});assert.deepEqual(yes.definition,no.definition);assert.equal(no.initialization,null);
  const input=textEditInput({dataset:ds,parent:yes.definition,initialization:yes.initialization,feedback:{public:'measured'},format:'json_schema'}),without=textEditInput({dataset:ds,parent:no.definition,initialization:no.initialization,feedback:{public:'measured'},format:'json_schema'});
  assert.equal(input.messages[0]!.content,without.messages[0]!.content);const user=JSON.parse(String(input.messages[1]!.content)),plain=JSON.parse(String(without.messages[1]!.content));assert.deepEqual(user.parent,plain.parent);assert.deepEqual(user.measuredPublicFeedback,plain.measuredPublicFeedback);assert.equal(plain.initialization,null);
  const card=JSON.stringify(user.initialization);for(const key of ['researchMetadata','sourceCandidate','sourceDefinitionHash','knownExplorationTokens','sourceArtifactSHA256'])assert.ok(!card.includes(key));
  assert.deepEqual(setFirstPresentation(setFirstPresentation(yes.definition,'repeat-task-on-first-sample'),'repeat-task-on-first-sample'),setFirstPresentation(yes.definition,'repeat-task-on-first-sample'));
  assert.equal(yes.manifest.presentation,ds==='humaneval'||ds==='drop'?'repeat-task-on-first-sample':'no-repeat');assert.match(yes.manifest.optimizerProfileHash,/^[a-f0-9]{64}$/);
 }
});

test('loaded accepted strategies and first-presentation settings reach native SAMPLE user messages without changing system',async()=>{
 const captures:any[]=[];const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'offline',concurrency:1,timeoutMs:1000};
 const runtime=createExperimentRuntime(settings,{provider:{async invoke(input){captures.push(structuredClone(input));return{message:{role:'assistant',content:'answer'},finishReason:'stop'};}}});
 try{for(const ds of ['humaneval','mbpp','drop'] as const){const a=await loadPromptAssets(ds),task={id:ds+':public',dataset:ds,prompt:'UNIQUE_ORIGINAL_TASK',outputInstruction:'',metadata:{}};await runGraphAgent(a.definition,task,runtime,settings);const input=captures.at(-1),users=input.messages.filter((m:any)=>m.role==='user');assert.equal(users.filter((m:any)=>m.content==='UNIQUE_ORIGINAL_TASK').length,ds==='mbpp'?0:1);assert.ok(JSON.stringify(users).includes('UNIQUE_ORIGINAL_TASK'));assert.ok(!JSON.stringify(users).includes('researchMetadata'));}
  const systems=captures.map(i=>i.messages.filter((m:any)=>m.role==='system'));assert.deepEqual(systems[0],systems[1]);assert.deepEqual(systems[1],systems[2]);
 }finally{await runtime.close();}
});

test('first task presentation is idempotent and does not accumulate across Automation history turns',async()=>{
 const seen:any[]=[];let turn=0;const a=await loadPromptAssets('automationbench',{presentation:'repeat-task-on-first-sample'}),settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'offline',concurrency:1,timeoutMs:1000};
 const runtime=createExperimentRuntime(settings,{provider:{async invoke(input){seen.push(structuredClone(input));return{message:{role:'assistant',content:JSON.stringify(++turn===1?{done:false,tool:'api_search',arguments:{query:'public endpoint',top_k:1}}:{done:true,tool:'',arguments:{}})},finishReason:'stop'};}}});
 const session={tools:[{name:'api_search',inputSchema:{type:'object',required:['query']}},{name:'api_fetch',inputSchema:{type:'object',required:['method','url','params','body']}},{name:'base64_encode',inputSchema:{type:'object',required:['text']}}],assertHealthy(){},async call(){return{content:'{"endpoint":"public"}'};}};
 try{await automationScope.run(session as any,()=>runGraphAgent(a.definition,{id:'automationbench:public',dataset:'automationbench',prompt:'UNIQUE_TASK_ONCE',outputInstruction:'',metadata:{}},runtime,settings));assert.equal(seen.length,2);assert.equal(seen[0].messages.filter((m:any)=>m.role==='user'&&m.content==='UNIQUE_TASK_ONCE').length,1);assert.equal(seen[1].messages.filter((m:any)=>m.role==='user'&&m.content==='UNIQUE_TASK_ONCE').length,0);assert.ok(JSON.stringify(seen[1]).includes('public endpoint'));}finally{await runtime.close();}
});
