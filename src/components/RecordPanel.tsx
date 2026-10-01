import { useMemo, useState } from "react";
import type { EditOperation, RData, RRType, ValidationFinding, Zone } from "../types";
import type { EditorCtx } from "../App";
import {
  RR_TYPE_OPTIONS,
  nameSyntaxOk,
  normalizeName,
  parseRdata,
  placeholderFor,
  rdataToText,
  uid,
} from "../dnslib";

export function RecordPanel({
  ctx,
  selectedName,
  onSelectName,
  mutate,
  busy,
}: {
  ctx: EditorCtx;
  selectedName: string;
  onSelectName: (n: string) => void;
  mutate: (ops: EditOperation[]) => Promise<boolean>;
  busy: boolean;
}) {
  const records = ctx.draft.records
    .filter((r) => r.name === selectedName)
    .sort((a, b) => (a.type < b.type ? -1 : 1));
  const isApex = selectedName === ctx.draft.origin;
  const isCut = records.some((r) => r.type === "NS") && !isApex;
  const isWild = selectedName.startsWith("*.");

  const groups = useMemo(() => {
    const m = new Map<string, typeof records>();
    for (const r of records) {
      const list = m.get(r.type) ?? [];
      list.push(r);
      m.set(r.type, list);
    }
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [records]);

  const relevantFindings = ctx.findings.filter(
    (f) =>
      f.name === selectedName ||
      f.recordIds?.some((id) => records.some((r) => r.id === id)),
  );

  return (
    <div className="panel">
      <header>
        <h2>记录集</h2>
        <div className="spacer" />
        <span className="mono muted" style={{ fontSize: 12 }}>
          {selectedName}.
        </span>
      </header>
      <div className="body scroll">
        {isApex && <ApexBlock zone={ctx.draft} mutate={mutate} busy={busy} />}

        <div className="flex row-gap" style={{ marginTop: isApex ? 12 : 0 }}>
          {isCut && <span className="tag deleg">委派切点</span>}
          {isWild && <span className="tag wild">通配节点</span>}
          {isApex && <span className="tag apex">区域起点</span>}
          {isCut && (
            <span className="muted" style={{ fontSize: 11.5 }}>
              此名字之下的查询将以该 NS 集合作答（转介），父区其他记录不再生效。
            </span>
          )}
        </div>

        {relevantFindings.length > 0 && (
          <div className="row-gap">
            {relevantFindings.map((f, i) => (
              <FindingLine key={i} f={f} ctx={ctx} onSelectName={onSelectName} />
            ))}
          </div>
        )}

        {groups.length === 0 && !isApex && (
          <div className="empty">该名字下没有记录（是空非终结点或尚未添加）。</div>
        )}

        {groups.map(([type, list]) => (
          <RRsetView
            key={type}
            type={type as RRType}
            owner={selectedName}
            records={list}
            mutate={mutate}
            busy={busy}
          />
        ))}

        <AddRecordForm
          key={selectedName}
          defaultName={selectedName === ctx.draft.origin ? "" : relName(selectedName, ctx.draft.origin)}
          origin={ctx.draft.origin}
          mutate={mutate}
          busy={busy}
          onCreated={(fullName) => onSelectName(fullName)}
        />
      </div>
    </div>
  );
}

function relName(name: string, origin: string): string {
  if (name === origin) return "";
  return name.endsWith("." + origin) ? name.slice(0, -(origin.length + 1)) : name;
}

function ApexBlock({
  zone,
  mutate,
  busy,
}: {
  zone: Zone;
  mutate: (ops: EditOperation[]) => Promise<boolean>;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState(zone.soa);

  const s = zone.soa;
  if (!editing) {
    return (
      <div className="rrset">
        <div className="rrset-head">
          <span className="owner">{zone.origin}.</span>
          <span className="pill-type">SOA</span>
          <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>
            TTL {s.ttl}
          </span>
          <div style={{ flex: 1 }} />
          <button className="small" onClick={() => { setFields({ ...s }); setEditing(true); }}>
            编辑 SOA
          </button>
        </div>
        <div className="rr-row" style={{ gridTemplateColumns: "1fr" }}>
          <span className="rd">
            {s.mname}. {s.rname}. {s.serial} {s.refresh} {s.retry} {s.expire} {s.minimum}
          </span>
        </div>
        <div className="rr-row muted" style={{ gridTemplateColumns: "1fr", fontSize: 11 }}>
          发布时序列号会自动推进（取上一版本 serial+1 与当前时间戳的较大值）。
        </div>
      </div>
    );
  }

  const num = (k: keyof typeof fields) => (
    <div key={k}>
      <label>{k}</label>
      <input
        type="number"
        value={fields[k]}
        onChange={(e) => setFields({ ...fields, [k]: Number(e.target.value) })}
      />
    </div>
  );

  return (
    <div className="editor-form">
      <div className="row">
        <div>
          <label>mname 主域名服务器</label>
          <input className="mono" value={fields.mname} onChange={(e) => setFields({ ...fields, mname: e.target.value })} />
        </div>
        <div>
          <label>rname 管理员邮箱</label>
          <input className="mono" value={fields.rname} onChange={(e) => setFields({ ...fields, rname: e.target.value })} />
        </div>
      </div>
      <div className="row">
        {num("ttl")}
        {num("serial")}
      </div>
      <div className="row">
        {num("refresh")}
        {num("retry")}
        {num("expire")}
        {num("minimum")}
      </div>
      <div className="flex">
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            const ok = await mutate([
              {
                op: "setSoa",
                fields: {
                  mname: normalizeName(fields.mname),
                  rname: normalizeName(fields.rname),
                  ttl: fields.ttl,
                  serial: fields.serial,
                  refresh: fields.refresh,
                  retry: fields.retry,
                  expire: fields.expire,
                  minimum: fields.minimum,
                },
              },
            ]);
            if (ok) setEditing(false);
          }}
        >
          保存 SOA
        </button>
        <button onClick={() => setEditing(false)}>取消</button>
      </div>
    </div>
  );
}

