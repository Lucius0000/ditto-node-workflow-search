import assert from "node:assert/strict";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker, type ModelProvider } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { automationScope, type AutomationSession } from "../benchmark/automation.js";
import { createAutomationTools } from "../ditto/automation-tools.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { initialOrganization, buildOrganizationPlan,nodeCatalog } from "../workflow/organization.js";
import {executionTopologyHash} from '../search/node-construction.js';
import type { BenchmarkTask } from "../domain.js";
import {createExperimentRuntime} from '../ditto/runtime.js';
import {AutomationBudget} from '../workflow/automation-budget.js';
import {runOrganization} from '../workflow/organization-executor.js';

function task(id: string): BenchmarkTask {
  return { id, dataset: "automationbench", prompt: `Update world ${id}`, outputInstruction: "Plan then execute", metadata: { split: "validate" } };
}

function session(id: string, broken = false) {
  let calls = 0;
  let failure: Error | undefined;
  const events: Readonly<Record<string, unknown>>[] = [];
  const scope: AutomationSession = {
    tools: [{ name: "api_fetch", inputSchema: { type: "object", properties: { world: { type: "string" } }, required: ["world"] } }],
    async call(name, args) {
      assert.equal(name, "api_fetch");
      assert.equal(args.world, id, "concurrent tasks cannot cross worlds");
      if (broken) { failure = new Error("Automation bridge disconnected"); throw failure; }
      calls++;
      return { content: JSON.stringify({ world: id, changes: calls }) };
    },
    record(entry) { events.push(entry); },
    assertHealthy() { if (failure) throw failure; },
  };
  return { scope, events, calls: () => calls };
}

test('workflow budget totals sixty actors across nodes and drains each requested tool group before termination',async()=>{
  const world=session('sixty');let calls=0;
  const provider:ModelProvider={async invoke(){calls++;return {message:{role:'assistant',content:''},finishReason:'action_request',actionRequests:['one','two'].map(id=>({id:`${calls}-${id}`,name:'api_fetch',arguments:{world:'sixty'}}))};}};
  const experiment=createExperimentRuntime({baseUrl:'https://offline.invalid',apiKey:'offline',model:'fixture',concurrency:3,timeoutMs:600000},{profile:'automationbench',tools:createAutomationTools(),provider});
  try{
    const result=await automationScope.run(world.scope,()=>new WorkflowExecutor(experiment.runtime,experiment.providerName,'fixture').run(buildOrganizationPlan(initialOrganization('automationbench')),task('sixty')));
    assert.equal(calls,60);assert.equal(world.calls(),120);assert.equal(result.executionBudget!.reason,'actor-call-limit');assert.deepEqual(result.executionBudget!.pendingActionIds,[]);
    assert.equal(result.executionBudget!.outputKind,'supervisor-budget-not-model-final');assert.ok(!result.executedNodeIds.includes('output'));
    const budget=new AutomationBudget(()=>0);try{for(let i=0;i<59;i++)budget.claimActor();assert.equal(budget.beforeGraph(2,true,0),'actor-call-limit');assert.equal(budget.actorCalls,59);}finally{budget.close();}
  }finally{await experiment.close();}
});

test('wall-clock budget uses a fake clock, preserves completed tools and never swallows a real bridge fault',async()=>{
  for(const broken of [false,true]){
    let clock=0;const budget=new AutomationBudget(()=>clock),world=session('clock',broken);
    const provider:ModelProvider={async invoke(){clock=600001;return {message:{role:'assistant',content:''},finishReason:'action_request',actionRequests:[{id:'one',name:'api_fetch',arguments:{world:'clock'}}]};}};
    const experiment=createExperimentRuntime({baseUrl:'https://offline.invalid',apiKey:'offline',model:'fixture',concurrency:3,timeoutMs:600000},{profile:'automationbench',tools:createAutomationTools(),provider});
    try{
      const run=automationScope.run(world.scope,()=>runOrganization(experiment.runtime,{provider:experiment.providerName,model:'fixture'},buildOrganizationPlan(initialOrganization('automationbench')),task('clock'),undefined,budget));
      if(broken)await assert.rejects(run,/bridge disconnected/);
      else{const result=await run;assert.equal(world.calls(),1);assert.equal(result.executionBudget!.reason,'wall-clock-limit');assert.equal(result.executionBudget!.actorCalls,1);assert.deepEqual(result.executionBudget!.pendingActionIds,[]);}
    }finally{await experiment.close();budget.close();}
  }
});

