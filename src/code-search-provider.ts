import type { ProviderSettings } from './config.js';

export type CodeSearchSource = 'official' | 'ark-plan';

/** Explicit local source selection; delivery defaults stay on the official API. */
export function codeSearchProvider(source: CodeSearchSource, env: NodeJS.ProcessEnv = process.env): ProviderSettings {
  if (!['official', 'ark-plan'].includes(source)) throw Error('Unknown code-search provider source');
  const keyName = source === 'official' ? 'DS_API_KEY' : 'ARK_PLAN_KEY_LIU';
  const apiKey = env[keyName];
  if (!apiKey?.trim()) throw Error(`${keyName} is required`);
  const concurrency = Number(env.CODE_SOUL_CONCURRENCY ?? '3');
  const timeoutMs = Number(env.CODE_SOUL_TIMEOUT_MS ?? '600000');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw Error('Invalid shared concurrency');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) throw Error('Invalid request deadline');
  return Object.freeze({ apiKey, concurrency, timeoutMs,
    baseUrl: source === 'official' ? 'https://api.deepseek.com' : 'https://ark.cn-beijing.volces.com/api/plan/v3',
    model: source === 'official' ? 'deepseek-flash' : 'deepseek-v4.1-flash' });
}