function RRsetView({
  type,
  owner,
  records,
  mutate,
  busy,
}: {
  type: RRType;
  owner: string;
  records: { id: string; ttl: number; rdata: RData; editId?: string }[];
  mutate: (ops: EditOperation[]) => Promise<boolean>;
  busy: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="rrset">
      <div className="rrset-head">
        <span className="owner">{owner}.</span>
        <span className="pill-type">{type}</span>
      </div>
      {records.map((r) =>
        editingId === r.id ? (
          <EditRow
            key={r.id}
            type={type}
            owner={owner}
            ttl={r.ttl}
            initialText={rdataToText(type, r.rdata)}
            busy={busy}
            onCancel={() => setEditingId(null)}
            onSubmit={async (name, ttl2, rdata) => {
              const ok = await mutate([
                {
                  op: "replaceRecord",
                  editId: uid("e"),
                  recordId: r.id,
                  name,
                  type,
                  ttl: ttl2,
                  rdata,
                },
              ]);
              if (ok) setEditingId(null);
              return ok;
            }}
          />
        ) : (
          <div
            key={r.id}
            className={`rr-row ${r.editId ? "added" : ""}`}
            title={r.editId ? `由草稿编辑 ${r.editId} 产生` : undefined}
          >
            <span className="t">{r.ttl}</span>
            <span className="t">{type}</span>
            <span className="rd">{rdataToText(type, r.rdata)}</span>
            <span className="actions">
              <button className="small" onClick={() => setEditingId(r.id)}>
                改
              </button>
              <button
                className="small danger"
                disabled={busy}
                onClick={async () => {
                  await mutate([
                    { op: "deleteRecords", editId: uid("e"), recordIds: [r.id] },
                  ]);
                }}
              >
                删
              </button>
            </span>
          </div>
        ),
      )}
    </div>
  );
}

