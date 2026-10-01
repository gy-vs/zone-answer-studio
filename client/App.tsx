import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BootState, DraftOp, ValidationResult, SampleEffectEntry,
} from '@shared/types.js';
import { api } from './api.js';
import { RecordsTab } from './tabs/RecordsTab.js';
import { QueryTab } from './tabs/QueryTab.js';
import { VersionsTab } from './tabs/VersionsTab.js';

function getClientId(): string {
  if (typeof sessionStorage === 'undefined') return Math.random().toString(36).slice(2);
  let id = sessionStorage.getItem('client-id');
  if (!id) {
    id = 'win-' + Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem('client-id', id);
  }
  return id;
}

type Tab = 'records' | 'query' | 'versions';

export function App() {
  const [boot, setBoot] = useState<BootState | null>(null);
  const [tab, setTab] = useState<Tab>('query');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [effects, setEffects] = useState<SampleEffectEntry[]>([]);
  const [queryPrefill, setQueryPrefill] = useState<{ name: string; qtype: string } | null>(null);
  const [staleDraft, setStaleDraft] = useState(false);
  const clientId = useMemo(getClientId, []);
  const knownRevision = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const b = await api.boot();
    setBoot((prev) => {
      if (prev && prev.draft.revision !== b.draft.revision && knownRevision.current !== b.draft.revision) {
        // 草稿在本窗口之外发生了变化
        if (knownRevision.current !== null) setStaleDraft(true);
      }
      knownRevision.current = b.draft.revision;
      return b;
    });
    setEffects(await api.effects().then((r) => r.entries));
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const t = setInterval(() => { refresh().catch(() => {}); }, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const syncNow = useCallback(async () => {
    await refresh();
    setStaleDraft(false);
  }, [refresh]);

  const saveOps = useCallback(async (ops: Exclude<DraftOp, { kind: 'reset' }>[]) => {
    if (!boot) throw new Error('未加载');
    setError(null);
    const resp = await api.saveOps(ops, boot.draft.revision, clientId);
    knownRevision.current = resp.draft.revision;
    await refresh();
    return resp;
  }, [boot, clientId, refresh]);

  const handlePublish = useCallback(async () => {
    if (!boot) return;
    setError(null);
    try {
      const resp = await api.publish(clientId, '从网页发布');
      knownRevision.current = resp.draft.revision;
      setNotice(`已发布版本 ${resp.published.id}，SOA serial=${resp.published.serial}`);
      setTimeout(() => setNotice(null), 5000);
      await refresh();
    } catch (e) {
      const err = e as { body?: { validation?: ValidationResult }; message: string };
      const v = err.body?.validation;
      if (v) {
        const first = v.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('；');
        setError('发布被阻止：' + first);
      } else {
        setError(err.message);
      }
    }
  }, [boot, clientId, refresh]);

  const resetDraft = useCallback(async () => {
    await api.resetDraft(clientId);
    await refresh();
  }, [clientId, refresh]);

  if (!boot) {
    return <div className="loading">正在加载服务端区域状态…</div>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          区域草稿与权威查询预览
        </div>
        <div className="zone-meta">
          <span className="pill">区域起点 <code>{boot.meta.zoneName}</code></span>
          <span className="pill">草稿 rev {boot.draft.revision}</span>
          <span className="pill">
            已发布 {boot.published
              ? <code>{boot.published.id.slice(0, 10)}</code>
              : <em>尚无</em>}
          </span>
          <span className="pill client">本窗口 {clientId}</span>
        </div>
        <nav className="tabs">
          <button className={tab === 'records' ? 'active' : ''} onClick={() => setTab('records')}>
            记录与草稿
          </button>
          <button className={tab === 'query' ? 'active' : ''} onClick={() => setTab('query')}>
            查询预览
          </button>
          <button className={tab === 'versions' ? 'active' : ''} onClick={() => setTab('versions')}>
            版本对照
          </button>
        </nav>
      </header>

      {staleDraft && (
        <div className="banner warn">
          检测到其他窗口已保存更新的草稿（当前显示可能是旧 revision）。
          <button onClick={syncNow}>立即载入最新草稿</button>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <main className="content">
        {tab === 'records' && (
          <RecordsTab
            boot={boot}
            effects={effects}
            onSaveOps={saveOps}
            onPublish={handlePublish}
            onReset={resetDraft}
            onError={setError}
          />
        )}
        {tab === 'query' && (
          <QueryTab
            boot={boot}
            effects={effects}
            onRefreshEffects={async () => setEffects((await api.effects()).entries)}
            prefill={queryPrefill}
            onConsumePrefill={() => setQueryPrefill(null)}
          />
        )}
        {tab === 'versions' && (
          <VersionsTab
            boot={boot}
            onQueryVersion={(name, qtype) => {
              setQueryPrefill({ name, qtype });
              setTab('query');
            }}
          />
        )}
      </main>
      <footer className="footer">
        所有数据保存在本机服务端 <code>data/state.json</code>；不访问公共 DNS、不依赖外部服务。
      </footer>
    </div>
  );
}
