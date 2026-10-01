import { useEffect, useMemo, useState } from "react";
import type {
  RecordChange,
  ResourceRecord,
  RRType,
  SamplesReviewResponse,
  SOAFields,
  ZoneDiff,
} from "../types";
import type { EditorCtx } from "../App";
import { api } from "../api";
import { fmtTime, rdataToText } from "../dnslib";
import { VerdictView } from "./VerdictView";

export function BottomPanels({
  ctx,
  busy,
  onPublish,
  onDiscard,
  onSelectQuery,
}: {
  ctx: EditorCtx;
  busy: boolean;
  onPublish: (note: string) => void | Promise<void>;
  onDiscard: () => void;
  onSelectQuery: (qname: string, qtype: any) => void;
}) {
  return (
    <div className="bottom">
      <ChangesPanel ctx={ctx} busy={busy} onPublish={onPublish} onDiscard={onDiscard} />
      <SamplesPanel ctx={ctx} onSelectQuery={onSelectQuery} />
      <HistoryPanel ctx={ctx} onSelectQuery={onSelectQuery} />
    </div>
  );
}

// ---------------- 待发布变更 ----------------

function computeDiffClient(ctx: EditorCtx): ZoneDiff {
  const pub = ctx.published?.zone ?? null;
  const draft = ctx.draft;

  const group = (zone: typeof draft) => {
    const m = new Map<string, ResourceRecord[]>();
    for (const r of zone.records) {
      const k = `${r.name}|${r.type}`;
      const l = m.get(k) ?? [];
      l.push(r);
      m.set(k, l);
    }
    return m;
  };
  const sig = (r: { type: any; rdata: any }) => rdataToText(r.type, r.rdata);
  const rdataText = (t: any, r: any) => rdataToText(t, r);

  const pubMap = pub ? group(pub) : new Map();
  const draftMap = group(draft);
  const records: RecordChange[] = [];
  let added = 0, deleted = 0, modified = 0;

  const keys = new Set([...pubMap.keys(), ...draftMap.keys()]);
  for (const key of [...keys].sort()) {
    const parts = key.split("|");
    const type = parts[1] as RRType;
    const name = parts[0];
    const before: ResourceRecord[] = pubMap.get(key) ?? [];
    const after: ResourceRecord[] = draftMap.get(key) ?? [];
    const bSigs = new Map<string, ResourceRecord>(before.map((r) => [sig(r), r]));
    const aSigs = new Map<string, ResourceRecord>(after.map((r) => [sig(r), r]));

    if (bSigs.size === 1 && aSigs.size === 1) {
      const b = before[0];
      const a = after[0];
      if (sig(b) !== sig(a)) {
        records.push({
          kind: b.ttl !== a.ttl && rdataText(a.type, a.rdata) === rdataText(b.type, b.rdata) ? "ttl" : "rdata",
          name,
          type,
          before: `${b.ttl} ${rdataText(b.type, b.rdata)}`,
          after: `${a.ttl} ${rdataText(a.type, a.rdata)}`,
          editIds: a.editId ? [a.editId] : undefined,
          draftRecordId: a.id,
        });
        modified++;
        continue;
      }
    }
    for (const [, r] of aSigs) {
      if (!bSigs.has(sig(r))) {
        records.push({
          kind: "added",
          name,
          type,
          after: `${r.ttl} ${rdataText(r.type, r.rdata)}`,
          editIds: r.editId ? [r.editId] : undefined,
          draftRecordId: r.id,
        });
        added++;
      }
    }
    for (const [, r] of bSigs) {
      if (!aSigs.has(sig(r))) {
        records.push({
          kind: "deleted",
          name,
          type,
          before: `${r.ttl} ${rdataText(r.type, r.rdata)}`,
        });
        deleted++;
      }
    }
  }

  const soa: ZoneDiff["soa"] = [];
  if (pub) {
    const fields: (keyof SOAFields)[] = ["mname", "rname", "refresh", "retry", "expire", "minimum", "ttl"];
    for (const f of fields) {
      if (pub.soa[f] !== draft.soa[f]) {
        soa.push({ field: f, before: pub.soa[f], after: draft.soa[f] });
      }
    }
  }

  return {
    originChanged:
      pub && pub.origin !== draft.origin ? { from: pub.origin, to: draft.origin } : undefined,
    soa,
    records,
    counts: { added, deleted, modified },
  };
}

