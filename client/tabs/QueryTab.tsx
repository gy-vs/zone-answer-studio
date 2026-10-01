import { useCallback, useEffect, useState } from 'react';
import type {
  BootState, QueryResultResponse, RRType, PublishedVersion, SampleEffectEntry,
} from '@shared/types.js';
import { RR_TYPES } from '@shared/types.js';
import { api } from '../api.js';
import { QueryResult } from '../components/QueryResult.js';
import { displayName } from '../components/display.js';

interface Props {
  boot: BootState;
  effects: SampleEffectEntry[];
  onRefreshEffects: () => Promise<void>;
  prefill: { name: string; qtype: string } | null;
  onConsumePrefill: () => void;
}

export function QueryTab({ boot, effects, onRefreshEffects, prefill, onConsumePrefill }: Props) {
  const [name, setName] = useState('www');
  const [qtype, setQtype] = useState<RRType | 'ANY'>('A');
  const [publishedSource, setPublishedSource] = useState<string>('published');
  const [draftResult, setDraftResult] = useState<QueryResultResponse | null>(null);
  const [pubResult, setPubResult] = useState<QueryResultResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState<{ name: string; qtype: RRType | 'ANY' } | null>(null);

  useEffect(() => {
    if (prefill) {
      setName(displayName(prefill.name, boot.meta.zoneName) === '@' ? '@' : prefill.name);
      setQtype(prefill.qtype as RRType | 'ANY');
      onConsumePrefill();
    }
  }, [prefill, boot.meta.zoneName, onConsumePrefill]);

  const run = useCallback(async (
    qName?: string, qType?: RRType | 'ANY', pubSrc?: string,
  ) => {
    const useName = qName ?? name;
    const useType = qType ?? qtype;
    const useSrc = pubSrc ?? publishedSource;
    setRunning(true);
    setErr(null);
    try {
      const [d, p] = await Promise.all([
        api.query({ name: useName, qtype: useType, source: 'draft' }),
        boot.published || useSrc !== 'published'
          ? api.query({ name: useName, qtype: useType, source: useSrc }).catch((e) => {
            if (e.code === 'NO_PUBLISHED') return null;
            throw e;
          })
          : Promise.resolve(null),
      ]);
      setDraftResult(d);
      setPubResult(p);
      setLastQuery({ name: useName, qtype: useType });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [name, qtype, publishedSource, boot.published]);

  // 自动在首次加载时跑一次
  useEffect(() => {
    run('www', 'A', 'published').catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 草稿或已发布版本变化后（轮询感知），重跑最近一次查询，保证对照实时
  useEffect(() => {
    if (lastQuery) {
      run(lastQuery.name, lastQuery.qtype).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot.draft.revision, boot.published?.id]);

  const [versionList, setVersionList] = useState<PublishedVersion[]>([]);
  useEffect(() => {
    api.versions().then(setVersionList).catch(() => {});
  }, [boot.published?.id]);

  const effectClass = (e: string) =>
    e === 'same' ? 'eff-same' : e === 'changed' ? 'eff-changed' : 'eff-error';

  return (
    <div className="query-tab">
      <section className="query-bar-card">
        <div className="query-bar">
          <label className="q-name">
            <span>查询名</span>
            <input
              value={name}
              placeholder="www 或 foo.eu 或 a.b.lab.internal."
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && run()}
            />
          </label>
          <label className="q-type">
            <span>类型</span>
            <select value={qtype} onChange={(e) => setQtype(e.target.value as RRType | 'ANY')}>
              {[...RR_TYPES, 'ANY' as const].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="q-src">
            <span>左列版本</span>
            <select value={publishedSource} onChange={(e) => {
              setPublishedSource(e.target.value);
              run(undefined, undefined, e.target.value);
            }}>
              <option value="published">最新已发布版本</option>
              {versionList.map((v) => (
                <option key={v.id} value={v.id}>{v.id.slice(0, 12)} · {v.publishedAt.slice(0, 19).replace('T', ' ')}</option>
              ))}
            </select>
          </label>
          <button className="primary big" disabled={running} onClick={() => run()}>
            {running ? '查询中…' : '对照预览'}
          </button>
        </div>
        {err && <div className="banner error">{err}</div>}
      </section>

      <section className="compare-grid">
        <div className="compare-col published">
          <div className="col-head">
            <h3>已发布版本</h3>
            {pubResult && <span className="col-source">{pubResult.sourceLabel}</span>}
          </div>
          {pubResult
            ? <QueryResult result={pubResult} zoneName={boot.meta.zoneName} />
            : <div className="query-empty">尚无已发布版本；发布后此处显示冻结的历史应答。</div>}
        </div>
        <div className="compare-col draft">
          <div className="col-head">
            <h3>当前草稿</h3>
            {draftResult && <span className="col-source">{draftResult.sourceLabel}</span>}
          </div>
          <QueryResult result={draftResult} zoneName={boot.meta.zoneName} />
        </div>
      </section>

      <section className="samples-card">
        <div className="samples-head">
          <h3>查询样例 · 草稿对已发布的影响</h3>
          <button className="small" onClick={onRefreshEffects}>刷新影响</button>
        </div>
        <p className="samples-hint">
          这组样例随区域保存在服务端。保存草稿改动后，此处逐条标注应答是否变化及原因；
          点任一条目可载入上方对照。
        </p>
        <table className="samples-table">
          <thead>
            <tr>
              <th>样例</th><th>查询</th><th>已发布应答</th><th>草稿应答</th><th>影响与原因</th><th></th>
            </tr>
          </thead>
          <tbody>
            {effects.map((entry) => (
              <tr key={entry.sample.id} className={effectClass(entry.effect)}>
                <td className="sample-label">{entry.sample.label ?? '—'}</td>
                <td className="sample-q">
                  <code>{displayName(entry.sample.name, boot.meta.zoneName)}</code>
                  <span className="qtype-tag">{entry.sample.qtype}</span>
                </td>
                <td>{entry.published
                  ? <span className="mini-kind">{entry.published.kind}</span>
                  : <span className="muted">无版本</span>}</td>
                <td><span className="mini-kind">{entry.draft.kind}</span></td>
                <td className="reasons">
                  <span className={`eff-pill ${effectClass(entry.effect)}`}>
                    {entry.effect === 'same' ? '一致' : entry.effect === 'changed' ? '有变化' : '草稿异常'}
                  </span>
                  {entry.reasons.slice(0, 2).map((r, i) => <div key={i} className="reason">{r}</div>)}
                </td>
                <td>
                  <button className="small" onClick={() => {
                    setName(entry.sample.name);
                    setQtype(entry.sample.qtype);
                    run(entry.sample.name, entry.sample.qtype);
                  }}>对照</button>
                  <button className="small danger" onClick={async () => {
                    await api.deleteSample(entry.sample.id);
                    await onRefreshEffects();
                  }}>删</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <AddSample onAdded={onRefreshEffects} />
      </section>
    </div>
  );
}

function AddSample({ onAdded }: { onAdded: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [qtype, setQtype] = useState<RRType | 'ANY'>('A');
  const [label, setLabel] = useState('');
  return (
    <div className="add-sample">
      <input placeholder="名字，如 api" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={qtype} onChange={(e) => setQtype(e.target.value as RRType | 'ANY')}>
        {[...RR_TYPES, 'ANY' as const].map((t) => <option key={t}>{t}</option>)}
      </select>
      <input placeholder="说明（可选）" value={label} onChange={(e) => setLabel(e.target.value)} />
      <button className="small primary" onClick={async () => {
        if (!name.trim()) return;
        await api.addSample(name, qtype, label || undefined);
        setName(''); setLabel('');
        await onAdded();
      }}>保存为样例</button>
    </div>
  );
}
