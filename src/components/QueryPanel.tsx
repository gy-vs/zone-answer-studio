import { useEffect, useMemo, useState } from "react";
import type {
  ApiError,
  QueryResult,
  QueryType,
  StateResponse,
  ZoneVersion,
} from "../types";
import type { EditorCtx } from "../App";
import { api } from "../api";
import { normalizeName } from "../dnslib";
import { VerdictView } from "./VerdictView";

const Q_TYPES: QueryType[] = ["A", "AAAA", "CNAME", "NS", "MX", "TXT", "SRV", "PTR", "CAA", "SOA", "ANY"];

export function QueryPanel({
  ctx,
  query,
  setQuery,
  onAddSample,
}: {
  ctx: EditorCtx;
  query: { qname: string; qtype: QueryType };
  setQuery: (q: { qname: string; qtype: QueryType }) => void;
  onAddSample: (s: { revision: number; samples: StateResponse["samples"] }) => void;
}) {
  const [draftResult, setDraftResult] = useState<QueryResult | null>(null);
  const [publishedResult, setPublishedResult] = useState<QueryResult | null>(null);
  const [historyTarget, setHistoryTarget] = useState<string>("published");
  const [historyResult, setHistoryResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const qnameAbsolute = useMemo(() => {
    const n = normalizeName(query.qname);
    if (!n) return "";
    if (n.endsWith("." + ctx.draft.origin) || n === ctx.draft.origin) return n;
    return `${n}.${ctx.draft.origin}`;
  }, [query.qname, ctx.draft.origin]);

  const run = async () => {
    if (!qnameAbsolute) {
      setError("请输入查询名（可填相对名）");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const [d, p] = await Promise.all([
        api.query({ qname: qnameAbsolute, qtype: query.qtype, target: "draft" }),
        ctx.published
          ? api.query({ qname: qnameAbsolute, qtype: query.qtype, target: "published" })
          : Promise.resolve(null),
      ]);
      setDraftResult(d);
      setPublishedResult(p);
      if (historyTarget !== "published") {
        const h = await api.query({
          qname: qnameAbsolute,
          qtype: query.qtype,
          target: historyTarget,
        });
        setHistoryResult(h);
      } else if (p) {
        setHistoryResult(p);
      }
    } catch (e) {
      setError((e as ApiError).error ?? "查询失败");
    } finally {
      setLoading(false);
    }
  };

  // 修订号变化或查询输入变化时自动重新查询（防抖）
  useEffect(() => {
    const t = setTimeout(run, 180);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qnameAbsolute, query.qtype, ctx.revision, historyTarget, ctx.published?.id]);

  const addSample = async () => {
    try {
      const s = await api.addSample(qnameAbsolute, query.qtype, query.qname || qnameAbsolute);
      onAddSample(s);
    } catch (e) {
      setError((e as ApiError).error ?? "添加样例失败");
    }
  };

  return (
    <div className="panel">
      <header>
        <h2>查询预览</h2>
        <div className="spacer" />
        <button className="small" onClick={addSample} title="把当前查询保存为回归样例">
          + 存为样例
        </button>
      </header>
      <div className="body scroll">
        <div className="query-bar">
          <input
            className="mono"
            name="qname"
            value={query.qname}
            placeholder="查询名，如 www 或 app.example.net."
            onChange={(e) => setQuery({ ...query, qname: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
          <select
            value={query.qtype}
            onChange={(e) => setQuery({ ...query, qtype: e.target.value as QueryType })}
          >
            {Q_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <button className="primary" onClick={run} disabled={loading}>
            查询
          </button>
        </div>
        <div className="muted mono" style={{ fontSize: 11, marginBottom: 10 }}>
          → {qnameAbsolute || "（空）"} {query.qtype}
        </div>
        {error && <div className="finding error">{error}</div>}

        <div className="dual">
          <div>
            <h3>
              <span className="dot blue" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
              当前草稿 <span className="muted mono">r{ctx.revision}</span>
            </h3>
            {draftResult ? (
              <VerdictView r={draftResult} compact />
            ) : (
              <div className="empty">—</div>
            )}
          </div>
          <div>
            <h3>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--green)", display: "inline-block" }} />
              版本对照
              <select
                style={{ marginLeft: "auto", fontSize: 11, padding: "2px 4px" }}
                value={historyTarget}
                onChange={(e) => setHistoryTarget(e.target.value)}
              >
                <option value="published">
                  {ctx.published ? `已发布 ${ctx.published.id}` : "尚无已发布版本"}
                </option>
                {ctx.history
                  .slice()
                  .reverse()
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.id}（serial {h.serial}）
                    </option>
                  ))}
              </select>
            </h3>
            {historyTarget === "published"
              ? publishedResult
                ? <VerdictView r={publishedResult} compact />
                : <div className="empty">尚无已发布版本</div>
              : historyResult
                ? <VerdictView r={historyResult} compact />
                : <div className="empty">—</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
