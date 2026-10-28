import { createHash } from 'node:crypto';
import { createContext, Script, SourceTextModule, type Context as VmContext } from 'node:vm';
import { Worker } from 'node:worker_threads';
import { parse } from 'acorn';
import {ModuleContractError,validateModuleSyntax} from './source-guard.js';
export {ModuleContractError,validateModuleSyntax} from './source-guard.js';
import { graph, graphStep, loop } from '@codesoul-co/ditto/runtime';
import type { RegisteredTool, JsonObject } from '@codesoul-co/ditto';
import type { ModelConfig } from '@codesoul-co/ditto/worker/infer';
import type { AgentRunResult, BenchmarkTask } from '../domain.js';
import type { ProviderSettings } from '../config.js';
import { createExperimentRuntime, type ExperimentRuntime } from '../ditto/runtime.js';
import { createTaskMemory } from '../ditto/task-memory.js';
import { createBenchmarkTools, closeBenchmarkTools } from '../ditto/benchmark-tools.js';
import { baselinePrompts, baselineTextMessages } from '../benchmark/baseline-prompts.js';
import { GENERATION } from '../protocol.js';
import { captureCapabilityOutputs } from '../workflow/capability-observer.js';
import { currentProviderUsage, currentTimeBudgetSignal } from '../execution/time-budget.js';
import { CODING_EXECUTION_POLICY, CODING_MUTATION_POLICY, dependencyEditBudget } from './policy.js';

export interface ModuleNode { id: string; type: string; graphId: string; dependencies: string[]; bindingHash: string }
export interface ModuleShape {
  nodes: ModuleNode[]; tools: { name: string; sourceHash: string }[]; controlHash: string; sourceHash: string; environmentHash?: string;
}
export interface ModuleChange {
  parent: ModuleShape; child: ModuleShape; added: string[]; removed: string[]; changed: string[];
  contentChanged: string[]; addedDependencies: string[]; removedDependencies: string[]; dependencyEditLimit: number;
  toolChanges: string[]; controlChanged: boolean;
}
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const allowedTypes = new Set(['CONTEXT.LOAD','CONTEXT.SELECT','CONTEXT.UPDATE','CONTEXT.COMPRESS',
  'MEMORY.GET','MEMORY.QUERY','MEMORY.SEARCH','MEMORY.WRITE','MEMORY.UPDATE','MEMORY.DELETE',
  'INFER.REASONING.SAMPLE','INFER.REASONING.TRAJECTORY','INFER.REASONING.REFLECT','INFER.REASONING.DELIBERATE',
  'INFER.CACHE.LOOKUP','INFER.CACHE.WRITE','INFER.CACHE.INVALIDATE','INTERACTION.ACT.TOOL','INTERACTION.OBSERVE']);
function fingerprintFunction(fn: Function): string {
  const text = Function.prototype.toString.call(fn);
  // Acorn's AST canonicalizes formatting but preserves string/data values exactly.
  const normalized = /^\*/.test(text) ? `function${text}`
    : /^async\s+\*/.test(text) ? text.replace(/^async\s+/, 'async function')
    : /^(?:async\s+)?[a-zA-Z_$][\w$]*\s*\(/.test(text) && !/^function\b/.test(text) ? `function ${text}` : text;
  const ast = parse(`(${normalized})`, { ecmaVersion: 'latest' });
  return hash(JSON.parse(JSON.stringify(ast, (key, value) => ['start','end','raw'].includes(key) ? undefined : value)));
}
function environmentFingerprint(source: string): string {
  const ast: any = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const normalize = (value: any): any => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(normalize).filter(item => item !== undefined);
    if (value.type === 'ExportNamedDeclaration' && value.declaration?.type === 'VariableDeclaration'
      && value.declaration.declarations.every((item: any) => item.id?.name === 'tools')) return undefined;
    if (value.type === 'CallExpression' && value.callee?.type === 'MemberExpression') {
      const name = value.callee.property?.name;
      if (name === 'node' || (value.callee.object?.name === 'api' && (name === 'graph' || name === 'loop'))) return { type: `Declared${name}` };
    }
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['start','end','raw'].includes(key)).map(([key, child]) => [key, normalize(child)]));
  };
  return hash(normalize(ast));
}
function safeFunction<T extends Function>(fn: T): T { Object.setPrototypeOf(fn, null); return Object.freeze(fn); }
function inertObject(properties: Record<string, unknown>): any {
  const object = Object.assign(Object.create(null), properties);
  return Object.freeze(object);
}

