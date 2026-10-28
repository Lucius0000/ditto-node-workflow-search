import { captureProviderDiagnostics, summarizeProviderDiagnostics } from "../ditto/provider-diagnostics.js";
import { EXPERIMENT_EXECUTION } from "../model-profile.js";
import { baselineTextMessages } from "../benchmark/baseline-prompts.js";
import { isDeepStrictEqual } from "node:util";
import { isRawBaseline } from "./spec.js";
import { hasCapabilities, type CapabilityPlan } from "./capability-schema.js";
import { CapabilityExecutor } from "./capability-executor.js";
import { checkerContract, validateCheckerCriteria, validateCheckerDependencies } from "./checker-policy.js";
import { applyCheckerSemantics, type CheckedReflectionOutput, type ReflectionBinding } from "./checker-semantics.js";
import type { Context, ContextItem as SharedContextItem } from "@codesoul-co/ditto/contracts";
import {
  graph,
  graphStep,
  loop,
  type DittoRuntime,
  type ExecutionGraph,
} from "@codesoul-co/ditto/runtime";
import type {
  DeliberateOutput,
  Message,
  ModelConfig,
  NodeResult,
  ReflectOutput,
  SampleOutput,
  TrajectoryOutput,
  Usage,
} from "@codesoul-co/ditto/worker/infer";
import type {
  AgentPlanSpec,
  AgentRunResult,
  BenchmarkTask,
  GraphTransition,
  LocalGraphSpec,
  OutputCondition,
  SearchableNodeType,
  WorkflowNodeSpec,
  GenerationOutcome,
  CheckerAudit,
} from "../domain.js";

type NormalizedNodeOutput = Context | TrajectoryOutput | SampleOutput | DeliberateOutput | ReflectOutput | CheckedReflectionOutput;

interface GraphExecutionInput {
  readonly task: BenchmarkTask;
  /** Outputs from earlier Graphs. Outputs produced inside this Graph are supplied separately by Ditto. */
  readonly priorOutputs: Readonly<Record<string, NormalizedNodeOutput>>;
}

interface CompiledGraph {
  readonly bindings: Map<string, ReflectionBinding>;
  readonly spec: LocalGraphSpec;
  readonly graph: ExecutionGraph<GraphExecutionInput, Record<string, unknown>>;
  readonly nodes: readonly WorkflowNodeSpec[];
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
    node: SearchableNodeType,
    dependencies: readonly string[],
    bind: (input: GraphExecutionInput, outputs: Readonly<Record<string, unknown>>) => unknown,
  ): DynamicGraphBuilder;
}

export class WorkflowExecutor {
  readonly #runtime: DittoRuntime;
  readonly #model: ModelConfig;

  constructor(runtime: DittoRuntime, provider: string, model: string) {
    this.#runtime = runtime;
    this.#model = Object.freeze({ provider, model });
  }

  /**
   * Compile searched Nodes into local Graphs, then let one Ditto Loop own every
   * sequence, repeat, and switch decision. Search-parent links never participate
   * in execution; only `WorkflowNodeSpec.dependencies` become Graph dependencies.
   */
  async run(plan: AgentPlanSpec, task: BenchmarkTask, signal?: AbortSignal): Promise<AgentRunResult> {
    if (hasCapabilities(plan.nodes)) return new CapabilityExecutor(this.#runtime, this.#model.provider ?? "deepseek", this.#model.model).run(plan as unknown as CapabilityPlan, task, signal);
    const nodesById = validatePlan(plan);
    validateCheckerDependencies(plan.graphs.flatMap(graph => graph.nodeIds.map(id => nodesById.get(id)!)));
    for (const node of plan.nodes) if (node.type === "INFER.REASONING.REFLECT") validateCheckerCriteria(task.dataset, node.config.criteria);
    const compiled = compileGraphs(plan, nodesById, this.#model);
    const graphOptions = signal ? { signal } : {};

    const definition = loop<BenchmarkTask, AgentRunResult>({
      id: `${plan.id}:loop`,
      maxIterations: EXPERIMENT_EXECUTION.maxIterations,
      *plan(loopTask) {
        const state = createExecutionState();
        let graphId: string | undefined = plan.loop.entryGraphId;

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
          }

          graphId = nextGraphId(
            plan.loop.transitions[current.spec.id] ?? { kind: "end" },
            state.outputs,
            state.visits,
          );
        }

        const outputNode = nodesById.get(plan.outputNodeId)!;
        const answer = answerFor(outputNode, state.outputs, state.executedNodeIds);
        return Object.freeze({
          answer,
          executedNodeIds: Object.freeze([...state.executedNodeIds]),
          executedGraphIds: Object.freeze([...state.executedGraphIds]),
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          totalTokens: state.totalTokens,
          generationOutcomes: Object.freeze([...state.generationOutcomes]),
          checkerAudits: Object.freeze([...state.checkerAudits]),
        });
      },
    });

    return captureProviderDiagnostics(async records => {
      try {
        const result = await this.#runtime.loop(definition, task, signal ? { signal } : {});
        return records.length ? Object.freeze({ ...result, ...summarizeProviderDiagnostics(records) }) : result;
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), summarizeProviderDiagnostics(records));
      }
    });
  }
}

