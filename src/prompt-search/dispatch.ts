import {AsyncLocalStorage} from 'node:async_hooks';
/** Optional public request correlation; no provider or account policy. */
export const dispatchContext=new AsyncLocalStorage<Record<string,unknown>>();
