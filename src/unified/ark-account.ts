import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const inFlight = new Map<string, Promise<Record<string, unknown>>>();
class AccountQueryError extends Error {
  constructor(readonly status: number, readonly serviceCode: unknown, message: string) { super(message); }
}

/** Read-only control-plane queries. Keys and signed headers never leave this function's request. */
export async function accountQuery(action: 'GetPersonalPlan' | 'GetAFPUsage', accountSuffix = ''): Promise<Record<string, unknown>> {
  if (accountSuffix && !/^[A-Z][A-Z0-9_]{0,31}$/.test(accountSuffix)) throw Error('Unknown configured account alias');
  const key = `${accountSuffix}:${action}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const query = (async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await queryOnce(action, accountSuffix); }
      catch (error) {
        if (!(error instanceof AccountQueryError) || attempt >= 2 ||
          !(error.status === 429 || error.serviceCode === 'AccountFlowLimitExceeded')) throw error;
        await delay(1000 * (attempt + 1));
      }
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, query);
  return query;
}

async function queryOnce(action: 'GetPersonalPlan' | 'GetAFPUsage', accountSuffix: string): Promise<Record<string, unknown>> {
  const suffix = accountSuffix ? `_${accountSuffix}` : '';
  const ak = process.env[`ARK_AUDIT_ACCESS_KEY_ID${suffix}`];
  const sk = process.env[`ARK_AUDIT_SECRET_ACCESS_KEY${suffix}`];
  if (!ak || !sk) throw Error('Agent Plan control-plane credentials unavailable');
  const body = JSON.stringify(action === 'GetPersonalPlan' ? { Plan: 'AgentPlan' } : {});
  const host = 'ark.cn-beijing.volcengineapi.com';
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const shortDate = date.slice(0, 8);
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
  const query = `Action=${action}&Version=2024-01-01`;
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const contentHash = sha(body);
  const canonical = ['POST', '/', query, `content-type:application/json\nhost:${host}\nx-content-sha256:${contentHash}\nx-date:${date}\n`, signedHeaders, contentHash].join('\n');
  const scope = `${shortDate}/cn-beijing/ark/request`;
  const signature = createHmac('sha256', hmac(hmac(hmac(hmac(sk, shortDate), 'cn-beijing'), 'ark'), 'request'))
    .update(`HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`).digest('hex');
  const response = await fetch(`https://${host}/?${query}`, { method: 'POST', body,
    signal: AbortSignal.timeout(30000), redirect: 'error', headers: { 'Content-Type': 'application/json',
      'X-Date': date, 'X-Content-Sha256': contentHash,
      Authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok || (payload.ResponseMetadata as { Error?: unknown } | undefined)?.Error) {
    const error = (payload.ResponseMetadata as { Error?: { Code?: unknown } } | undefined)?.Error;
    throw new AccountQueryError(response.status, error?.Code,
      `Agent Plan ${action} failed: ${JSON.stringify(error ?? { status: response.status })}`);
  }
  return payload.Result as Record<string, unknown>;
}