function EditRow({
  type,
  owner,
  ttl,
  initialText,
  busy,
  onSubmit,
  onCancel,
}: {
  type: RRType;
  owner: string;
  ttl: number;
  initialText: string;
  busy: boolean;
  onSubmit: (name: string, ttl: number, rdata: RData) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(owner);
  const [ttl2, setTtl] = useState(ttl);
  const [text, setText] = useState(initialText);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="rr-row" style={{ gridTemplateColumns: "120px 60px 1fr", display: "grid", gridColumn: "1 / -1" }}>
      <input className="mono" value={name} onChange={(e) => setName(e.target.value)} />
      <input type="number" value={ttl2} onChange={(e) => setTtl(Number(e.target.value))} />
      <div>
        <input
          className="mono"
          style={{ width: "100%" }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
        <div className="flex" style={{ marginTop: 6 }}>
          <button
            className="small primary"
            disabled={busy}
            onClick={() => {
              const p = parseRdata(type, text);
              if (p.error || !p.rdata) {
                setErr(p.error ?? "解析失败");
                return;
              }
              if (!nameSyntaxOk(name)) {
                setErr("记录名不合法");
                return;
              }
              if (ttl2 <= 0) {
                setErr("TTL 必须大于 0");
                return;
              }
              setErr(null);
              onSubmit(normalizeName(name), ttl2, p.rdata);
            }}
          >
            确定
          </button>
          <button className="small" onClick={onCancel}>
            取消
          </button>
          {err && <span className="form-error">{err}</span>}
        </div>
      </div>
    </div>
  );
}

function AddRecordForm({
  defaultName,
  origin,
  mutate,
  busy,
  onCreated,
}: {
  defaultName: string;
  origin: string;
  mutate: (ops: EditOperation[]) => Promise<boolean>;
  busy: boolean;
  onCreated: (fullName: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [type, setType] = useState<RRType>("A");
  const [ttl, setTtl] = useState(3600);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const fullName = (raw: string) => {
    const n = normalizeName(raw);
    if (!n) return origin;
    if (n.endsWith("." + origin) || n === origin) return n;
    return `${n}.${origin}`;
  };

  const submit = async () => {
    const fn = fullName(name);
    if (!nameSyntaxOk(fn)) {
      setErr(`记录名不合法（${fn}）`);
      return;
    }
    const p = parseRdata(type, text);
    if (p.error || !p.rdata) {
      setErr(p.error ?? "解析失败");
      return;
    }
    if (ttl <= 0) {
      setErr("TTL 必须大于 0");
      return;
    }
    setErr(null);
    const ok = await mutate([
      { op: "addRecord", editId: uid("e"), name: fn, type, ttl, rdata: p.rdata },
    ]);
    if (ok) {
      setText("");
      onCreated(fn);
    }
  };

  return (
    <div className="editor-form">
      <label style={{ fontSize: 11, color: "var(--muted)" }}>新增记录（名字可填相对名，自动补全 {origin}）</label>
      <div className="row" style={{ marginTop: 6 }}>
        <div>
          <label>名字</label>
          <input
            className="mono"
            value={name}
            placeholder="host 或 host.example.net."
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="shrink" style={{ flex: "0 0 90px" }}>
          <label>类型</label>
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value as RRType);
              setText("");
            }}
          >
            {RR_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="shrink" style={{ flex: "0 0 80px" }}>
          <label>TTL</label>
          <input type="number" value={ttl} onChange={(e) => setTtl(Number(e.target.value))} />
        </div>
      </div>
      <div className="row">
        <div>
          <label>记录数据</label>
          <input
            className="mono"
            value={text}
            placeholder={placeholderFor(type)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <div className="shrink" style={{ flex: "0 0 90px", display: "flex", alignItems: "flex-end" }}>
          <button className="primary" style={{ width: "100%" }} disabled={busy} onClick={submit}>
            添加
          </button>
        </div>
      </div>
      {err && <div className="form-error">{err}</div>}
      <div className="muted" style={{ fontSize: 11 }}>
        预览：<span className="mono">{fullName(name) || origin}. {ttl} {type} {text || "…"}</span>
      </div>
    </div>
  );
}

function FindingLine({
  f,
  ctx,
  onSelectName,
}: {
  f: ValidationFinding;
  ctx: EditorCtx;
  onSelectName: (n: string) => void;
}) {
  const edit = f.editIds?.[0]
    ? ctx.editLog.find((e) => e.id === f.editIds![0])
    : undefined;
  return (
    <div className={`finding ${f.severity}`}>
      <span className="code">{f.code}</span>
      <span>{f.message}</span>
      {edit && (
        <span
          className="editlink"
          title={`导致该问题的草稿改动：${edit.summary}（${edit.editorId}）`}
          onClick={() => f.name && onSelectName(f.name)}
        >
          定位改动：{edit.summary}
        </span>
      )}
    </div>
  );
}