interface Loaded {
  shape: ModuleShape; plan: any; tools: RegisteredTool[];
  inputs: Record<string, unknown>; actualReads: Record<string, string[]>; controlReads: Set<string>;
  close(): Promise<void>;
}

async function loadModule(source: string, model: ModelConfig, publicTask: BenchmarkTask, signal?: AbortSignal): Promise<Loaded> {
  validateModuleSyntax(source);
  if (!SourceTextModule) throw Error('Use node --experimental-vm-modules for executable workflow modules');
  const context: VmContext = createContext({ Date: undefined, process: undefined, fetch: undefined }, { codeGeneration: { strings: false, wasm: false } });
  const run = (code: string) => {
    try { return new Script(code).runInContext(context, { timeout: CODING_EXECUTION_POLICY.synchronousVmMs }); }
    catch (error) {
      if ((error as {code?:string}).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new ModuleContractError('VM execution budget exceeded');
      throw error;
    }
  };
  const bridge = <T extends Function>(fn: T): T => safeFunction(((...args: unknown[]) => {
    try { return fn(...args); }
    catch (error) {
      context.__errorMessage = error instanceof Error ? error.message : String(error);
      context.__isCandidateFailure = error instanceof ModuleContractError;
      throw run('Object.assign(new Error(__errorMessage),{candidateFailure:__isCandidateFailure})');
    }
  }) as unknown as T);
  const toVm = (value: unknown): any => { context.__jsonData = JSON.stringify(value); return run('JSON.parse(__jsonData)'); };
  const call = (fn: Function, args: unknown[]): any => {
    context.__callFn = fn;
    for (let i = 0; i < args.length; i++) context[`__argument${i}`] = args[i];
    context.__callArgs = run(`[${args.map((_value, index) => `__argument${index}`).join(',')}]`);
    return run('__callFn(...__callArgs)');
  };
  const nodes: ModuleNode[] = [];
  const graphs = new WeakMap<object, any>();
  const plans = new WeakMap<object, any>();
  const invocations = new WeakMap<object, any>();
  const inputRecords: Record<string, unknown> = {};
  const actualReads: Record<string, string[]> = {};
  const controlReads = new Set<string>();
  const controls: string[] = [];
  const nodeIds = new Set<string>();
  let construction = true;
  const proxyOutputs = (outputs: unknown) => {
    context.__outputObject = toVm(outputs); context.__readKeys = run('[]');
    return run('new Proxy(__outputObject,{get(t,k){if(typeof k==="string"&&Object.hasOwn(t,k))__readKeys.push(k);return t[k]}})');
  };
  const apiGraph = bridge((id: string): any => {
    if (!construction) throw new ModuleContractError('Declare Graphs before the Loop generator; runtime may choose/repeat declared Graphs');
    if (typeof id !== 'string' || !/^[a-z][\w-]{0,63}$/.test(id)) throw new ModuleContractError('Invalid Graph ID');
    const wrap = (builder: any): any => {
      const wrapper = inertObject({ node: bridge((nodeId: string, type: string, dependencies: string[], bind: Function) => {
        if (!construction || nodeIds.has(nodeId) || !/^[a-z][\w-]{0,63}$/.test(nodeId)) throw new ModuleContractError('Node IDs must be unique across the module');
        if (!allowedTypes.has(type) || !Array.isArray(dependencies) || dependencies.some(value => typeof value !== 'string') || typeof bind !== 'function') throw new ModuleContractError('Invalid Node contract or binding');
        if (nodes.length >= CODING_EXECUTION_POLICY.maxDeclaredNodes) throw new ModuleContractError('A workflow can declare at most 24 nodes');
        const local = nodes.filter(node => node.graphId === id).map(node => node.id);
        if (dependencies.some(dep => !local.includes(dep))) throw new ModuleContractError('Graph dependencies must name earlier local Nodes');
        nodeIds.add(nodeId); nodes.push({ id: nodeId, type, graphId: id, dependencies: [...dependencies], bindingHash: fingerprintFunction(bind) });
        const next = builder.node(nodeId, type, dependencies, (input: unknown, outputs: unknown) => {
          signal?.throwIfAborted();
          const data = proxyOutputs(outputs);
          const bound = call(bind, [toVm(input), data]);
          actualReads[nodeId] = [...new Set(context.__readKeys as string[])];
          context.__bound = bound;
          if (run('Boolean(__bound && typeof __bound.then === "function")')) throw new ModuleContractError('Node bindings must be synchronous');
          const hostBound = JSON.parse(run('JSON.stringify(__bound)'));
          if (type.startsWith('INFER.REASONING.')) {
            hostBound.model = structuredClone(model); hostBound.generation = structuredClone(GENERATION);
            hostBound.metadata = { ...(hostBound.metadata ?? {}), experiment: 'coding-node-v10', nodeType: type, nodeId,
              taskId: publicTask.id, dataset: publicTask.dataset };
          }
          inputRecords[nodeId] = structuredClone(hostBound);
          return hostBound;
        });
        return wrap(next);
      }) });
      graphs.set(wrapper, builder); return wrapper;
    };
    return wrap(graph(id));
  });
  const apiLoop = bridge((definition: any) => {
    if (!construction || typeof definition?.plan !== 'function') throw new ModuleContractError('A module must declare a generator Loop plan');
    const maxIterations = definition.maxIterations ?? 8;
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > CODING_EXECUTION_POLICY.maxLoopIterations) throw new ModuleContractError('maxIterations must be 1..12');
    controls.push(hash({ plan: fingerprintFunction(definition.plan), maxIterations }));
    const token = inertObject({});
    const native = loop({ id: String(definition.id ?? 'agent'), maxIterations,
      *plan(task: unknown): Generator<any, any, any> {
        const iterator = call(definition.plan, [toVm(task)]);
        let value: unknown;
        for (;;) {
          context.__generator = iterator;
          const proxy = value === undefined ? undefined : proxyOutputs(value);
          context.__resumeValue = proxy;
          const step = run('__generator.next(__resumeValue)');
          if (value !== undefined) for (const key of context.__readKeys as string[]) controlReads.add(key);
          if (step.done) {
            if (typeof step.value !== 'string') throw new ModuleContractError('Loop must return a final answer string');
            return step.value;
          }
          const invocation = invocations.get(step.value);
          if (!invocation) throw new ModuleContractError('Loop may yield only api.graphStep invocations');
          value = yield invocation;
        }
      },
    });
    plans.set(token, native); return token;
  });
  const apiStep = bridge((wrapped: object, input: unknown): any => {
    const native = graphs.get(wrapped);
    if (!native) throw new ModuleContractError('graphStep accepts only this module\'s declared Graphs');
    const nativeIterator = graphStep(native, input, signal ? { signal } : {});
    let started = false, finished = false;
    let facade: object;
    facade = inertObject({
      next: bridge((value?: unknown) => {
        if (!started) {
          started = true;
          const token = inertObject({});
          invocations.set(token, nativeIterator.next().value);
          return inertObject({ done: false, value: token });
        }
        if (finished) return inertObject({ done: true, value: undefined });
        finished = true;
        return inertObject({ done: true, value });
      }),
      [Symbol.iterator]: bridge(() => facade),
    });
    return facade;
  });
  const apiAnswer = bridge((value: any): string => {
    if (typeof value === 'string') return value;
    if (value?.status && value.status !== 'success') {
      const message = `Node returned ${value.error?.code ?? value.status}: ${value.error?.message ?? ''}`;
      if (/PROVIDER|HTTP|REFLECT_FORMAT_ERROR|BACKEND_ERROR|TIMEOUT/i.test(message)) throw new Error(message);
      throw new ModuleContractError(message);
    }
    const output = value?.output ?? value;
    const message = output?.message ?? output?.result ?? output?.revisedResult ?? output;
    if (typeof message?.content !== 'string') throw new ModuleContractError('Final answer requires a completed Infer message');
    return message.content;
  });
  const apiSample = bridge((task: BenchmarkTask, instruction = '', evidence = '') => {
    const text = instruction || baselinePrompts(task.dataset)?.agent || 'Solve the task accurately.';
    const messages = task.dataset === 'drop' || task.dataset === 'gsm8k'
      ? baselineTextMessages(task.dataset, text, task.prompt, evidence)
      : [{ role: 'user', content: `${text}\n\n${task.prompt}\n\n${evidence}` }];
    return toVm({ model, generation: GENERATION, messages, metadata: { experiment: 'coding-node-v10', taskId: task.id, nodeType: 'INFER.REASONING.SAMPLE' } });
  });
  const contextText = bridge((value: any): string => {
    if (value?.status && value.status !== 'success') {
      const message = `Cannot consume failed Node: ${value.error?.code ?? value.status}: ${value.error?.message ?? ''}`;
      if (/PROVIDER|HTTP|REFLECT_FORMAT_ERROR|BACKEND_ERROR|TIMEOUT/i.test(message)) throw new Error(message);
      throw new ModuleContractError(message);
    }
    const output = value?.output ?? value;
    if (output?.items) return output.items.map((item: any) => typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).join('\n');
    if (output?.context?.items) return output.context.items.map((item: any) => typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).join('\n');
    return typeof output === 'string' ? output : JSON.stringify(output);
  });
  const api = inertObject({ graph: apiGraph, loop: apiLoop, graphStep: apiStep, answer: apiAnswer, sample: apiSample,
    contextText, model: toVm(model), generation: toVm(GENERATION) });
  const module = new SourceTextModule(source, { context, identifier: 'candidate-workflow.mjs' });
  await module.link(() => { throw new ModuleContractError('Module imports are unavailable'); });
  await module.evaluate({ timeout: CODING_EXECUTION_POLICY.synchronousVmMs });
  const exports = module.namespace as unknown as { createWorkflow?: Function; tools?: any[] };
  if (typeof exports.createWorkflow !== 'function') throw new ModuleContractError('Export function createWorkflow(api) is required');
  const token = call(exports.createWorkflow, [api, toVm(publicTask)]);
  const plan = plans.get(token);
  if (!plan || controls.length !== 1 || !nodes.some(node => node.type.startsWith('INFER.REASONING.'))) throw new ModuleContractError('Return one declared Loop with an Infer answer-producing Node');
  construction = false;
  const definitions = exports.tools ?? [];
  if (!Array.isArray(definitions) || definitions.length > 6) throw new ModuleContractError('tools must be an array of at most six pure functions');
  const workers = new Set<Worker>();
  const toolShapes: ModuleShape['tools'] = [];
  const registered: RegisteredTool[] = definitions.map((tool: any) => {
    if (!/^generated_[a-z][\w-]{0,55}$/.test(tool.name) || typeof tool.execute !== 'function' || !tool.inputSchema || typeof tool.description !== 'string') throw new ModuleContractError('Tools require generated_ name, description, inputSchema, execute(args)');
    if (toolShapes.some(old => old.name === tool.name)) throw new ModuleContractError('Duplicate generated tool');
    const source = Function.prototype.toString.call(tool.execute);
    toolShapes.push({ name: tool.name, sourceHash: hash({ source: fingerprintFunction(tool.execute), inputSchema: tool.inputSchema, description: tool.description }) });
    return { name: tool.name, description: tool.description, inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)), effects: [],
      validate(args: JsonObject) {
        const schema = tool.inputSchema;
        for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) throw new ModuleContractError(`Missing tool argument ${key}`);
        if (schema.additionalProperties === false) for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties ?? {}, key)) throw new ModuleContractError(`Unexpected tool argument ${key}`);
        for (const [key, specification] of Object.entries(schema.properties ?? {}) as [string, any][]) {
          if (!Object.hasOwn(args, key)) continue;
          const value = args[key];
          const type = specification.type;
          const valid = type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
            : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : type ? typeof value === type : true;
          if (!valid) throw new ModuleContractError(`Invalid ${type} tool argument ${key}`);
        }
      },
      async execute(args: JsonObject, execution: any) {
        execution.signal?.throwIfAborted();
        const worker = new Worker(new URL('./tool-worker.js', import.meta.url), { workerData: { source, args }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } });
        workers.add(worker);
        try {
          const value: any = await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error, result?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); execution.signal?.removeEventListener('abort', abort); void worker.terminate().then(() => error ? reject(error) : resolve(result)); };
            const abort = () => finish(new ModuleContractError('Generated tool canceled'));
            const timer = setTimeout(() => finish(new ModuleContractError('Generated tool exceeded 1000ms')), CODING_EXECUTION_POLICY.toolWallMs);
            execution.signal?.addEventListener('abort', abort, { once: true });
            worker.once('message', reply => reply.ok ? finish(undefined, reply.value) : finish(new ModuleContractError(reply.error)));
            worker.once('error', error => finish(error));
            worker.once('exit', code => { if (!settled) finish(new ModuleContractError(`Generated tool exited ${code}`)); });
          });
          return { status: 'success' as const, structuredContent: { result: value } };
        } finally { workers.delete(worker); }
      },
    };
  });
  return { shape: { nodes, tools: toolShapes, controlHash: hash(controls), sourceHash: hash(source), environmentHash: environmentFingerprint(source) }, plan, tools: registered,
    inputs: inputRecords, actualReads, controlReads,
    async close() { await Promise.all([...workers].map(worker => worker.terminate())); workers.clear(); },
  };
}

