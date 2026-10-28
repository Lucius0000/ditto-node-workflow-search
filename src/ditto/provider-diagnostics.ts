import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderCallDiagnostics } from "../domain.js";

const diagnostics = new AsyncLocalStorage<ProviderCallDiagnostics[]>();

/** Nested capture isolates simultaneous provider calls and complete workflow runs. */
export function captureProviderDiagnostics<T>(operation: (records: ProviderCallDiagnostics[]) => Promise<T>): Promise<T> {
  const records: ProviderCallDiagnostics[] = [];
  return diagnostics.run(records, () => operation(records));
}

/** Resume an async iterator under the same per-call ledger on every next(). */
export function withProviderDiagnostics<T>(records: ProviderCallDiagnostics[], operation: () => Promise<T>): Promise<T> {
  return diagnostics.run(records, operation);
}

/** Capture the array before crossing the child-process event callback boundary. */
export function currentProviderDiagnostics(): ProviderCallDiagnostics[] | undefined {
  return diagnostics.getStore();
}

export function summarizeProviderDiagnostics(records: readonly ProviderCallDiagnostics[]) {
  return {
    usageKnown: records.length > 0 && records.every((record) => record.usageKnown),
    providerAttempts: records.reduce((sum, record) => sum + record.attempts, 0),
    failedProviderAttempts: records.reduce((sum, record) => sum + record.failedAttempts, 0),
    unknownUsageAttempts: records.reduce((sum, record) => sum + record.unknownUsageAttempts, 0),
    inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
    outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
    totalTokens: records.reduce((sum, record) => sum + record.totalTokens, 0),
    providerDiagnostics: Object.freeze([...records]),
  };
}
