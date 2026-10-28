import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProvider } from "@codesoul-co/ditto/worker/infer";
import { createExperimentRuntime } from "../ditto/runtime.js";
import { withWorkflowTimeBudget } from "../execution/time-budget.js";
import { BASELINE_MODULE, inspectModule, runExecutableModule, validateModuleChange, validateModuleSyntax } from "../coding/module.js";

const settings = { baseUrl: "https://example.invalid", model: "fixture", apiKey: "offline", concurrency: 3, timeoutMs: 600000 };
const task = { id: "coding-fixture", dataset: "math" as const, prompt: "Compute twice 21.", outputInstruction: "Return a number.", metadata: {} };
async function execute(source: string, respond: (input: Parameters<ModelProvider["invoke"]>[0], index: number) => string = () => "42") {
  const calls: Parameters<ModelProvider["invoke"]>[0][] = [];
  const shared = createExperimentRuntime(settings, { provider: { async invoke(input) {
    calls.push(structuredClone(input));
    return { message: { role: "assistant", content: respond(input, calls.length) }, finishReason: "stop", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
  } } });
  try { return { result: await withWorkflowTimeBudget({ requestMs: 3000, workflowMs: 5000 }, () => runExecutableModule(source, task, shared, settings)), calls }; }
  finally { await shared.close(); }
}

const WITH_SELECT = BASELINE_MODULE
  .replace('.node("solve", "INFER.REASONING.SAMPLE", ["context"], (task, outputs) => api.sample(task))',
    '.node("selected", "CONTEXT.SELECT", ["context"], (_task, outputs) => ({context:outputs.context,purpose:"infer",limit:1}))\n    .node("solve", "INFER.REASONING.SAMPLE", ["selected"], (task, outputs) => api.sample(task,"Use public context.",api.contextText(outputs.selected)))');

test("executable module builds and runs real Ditto Graph/Loop with mock inference", async () => {
  const shape = await inspectModule(BASELINE_MODULE);
  assert.deepEqual(shape.nodes.map(node => node.id), ["context", "solve"]);
  const { result, calls } = await execute(BASELINE_MODULE);
  assert.equal(result.answer, "42"); assert.equal(calls.length, 1);
  assert.equal(result.totalTokens, 3);
  assert.deepEqual(result.executedNodeIds, ["context", "solve"]);
  assert.match(JSON.stringify(result.nodeInputs), /Compute twice 21/);
});

test("one-node extension and small dependency/binding changes execute; two added Nodes reject", async () => {
  const change = await validateModuleChange(BASELINE_MODULE, WITH_SELECT);
  assert.deepEqual(change.added, ["selected"]);
  assert.deepEqual(change.changed, ["solve"]);
  const { result } = await execute(WITH_SELECT);
  assert.equal(result.answer, "42");
  assert.deepEqual((result.consumedDependencies as Record<string, string[]>).solve, ["selected"]);
  const twoAdded = WITH_SELECT.replace('.node("selected",', '.node("extra", "CONTEXT.LOAD", [], task => ({sources:[{role:"user",content:task.prompt}]}))\n    .node("selected",');
  await assert.rejects(validateModuleChange(BASELINE_MODULE, twoAdded), /ONE Node/);
  const threeChanges = WITH_SELECT
    .replace('content:task.prompt', 'content:"Updated " + task.prompt')
    .replace('purpose:"infer",limit:1', 'purpose:"infer",limit:2')
    .replace('Use public context.', 'Changed solver instruction.');
  assert.equal((await validateModuleChange(WITH_SELECT, threeChanges)).contentChanged.length,3);
});

test("pure rewiring is allowed without adding a Node", async () => {
  const parent = `export function createWorkflow(api) {
    const g=api.graph("agent")
      .node("context","CONTEXT.LOAD",[],task=>({sources:[{role:"user",content:task.prompt}]}))
      .node("extra","CONTEXT.LOAD",["context"],task=>({sources:[{role:"user",content:task.prompt}]}))
      .node("solve","INFER.REASONING.SAMPLE",["context","extra"],(task,outputs)=>api.sample(task,"Solve.",api.contextText(outputs.context)+api.contextText(outputs.extra)));
    return api.loop({id:"agent",maxIterations:3,*plan(task){const out=yield*api.graphStep(g,task);return api.answer(out.solve);}});
  }`;
  const child = parent.replace('.node("extra","CONTEXT.LOAD",["context"]', '.node("extra","CONTEXT.LOAD",[]');
  const change = await validateModuleChange(parent, child);
  assert.deepEqual(change.added, []); assert.deepEqual(change.removed, []); assert.deepEqual(change.changed, ["extra"]);
  assert.equal((await execute(child)).result.answer, "42");
});

const TOOL_MODULE = `export const tools=[{
  name:"generated_double",description:"Double a finite public number.",
  inputSchema:{type:"object",properties:{value:{type:"number"}},required:["value"],additionalProperties:false},
  execute(args){return args.value*2;}
}];
export function createWorkflow(api) {
 const g=api.graph("agent")
  .node("context","CONTEXT.LOAD",[],task=>({sources:[{role:"user",content:task.prompt}]}))
  .node("act","INTERACTION.ACT.TOOL",["context"],(_task,outputs)=>({call:{id:"double",name:"generated_double",arguments:{value:api.contextText(outputs.context).includes("21")?21:1}}}))
  .node("observed","INTERACTION.OBSERVE",["act"],(_task,outputs)=>({result:outputs.act}))
  .node("loaded","CONTEXT.LOAD",["observed"],(_task,outputs)=>({sources:[{id:"tool-evidence",content:api.contextText(outputs.observed)}]}))
  .node("solve","INFER.REASONING.SAMPLE",["loaded"],(task,outputs)=>api.sample(task,"Use actual tool evidence.",api.contextText(outputs.loaded)));
 return api.loop({id:"agent",maxIterations:3,*plan(task){const out=yield*api.graphStep(g,task);return api.answer(out.solve);}});
}`;

test("LLM-written pure tool actually executes through ACT → OBSERVE → LOAD → Infer", async () => {
  const { result, calls } = await execute(TOOL_MODULE, input => JSON.stringify(input.messages).includes('"result":42') || JSON.stringify(input.messages).includes('\\"result\\":42') ? "42" : "MISSING_REAL_TOOL_EVIDENCE");
  assert.equal(result.answer, "42");
  assert.deepEqual(result.executedNodeIds, ["context", "act", "observed", "loaded", "solve"]);
  const outputs = result.nodeOutputs as Record<string, any>;
  assert.equal(outputs.act.structuredContent.result, 42);
  assert.equal(outputs.observed.callId, outputs.act.callId);
  assert.equal(calls.length, 1); assert.match(JSON.stringify(calls[0]), /42/);
});

test("generated tool input schema rejects a string for a declared number before model execution", async () => {
  const bad = TOOL_MODULE.replace('value:api.contextText(outputs.context).includes("21")?21:1', 'value:"21"');
  const { result, calls } = await execute(bad);
  assert.equal(result.answer, ""); assert.ok(result.candidateFailure); assert.equal(calls.length, 0);
});

test("a custom Loop may repeat a declared Graph and stop using actual output", async () => {
  const source = `export function createWorkflow(api) {
    const prepare=api.graph("prepare").node("context","CONTEXT.LOAD",[],task=>({sources:[{role:"user",content:task.prompt}]}));
    const solve=api.graph("reason").node("solve","INFER.REASONING.SAMPLE",[],task=>api.sample(task,"Continue until complete.",task.evidence));
    return api.loop({id:"repeat-agent",maxIterations:5,*plan(task){
      const prep=yield*api.graphStep(prepare,task);let out;
      for(let i=0;i<3;i++){out=yield*api.graphStep(solve,{...task,evidence:api.contextText(prep.context)});if(api.answer(out.solve)==="DONE")break;}
      return api.answer(out.solve);
    }});
  }`;
  const { result, calls } = await execute(source, (_input, index) => index === 3 ? "DONE" : "CONTINUE");
  assert.equal(result.answer, "DONE"); assert.equal(calls.length, 3); assert.equal(result.totalTokens, 9);
  assert.deepEqual(result.executedNodeIds, ["context", "solve", "solve", "solve"]);
});

test("unexecuted conditional branches are permitted; executed discarded answer Nodes are rejected", async () => {
  const branched = `export function createWorkflow(api){
    const a=api.graph("first").node("first","INFER.REASONING.SAMPLE",[],task=>api.sample(task));
    const b=api.graph("second").node("second","INFER.REASONING.SAMPLE",[],task=>api.sample(task));
    return api.loop({id:"branch-agent",maxIterations:2,*plan(task){const out=yield*api.graphStep(task.prompt.includes("21")?a:b,task);return api.answer(out.first??out.second);}});
  }`;
  const chosen = await execute(branched);
  assert.equal(chosen.result.answer, "42"); assert.deepEqual(chosen.result.executedNodeIds, ["first"]);
  const discarded = BASELINE_MODULE.replace('.node("solve",', '.node("unused", "INFER.REASONING.SAMPLE", ["context"], task => api.sample(task))\n    .node("solve",');
  const { result } = await execute(discarded);
  assert.equal(result.answer, ""); assert.ok(result.candidateFailure, "an executed answer with no consumer must not be accepted");
});

test("source guard rejects host APIs, imports and direct prototype access", () => {
  for (const source of ['import "node:fs";', 'export const value=process;', 'export const value=fetch;', 'export const value=({}).constructor;']) {
    assert.throws(() => validateModuleSyntax(source), /Unavailable|not permitted/);
  }
});

const escaped = (expression: string) => BASELINE_MODULE.replace('  return api.loop(', `  const key="con"+"structor";const escaped=${expression};
  if(escaped==="object")throw new Error("HOST_ACCESS_CONFIRMED");
  return api.loop(`);
test("Graph-step iterators and host bridge errors cannot expose host Function", async () => {
  const attempts = [
    escaped('api.graphStep(g,{})[key][key]("return typeof process")()'),
    escaped('(()=>{try{api.graph("invalid id");}catch(error){return error[key][key]("return typeof process")();}})()'),
    escaped('__callArgs[key][key]("return typeof process")()'),
  ];
  for (const source of attempts) await assert.rejects(inspectModule(source), error => typeof (error as {message?:unknown})?.message === 'string' && !(error as {message:string}).message.includes("HOST_ACCESS_CONFIRMED"));
});

test("shared closure changes cannot silently alter six Node bindings under unchanged fingerprints", async () => {
  const parent = `const decorate=value=>"FIRST "+value;
  export function createWorkflow(api){const g=api.graph("agent")
   .node("context","CONTEXT.LOAD",[],task=>({sources:[{role:"user",content:decorate(task.prompt)}]}))
   .node("extra-a","CONTEXT.LOAD",[],task=>({sources:[{role:"user",content:decorate(task.prompt)}]}))
   .node("extra-b","CONTEXT.LOAD",[],task=>({sources:[{role:"user",content:decorate(task.prompt)}]}))
   .node("extra-c","CONTEXT.LOAD",[],task=>({sources:[{role:"user",content:decorate(task.prompt)}]}))
   .node("selected","CONTEXT.SELECT",["context"],(task,outputs)=>({context:outputs.context,purpose:"infer",query:decorate(task.prompt)}))
   .node("solve","INFER.REASONING.SAMPLE",["selected"],(task,outputs)=>api.sample(task,decorate("instruction"),api.contextText(outputs.selected)));
   return api.loop({id:"agent",maxIterations:3,*plan(task){const out=yield*api.graphStep(g,task);return api.answer(out.solve);}});
  }`;
  await assert.rejects(validateModuleChange(parent, parent.replace('"FIRST "', '"SECOND "')), /FIVE existing|closure|environment|capture/i);
});

function denseModule(order:readonly string[],contentChanges:readonly string[]=[]):string {
 const nodes=order.map((id,index)=>{
  const prefix=contentChanges.includes(id)?'changed':'original';
  const type=id==='solve'?'INFER.REASONING.SAMPLE':'CONTEXT.LOAD';
  const binding=id==='solve'?`task=>api.sample(task,${JSON.stringify(prefix)})`:`task=>({sources:[{role:"user",content:${JSON.stringify(prefix)}+task.prompt}]})`;
  return `.node(${JSON.stringify(id)},${JSON.stringify(type)},${JSON.stringify(order.slice(0,index))},${binding})`;
 }).join('\n');
 return `export function createWorkflow(api){const g=api.graph("agent")${nodes};return api.loop({id:"agent",maxIterations:2,*plan(task){const out=yield*api.graphStep(g,task);return api.answer(out.solve);}});}`;
}

test('five-node global dependency reversal allows 20 edge edits without spending content budget',async()=>{
 const order=['context','aux-a','aux-b','aux-c','solve'];
 const change=await validateModuleChange(denseModule(order),denseModule([...order].reverse()));
 assert.equal(change.changed.length,5);assert.equal(change.contentChanged.length,0);
 assert.equal(change.addedDependencies.length,10);assert.equal(change.removedDependencies.length,10);
 assert.equal(change.dependencyEditLimit,20);
});

test('large global rewiring retains an explicit edge-edit budget',async()=>{
 const order=['context','aux-a','aux-b','aux-c','aux-d','aux-e','aux-f','solve'];
 await assert.rejects(validateModuleChange(denseModule(order),denseModule([...order].reverse())),/Dependency edits exceed 32/);
});

test('five existing content/binding edits are allowed; six are rejected independently of dependencies',async()=>{
 const order=['context','aux-a','aux-b','aux-c','aux-d','solve'];
 const accepted=await validateModuleChange(denseModule(order),denseModule(order,order.slice(0,5)));
 assert.equal(accepted.contentChanged.length,5);assert.equal(accepted.addedDependencies.length,0);
 await assert.rejects(validateModuleChange(denseModule(order),denseModule(order,order)),/FIVE existing/);
});

test("a candidate binding that exceeds VM execution time is a completed candidate failure", async () => {
  const source = BASELINE_MODULE.replace('(task, outputs) => api.sample(task)', '(_task, _outputs) => {for(;;){}}');
  const { result, calls } = await execute(source);
  assert.equal(result.answer, ""); assert.ok(result.candidateFailure); assert.equal(calls.length, 0);
});

test("native Context INVALID_INPUT is a candidate failure with preserved public feedback", async () => {
  const source=WITH_SELECT.replace('context:outputs.context,','context:outputs.context.context,');
  const {result,calls}=await execute(source);
  assert.equal(result.answer,'');assert.equal(calls.length,0);
  assert.match((result.candidateFailure as {message:string}).message,/context must be an object/);
});

test("provider failures remain infrastructure errors instead of candidate zero", async () => {
  await assert.rejects(execute(BASELINE_MODULE,()=>{throw Error('HTTP 503 provider unavailable');}),/503|provider/i);
});