function compileGraphs(
  plan: AgentPlanSpec,
  nodesById: ReadonlyMap<string, WorkflowNodeSpec>,
  model: ModelConfig,
): ReadonlyMap<string, CompiledGraph> {
  const result = new Map<string, CompiledGraph>();
  for (const graphSpec of plan.graphs) {
    const localIds = new Set(graphSpec.nodeIds);
    const nodes = graphSpec.nodeIds.map((id) => nodesById.get(id)!);
    const bindings = new Map<string, ReflectionBinding>();
    let builder = graph<GraphExecutionInput>(`${plan.id}:${graphSpec.id}`) as unknown as DynamicGraphBuilder;

    for (const node of nodes) {
      // Cross-Graph dependencies are intentionally absent from the local DAG. Their
      // values are read from Loop state by the binder when this Graph is invoked.
      const localDependencies = node.dependencies.filter((id) => localIds.has(id));
      builder = builder.node(node.id, node.type, localDependencies, (input, localOutputs) => {
        const dependencies = bindDependencies(node, nodesById, input.priorOutputs, localOutputs, bindings);
        return nodeInput(node, input.task, dependencies, model, bindings);
      });
    }

    result.set(graphSpec.id, Object.freeze({
      spec: graphSpec,
      graph: builder as unknown as ExecutionGraph<GraphExecutionInput, Record<string, unknown>>,
      nodes: Object.freeze(nodes),
      bindings,
    }));
  }
  return result;
}

