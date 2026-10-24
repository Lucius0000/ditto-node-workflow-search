import { randomUUID } from "node:crypto";
import type {
  MemoryDraft,
  MemoryItem,
  MemoryResources,
  MemorySearchInput,
  MemorySearchProvider,
  MemorySearchResult,
  MemoryStore,
} from "@codesoul-co/ditto";

/** A fresh in-memory resource scope. Create one for each workflow attempt. */
export function createTaskMemory(): MemoryResources {
  const records = new Map<string, MemoryItem>();
  const search: MemorySearchProvider = {
    async search(input) { return searchRecords(records, input); },
  };
  const store: MemoryStore & MemorySearchProvider = {
    async write(input) {
      return input.memories.map((draft: MemoryDraft) => {
        const id = randomUUID();
        const record: MemoryItem = {
          id,
          ...(draft.key === undefined ? {} : { key: draft.key }),
          content: structuredClone(draft.content),
          ...(draft.metadata === undefined ? {} : { metadata: structuredClone(draft.metadata) }),
        };
        records.set(id, record);
        return structuredClone(record);
      });
    },
    async get(input) {
      const ids = new Set(input.ids ?? []);
      const keys = new Set(input.keys ?? []);
      return [...records.values()]
        .filter((item) => ids.has(item.id) || (item.key !== undefined && keys.has(item.key)))
        .map((item) => structuredClone(item));
    },
    async query(input) {
      const limit = boundedLimit(input.limit, 100);
      const offset = decodeCursor(input.cursor);
      const items = [...records.values()].filter((item) => matchesFilter(item, input.filter));
      const page = items.slice(offset, offset + limit).map((item) => structuredClone(item));
      const nextOffset = offset + page.length;
      return {
        items: page,
        ...(nextOffset < items.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
      };
    },
    async update(input) {
      return input.memories.map((change) => {
        const current = records.get(change.id);
        if (!current) throw new Error(`Memory item not found: ${change.id}`);
        const updated: MemoryItem = {
          ...current,
          ...(change.content === undefined ? {} : { content: structuredClone(change.content) }),
          ...(change.metadata === undefined ? {} : { metadata: structuredClone(change.metadata) }),
        };
        records.set(updated.id, updated);
        return structuredClone(updated);
      });
    },
    async delete(input) {
      const deleted: string[] = [];
      for (const id of input.ids) {
        if (records.delete(id)) deleted.push(id);
      }
      return { deleted };
    },
    search: search.search,
  };

  return { store, search };
}

function searchRecords(
  records: ReadonlyMap<string, MemoryItem>,
  input: MemorySearchInput,
): readonly MemorySearchResult[] {
  const query = lexicalText(input.query);
  const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (!terms.length) return [];
  const limit = boundedLimit(input.limit, 10);
  const ranked = [...records.values()]
    .filter((item) => matchesFilter(item, input.filter))
    .map((memory) => {
      const haystack = lexicalText(memory.content).toLocaleLowerCase();
      const matched = terms.filter((term) => haystack.includes(term)).length;
      return { memory, score: matched / terms.length };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  return ranked.map(({ memory, score }) => ({ memory: structuredClone(memory), score }));
}

function lexicalText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value ?? "");
  return JSON.stringify(value);
}

function matchesFilter(item: MemoryItem, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  for (const [key, expected] of Object.entries(filter)) {
    const actual = key === "id" || key === "key" || key === "content"
      ? item[key as keyof MemoryItem]
      : item.metadata?.[key];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  return true;
}

function boundedLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
    throw new RangeError("Memory limit must be an integer from 0 to 1000");
  }
  return limit;
}

function encodeCursor(offset: number): string {
  return `task-memory:${offset}`;
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^task-memory:(\d+)$/.exec(cursor);
  if (!match) throw new TypeError("Invalid task memory cursor");
  return Number(match[1]);
}