test('distinct actors share one workflow count and graph fan-out cannot exceed sixty',async()=>{
  const counts=new Map<string,number>(),world=session('shared');
  const provider:ModelProvider={async invoke(input){const id=String(input.metadata!.nodeId);counts.set(id,(counts.get(id)??0)+1);return {message:{role:'assistant',content:'continue'},finishReason:'stop'};}};
  const experiment=createExperimentRuntime({baseUrl:'https://offline.invalid',apiKey:'offline',model:'fixture',concurrency:3,timeoutMs:600000},{profile:'automationbench',tools:createAutomationTools(),provider});
  const base=initialOrganization('automationbench');
  const spec={...base,nodes:[base.nodes[0]!,{...base.nodes[1]!,id:'actor-one',feedback:[]},{...base.nodes[1]!,id:'actor-two',feedback:[]},{...base.nodes[5]!,dependencies:['actor-two']}],graphs:[{id:'prepare',nodeIds:['context']},{id:'reason',nodeIds:['actor-one','actor-two']},{id:'finish',nodeIds:['output']}],transitions:{prepare:{kind:'next' as const,graphId:'reason'},reason:{kind:'repeat' as const,graphId:'reason',maxVisits:1000,until:{sourceNodeId:'actor-two',operator:'equals' as const,path:['message','content'],value:'never'},nextGraphId:'finish'},finish:{kind:'end' as const}}};
  try{
    const result=await automationScope.run(world.scope,()=>new WorkflowExecutor(experiment.runtime,experiment.providerName,'fixture').run(buildOrganizationPlan(spec),task('shared')));
    assert.equal(counts.get('actor-one'),30);assert.equal(counts.get('actor-two'),30);assert.equal(result.executionBudget!.actorCalls,60);assert.equal(world.calls(),0);
  }finally{await experiment.close();}
});

test('wall deadline cancels an in-flight model without inventing a final answer or swallowing HTTP failure',async()=>{
  for(const serviceFault of [false,true]){
    let clock=0;const budget=new AutomationBudget(()=>clock),world=session('inflight');
    const provider:ModelProvider={async invoke(_input,{signal}){
      if(serviceFault){clock=600001;throw Error('HTTP 500 server failure');}
      return new Promise((_resolve,reject)=>{
        signal.addEventListener('abort',()=>reject(Error('Provider bridge request cancelled')),{once:true});
        setTimeout(()=>{clock=600001;void budget.wallExpired;},5);
      });
    }};
    const experiment=createExperimentRuntime({baseUrl:'https://offline.invalid',apiKey:'offline',model:'fixture',concurrency:3,timeoutMs:600000},{profile:'automationbench',tools:createAutomationTools(),provider});
    try{
      const run=automationScope.run(world.scope,()=>runOrganization(experiment.runtime,{provider:experiment.providerName,model:'fixture'},buildOrganizationPlan(initialOrganization('automationbench')),task('inflight'),undefined,budget));
      if(serviceFault)await assert.rejects(run,/HTTP 500/);
      else{const result=await run;assert.equal(result.executionBudget!.cancelledInFlightModel,true);assert.equal(result.usageKnown,false);assert.equal(world.calls(),0);assert.match(result.answer,/supervisor termination/);}
    }finally{await experiment.close();budget.close();}
  }
});

