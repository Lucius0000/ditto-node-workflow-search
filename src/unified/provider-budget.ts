import type { ProviderInvocationEvent } from '../ditto/runtime.js';
import type { SampleInput } from '@codesoul-co/ditto/worker/infer';

export interface ProviderBudgetSnapshot {
  providerCalls: number;
  httpAttempts: number;
  failedAttempts: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  unknownUsageAttempts: number;
  inFlight: number;
}
export class ProviderBudgetExceeded extends Error {
  readonly code = 'SEARCH_BUDGET_EXHAUSTED';
  constructor(readonly budget: ProviderBudgetSnapshot) { super('SEARCH_BUDGET_EXHAUSTED: no new provider requests admitted; in-flight calls retain their usage'); }
}
export interface ProviderBudgetOptions {
  maxCalls: number;
  maxTokens: number;
  restored?: Partial<ProviderBudgetSnapshot>;
  onEvent?: (event: { phase: 'admitted' | 'settled'; usage: ProviderBudgetSnapshot; role?: string }) => void | Promise<void>;
}

/** Counts optimizer, native internal inference and format repairs through one gate. */
export function createProviderBudget(options: ProviderBudgetOptions) {
  for (const [name, value] of Object.entries({ maxCalls: options.maxCalls, maxTokens: options.maxTokens })) {
    if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid provider budget ${name}`);
  }
  const usage: ProviderBudgetSnapshot = { providerCalls: 0, httpAttempts: 0, failedAttempts: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownUsageAttempts: 0, inFlight: 0, ...options.restored };
  for (const [name, value] of Object.entries(usage)) if (!Number.isSafeInteger(value) || value < 0) throw Error(`Invalid restored usage ${name}`);
  // A process restart cannot know the final charges of abandoned in-flight calls.
  usage.httpAttempts += usage.inFlight;
  usage.unknownUsageAttempts += usage.inFlight;
  usage.inFlight = 0;
  const snapshot = (): ProviderBudgetSnapshot => ({ ...usage });
  const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const roleOf = (input: SampleInput): string | undefined => typeof input.metadata?.role === 'string' ? input.metadata.role : undefined;
  return {
    snapshot,
    async beforeProviderCall(input: SampleInput) {
      if (Math.max(usage.providerCalls, usage.httpAttempts + usage.inFlight) >= options.maxCalls || usage.totalTokens >= options.maxTokens) {
        throw new ProviderBudgetExceeded(snapshot());
      }
      usage.providerCalls++;
      usage.inFlight++;
      const role = roleOf(input);
      try { await options.onEvent?.({ phase: 'admitted', usage: snapshot(), ...(role ? { role } : {}) }); }
      catch (error) { usage.providerCalls--; usage.inFlight--; throw error; }
    },
    async afterProviderCall(event: ProviderInvocationEvent) {
      usage.inFlight = Math.max(0, usage.inFlight - 1);
      const attempts = event.diagnostics.reduce((sum, row) => sum + count(row.attempts), 0);
      usage.httpAttempts += Math.max(1, attempts);
      if (event.diagnostics.length) {
        for (const record of event.diagnostics) {
          usage.failedAttempts += count(record.failedAttempts);
          usage.inputTokens += count(record.inputTokens);
          usage.outputTokens += count(record.outputTokens);
          usage.totalTokens += count(record.totalTokens);
          usage.unknownUsageAttempts += Math.max(count(record.unknownUsageAttempts), record.usageKnown ? 0 : 1);
        }
      } else {
        const tokens = event.output?.usage;
        usage.failedAttempts += event.error !== undefined ? 1 : 0;
        usage.inputTokens += count(tokens?.inputTokens);
        usage.outputTokens += count(tokens?.outputTokens);
        usage.totalTokens += count(tokens?.totalTokens ?? ((tokens?.inputTokens ?? 0) + (tokens?.outputTokens ?? 0)));
        if (!tokens) usage.unknownUsageAttempts++;
      }
      const role = roleOf(event.input);
      await options.onEvent?.({ phase: 'settled', usage: snapshot(), ...(role ? { role } : {}) });
    },
  };
}
