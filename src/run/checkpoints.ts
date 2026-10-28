import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { renameArtifact } from "./atomic.js";
import { dirname, join } from "node:path";
import type { AgentPlanSpec, DatasetName, WorkflowNodeSpec } from "../domain.js";
import { DATASETS } from "../domain.js";
import { materializeAgentPlan } from "../workflow/spec.js";
import { assertBaselinePromptProfile } from "../benchmark/baseline-prompts.js";
import { assertEvaluationRuntimeIdentity, validateEvaluationRuntimeIdentity, type EvaluationRuntimeIdentity } from "./case-recovery.js";

export interface WorkflowCheckpoint {
  readonly timeBudget?: import("../execution/time-budget.js").TimeBudgetPolicy;
  readonly schemaVersion: 1;
  readonly searchNodeId: string;
  readonly plan: AgentPlanSpec;
  readonly planHash: string;
  readonly dataset: DatasetName;
  readonly model: string;
  readonly endpoint: string;
  readonly protocol: unknown;
  readonly metricProfile: string;
  readonly dittoVersion: string;
  readonly promptProfile?: unknown;
  readonly executionIdentity?: EvaluationRuntimeIdentity;
}

export const artifactHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function checkpointForPlan(plan: AgentPlanSpec, manifest: Record<string, unknown>): WorkflowCheckpoint {
  if (!(DATASETS as readonly unknown[]).includes(manifest.dataset)) throw new Error("Invalid checkpoint dataset");
  for (const key of ["model", "endpoint", "metricProfile", "dittoVersion"]) {
    if (typeof manifest[key] !== "string") throw new Error(`Checkpoint manifest lacks ${key}`);
  }
  const checkpoint: WorkflowCheckpoint = {
    schemaVersion: 1, searchNodeId: plan.leafSearchNodeId, plan, planHash: artifactHash(plan),
    dataset: manifest.dataset as DatasetName, model: manifest.model as string, endpoint: manifest.endpoint as string,
    protocol: manifest.protocol, metricProfile: manifest.metricProfile as string, dittoVersion: manifest.dittoVersion as string,
    ...(manifest.promptProfile ? { promptProfile: manifest.promptProfile } : {}),
    ...(manifest.timeBudget ? { timeBudget: manifest.timeBudget as import("../execution/time-budget.js").TimeBudgetPolicy } : {}),
    ...(manifest.executionIdentity ? { executionIdentity: structuredClone(manifest.executionIdentity) as EvaluationRuntimeIdentity } : {}),
  };
  validateCheckpoint(checkpoint);
  return checkpoint;
}

export function validateCheckpoint(checkpoint: WorkflowCheckpoint): void {
  if (checkpoint.executionIdentity !== undefined) validateEvaluationRuntimeIdentity(checkpoint.executionIdentity);
  assertBaselinePromptProfile(checkpoint.dataset, checkpoint.promptProfile);
  if (checkpoint.schemaVersion !== 1 || !/^search-\d+$/.test(checkpoint.searchNodeId)) throw new Error("Invalid checkpoint identity");
  if (artifactHash(checkpoint.plan) !== checkpoint.planHash) throw new Error("Checkpoint hash mismatch");
  const rebuilt = materializeAgentPlan(checkpoint.searchNodeId, checkpoint.plan.nodes);
  if (artifactHash(rebuilt) !== checkpoint.planHash) throw new Error("Checkpoint is not the declared Ditto Node/Graph/Loop plan");
}

/** New runs require the exact source/build/actual SDK identity before executing a checkpoint. */
export function assertCheckpointExecutionIdentity(checkpoint: WorkflowCheckpoint, actual: EvaluationRuntimeIdentity): void {
  validateCheckpoint(checkpoint);
  assertEvaluationRuntimeIdentity(checkpoint.executionIdentity, actual);
}

export async function writeArtifact(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await renameArtifact(temporary, path);
}

export async function publishCheckpoint(directory: string, checkpoint: WorkflowCheckpoint): Promise<void> {
  validateCheckpoint(checkpoint);
  const path = join(directory, `${checkpoint.searchNodeId}.json`);
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as WorkflowCheckpoint;
    if (artifactHash(existing) !== artifactHash(checkpoint)) throw new Error("Refusing to replace an immutable workflow checkpoint");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeArtifact(path, checkpoint);
}

/** Read-only compatibility with runs launched before checkpoint publication.
 * Each evaluated tree leaf deterministically reconstructs its exact plan.
 * Test artifacts are written only in the Test Runner's separate output root.
 */
export async function discoverCheckpoints(runDirectory: string): Promise<readonly WorkflowCheckpoint[]> {
  const manifest = JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8")) as Record<string, unknown>;
  const checkpoints = new Map<string, WorkflowCheckpoint>();
  try {
    for (const entry of await readdir(join(runDirectory, "checkpoints"))) {
      if (!/^search-\d+\.json$/.test(entry)) continue;
      const checkpoint = JSON.parse(await readFile(join(runDirectory, "checkpoints", entry), "utf8")) as WorkflowCheckpoint;
      validateCheckpoint(checkpoint);
      checkpoints.set(checkpoint.searchNodeId, checkpoint);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let treeText: string;
  try { treeText = await readFile(join(runDirectory, "search-tree.jsonl"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...checkpoints.values()];
    throw error;
  }
  const tree = new Map<string, { id: string; searchParentId: string | null; node: WorkflowNodeSpec; evaluation?: unknown }>();
  // An append still in flight is not a published record until its newline.
  const completeText = treeText.slice(0, treeText.lastIndexOf("\n") + 1);
  for (const line of completeText.split(/\r?\n/).filter(Boolean)) {
    const entry = JSON.parse(line) as { id: string; searchParentId: string | null; node: WorkflowNodeSpec; evaluation?: unknown };
    tree.set(entry.id, entry);
  }
  for (const entry of tree.values()) {
    if (!entry.evaluation || checkpoints.has(entry.id)) continue;
    const nodes: WorkflowNodeSpec[] = [];
    const seen = new Set<string>();
    let current: typeof entry | undefined = entry;
    while (current) {
      if (seen.has(current.id)) throw new Error("Cycle in historical search tree");
      seen.add(current.id);
      nodes.unshift(current.node);
      if (current.searchParentId === null) break;
      const parentId: string = current.searchParentId;
      current = tree.get(parentId);
      if (!current) throw new Error(`Incomplete historical path: ${parentId}`);
    }
    checkpoints.set(entry.id, checkpointForPlan(materializeAgentPlan(entry.id, nodes), manifest));
  }
  return [...checkpoints.values()].sort((a, b) => a.searchNodeId.localeCompare(b.searchNodeId));
}