const inspectionTask: BenchmarkTask = { id: 'inspection', dataset: 'drop', prompt: '<PUBLIC_TASK>', outputInstruction: '', metadata: {} };
const inspectionModel = { provider: 'deepseek', model: 'deepseek-flash' };
export async function inspectModule(source: string): Promise<ModuleShape> {
  const loaded = await loadModule(source, inspectionModel, inspectionTask);
  try { return loaded.shape; } finally { await loaded.close(); }
}
export async function validateModuleChange(parentSource: string, childSource: string): Promise<ModuleChange> {
  const parent = await inspectModule(parentSource), child = await inspectModule(childSource);
  const parentNodes = new Map(parent.nodes.map(node => [node.id, node]));
  const childNodes = new Map(child.nodes.map(node => [node.id, node]));
  const added = child.nodes.filter(node => !parentNodes.has(node.id)).map(node => node.id);
  const removed = parent.nodes.filter(node => !childNodes.has(node.id)).map(node => node.id);
  const environmentChanged = parent.environmentHash !== child.environmentHash;
  const changed = child.nodes.filter(node => parentNodes.has(node.id) && (environmentChanged || hash(parentNodes.get(node.id)) !== hash(node))).map(node => node.id);
  // Dependency-only edits are independent of the content/binding change limit.
  // Every node in the workflow may participate; there is no five-node subgraph restriction.
  const contentChanged = child.nodes.filter(node => {
    const previous = parentNodes.get(node.id);
    return previous && (environmentChanged || previous.type !== node.type || previous.bindingHash !== node.bindingHash || previous.graphId !== node.graphId);
  }).map(node => node.id);
  const edges = (shape: ModuleShape) => new Set(shape.nodes.flatMap(node => node.dependencies.map(dependency => `${dependency}->${node.id}`)));
  const parentEdges = edges(parent), childEdges = edges(child);
  const addedDependencies = [...childEdges].filter(edge => !parentEdges.has(edge));
  const removedDependencies = [...parentEdges].filter(edge => !childEdges.has(edge));
  const dependencyEditLimit = dependencyEditBudget(Math.max(parent.nodes.length, child.nodes.length));
  const oldTools = new Map(parent.tools.map(tool => [tool.name, tool.sourceHash]));
  const newTools = new Map(child.tools.map(tool => [tool.name, tool.sourceHash]));
  const toolChanges = [...new Set([...oldTools.keys(), ...newTools.keys()])].filter(name => oldTools.get(name) !== newTools.get(name));
  if (added.length > 1 || removed.length > 1 || (added.length && removed.length)) throw new ModuleContractError('Each change may add at most ONE Node, or remove one without adding');
  if (contentChanged.length > CODING_MUTATION_POLICY.maxExistingContentChanges) throw new ModuleContractError('At most FIVE existing Node content/bindings/Graph assignments may change; dependency-only changes use a separate budget');
  if (addedDependencies.length + removedDependencies.length > dependencyEditLimit) throw new ModuleContractError(`Dependency edits exceed ${dependencyEditLimit}; count each added or removed edge once`);
  if (toolChanges.length > 1) throw new ModuleContractError('At most ONE tool definition may change per proposal');
  if (child.nodes.length < 2) throw new ModuleContractError('Keep an input and an answer-producing Node');
  if (child.sourceHash === parent.sourceHash) throw new ModuleContractError('Duplicate unchanged module');
  return { parent, child, added, removed, changed, contentChanged, addedDependencies, removedDependencies, dependencyEditLimit,
    toolChanges, controlChanged: parent.controlHash !== child.controlHash };
}

