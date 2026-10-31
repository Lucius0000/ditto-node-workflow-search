import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { CaseResult } from "../domain.js";
import { renameArtifact } from "./atomic.js";

const CODE_IDENTITY_DOMAIN = "ditto-evaluation-code-v4:prompts:utf8-crlf-to-lf\0";
export const FROZEN_ASSET_RUNTIME_POLICY = 'frozen-initialization-assets-v1';
const FROZEN_ASSET_FILES = new Set(['humaneval','mbpp','drop','automationbench','strategy-template'].map(name=>`prompts/initialization/${name}.json`));
const CODE_TEXT_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".py", ".ps1", ".json", ".txt", ".md"]);

/** Normalize only controlled UTF-8 text; binary assets retain their exact bytes. */
async function codeIdentityBytes(path: string): Promise<Uint8Array> {
  const bytes = await readFile(path);
  if (!CODE_TEXT_EXTENSIONS.has(extname(path).toLowerCase())) return bytes;
  // Fatal decoding prevents lossy replacement; ignoreBOM preserves a real BOM.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
}

/** Versioned source identity is stable under Git's CRLF-to-LF text checkout. */
export async function evaluationCodeHash(root: string, policy?:typeof FROZEN_ASSET_RUNTIME_POLICY): Promise<string> {
  if(policy!==undefined&&policy!==FROZEN_ASSET_RUNTIME_POLICY)throw Error('Unknown execution hash policy');
  const hash = createHash("sha256").update(policy?CODE_IDENTITY_DOMAIN+policy+'\0':CODE_IDENTITY_DOMAIN);
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "__pycache__") continue;
      const name = `${relative}/${entry.name}`;
      if(policy&&FROZEN_ASSET_FILES.has(name))continue;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) { hash.update(name); hash.update(await codeIdentityBytes(join(root, name))); }
    }
  }
  await visit("src");
  await visit("scripts");
  try { await visit("prompts"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; hash.update("prompts:absent\0"); }
  hash.update(await codeIdentityBytes(join(root, "package-lock.json")));
  for (const name of ["requirements.txt", "requirements-scoring.txt", "requirements-provider.txt"]) {
    hash.update(`\0${name}\0`);
    try { hash.update(await codeIdentityBytes(join(root, name))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("absent\0");
    }
  }
  return hash.digest("hex");
}

export interface EvaluationRuntimeIdentity {
  readonly schemaVersion: 1;
  readonly sourceSha256: string;
  readonly compiledSha256: string;
  readonly providerEnvironmentSha256: string;
  /** Application-reported actual Python/SDK versions, never provider credentials. */
  readonly providerEnvironment: Readonly<Record<string, string>>;
}

const ENVIRONMENT_FIELDS = new Set(["pythonExecutable", "pythonVersion", "openaiVersion", "httpxVersion", "nodeVersion", "dittoVersion"]);
const identityHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function normalizedEnvironment(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid provider environment identity");
  for (const [key, text] of Object.entries(value)) {
    if (!ENVIRONMENT_FIELDS.has(key) || typeof text !== "string" || !text.trim()) throw Error(`Invalid provider environment field: ${key}`);
  }
  for (const key of ["pythonExecutable", "pythonVersion", "openaiVersion", "httpxVersion"]) {
    if (!value[key]) throw Error(`Provider environment identity lacks actual ${key}`);
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

/** Hash actual emitted bytes as well as source; a stale or edited dist cannot reuse cases. */
export async function evaluationCompiledHash(root: string, compiledDirectory = "dist"): Promise<string> {
  const hash = createHash("sha256").update("ditto-evaluation-compiled-v1\0");
  let executableFiles = 0;
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(join(root, compiledDirectory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw Error("Compiled identity cannot silently ignore a symbolic link");
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        const bytes = await readFile(join(root, compiledDirectory, name));
        hash.update(JSON.stringify([name, bytes.length])); hash.update(bytes);
        if ([".js", ".mjs", ".cjs"].includes(extname(name))) executableFiles++;
      }
    }
  }
  await visit("");
  if (!executableFiles) throw Error("Compiled identity requires actual emitted JavaScript");
  return hash.digest("hex");
}

export async function evaluationRuntimeIdentity(root: string, providerEnvironment: Readonly<Record<string, string>>, compiledDirectory = "dist", policy?:typeof FROZEN_ASSET_RUNTIME_POLICY): Promise<EvaluationRuntimeIdentity> {
  const environment = normalizedEnvironment({ nodeVersion: process.version, ...providerEnvironment });
  const [sourceSha256, compiledSha256] = await Promise.all([evaluationCodeHash(root,policy), evaluationCompiledHash(root, compiledDirectory)]);
  return { schemaVersion: 1, sourceSha256, compiledSha256, providerEnvironment: environment,
    providerEnvironmentSha256: identityHash(environment) };
}

export function validateEvaluationRuntimeIdentity(value: unknown): asserts value is EvaluationRuntimeIdentity {
  if (!value || typeof value !== "object") throw Error("Missing frozen execution identity");
  const identity = value as EvaluationRuntimeIdentity;
  if (identity.schemaVersion !== 1 || [identity.sourceSha256, identity.compiledSha256, identity.providerEnvironmentSha256]
    .some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw Error("Invalid frozen execution identity");
  if (identityHash(normalizedEnvironment(identity.providerEnvironment)) !== identity.providerEnvironmentSha256) throw Error("Provider environment identity hash mismatch");
}

/** Call before resume/Test and include this identity in each case-recovery key. */
export function assertEvaluationRuntimeIdentity(expected: unknown, actual: EvaluationRuntimeIdentity): void {
  validateEvaluationRuntimeIdentity(expected); validateEvaluationRuntimeIdentity(actual);
  if (expected.sourceSha256 !== actual.sourceSha256 || expected.compiledSha256 !== actual.compiledSha256
    || expected.providerEnvironmentSha256 !== actual.providerEnvironmentSha256) throw Error("Source, compiled artifact or actual provider environment differs from frozen execution identity");
}

/** Only incomplete evaluations recover; separate successful runs stay independent. */
export class CaseRecovery {
  readonly identity: string;
  readonly priorCases: readonly CaseResult[];
  readonly originalOperations: Readonly<Record<string, unknown>>;
  readonly currentOperations: Readonly<Record<string, unknown>>;
  readonly #path: string;
  readonly #identityFields: unknown;
  readonly #cases = new Map<string, CaseResult>();
  #writes = Promise.resolve();

  private constructor(path: string, identity: string, identityFields: unknown, prior: readonly CaseResult[],
    originalOperations: Readonly<Record<string, unknown>>, currentOperations: Readonly<Record<string, unknown>>) {
    this.#path = path; this.identity = identity; this.priorCases = prior;
    this.#identityFields = identityFields;
    this.originalOperations = originalOperations;
    this.currentOperations = currentOperations;
    for (const result of prior) this.#cases.set(result.caseId, result);
  }

  static async open(root: string, identityFields: unknown, operations: Readonly<Record<string, unknown>> = {}): Promise<CaseRecovery> {
    const identity = createHash("sha256").update(JSON.stringify(identityFields)).digest("hex");
    await mkdir(root, { recursive: true });
    const path = join(root, `${identity}.json`);
    let prior: CaseResult[] = [];
    let originalOperations = operations;
    try {
      const saved = JSON.parse(await readFile(path, "utf8")) as {
        identity: string; complete: boolean; cases: CaseResult[]; originalOperations?: Readonly<Record<string, unknown>>;
      };
      if (saved.identity !== identity || !Array.isArray(saved.cases)) throw new Error("Invalid case recovery identity");
      if (!saved.complete) {
        prior = saved.cases;
        originalOperations = saved.originalOperations ?? operations;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const recovery = new CaseRecovery(path, identity, identityFields, prior, originalOperations, operations);
    await recovery.#save(false);
    return recovery;
  }

  async record(result: CaseResult): Promise<void> {
    this.#cases.set(result.caseId, result);
    await this.#save(false);
  }

  async finish(valid: boolean): Promise<void> { await this.#save(valid); }

  async #save(complete: boolean): Promise<void> {
    const content = JSON.stringify({ schemaVersion: 1, identity: this.identity, identityFields: this.#identityFields,
      originalOperations: this.originalOperations, currentOperations: this.currentOperations,
      complete, cases: [...this.#cases.values()] });
    this.#writes = this.#writes.then(async () => {
      const temporary = `${this.#path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temporary, `${content}\n`, "utf8");
      await renameArtifact(temporary, this.#path);
    });
    await this.#writes;
  }
}

export function displayScore(valid: boolean, score: number): number | null { return valid ? score : null; }
