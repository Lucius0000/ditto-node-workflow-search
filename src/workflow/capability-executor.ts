import { isAnswerNode, validatePlan, type CapabilityPlan, type CapabilityNode, type CapabilityNodeType } from "./capability-schema.js";
import { CapabilityBindingError, extendedNodeInput, projectEvidence, type EvidenceBinding } from "./capability-bindings.js";
import { captureProviderDiagnostics, summarizeProviderDiagnostics } from "../ditto/provider-diagnostics.js";
import { currentProviderUsage } from "../execution/time-budget.js";
import { captureCapabilityOutputs } from "./capability-observer.js";
import { EXPERIMENT_EXECUTION } from "../model-profile.js";
import { baselineTextMessages } from "../benchmark/baseline-prompts.js";
import { isDeepStrictEqual } from "node:util";
import { checkerContract, validateCheckerCriteria } from "./checker-policy.js";
import { applyCheckerSemantics, type ReflectionBinding } from "./checker-semantics.js";
import type { Context, ContextItem as SharedContextItem } from "@codesoul-co/ditto/contracts";
import {
  graph,
  graphStep,
  loop,
  type DittoRuntime,
  type ExecutionGraph,
} from "@codesoul-co/ditto/runtime";
import type {
  Message,
  ModelConfig,
  NodeResult,
  Usage,
} from "@codesoul-co/ditto/worker/infer";
import type {
  AgentRunResult,
  BenchmarkTask,
  GraphTransition,
  LocalGraphSpec,
  OutputCondition,
  GenerationOutcome,
  CheckerAudit,
} from "../domain.js";

type NormalizedNodeOutput = Record<string, any>;

interface GraphExecutionInput {
  readonly task: BenchmarkTask;
  /** Outputs from earlier Graphs. Outputs produced inside this Graph are supplied separately by Ditto. */
  readonly priorOutputs: Readonly<Record<string, NormalizedNodeOutput>>;
}

interface CompiledGraph {
  readonly observedOutputs: Map<string, NormalizedNodeOutput>;
  readonly inputs: Map<string, unknown>;
  readonly evidenceBindings: EvidenceBinding[];
  readonly bindings: Map<string, ReflectionBinding>;
  readonly spec: LocalGraphSpec;
  readonly graph: ExecutionGraph<GraphExecutionInput, Record<string, unknown>>;
  readonly nodes: readonly CapabilityNode[];
}

export interface CapabilityRunResult extends AgentRunResult {
  readonly nodeOutputs: Readonly<Record<string, unknown>>;
  readonly candidateFailure?: {readonly kind:'binding'|'tool';readonly nodeId:string;readonly code:string;readonly message:string};
  readonly nodeInputs: Readonly<Record<string, unknown>>;
  readonly evidenceBindings: readonly EvidenceBinding[];
}