test("Automation uses native SAMPLE→ACT→OBSERVE tool turns beyond the default sixteen", async () => {
  const states = new Map<string, number>();
  const provider: ModelProvider = { async invoke(input) {
    automationScope.getStore()?.assertHealthy();
    if (!input.actions?.length) return { message: { role: "assistant", content: "Proposed plan only" }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    const id = String(input.metadata?.taskId);
    const turn = states.get(id) ?? 0;
    states.set(id, turn + 1);
    if (turn < 18) return { message: { role: "assistant", content: "" }, finishReason: "action_request", actionRequests: [{ id: `${id}-${turn}`, name: "api_fetch", arguments: { world: id } }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    assert.equal(input.messages.filter(message => message.role === "tool").length, 18);
    return { message: { role: "assistant", content: `Actually updated ${id}` }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  } };
  const runtime = createDitto({ sandbox: { tools: ["api_fetch"] }, workers: [createContextWorker(), createInferWorker({ providers: { fake: provider }, defaultProvider: "fake" }), createInteractionWorker({ tools: createAutomationTools(), output: {async deliver(input) {return {deliveryId:input.deliveryId,status:"accepted" as const};}} })] });
  const executor = new WorkflowExecutor(runtime, "fake", "fake");
  const plan = buildOrganizationPlan(initialOrganization("automationbench"));
  const worlds = [session("a"), session("b")];
  try {
    const outputs = await Promise.all(worlds.map((world, index) => automationScope.run(world.scope, () => executor.run(plan, task(index ? "b" : "a")))));
    for (const [index, output] of outputs.entries()) {
      assert.equal(worlds[index]!.calls(), 18);
      assert.match(output.answer, /Actually updated/);
      assert.equal(output.totalTokens, 38);
      const events = worlds[index]!.events.filter(event => event.kind === "organization-node");
      assert.equal(events.filter(event=>event.nodeType === "INTERACTION.OBSERVE").length,18);
      assert.equal(events.filter(event=>event.nodeType === "INTERACTION.ACT.TOOL").length,18);
    }
  } finally { await runtime.close(); }
});

test("Automation infrastructure failure cannot become a successful textual completion", async () => {
  const provider: ModelProvider = { async invoke(input) {
    automationScope.getStore()?.assertHealthy();
    return input.actions?.length
      ? { message: { role: "assistant", content: "" }, finishReason: "action_request", actionRequests: [{ id: "broken-1", name: "api_fetch", arguments: { world: "broken" } }] }
      : { message: { role: "assistant", content: "plan" }, finishReason: "stop" };
  } };
  const runtime = createDitto({ sandbox: { tools: ["api_fetch"] }, workers: [createContextWorker(), createInferWorker({ providers: { fake: provider } }), createInteractionWorker({ tools: createAutomationTools(), output: {async deliver(input) {return {deliveryId:input.deliveryId,status:"accepted" as const};}} })] });
  const executor = new WorkflowExecutor(runtime, "fake", "fake");
  const plan = buildOrganizationPlan(initialOrganization("automationbench"));
  try { await assert.rejects(automationScope.run(session("broken", true).scope, () => executor.run(plan, task("broken"))), /bridge disconnected/); }
  finally { await runtime.close(); }
});

test("tool batches execute once and request IDs may be reused in a later model turn", async () => {
  for (const batch of [true, false]) {
    let turns = 0;
    const world = session("batch");
    const provider: ModelProvider = { async invoke(input) {
      const turn = turns++;
      if (turn < (batch ? 1 : 2)) return { message: { role: "assistant", content: "" }, finishReason: "action_request",
        actionRequests: (batch ? ["same", "second"] : ["same"]).map(id => ({ id, name: "api_fetch", arguments: { world: "batch" } })) };
      assert.equal(input.messages.filter(m => m.role === "tool").length, 2);
      assert.equal(input.messages.filter(m => m.role === "assistant").length, batch ? 1 : 2);
      return { message: { role: "assistant", content: "done" }, finishReason: "length" };
    } };
    const runtime = createDitto({ sandbox: { tools: ["api_fetch"] }, workers: [createContextWorker(), createInferWorker({ providers: { fake: provider } }), createInteractionWorker({ tools: createAutomationTools(), output: { async deliver(input) { return { deliveryId: input.deliveryId, status: "accepted" as const }; } } })] });
    try {
      const executor = new WorkflowExecutor(runtime, "fake", "fake");
      const result = await automationScope.run(world.scope, () => executor.run(buildOrganizationPlan(initialOrganization("automationbench")), task("batch")));
      assert.equal(world.calls(), 2); assert.equal(result.answer, "done");
    } finally { await runtime.close(); }
  }
});

test('searched routing that loses observations is rejected before another actor call',async()=>{
  let calls=0;
  const provider:ModelProvider={async invoke(){calls++;return {message:{role:'assistant',content:''},finishReason:'action_request',actionRequests:[{id:'one',name:'api_fetch',arguments:{world:'missing'}}]};}};
  const runtime=createDitto({sandbox:{tools:['api_fetch']},workers:[createContextWorker(),createInferWorker({providers:{fake:provider}}),createInteractionWorker({tools:createAutomationTools(),output:{async deliver(input){return {deliveryId:input.deliveryId,status:'accepted' as const};}}})]});
  const spec=initialOrganization('automationbench');
  const broken={...spec,nodes:spec.nodes.map(n=>n.template==='update'?{...n,dependencies:['context','actor']}:n)};
  try{
    await assert.rejects(automationScope.run(session('missing').scope,()=>new WorkflowExecutor(runtime,'fake','fake').run(buildOrganizationPlan(broken),task('missing'))),/Missing tool observations/);
    assert.equal(calls,1,'no model request receives an incomplete tool group');
  }finally{await runtime.close();}
});

test('normal early final executes no tools and records the declared terminating graph',async()=>{
  const world=session('early');
  const provider:ModelProvider={async invoke(){return {message:{role:'assistant',content:'Unable to finish'},finishReason:'stop'};}};
  const runtime=createDitto({sandbox:{tools:['api_fetch']},workers:[createContextWorker(),createInferWorker({providers:{fake:provider}}),createInteractionWorker({tools:createAutomationTools(),output:{async deliver(input){return {deliveryId:input.deliveryId,status:'accepted' as const};}}})]});
  try{
    const result=await automationScope.run(world.scope,()=>new WorkflowExecutor(runtime,'fake','fake').run(buildOrganizationPlan(initialOrganization('automationbench')),task('early')));
    assert.equal(result.answer,'Unable to finish');assert.equal(world.calls(),0);
    assert.deepEqual(result.executedGraphIds,['prepare','reason','finish']);assert.equal(result.loopTrace!.at(-1)!.outputNodeId,'output');
  }finally{await runtime.close();}
});

test('Automation reflection retains checker adoption rules and never promotes a passed-check rewrite',async()=>{
  const provider:ModelProvider={async invoke(input){
    const id=input.metadata?.nodeId;
    const content=id==='actor'?'Original final text':JSON.stringify({assessment:{passed:true,summary:'No demonstrated error'},issues:[],...(id==='revision'?{revisedResult:{role:'assistant',content:'Unjustified replacement'}}:{})});
    return {message:{role:'assistant',content},finishReason:'stop'};
  }};
  const experiment=createExperimentRuntime({baseUrl:'https://offline.invalid',apiKey:'offline',model:'fixture',concurrency:3,timeoutMs:600000},{profile:'automationbench',tools:createAutomationTools(),provider});
  const spec=initialOrganization('automationbench');
  const nodes=[spec.nodes[0]!,{...spec.nodes[1]!,feedback:[]},
    {id:'checker',template:'critique',dependencies:['actor'],targetNodeId:'actor'},
    {id:'revision',template:'revise',dependencies:['actor','checker'],targetNodeId:'actor'},
    {...spec.nodes[5]!,dependencies:['revision']}];
  const plan=buildOrganizationPlan({...spec,nodes,graphs:[{id:'solve',nodeIds:nodes.map(n=>n.id)}],entryGraphId:'solve',transitions:{solve:{kind:'end'}}});
  try{
    const result=await automationScope.run(session('reflection').scope,()=>new WorkflowExecutor(experiment.runtime,experiment.providerName,'fixture').run(plan,task('reflection')));
    assert.equal(result.answer,'Original final text');assert.equal(result.checkerAudits!.length,2);
    assert.equal(result.checkerAudits![1]!.decision,'preserved-passed-or-no-error');
  }finally{await experiment.close();}
});

test('declared repeat budget exit retains partial effects and pending evidence as a normal workflow result',async()=>{
  const world=session('budget');
  const provider:ModelProvider={async invoke(){return {message:{role:'assistant',content:'Partial progress'},finishReason:'action_request',actionRequests:['one','two'].map(id=>({id,name:'api_fetch',arguments:{world:'budget'}}))};}};
  const runtime=createDitto({sandbox:{tools:['api_fetch']},workers:[createContextWorker(),createInferWorker({providers:{fake:provider}}),createInteractionWorker({tools:createAutomationTools(),output:{async deliver(input){return {deliveryId:input.deliveryId,status:'accepted' as const};}}})]});
  const spec=initialOrganization('automationbench');
  const bounded={...spec,transitions:{...spec.transitions,tools:{kind:'repeat' as const,graphId:'tools',maxVisits:1,until:{sourceNodeId:'actor',operator:'equals' as const,path:['message','content'],value:'never'},nextGraphId:'finish'}}};
  try{
    const result=await automationScope.run(world.scope,()=>new WorkflowExecutor(runtime,'fake','fake').run(buildOrganizationPlan(bounded),task('budget')));
    assert.equal(result.answer,'Partial progress');assert.equal(world.calls(),1);
    assert.deepEqual(result.executedGraphIds,['prepare','reason','tools','finish']);
    assert.equal((result.nodeOutputs!.actor as {actionRequests:unknown[]}).actionRequests.length,2);
    assert.ok(world.events.some(e=>e.kind==='organization-transition'&&e.graphId==='tools'&&e.successor==='finish'));
  }finally{await runtime.close();}
});

test('semantic dedup preserves actor tool capability and metadata bindings while ignoring cosmetic names',async()=>{
  const requests:any[]=[];
  const provider:ModelProvider={async invoke(input){requests.push(input);return {message:{role:'assistant',content:'done'},finishReason:'stop'};}};
  const experiment=createExperimentRuntime({baseUrl:'https://offline.invalid',apiKey:'offline',model:'fixture',concurrency:3,timeoutMs:600000},{profile:'automationbench',tools:createAutomationTools(),provider});
  const base=initialOrganization('automationbench');
  const simple=(template:string)=>({...base,nodes:[base.nodes[0]!,{id:'answer',template,dependencies:['context'],config:nodeCatalog('automationbench').actor!.config}],graphs:[{id:'solve',nodeIds:['context','answer']}],entryGraphId:'solve',transitions:{solve:{kind:'end' as const}},outputNodeId:'answer'});
  const actor=simple('actor'),sample=simple('sample');
  const renamed={...actor,nodes:actor.nodes.map(n=>({...n,id:n.id==='context'?'renamed-context':'renamed-answer',dependencies:n.dependencies.map(()=> 'renamed-context')})),graphs:[{id:'renamed-graph',nodeIds:['renamed-context','renamed-answer']}],entryGraphId:'renamed-graph',transitions:{'renamed-graph':{kind:'end' as const}},outputNodeId:'renamed-answer'};
  assert.notEqual(executionTopologyHash(actor),executionTopologyHash(sample));assert.equal(executionTopologyHash(actor),executionTopologyHash(renamed));
  try{
    for(const plan of [actor,sample,{...actor,nodes:actor.nodes.map(n=>n.template==='context'?{...n,config:{includeTaskMetadata:true}}:n)}]){
      await automationScope.run(session('hash').scope,()=>new WorkflowExecutor(experiment.runtime,experiment.providerName,'fixture').run(buildOrganizationPlan(plan),{...task('hash'),metadata:{publicMarker:'PUBLIC_METADATA'}}));
    }
    assert.equal(requests[0].actions.length,1);assert.equal(requests[1].actions,undefined);
    assert.deepEqual(requests[0].messages,requests[1].messages,'only capability differs in otherwise identical SAMPLE requests');
    assert.doesNotMatch(JSON.stringify(requests[0].messages),/PUBLIC_METADATA/);assert.match(JSON.stringify(requests[2].messages),/PUBLIC_METADATA/);
  }finally{await experiment.close();}
  const withChecker=(template:string)=>({...actor,nodes:[...actor.nodes,{id:'check',template,dependencies:['answer'],targetNodeId:'answer',config:{mode:'verify'}}],graphs:[{id:'solve',nodeIds:['context','answer','check']}]});
  assert.equal(executionTopologyHash(withChecker('verify')),executionTopologyHash(withChecker('critique')),'reflection aliases with identical effective modes share the same binding semantics');
});