function bindDependencies(
  node: WorkflowNodeSpec,
  nodesById: ReadonlyMap<string, WorkflowNodeSpec>,
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
  node: WorkflowNodeSpec,
  task: BenchmarkTask,
  dependencies: Readonly<Record<string, NormalizedNodeOutput>>,
  model: ModelConfig,
  bindings: Map<string, ReflectionBinding>,
): unknown {
  const context = dependencyContext(dependencies);
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
      if (isRawBaseline(node) && messages.length === 0) {
        return {
          messages: task.dataset === "drop" || task.dataset === "gsm8k"
            ? baselineTextMessages(task.dataset, node.config.instruction, task.prompt)
            : [{ role: "user", content: node.config.instruction + task.prompt }],
          model, generation: node.config.generation, metadata,
        };
      }
      const evidence = messages.length
        ? `\n\nOutputs from prerequisite Nodes:\n${messages.map(({ id, message }) => `[${id}] ${messageText(message)}`).join("\n")}`
        : "";
      const contextText = context
        ? `\n\nWorking context:\n${context.items.map((item) => contextItemText(item)).join("\n")}`
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
      validateCheckerCriteria(task.dataset, node.config.criteria);
      const targetNodeId = target.answerSourceNodeId ?? target.id;
      const feedback = Object.values(dependencies).flatMap(output => "checkerAudit" in output && output.checkerAudit.mode !== "revise" &&
        output.checkerAudit.targetNodeId === targetNodeId && output.checkerAudit.originalAnswer === messageText(target.message) ? [output.checkerAudit] : []);
      const criteria = [checkerContract(task.dataset), ...node.config.criteria];
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

function validatePlan(plan: AgentPlanSpec): ReadonlyMap<string, WorkflowNodeSpec> {
  if (!plan.id.trim()) throw new Error("Agent plan ID cannot be empty");
  if (!Number.isSafeInteger(plan.loop.maxGraphRuns) || plan.loop.maxGraphRuns < 1) {
    throw new Error("Loop maxGraphRuns must be a positive integer");
  }

  const nodes = new Map<string, WorkflowNodeSpec>();
  for (const node of plan.nodes) {
    if (!node.id.trim() || nodes.has(node.id)) throw new Error(`Duplicate or empty Node ID: ${node.id}`);
    nodes.set(node.id, node);
  }
  if (!nodes.has(plan.outputNodeId)) throw new Error(`Unknown output Node: ${plan.outputNodeId}`);

  const graphIds = new Set<string>();
  const assigned = new Set<string>();
  for (const graphSpec of plan.graphs) {
    if (!graphSpec.id.trim() || graphIds.has(graphSpec.id)) throw new Error(`Duplicate or empty Graph ID: ${graphSpec.id}`);
    graphIds.add(graphSpec.id);
    const seenLocally = new Set<string>();
    for (const nodeId of graphSpec.nodeIds) {
      const node = nodes.get(nodeId);
      if (!node) throw new Error(`Graph ${graphSpec.id} references unknown Node: ${nodeId}`);
      if (node.graphId !== graphSpec.id) throw new Error(`Node ${nodeId} belongs to Graph ${node.graphId}, not ${graphSpec.id}`);
      if (assigned.has(nodeId)) throw new Error(`Node ${nodeId} is assigned to multiple Graphs`);
      for (const dependency of node.dependencies) {
        if (!nodes.has(dependency)) throw new Error(`Node ${nodeId} references unknown dependency: ${dependency}`);
        if (nodes.get(dependency)!.graphId !== graphSpec.id) {
          throw new Error(`Node ${nodeId} dependency ${dependency} crosses a Graph boundary; use Loop state instead`);
        }
        if (!seenLocally.has(dependency)) {
          throw new Error(`Graph ${graphSpec.id} must list local dependency ${dependency} before ${nodeId}`);
        }
      }
      seenLocally.add(nodeId);
      assigned.add(nodeId);
    }
  }
  if (assigned.size !== nodes.size) {
    const missing = [...nodes.keys()].filter((id) => !assigned.has(id));
    throw new Error(`Nodes are not assigned to a Graph: ${missing.join(", ")}`);
  }
  if (!graphIds.has(plan.loop.entryGraphId)) throw new Error(`Unknown entry Graph: ${plan.loop.entryGraphId}`);

  for (const [source, transition] of Object.entries(plan.loop.transitions)) {
    if (!graphIds.has(source)) throw new Error(`Transition source is not a Graph: ${source}`);
    for (const target of transitionTargets(transition)) {
      if (!graphIds.has(target)) throw new Error(`Transition from ${source} targets unknown Graph: ${target}`);
    }
  }
  return nodes;
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
  }
}

function normalizeNodeOutput(node: WorkflowNodeSpec, raw: unknown, binding?: ReflectionBinding): NormalizedNodeOutput {
  if (node.type === "CONTEXT.LOAD") {
    if (!isContext(raw)) throw new Error(`Node ${node.id} returned an invalid Context`);
    return raw;
  }
  const output = unwrap(raw as NodeResult<NormalizedNodeOutput>, node.id);
  // Unusable length output retains the budget boundary's empty answer and actual finish reason.
  if (node.type === "INFER.REASONING.REFLECT" && binding && "assessment" in output && "issues" in output) {
    return applyCheckerSemantics(node, output, binding);
  }
  return output;
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
  if ("message" in output && isMessage(output.message)) return output.message;
  if ("result" in output && isMessage(output.result)) return output.result;
  if ("revisedResult" in output && isMessage(output.revisedResult)) return output.revisedResult;
  return undefined;
}

function answerFor(
  outputNode: WorkflowNodeSpec,
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
  return context.items.map((item) => ({
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