export const BASELINE_MODULE = `export function createWorkflow(api) {
  const g = api.graph("agent")
    .node("context", "CONTEXT.LOAD", [], task => ({sources:[{role:"user",content:task.prompt}]}))
    .node("solve", "INFER.REASONING.SAMPLE", ["context"], (task, outputs) => api.sample(task));
  return api.loop({id:"agent",maxIterations:4,*plan(task) {
    const out = yield* api.graphStep(g, task);
    return api.answer(out.solve);
  }});
}`;

export async function runExecutableModule(source: string, task: BenchmarkTask, shared: ExperimentRuntime, settings: ProviderSettings): Promise<AgentRunResult & Record<string, unknown>> {
  const signal = currentTimeBudgetSignal();
  const loaded = await loadModule(source, { provider: shared.providerName, model: shared.model }, task, signal);
  const standard = createBenchmarkTools();
  const tools = [...standard, ...loaded.tools];
  const scoped = createExperimentRuntime(settings, { provider: shared.provider, managedProvider: true, tools, memory: createTaskMemory() });
  const outputs: Record<string, unknown> = {};
  const executedNodeIds: string[] = [], executedGraphIds: string[] = [];
  try {
    const answer = await captureCapabilityOutputs(event => {
      outputs[event.nodeId] = event.output;
      executedNodeIds.push(event.nodeId); if (!executedGraphIds.includes(event.graphId)) executedGraphIds.push(event.graphId);
    }, () => scoped.runtime.loop(loaded.plan, task, signal ? { signal } : {}));
    const usage = currentProviderUsage();
    const used = new Set(loaded.controlReads);
    const follow = (id: string) => { for (const sourceId of loaded.actualReads[id] ?? []) if (!used.has(sourceId)) { used.add(sourceId); follow(sourceId); } };
    for (const id of [...used]) follow(id);
    const initialLoad = loaded.shape.nodes.find(node => node.type === 'CONTEXT.LOAD')?.id;
    const discarded = loaded.shape.nodes.filter(node => executedNodeIds.includes(node.id) && !used.has(node.id)
      && node.id !== initialLoad && !['MEMORY.WRITE','MEMORY.UPDATE','MEMORY.DELETE','INFER.CACHE.WRITE','INFER.CACHE.INVALIDATE'].includes(node.type)).map(node => node.id);
    if (discarded.length) throw new ModuleContractError(`Executed Nodes have no information/control/state consumer: ${discarded.join(',')}`);
    return { answer: typeof answer === 'string' ? answer : String(answer), executedNodeIds, executedGraphIds,
      inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, totalTokens: usage?.totalTokens ?? 0,
      ...(usage ?? {}), moduleShape: loaded.shape, nodeInputs: loaded.inputs, nodeOutputs: outputs,
      consumedDependencies: loaded.actualReads, controlReads: [...loaded.controlReads] };
  } catch (error) {
    const usage = currentProviderUsage();
    const message = typeof (error as {message?:unknown})?.message === 'string' ? (error as {message:string}).message : String(error);
    const code = String((error as {code?:unknown})?.code ?? '');
    const declaredFailure = (error as {candidateFailure?:boolean})?.candidateFailure;
    if (error instanceof ModuleContractError || declaredFailure === true
      || /^(INVALID_INPUT|BINDING_ERROR|STRATEGY_UNAVAILABLE|MISSING_ITEM|DUPLICATE_ITEM|ITEM_LIMIT_EXCEEDED|BUDGET_UNSATISFIABLE)$/.test(code)
      || /INVALID_INPUT|BINDING|Generated tool|tool argument|Unavailable source/.test(message)
      || (declaredFailure !== false && !(error instanceof Error) && !/REFLECT_FORMAT_ERROR|PROVIDER|HTTP|BACKEND_ERROR/.test(message))) {
      return { answer: '', executedNodeIds, executedGraphIds, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0, ...(usage ?? {}), moduleShape: loaded.shape, nodeInputs: loaded.inputs,
        nodeOutputs: outputs, candidateFailure: { kind: 'module', message } };
    }
    throw Object.assign(error instanceof Error ? error : new Error(message), usage, { partialRun: { executedNodeIds, executedGraphIds, nodeOutputs: outputs, nodeInputs: loaded.inputs } });
  } finally { await scoped.close(); await loaded.close(); await closeBenchmarkTools(standard); }
}