function ChangesPanel({
  ctx,
  busy,
  onPublish,
  onDiscard,
}: {
  ctx: EditorCtx;
  busy: boolean;
  onPublish: (note: string) => void;
  onDiscard: () => void;
}) {
  const diff = useMemo(() => computeDiffClient(ctx), [ctx]);
  const errors = ctx.findings.filter((f) => f.severity === "error");
  const warnings = ctx.findings.filter((f) => f.severity === "warning");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);

  const editById = useMemo(() => {
    const m = new Map<string, (typeof ctx.editLog)[number]>();
    for (const e of ctx.editLog) m.set(e.id, e);
    return m;
  }, [ctx.editLog]);

  return (
    <div className="panel">
      <header>
        <h2>待发布变更</h2>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 11 }}>
          {diff.counts.added} 增 / {diff.counts.deleted} 删 / {diff.counts.modified} 改
        </span>
      </header>
      <div className="body" style={{ maxHeight: 380, overflow: "auto" }}>
        {errors.length > 0 && (
          <div className="row-gap">
            <strong style={{ color: "var(--red)", fontSize: 12 }}>
              以下错误阻断发布：
            </strong>
            {errors.map((f, i) => {
              const edit = f.editIds?.[0] ? editById.get(f.editIds[0]) : undefined;
              return (
                <div key={i} className="finding error">
                  <span className="code">{f.code}</span>
                  <span>
                    {f.message}
                    {edit && (
                      <div style={{ fontSize: 11, marginTop: 2 }}>
                        导致发布失败的草稿改动：
                        <b style={{ color: "var(--accent)" }}> {edit.summary}</b>
                        （编辑窗口 {edit.editorId.slice(0, 10)}，{fmtTime(edit.at)}）
                      </div>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {warnings.length > 0 && errors.length === 0 && (
          <details className="row-gap">
            <summary style={{ fontSize: 12, color: "var(--amber)", cursor: "pointer" }}>
              {warnings.length} 个警告（不阻断发布）
            </summary>
            <div style={{ marginTop: 6 }}>
              {warnings.map((f, i) => (
                <div key={i} className="finding warning">
                  <span className="code">{f.code}</span>
                  <span>{f.message}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        {diff.originChanged && (
          <div className="diff-line rdata">
            <span className="kind">起点</span>
            <span className="from">{diff.originChanged.from}.</span>
            <span>→</span>
            <span className="to">{diff.originChanged.to}.</span>
          </div>
        )}
        {diff.soa.map((c) => (
          <div key={c.field} className="diff-line ttl">
            <span className="kind">SOA {c.field}</span>
            <span className="from muted">{String(c.before)}</span>
            <span>→</span>
            <span className="to">{String(c.after)}</span>
          </div>
        ))}

        {diff.records.length === 0 && diff.soa.length === 0 && !diff.originChanged && (
          <div className="empty">草稿与已发布版本一致，没有待发布内容。</div>
        )}

        {diff.records.map((c, i) => (
          <div key={i} className={`diff-line ${c.kind}`}>
            <span className="kind">
              {c.kind === "added" ? "+" : c.kind === "deleted" ? "−" : "改"}
            </span>
            <div>
              <div>
                {c.name}. <span className="pill-type">{c.type}</span>
              </div>
              {c.before && <div className="from muted">旧 {c.before}</div>}
              {c.after && <div className="to">新 {c.after}</div>}
              {c.editIds?.[0] && editById.get(c.editIds[0]) && (
                <div className="muted" style={{ fontSize: 10.5 }}>
                  来自：{editById.get(c.editIds[0])!.summary}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", display: "flex", gap: 8 }}>
        <input
          style={{ flex: 1 }}
          placeholder="发布说明（可选）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {confirm ? (
          <>
            <button
              className="primary"
              disabled={busy || errors.length > 0}
              onClick={async () => {
                await onPublish(note);
                setNote("");
                setConfirm(false);
              }}
            >
              确认发布
            </button>
            <button onClick={() => setConfirm(false)}>取消</button>
          </>
        ) : (
          <>
            <button
              className="primary"
              disabled={busy || errors.length > 0 || (diff.records.length === 0 && diff.soa.length === 0 && !diff.originChanged)}
              onClick={() => setConfirm(true)}
              title={errors.length ? "存在阻断错误" : "把整份草稿原子地发布为新版本"}
            >
              发布新版本
            </button>
            <button className="danger" disabled={busy || ctx.editLog.length === 0} onClick={onDiscard}>
              丢弃草稿
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- 查询样例 ----------------

function SamplesPanel({
  ctx,
  onSelectQuery,
}: {
  ctx: EditorCtx;
  onSelectQuery: (qname: string, qtype: any) => void;
}) {
  const [review, setReview] = useState<SamplesReviewResponse | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = async () => {
    try {
      setReview(await api.review());
    } catch {
      /* ignore */
    }
  };

  // 每次修订号变化重算批量对照
  useEffect(() => {
    let cancelled = false;
    api
      .review()
      .then((r) => {
        if (!cancelled) setReview(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ctx.revision, ctx.samples.length]);

  const items = review?.items ?? [];
  const changedCount = items.filter((i) => i.changed).length;

  return (
    <div className="panel">
      <header>
        <h2>查询样例对照</h2>
        <div className="spacer" />
        <button className="small" onClick={load}>
          重新对照
        </button>
      </header>
      <div className="body" style={{ maxHeight: 420, overflow: "auto" }}>
        {items.length === 0 && <div className="empty">还没有查询样例。在查询预览中点“存为样例”。</div>}
        {changedCount > 0 && (
          <div className="finding warning" style={{ marginBottom: 8 }}>
            {changedCount} 个样例的草稿应答与已发布版本不同。
          </div>
        )}
        {items.map((it) => (
          <div
            key={it.sample.id}
            className={`sample-row ${it.changed ? "changed" : "same"}`}
            onClick={() => {
              onSelectQuery(it.sample.qname, it.sample.qtype);
              setOpenId(openId === it.sample.id ? null : it.sample.id);
            }}
          >
            <div className="q">
              {it.sample.label !== it.sample.qname && (
                <span className="muted">{it.sample.label}：</span>
              )}
              {it.sample.qname}. <span className="pill-type">{it.sample.qtype}</span>
            </div>
            <div className="status">
              正式 [{kindShort(it.published.kind)}] → 草稿 [{kindShort(it.draft.kind)}]
              {it.changes.map((c, i) => (
                <div key={i} style={{ color: "var(--amber)" }}>· {c}</div>
              ))}
            </div>
            {openId === it.sample.id && (
              <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 8 }}>
                <div className="dual" style={{ gridTemplateColumns: "1fr" }}>
                  <div>
                    <h3>正式版本结果</h3>
                    <VerdictView r={it.published} compact />
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <h3>草稿结果</h3>
                    <VerdictView r={it.draft} compact />
                  </div>
                </div>
                <div style={{ textAlign: "right", marginTop: 6 }}>
                  <button
                    className="small danger"
                    onClick={async () => {
                      await api.deleteSample(it.sample.id).catch(() => {});
                      await load();
                    }}
                  >
                    删除样例
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function kindShort(k: string): string {
  switch (k) {
    case "positive":
      return "肯定";
    case "nxdomain":
      return "NXDOMAIN";
    case "nodata":
      return "NODATA";
    case "referral":
      return "转介";
    case "cname-target-external":
      return "CNAME出区";
    case "cname-loop":
      return "CNAME环";
    case "refused":
      return "REFUSED";
    case "invalid":
      return "草稿错误";
    default:
      return k;
  }
}

// ---------------- 历史 ----------------

function HistoryPanel({
  ctx,
  onSelectQuery,
}: {
  ctx: EditorCtx;
  onSelectQuery: (qname: string, qtype: any) => void;
}) {
  const [openVersion, setOpenVersion] = useState<string | null>(null);
  const [versionZone, setVersionZone] = useState<any>(null);

  const open = async (id: string) => {
    if (openVersion === id) {
      setOpenVersion(null);
      setVersionZone(null);
      return;
    }
    setOpenVersion(id);
    try {
      setVersionZone(await api.version(id));
    } catch {
      setVersionZone(null);
    }
  };

  void onSelectQuery;

  return (
    <div className="panel">
      <header>
        <h2>版本历史</h2>
      </header>
      <div className="body" style={{ maxHeight: 420, overflow: "auto" }}>
        {ctx.history
          .slice()
          .reverse()
          .map((h) => (
            <div key={h.id}>
              <div className="hist-row" onClick={() => open(h.id)}>
                <div className="flex">
                  <span className="v">{h.id}</span>
                  <span className="mono muted">serial {h.serial}</span>
                  <span style={{ flex: 1 }} />
                  <span className="when">{fmtTime(h.publishedAt)}</span>
                </div>
                <div className="muted" style={{ marginTop: 2 }}>
                  {h.note}
                </div>
                {h.changesSummary.length > 0 && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                    {h.changesSummary.slice(0, 3).join("；")}
                    {h.changesSummary.length > 3 ? ` 等 ${h.changesSummary.length} 项` : ""}
                  </div>
                )}
              </div>
              {openVersion === h.id && versionZone && (
                <div style={{ padding: "6px 10px", background: "#10161d", borderBottom: "1px solid var(--border)" }}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                    该版本是一份不可变快照；在查询预览右上角选择
                    <b className="mono"> {h.id}</b> 即可用当时的区域回答查询，
                    当前记录不会倒灌进历史结果。
                  </div>
                  <div className="mono" style={{ fontSize: 11, maxHeight: 180, overflow: "auto" }}>
                    {(versionZone.records as any[]).map((r, i) => (
                      <div key={i} style={{ padding: "2px 0", color: "var(--muted)" }}>
                        {r.name}. {r.ttl} {r.type} {JSON.stringify(r.rdata)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
