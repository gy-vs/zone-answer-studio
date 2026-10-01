import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiError,
  EditOperation,
  EditorIdentity,
  QueryResult,
  QueryType,
  StateResponse,
  ValidationFinding,
  Zone,
} from "./types";
import { api } from "./api";
import { uid } from "./dnslib";
import { TopBar } from "./components/TopBar";
import { ZoneTree } from "./components/ZoneTree";
import { RecordPanel } from "./components/RecordPanel";
import { QueryPanel } from "./components/QueryPanel";
import { BottomPanels } from "./components/BottomPanels";
import { Toasts, type Toast } from "./components/Toasts";

export interface EditorCtx {
  identity: EditorIdentity;
  revision: number;
  publishedRevision: number;
  draft: Zone;
  findings: ValidationFinding[];
  editLog: StateResponse["editLog"];
  published: StateResponse["published"];
  history: StateResponse["history"];
  samples: StateResponse["samples"];
}

export function App() {
  // 每个浏览器标签/窗口一个稳定编辑者身份（sessionStorage：刷新保持，
  // 新开窗口另算一个编辑者，便于模拟并行编辑）。
  const identity = useRef<EditorIdentity>(makeIdentity());
  const [ctx, setCtx] = useState<EditorCtx | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [query, setQuery] = useState<{ qname: string; qtype: QueryType }>({
    qname: "www",
    qtype: "A",
  });
  const [busy, setBusy] = useState(false);
  const pollTimer = useRef<number | null>(null);
  const knownRevision = useRef<number | null>(null);

  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = uid("t");
    setToasts((xs) => [...xs, { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), 6000);
  }, []);

  const hydrate = useCallback(
    (s: StateResponse, opts: { force?: boolean } = {}) => {
      // 丢弃迟到的旧响应，避免本地刚保存后被在途的轮询回滚到旧修订
      if (!opts.force && knownRevision.current !== null && s.revision < knownRevision.current) {
        return;
      }
      knownRevision.current = s.revision;
      setCtx({
        identity: identity.current,
        revision: s.revision,
        publishedRevision: s.publishedRevision,
        draft: s.draft,
        findings: s.draftFindings,
        editLog: s.editLog,
        published: s.published,
        history: s.history,
        samples: s.samples,
      });
    },
    [],
  );

  const refresh = useCallback(
    async (silent = false) => {
      try {
        const s = await api.state();
        hydrate(s);
        void silent;
      } catch (e) {
        if (!silent) pushToast({ kind: "error", text: `加载状态失败：${(e as Error).message}` });
      }
    },
    [hydrate, pushToast],
  );

  useEffect(() => {
    refresh();
    // 轻量轮询：并行窗口保存后，另一窗口能在 2.5s 内发现修订号变化并提示
    pollTimer.current = window.setInterval(() => refresh(true), 2500);
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, [refresh]);

  // 跟踪外部（其他窗口）改动
  const prevRevision = useRef<number | null>(null);
  useEffect(() => {
    if (!ctx) return;
    if (prevRevision.current !== null && prevRevision.current !== ctx.revision) {
      // 只有当变化不是自己刚刚发起的操作时才提示（busy 期间的 hydrate 不提示）
      if (!busy) {
        const who = ctx.editLog.at(-1);
        pushToast({
          kind: "info",
          text: who
            ? `检测到其他窗口的改动（r${ctx.revision}）：${who.summary}`
            : `区域状态已更新（r${ctx.revision}，可能是发布或丢弃）`,
        });
      }
    }
    prevRevision.current = ctx.revision;
  }, [ctx, busy, pushToast]);

  // ---------------- 变更操作（乐观并发） ----------------

  const mutate = useCallback(
    async (operations: EditOperation[]): Promise<boolean> => {
      if (!ctx) return false;
      setBusy(true);
      try {
        const r = await api.mutate(identity.current, ctx.revision, operations);
        knownRevision.current = r.revision;
        setCtx((c) =>
          c
            ? {
                ...c,
                revision: r.revision,
                draft: r.zone,
                editLog: r.editLog,
                findings: r.findings,
              }
            : c,
        );
        return true;
      } catch (e) {
        const err = e as ApiError;
        if (err.code === "conflict" && err.conflict) {
          handleConflict(err, setCtx, pushToast, knownRevision);
        } else {
          pushToast({ kind: "error", text: err.error ?? "保存失败" });
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [ctx, pushToast],
  );

  const publish = useCallback(
    async (note: string) => {
      if (!ctx) return;
      setBusy(true);
      try {
        const r = await api.publish(identity.current, ctx.revision, note);
        knownRevision.current = r.revision;
        setCtx((c) =>
          c
            ? {
                ...c,
                revision: r.revision,
                publishedRevision: r.revision,
                draft: r.zone,
                editLog: r.editLog,
                published: r.version,
                findings: [],
                history: [
                  ...c.history.filter((h) => h.id !== r.version.id),
                  {
                    id: r.version.id,
                    serial: r.version.serial,
                    publishedAt: r.version.publishedAt,
                    editorLabel: r.version.editorId,
                    note: r.version.note,
                    changesSummary: r.version.changes
                      .slice(0, 8)
                      .map((x) => x.summary),
                  },
                ],
              }
            : c,
        );
        pushToast({
          kind: "success",
          text: `已发布 ${r.version.id}（serial ${r.version.serial}）`,
        });
      } catch (e) {
        const err = e as ApiError;
        if (err.code === "conflict" && err.conflict) {
          handleConflict(err, setCtx, pushToast, knownRevision);
        } else if (err.code === "publish-blocked") {
          setCtx((c) => (c ? { ...c, findings: err.findings ?? c.findings } : c));
          pushToast({
            kind: "error",
            text: "发布被阻断：草稿存在校验错误，请先解决下列错误",
          });
        } else {
          pushToast({ kind: "error", text: err.error ?? "发布失败" });
        }
      } finally {
        setBusy(false);
      }
    },
    [ctx, pushToast],
  );

  const discard = useCallback(async () => {
    if (!ctx) return;
    setBusy(true);
    try {
      const r = await api.discard(ctx.revision);
      knownRevision.current = r.revision;
      setCtx((c) =>
        c
          ? {
              ...c,
              revision: r.revision,
              draft: r.zone,
              editLog: r.editLog,
              findings: r.findings,
            }
          : c,
      );
      pushToast({ kind: "info", text: "已丢弃草稿，回到已发布版本" });
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "conflict" && err.conflict) handleConflict(err, setCtx, pushToast, knownRevision);
      else pushToast({ kind: "error", text: err.error ?? "丢弃失败" });
    } finally {
      setBusy(false);
    }
  }, [ctx, pushToast]);

  const samplesUpdated = useCallback(
    (s: { revision: number; samples: StateResponse["samples"] }) => {
      // 样例增删不推进草稿修订号；这里只同步样例列表
      setCtx((c) => (c ? { ...c, samples: s.samples } : c));
    },
    [],
  );

  const queryResultVersion = useMemo(() => {
    // 查询面板通过 target 参数自行区分 draft/published/历史，
    // 这里仅暴露当前查询输入。
    return query;
  }, [query]);

  if (!ctx) {
    return <div className="empty" style={{ padding: 80 }}>正在加载区域状态…</div>;
  }

  return (
    <div className="app">
      <TopBar ctx={ctx} busy={busy} />
      <div className="main">
        <ZoneTree
          ctx={ctx}
          selectedName={selectedName ?? ctx.draft.origin}
          onSelect={setSelectedName}
        />
        <RecordPanel
          ctx={ctx}
          selectedName={selectedName ?? ctx.draft.origin}
          onSelectName={setSelectedName}
          mutate={mutate}
          busy={busy}
        />
        <QueryPanel
          ctx={ctx}
          query={queryResultVersion}
          setQuery={setQuery}
          onAddSample={samplesUpdated}
        />
      </div>
      <BottomPanels
        ctx={ctx}
        busy={busy}
        onPublish={publish}
        onDiscard={discard}
        onSelectQuery={(qname, qtype) => setQuery({ qname, qtype })}
      />
      <Toasts toasts={toasts} />
    </div>
  );
}

function makeIdentity(): EditorIdentity {
  const key = "zas-editor";
  const existing = sessionStorage.getItem(key);
  if (existing) {
    try {
      return JSON.parse(existing) as EditorIdentity;
    } catch {
      /* fall through */
    }
  }
  const id = {
    editorId: uid("win"),
    label: `窗口 ${Math.floor(Math.random() * 900 + 100)}`,
  };
  sessionStorage.setItem(key, JSON.stringify(id));
  return id;
}

function handleConflict(
  err: ApiError,
  setCtx: React.Dispatch<React.SetStateAction<EditorCtx | null>>,
  pushToast: (t: Omit<Toast, "id">) => void,
  knownRevision: React.MutableRefObject<number | null>,
) {
  const c = err.conflict!;
  knownRevision.current = c.currentRevision;
  setCtx((prev) =>
    prev
      ? {
          ...prev,
          revision: c.currentRevision,
          draft: c.currentZone,
          findings: c.findings,
          editLog: c.newerEdits,
        }
      : prev,
  );
  const others = c.newerEdits
    .filter((e) => e.editorId !== prevEditorId())
    .slice(-3)
    .map((e) => `· ${e.summary}`)
    .join("\n");
  pushToast({
    kind: "error",
    text: `保存被拒绝：另一个窗口已经保存了更新的草稿（当前 r${c.currentRevision}）。界面已加载服务器最新草稿，你的本次改动未写入，请在最新版本上重做。\n${others}`,
  });
}

function prevEditorId(): string {
  try {
    return (JSON.parse(sessionStorage.getItem("zas-editor") ?? "{}") as EditorIdentity).editorId;
  } catch {
    return "";
  }
}

// 供子组件使用的结果类型再导出
export type { QueryResult };