interface ExecutionState {
  readonly outputs: Record<string, NormalizedNodeOutput>;
  readonly visits: Record<string, number>;
  readonly executedNodeIds: string[];
  readonly executedGraphIds: string[];
  readonly generationOutcomes: GenerationOutcome[];
  readonly checkerAudits: CheckerAudit[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * `ExecutionGraph.node` is intentionally strongly typed for statically-authored Graphs.
 * Search produces Graphs at runtime, so this small adapter is the sole dynamic compiler
 * boundary. It still uses only Ditto's public immutable Graph builder.
 */
interface DynamicGraphBuilder {
  node(
    id: string,
    node: CapabilityNodeType,
    dependencies: readonly string[],
    bind: (input: GraphExecutionInput, outputs: Readonly<Record<string, unknown>>) => unknown,
  ): DynamicGraphBuilder;
}

export class CapabilityExecutor {
  readonly #runtime: DittoRuntime;
  readonly #model: ModelConfig;

  /** The caller owns a fresh Memory resource/runtime for each workflow attempt. */
  constructor(runtime: DittoRuntime, provider: string, model: string) {
    this.#runtime = runtime;
    this.#model = Object.freeze({ provider, model });
  }

  /**
   * Compile searched Nodes into local Graphs, then let one Ditto Loop own every
   * sequence, repeat, and switch decision. Search-parent links never participate
   * in execution; only `CapabilityNode.dependencies` become Graph dependencies.
   */
  async run(plan: CapabilityPlan, task: BenchmarkTask, signal?: AbortSignal): Promise<CapabilityRunResult> {
    const nodesById = validatePlan(plan);
    // Typed answer consumers are validated independently of evidence dependencies.
    for (const node of plan.nodes) if (node.type === "INFER.REASONING.REFLECT") validateCheckerCriteria(task.dataset as "drop"|"gsm8k"|"math", node.config.criteria);
    const faults: {binding?: {nodeId:string;error:CapabilityBindingError}} = {};
    const state = createExecutionState();
    const compiled = compileGraphs(plan, nodesById, this.#model, faults);
    const graphOptions = signal ? { signal } : {};

    const definition = loop<BenchmarkTask, CapabilityRunResult>({
      id: `${plan.id}:loop`,
      maxIterations: EXPERIMENT_EXECUTION.maxIterations,
      *plan(loopTask) {
        let graphId: string | undefined = plan.loop.entryGraphId;
        let candidateFailure: CapabilityRunResult['candidateFailure'];

        while (graphId !== undefined) {
          const current = compiled.get(graphId);
          if (!current) throw new Error(`Loop selected unknown Graph: ${graphId}`);

          const rawOutputs = yield* graphStep(current.graph, {
            task: loopTask,
            priorOutputs: Object.freeze({ ...state.outputs }),
          }, graphOptions);

          state.executedGraphIds.push(current.spec.id);
          state.visits[current.spec.id] = (state.visits[current.spec.id] ?? 0) + 1;
          for (const node of current.nodes) {
            if (!Object.hasOwn(rawOutputs, node.id)) {
              throw new Error(`Graph ${current.spec.id} did not return Node output: ${node.id}`);
            }
            const output = normalizeNodeOutput(node, rawOutputs[node.id], current.bindings.get(node.id));
            state.outputs[node.id] = output;
            if ("generationOutcome" in output) state.generationOutcomes.push(output.generationOutcome as GenerationOutcome);
            if ("checkerAudit" in output) state.checkerAudits.push(output.checkerAudit as CheckerAudit);
            state.executedNodeIds.push(node.id);
            addUsage(state, usageOf(output));
            if (node.type === 'INTERACTION.ACT.TOOL' && output.status === 'failed') {
              if (!['B_TOOL_INPUT','B_TOOL_LIMIT'].includes(output.error?.code)) throw Error(`Unexpected tool failure ${output.error?.code}`);
              candidateFailure = {kind:'tool',nodeId:node.id,code:output.error.code,message:output.error.message};
            }
          }

          if (candidateFailure) break;

          graphId = nextGraphId(
            plan.loop.transitions[current.spec.id] ?? { kind: "end" },
            state.outputs,
            state.visits,
          );
        }

        const outputNode = nodesById.get(plan.outputNodeId)!;
        const answer = candidateFailure ? '' : answerFor(outputNode, state.outputs, state.executedNodeIds);
        return Object.freeze({
          answer,
          executedNodeIds: Object.freeze([...state.executedNodeIds]),
          executedGraphIds: Object.freeze([...state.executedGraphIds]),
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          totalTokens: state.totalTokens,
          generationOutcomes: Object.freeze([...state.generationOutcomes]),
          checkerAudits: Object.freeze([...state.checkerAudits]),
          nodeOutputs: Object.freeze(structuredClone(state.outputs)),
          nodeInputs: Object.freeze(structuredClone(Object.fromEntries([...compiled.values()].flatMap(item => [...item.inputs])))),
          evidenceBindings: Object.freeze([...compiled.values()].flatMap(item => item.evidenceBindings)),
          ...(candidateFailure ? {candidateFailure} : {}),
        });
      },
    });

    return captureCapabilityOutputs(event => {
      const current = [...compiled.values()].find(item => item.graph.id === event.graphId);
      const node = current?.nodes.find(item => item.id === event.nodeId && item.type === event.nodeType);
      if (!current || !node) return;
      // Capture at completion, including independent siblings whose Graph later fails.
      try { current.observedOutputs.set(node.id, normalizeNodeOutput(node, event.output, current.bindings.get(node.id))); }
      catch { if (event.output && typeof event.output === "object") current.observedOutputs.set(node.id, event.output as NormalizedNodeOutput); }
    }, () => captureProviderDiagnostics(async records => {
      try {
        const result = await this.#runtime.loop(definition, task, signal ? { signal } : {});
        return records.length || currentProviderUsage() ? Object.freeze({ ...result, ...retainedUsage(result, records) }) : result;
      } catch (error) {
        if (faults.binding) {
          const outputs = {...state.outputs,...Object.fromEntries([...compiled.values()].flatMap(item=>[...item.observedOutputs]))};
          const usage = createExecutionState();
          for (const output of Object.values(outputs)) addUsage(usage, usageOf(output));
          return Object.freeze({...retainedUsage(usage,records),answer:'',executedNodeIds:Object.freeze(plan.nodes.filter(node=>Object.hasOwn(outputs,node.id)).map(node=>node.id)),
            executedGraphIds:Object.freeze([...state.executedGraphIds]),
            generationOutcomes:Object.freeze(Object.values(outputs).flatMap(output=>output.generationOutcome?[output.generationOutcome as GenerationOutcome]:[])),
            checkerAudits:Object.freeze(Object.values(outputs).flatMap(output=>output.checkerAudit?[output.checkerAudit as CheckerAudit]:[])),
            nodeOutputs:Object.freeze(structuredClone(outputs)),nodeInputs:Object.freeze(structuredClone(Object.fromEntries([...compiled.values()].flatMap(item=>[...item.inputs])))),
            evidenceBindings:Object.freeze([...compiled.values()].flatMap(item=>item.evidenceBindings)),
            candidateFailure:{kind:'binding' as const,nodeId:faults.binding.nodeId,code:'B_BINDING_INPUT',message:faults.binding.error.message}});
        }
        const outputs = {...state.outputs,...Object.fromEntries([...compiled.values()].flatMap(item=>[...item.observedOutputs]))};
        const usage = createExecutionState();
        for (const output of Object.values(outputs)) addUsage(usage, usageOf(output));
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), retainedUsage(usage, records), {
          partialRun: {nodeOutputs:structuredClone(outputs),nodeInputs:structuredClone(Object.fromEntries([...compiled.values()].flatMap(item=>[...item.inputs]))),
            executedNodeIds:plan.nodes.filter(node=>Object.hasOwn(outputs,node.id)).map(node=>node.id),executedGraphIds:[...state.executedGraphIds]},
        });
      }
    }));
  }
}

function retainedUsage(known: Pick<AgentRunResult, "inputTokens" | "outputTokens" | "totalTokens">, records: Parameters<typeof summarizeProviderDiagnostics>[0]) {
  const diagnostics = summarizeProviderDiagnostics(records);
  const provider = currentProviderUsage();
  return {
    ...diagnostics,
    ...(provider ?? {}),
    inputTokens: Math.max(known.inputTokens, diagnostics.inputTokens, provider?.inputTokens ?? 0),
    outputTokens: Math.max(known.outputTokens, diagnostics.outputTokens, provider?.outputTokens ?? 0),
    totalTokens: Math.max(known.totalTokens, diagnostics.totalTokens, provider?.totalTokens ?? 0),
  };
}

function compileGraphs(
  plan: CapabilityPlan,
  nodesById: ReadonlyMap<string, CapabilityNode>,
  model: ModelConfig,
  faults: {binding?: {nodeId:string;error:CapabilityBindingError}},
): ReadonlyMap<string, CompiledGraph> {
  const result = new Map<string, CompiledGraph>();
  for (const graphSpec of plan.graphs) {
    const localIds = new Set(graphSpec.nodeIds);
    const nodes = graphSpec.nodeIds.map((id) => nodesById.get(id)!);
    const bindings = new Map<string, ReflectionBinding>();
    const inputs = new Map<string, unknown>();
    const evidenceBindings: EvidenceBinding[] = [];
    const observedOutputs = new Map<string, NormalizedNodeOutput>();
    let builder = graph<GraphExecutionInput>(`${plan.id}:${graphSpec.id}`) as unknown as DynamicGraphBuilder;

    for (const node of nodes) {
      // Cross-Graph dependencies are intentionally absent from the local DAG. Their
      // values are read from Loop state by the binder when this Graph is invoked.
      const localDependencies = node.dependencies.filter((id) => localIds.has(id));
      builder = builder.node(node.id, node.type, localDependencies, (input, localOutputs) => {
        for (const [id,raw] of Object.entries(localOutputs)) observedOutputs.set(id, normalizeNodeOutput(nodesById.get(id)!, raw, bindings.get(id)));
        const dependencies = bindDependencies(node, nodesById, input.priorOutputs, localOutputs, bindings);
        // Only Infer receives this projection. Extended operations bind their declared Sources.
        if (isAnswerNode(node)) evidenceBindings.push(...projectEvidence(node, dependencies).bindings);
        let bound:unknown;
        try {bound = nodeInput(node, input.task, dependencies, model, bindings);}
        catch(error) {if(error instanceof CapabilityBindingError) faults.binding={nodeId:node.id,error};throw error;}
        inputs.set(node.id, structuredClone(bound));
        return bound;
      });
    }

    result.set(graphSpec.id, Object.freeze({
      spec: graphSpec,
      graph: builder as unknown as ExecutionGraph<GraphExecutionInput, Record<string, unknown>>,
      nodes: Object.freeze(nodes),
      bindings,
      inputs,
      evidenceBindings,
      observedOutputs,
    }));
  }
  return result;
}

function bindDependencies(
  node: CapabilityNode,
  nodesById: ReadonlyMap<string, CapabilityNode>,
  priorOutputs: Readonly<Record<string, NormalizedNodeOutput>>,
  localOutputs: Readonly<Record<string, unknown>>,
  bindings: ReadonlyMap<string, ReflectionBinding>,
): Readonly<Record<string, NormalizedNodeOutput>> {
  // A Graph is a local workflow boundary. Every later Graph receives the Loop's
  // accumulated state, while only explicit local dependencies can observe outputs
  // produced during the current Graph run. This lets `refine` consume `solve`
  // without inventing cross-Graph DAG edges, and prevents parallel sibling Nodes
  // in one Graph from silently observing one another.
  const dependencies: Record<string, NormalizedNodeOutput> = {
    ...priorOutputs,
  };
  for (const id of node.dependencies) {
    if (Object.hasOwn(localOutputs, id)) {
      dependencies[id] = normalizeNodeOutput(nodesById.get(id)!, localOutputs[id], bindings.get(id));
    } else {
      throw new Error(`Node ${node.id} local dependency has not executed: ${id}`);
    }
  }
  return Object.freeze(dependencies);
}

function nodeInput(
  node: CapabilityNode,
  task: BenchmarkTask,
  dependencies: Readonly<Record<string, NormalizedNodeOutput>>,
  model: ModelConfig,
  bindings: Map<string, ReflectionBinding>,
): unknown {
  const projected = projectEvidence(node, dependencies);
  const context = projected.context ?? dependencyContext(dependencies);
  const extension = extendedNodeInput(node, task, dependencies);
  if (extension !== undefined) return extension;
  const messages = dependencyMessages(dependencies);
  const taskMessage = taskText(task);
  const metadata = { experiment: "ditto-workflow-search", dataset: task.dataset, taskId: task.id, nodeId: node.id, nodeType: node.type };

  switch (node.type) {
    case "CONTEXT.LOAD":
      return {
        sources: [
          { role: "user", content: taskMessage },
          ...(node.config.includeTaskMetadata ? [{
            id: `${task.id}:metadata`,
            content: task.metadata,
            metadata: { dataset: task.dataset, taskId: task.id },
          }] : []),
        ],
      };

    case "INFER.REASONING.TRAJECTORY":
      return {
        messages: [{ role: "user", content: taskMessage }, ...messages.map(({ message }) => message)],
        objective: node.config.instruction,
        ...(context ? { context: inferContext(context) } : {}),
        strategy: { name: node.config.strategy, options: { ...node.config.options } },
        model,
        generation: node.config.generation,
        constraints: { maxSteps: EXPERIMENT_EXECUTION.maxSteps },
        metadata,
      };

    case "INFER.REASONING.SAMPLE": {
      // Evolved workflows may move/rewire sample-1. Its historical ID must
      // not discard actual prerequisite answers in those candidates.
      if ((node.id === "sample-1" && node.type === "INFER.REASONING.SAMPLE") && messages.length === 0 && !projected.hasB) {
        return {
          messages: task.dataset === "drop" || task.dataset === "gsm8k"
            ? baselineTextMessages(task.dataset, node.config.instruction, task.prompt)
            : [{ role: "user", content: node.config.instruction + task.prompt }],
          model, generation: node.config.generation, metadata,
        };
      }
      if (projected.hasB && node.id === "sample-1" && messages.length === 0) return {
        messages: task.dataset === "drop" || task.dataset === "gsm8k"
          ? baselineTextMessages(task.dataset, node.config.instruction, task.prompt, projected.text)
          : [{ role: "user", content: node.config.instruction + task.prompt + projected.text }],
        model, generation: node.config.generation, metadata,
      };
      const evidence = messages.length
        ? `\n\nOutputs from prerequisite Nodes:\n${messages.map(({ id, message }) => `[${id}] ${messageText(message)}`).join("\n")}`
        : "";
      const contextText = projected.hasB ? projected.text : context
        ? `\n\nWorking context:\n${context.items.map((item: SharedContextItem) => contextItemText(item)).join("\n")}`
        : "";
      return {
        messages: task.dataset === "drop" || task.dataset === "gsm8k"
          ? baselineTextMessages(task.dataset, node.config.instruction, task.prompt, `${evidence}${contextText}`)
          : [
          { role: "system", content: node.config.instruction },
          { role: "user", content: `${taskMessage}${evidence}${contextText}` },
        ],
        model,
        generation: node.config.generation,
        metadata: { ...metadata, role: node.config.role },
      };
    }

    case "INFER.REASONING.DELIBERATE": {
      if (!messages.length) throw new Error(`Node ${node.id} requires at least one message-producing dependency`);
      return {
        messages: [{ role: "user", content: taskMessage }],
        objective: task.outputInstruction,
        candidates: messages.map(({ id, message }) => ({ id, result: message })),
        mode: node.config.mode,
        ...(context ? { context: inferContext(context) } : {}),
        model,
        generation: node.config.generation,
        metadata,
      };
    }

    case "INFER.REASONING.REFLECT": {
      const target = messages.at(-1);
      if (!target) throw new Error(`Node ${node.id} requires a message-producing dependency`);
      validateCheckerCriteria(task.dataset as "drop"|"gsm8k"|"math", node.config.criteria);
      const targetNodeId = target.answerSourceNodeId ?? target.id;
      const feedback = Object.values(dependencies).flatMap(output => "checkerAudit" in output && output.checkerAudit.mode !== "revise" &&
        output.checkerAudit.targetNodeId === targetNodeId && output.checkerAudit.originalAnswer === messageText(target.message) ? [output.checkerAudit] : []);
      const criteria = [checkerContract(task.dataset as "drop"|"gsm8k"|"math"), ...node.config.criteria];
      bindings.set(node.id, { target: target.message, targetNodeId, feedback, criteria });
      return {
        messages: [{ role: "user", content: taskMessage }],
        target: { result: target.message },
        mode: node.config.mode,
        criteria: criteria.map((description, index) => ({ id: index ? `criterion-${index}` : "application-checker-policy", description, weight: 1 })),
        context: [...(context ? inferContext(context) : []), ...(node.config.mode === "revise" && feedback.length ? [{
          id: `checker-feedback:${node.id}`, content: { originalAnswerNodeId: targetNodeId, originalAnswer: target.message,
            checks: feedback.map(({ nodeId, assessment, issues }) => ({ nodeId, assessment, issues })) },
        }] : [])],
        model,
        generation: node.config.generation,
        metadata,
      };
    }
  }
}

function transitionTargets(transition: GraphTransition): readonly string[] {
  switch (transition.kind) {
    case "end": return [];
    case "next": return [transition.graphId];
    case "repeat": return [transition.graphId, ...(transition.nextGraphId ? [transition.nextGraphId] : [])];
    case "switch": return [
      ...transition.cases.map((item) => item.graphId),
      ...(transition.defaultGraphId ? [transition.defaultGraphId] : []),
    ];
  }
}

function nextGraphId(
  transition: GraphTransition,
  outputs: Readonly<Record<string, NormalizedNodeOutput>>,
  visits: Readonly<Record<string, number>>,
): string | undefined {
  switch (transition.kind) {
    case "end":
      return undefined;
    case "next":
      return transition.graphId;
    case "repeat": {
      if (!Number.isSafeInteger(transition.maxVisits) || transition.maxVisits < 1) {
        throw new Error("Repeat maxVisits must be a positive integer");
      }
      if (conditionMatches(transition.until, outputs)) return transition.nextGraphId;
      return (visits[transition.graphId] ?? 0) < transition.maxVisits
        ? transition.graphId
        : transition.nextGraphId;
    }
    case "switch":
      return transition.cases.find((item) => conditionMatches(item.when, outputs))?.graphId
        ?? transition.defaultGraphId;
  }
}

function conditionMatches(
  condition: OutputCondition,
  outputs: Readonly<Record<string, NormalizedNodeOutput>>,
): boolean {
  let value: unknown = outputs[condition.sourceNodeId];
  for (const segment of condition.path ?? []) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  switch (condition.operator) {
    case "equals": return isDeepStrictEqual(value, condition.value);
    case "not-equals": return !isDeepStrictEqual(value, condition.value);
    case "truthy": return Boolean(value);
    case "falsy": return !value;
    default: throw Error("Unsupported B condition");
  }
}

function normalizeNodeOutput(node: CapabilityNode, raw: unknown, binding?: ReflectionBinding): NormalizedNodeOutput {
  if (node.type.startsWith("CONTEXT.")) {
    if (node.type === "CONTEXT.SELECT") return { ...(raw as any).context, selection: raw, __bKind: "evidence", __bNode: node };
    if (!isContext(raw)) throw new Error(`Node ${node.id} returned an invalid Context`);
    return { ...raw, __bKind: "evidence", __bNode: node };
  }
  if (node.type.startsWith("INTERACTION.")) return { ...(raw as object), __bKind: "evidence", __bNode: node };
  const output = unwrap(raw as NodeResult<NormalizedNodeOutput>, node.id);
  // Unusable length output retains the budget boundary's empty answer and actual finish reason.
  if (node.type === "INFER.REASONING.REFLECT" && binding && "assessment" in output && "issues" in output) {
    return applyCheckerSemantics(node as any, output as any, binding);
  }
  return node.type.startsWith("MEMORY.") ? { records: output, __bKind: "evidence", __bNode: node } : output;
}

function unwrap<T>(result: NodeResult<T>, nodeId: string): T {
  if (!result || result.status !== "success" || result.output === undefined) {
    const status = result?.status ?? "invalid-result";
    throw new Error(`Node ${nodeId} failed [${result?.error?.code ?? status}]: ${result?.error?.message ?? "no output"}`);
  }
  return result.output;
}

function dependencyContext(outputs: Readonly<Record<string, NormalizedNodeOutput>>): Context | undefined {
  for (const output of Object.values(outputs)) if (isContext(output)) return output;
  return undefined;
}

function dependencyMessages(
  outputs: Readonly<Record<string, NormalizedNodeOutput>>,
): readonly { readonly id: string; readonly message: Message; readonly answerSourceNodeId?: string }[] {
  const messages: Array<{ id: string; message: Message; answerSourceNodeId?: string }> = [];
  for (const [id, output] of Object.entries(outputs)) {
    const message = outputMessage(output);
    if (message) messages.push({ id, message, ...("answerSourceNodeId" in output ? { answerSourceNodeId: output.answerSourceNodeId } : {}) });
  }
  return messages;
}

function outputMessage(output: NormalizedNodeOutput): Message | undefined {
  if (isContext(output)) return undefined;
  if (output.__bKind === "evidence") return undefined;
  if ("message" in output && isMessage(output.message)) return output.message;
  if ("result" in output && isMessage(output.result)) return output.result;
  if ("revisedResult" in output && isMessage(output.revisedResult)) return output.revisedResult;
  return undefined;
}

function answerFor(
  outputNode: CapabilityNode,
  outputs: Readonly<Record<string, NormalizedNodeOutput>>,
  executedNodeIds: readonly string[],
): string {
  const direct = outputs[outputNode.id];
  if (!direct) throw new Error(`Output Node was not executed: ${outputNode.id}`);
  const message = outputMessage(direct);
  if (message) return messageText(message);

  // VERIFY/CRITIQUE reflections need not revise and cross-Graph values are Loop
  // state rather than local dependencies. Walk the actual execution history so
  // a conditional/repeated plan preserves the most recently assessed answer.
  for (const id of [...executedNodeIds].reverse()) {
    if (id === outputNode.id) continue;
    const prior = outputs[id];
    if (!prior) continue;
    const inherited = outputMessage(prior);
    if (inherited) return messageText(inherited);
  }
  throw new Error(`Output Node ${outputNode.id} did not produce an answer message`);
}

function createExecutionState(): ExecutionState {
  return {
    outputs: Object.create(null) as Record<string, NormalizedNodeOutput>,
    visits: Object.create(null) as Record<string, number>,
    executedNodeIds: [],
    executedGraphIds: [],
    generationOutcomes: [],
    checkerAudits: [],
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function usageOf(output: NormalizedNodeOutput): Usage | undefined {
  return !isContext(output) && "usage" in output ? output.usage : undefined;
}

function addUsage(state: ExecutionState, usage?: Usage): void {
  if (!usage) return;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  state.inputTokens += input;
  state.outputTokens += output;
  state.totalTokens += usage.totalTokens ?? input + output;
}

function inferContext(context: Context): readonly {
  readonly id: string;
  readonly content: unknown;
  readonly source?: string;
}[] {
  return context.items.map((item: SharedContextItem) => ({
    id: item.id,
    content: item.content,
    ...(item.source ? { source: item.source.uri } : {}),
  }));
}

function taskText(task: BenchmarkTask): string {
  return task.outputInstruction
    ? `Task:\n${task.prompt}\n\nOutput requirements:\n${task.outputInstruction}`
    : task.prompt;
}

function contextItemText(item: SharedContextItem): string {
  return `[${item.id}] ${typeof item.content === "string" ? item.content : JSON.stringify(item.content)}`;
}

function messageText(message: Message): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Message>;
  return ["system", "user", "assistant", "tool"].includes(candidate.role ?? "")
    && (typeof candidate.content === "string" || Array.isArray(candidate.content));
}

function isContext(value: unknown): value is Context {
  return Boolean(value && typeof value === "object" && Array.isArray((value as Partial<Context>).items));
}
