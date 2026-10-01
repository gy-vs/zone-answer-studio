// 服务端 API 客户端。所有冲突以 HTTP 409 返回，错误体带完整新状态，
// 前端据此合并，避免旧窗口静默覆盖。
import type {
  ApiError,
  DiscardResponse,
  EditOperation,
  EditorIdentity,
  MutateResponse,
  PublishResponse,
  QueryRequest,
  QueryResult,
  QuerySample,
  SamplesReviewResponse,
  StateResponse,
  ZoneVersion,
} from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json();
  if (!res.ok) throw body as ApiError;
  return body as T;
}

export const api = {
  state: () => req<StateResponse>("/api/state"),
  query: (q: QueryRequest) =>
    req<QueryResult>("/api/query", { method: "POST", body: JSON.stringify(q) }),
  mutate: (
    editor: EditorIdentity,
    baseRevision: number,
    operations: EditOperation[],
  ) =>
    req<MutateResponse>("/api/mutate", {
      method: "POST",
      body: JSON.stringify({ editor, baseRevision, operations }),
    }),
  publish: (editor: EditorIdentity, baseRevision: number, note: string) =>
    req<PublishResponse>("/api/publish", {
      method: "POST",
      body: JSON.stringify({ editor, baseRevision, note }),
    }),
  discard: (baseRevision: number) =>
    req<DiscardResponse>("/api/discard", {
      method: "POST",
      body: JSON.stringify({ baseRevision }),
    }),
  samples: () =>
    req<{ revision: number; samples: QuerySample[] }>("/api/samples"),
  addSample: (
    qname: string,
    qtype: QueryRequest["qtype"],
    label: string,
  ) =>
    req<{ revision: number; samples: QuerySample[] }>("/api/samples", {
      method: "POST",
      body: JSON.stringify({ qname, qtype, label }),
    }),
  deleteSample: (id: string) =>
    req<{ revision: number; samples: QuerySample[] }>(
      `/api/samples/${id}`,
      { method: "DELETE" },
    ),
  review: () => req<SamplesReviewResponse>("/api/samples/review"),
  history: () =>
    req<{
      revision: number;
      history: StateResponse["history"];
    }>("/api/history"),
  version: (id: string) => req<ZoneVersion>(`/api/history/${id}`),
};
