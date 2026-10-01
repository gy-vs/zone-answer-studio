import { useMemo, useState } from 'react';
import type {
  BootState, DraftOp, RR, RRType, ValidationIssue,
} from '@shared/types.js';
import { RR_TYPES } from '@shared/types.js';
import { RRText, RdataFields, rdataToInputs } from '../components/ui.js';
import { displayName } from '../components/display.js';

type MutableOp = Exclude<DraftOp, { kind: 'reset' }>;

interface Props {
  boot: BootState;
  effects: { effect: string }[];
  onSaveOps: (ops: MutableOp[]) => Promise<unknown>;
  onPublish: () => Promise<void>;
  onReset: () => Promise<void>;
  onError: (msg: string | null) => void;
}

interface FormState {
  id?: string;
  name: string;
  type: RRType;
  ttl: string;
  fields: Record<string, string>;
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'A',
  ttl: '3600',
  fields: { address: '' },
};

function cutNames(records: RR[]): Set<string> {
  // 非起点且有 NS 的名字
  const ns = new Map<string, number>();
  for (const r of records) {
    if (r.type === 'NS') ns.set(r.name, (ns.get(r.name) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [name, count] of ns) if (count > 0 && name !== records.find((r) => r.type === 'SOA')?.name) {
    out.add(name);
  }
  return out;
}

export function RecordsTab({ boot, onSaveOps, onPublish, onReset, onError }: Props) {
  const { draft, published, draftValidation, meta } = boot;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const cuts = useMemo(() => cutNames(draft.records), [draft.records]);
  const apex = meta.zoneName;

  const publishedKeys = useMemo(() => {
    const s = new Set<string>();
    for (const r of published?.records ?? []) s.add(r.id);
    return s;
  }, [published]);

  const publishedMap = useMemo(() => {
    const m = new Map<string, RR>();
    for (const r of published?.records ?? []) m.set(r.id, r);
    return m;
  }, [published]);

  const groups = useMemo(() => {
    const m = new Map<string, RR[]>();
    for (const rr of draft.records) {
      const list = m.get(rr.name) ?? [];
      list.push(rr);
      m.set(rr.name, list);
    }
    const names = [...m.keys()].sort((a, b) => {
      // 区域起点置顶，其余按标签层级/字母
      if (a === apex) return -1;
      if (b === apex) return 1;
      const da = a.split('.').length;
      const db = b.split('.').length;
      if (da !== db) return da - db;
      return a.localeCompare(b);
    });
    return names.filter((n) => !filter || n.includes(filter.toLowerCase().trim())).map((name) => ({
      name,
      rrs: m.get(name)!.sort((a, b) => a.type.localeCompare(b.type)),
    }));
  }, [draft.records, apex, filter]);

  const changeType = (type: RRType) => {
    setForm((f) => ({ ...f, type, fields: {} }));
  };

  const startEdit = (rr: RR) => {
    setEditingId(rr.id);
    setForm({
      id: rr.id,
      name: displayName(rr.name, apex) === '@' ? apex : rr.name,
      type: rr.type,
      ttl: String(rr.ttl),
      fields: rdataToInputs(rr),
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const submit = async () => {
    setBusy(true);
    onError(null);
    try {
      const id = editingId ?? crypto.randomUUID();
      const rrPayload = {
        id,
        name: form.name,
        type: form.type,
        ttl: Number(form.ttl),
        fields: form.fields,
      };
      if (editingId) {
        const before = draft.records.find((r) => r.id === editingId)!;
        await onSaveOps([{
          id: crypto.randomUUID(), at: '', client: '', kind: 'update',
          before, after: rrPayload as unknown as RR,
        }]);
      } else {
        await onSaveOps([{
          id: crypto.randomUUID(), at: '', client: '', kind: 'add',
          rr: rrPayload as unknown as RR,
        }]);
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (rr: RR) => {
    setBusy(true);
    onError(null);
    try {
      await onSaveOps([{
        id: crypto.randomUUID(), at: '', client: '', kind: 'delete', rr,
      }]);
      if (editingId === rr.id) cancelEdit();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const errors = draftValidation.issues.filter((i) => i.severity === 'error');
  const warnings = draftValidation.issues.filter((i) => i.severity === 'warning');
  const opIndex = new Map<string, number>();
  draft.ops.forEach((op, i) => opIndex.set(op.id, i + 1));

  return (
    <div className="records-tab">
      <section className="editor-card">
        <h3>{editingId ? '编辑记录（保存后写入草稿）' : '新增记录到草稿'}</h3>
        <div className="form-grid">
          <label className="w6">
            <span>名字（@ 表示区域起点；可写相对名）</span>
            <input
              value={form.name}
              placeholder="@ 或 app 或 host.eu"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="w2">
            <span>类型</span>
            <select value={form.type} onChange={(e) => changeType(e.target.value as RRType)}>
              {RR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="w2">
            <span>TTL（秒）</span>
            <input value={form.ttl} onChange={(e) => setForm({ ...form, ttl: e.target.value })} />
          </label>
        </div>
        <RdataFields
          type={form.type}
          values={form.fields}
          onChange={(k, v) => setForm({ ...form, fields: { ...form.fields, [k]: v } })}
        />
        <div className="form-actions">
          <button className="primary" disabled={busy} onClick={submit}>
            {editingId ? '保存修改到草稿' : '加入草稿'}
          </button>
          {editingId && <button onClick={cancelEdit}>取消编辑</button>}
        </div>
      </section>

      <section className="validation-card">
        <div className="validation-head">
          <h3>草稿校验</h3>
          <div className="validation-summary">
            <span className={errors.length ? 'bad' : 'good'}>{errors.length} 个阻塞错误</span>
            <span className="muted">{warnings.length} 个警告</span>
          </div>
        </div>
        {draftValidation.issues.length === 0 && (
          <div className="all-good">草稿通过全部语义校验，可以发布。</div>
        )}
        <ul className="issue-list">
          {draftValidation.issues.map((issue: ValidationIssue, i) => (
            <li key={i} className={`issue ${issue.severity}`}>
              <span className="sev">{issue.severity === 'error' ? '错误' : '警告'}</span>
              <span className="issue-msg">{issue.message}</span>
              {issue.opIds && issue.opIds.length > 0 && (
                <span className="op-attrib">
                  归因草稿改动：{issue.opIds.map((oid) => {
                    const idx = opIndex.get(oid);
                    return idx ? `#${idx}` : oid.slice(0, 6);
                  }).join(', ')}
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="publish-bar">
          <button className="primary big" disabled={busy || errors.length > 0} onClick={onPublish}>
            发布当前草稿为新版本
          </button>
          <button disabled={busy || !published} onClick={onReset}>
            放弃草稿改动，回到已发布版本
          </button>
          {errors.length > 0 && <span className="publish-blocked">需先消除全部阻塞错误</span>}
        </div>
      </section>

      <section className="tree-card">
        <div className="tree-head">
          <h3>区域树与记录集</h3>
          <input
            className="filter-input"
            placeholder="按名字过滤…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="apex-hint">
          起点 <code>{apex}</code> 的 SOA / NS 是区域权威的根基；带
          <span className="cut-tag">委派</span> 标记的名字会产生转介而不是普通应答。
        </div>
        <div className="name-groups">
          {groups.map((g) => (
            <div key={g.name} className={`name-group ${g.name === apex ? 'is-apex' : ''} ${cuts.has(g.name) ? 'is-cut' : ''}`}>
              <div className="group-head">
                <span className="group-name">{displayName(g.name, apex)}</span>
                <span className="group-fqdn">{g.name}</span>
                {g.name === apex && <span className="apex-tag">区域起点</span>}
                {cuts.has(g.name) && <span className="cut-tag">子域委派 → 转介</span>}
              </div>
              <ul className="rr-list">
                {g.rrs.map((rr) => {
                  const changed = !publishedKeys.has(rr.id) ||
                    JSON.stringify(publishedMap.get(rr.id)?.rdata) !== JSON.stringify(rr.rdata) ||
                    publishedMap.get(rr.id)?.ttl !== rr.ttl;
                  return (
                    <li key={rr.id} className={`rr-item ${changed ? 'changed' : ''}`}>
                      <RRText rr={rr} zoneName={apex} />
                      <span className="rr-state">
                        {!published ? '待首次发布' : changed ? (publishedKeys.has(rr.id) ? '草稿已改' : '草稿新增') : '与已发布一致'}
                      </span>
                      <span className="rr-actions">
                        <button onClick={() => startEdit(rr)}>编辑</button>
                        <button className="danger" onClick={() => remove(rr)}>删除</button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
