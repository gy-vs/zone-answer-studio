import type {
  BootState, DraftUpdateResponse, PublishResponse, QueryResultResponse,
  QueryRequest, RR, RRType, ValidationResult, SampleEffectEntry, PublishedVersion,
  QuerySample,
} from '@shared/types.js';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let body: { error?: string; code?: string; currentRevision?: number } = {};
    try { body = await res.json(); } catch { /* ignore */ }
    const err = new Error(body.error || `请求失败 ${res.status}`) as Error & {
      status: number; code?: string; currentRevision?: number; body?: unknown;
    };
    err.status = res.status;
    err.code = body.code;
    err.currentRevision = body.currentRevision;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  boot: () => jsonFetch<BootState>('/api/boot'),

  saveOps: (ops: unknown[], baseRevision: number, client: string) =>
    jsonFetch<DraftUpdateResponse>('/api/draft/ops', {
      method: 'POST',
      body: JSON.stringify({ ops, baseRevision, client }),
    }),

  resetDraft: (client: string) =>
    jsonFetch<{ draft: BootState['draft']; validation: ValidationResult }>('/api/draft/reset', {
      method: 'POST',
      body: JSON.stringify({ client }),
    }),

  publish: (client: string, note?: string) =>
    jsonFetch<PublishResponse>('/api/publish', {
      method: 'POST',
      body: JSON.stringify({ client, note }),
    }),

  query: (req: QueryRequest) =>
    jsonFetch<QueryResultResponse>('/api/query', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  effects: () =>
    jsonFetch<{ entries: SampleEffectEntry[] }>('/api/effects'),

  versions: () =>
    jsonFetch<PublishedVersion[]>('/api/versions'),

  addSample: (name: string, qtype: RRType | 'ANY', label?: string) =>
    jsonFetch<QuerySample>('/api/samples', {
      method: 'POST',
      body: JSON.stringify({ name, qtype, label }),
    }),

  deleteSample: (id: string) =>
    jsonFetch<void>(`/api/samples/${id}`, { method: 'DELETE' }),
};

export type { RR };
