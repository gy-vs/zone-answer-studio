import type { EditorCtx } from "../App";

export function TopBar({ ctx, busy }: { ctx: EditorCtx; busy: boolean }) {
  const errorCount = ctx.findings.filter((f) => f.severity === "error").length;
  const warnCount = ctx.findings.filter((f) => f.severity === "warning").length;
  const dirty = ctx.editLog.length > 0;

  return (
    <div className="topbar">
      <div className="logo">
        Zone <span>Answer</span> Studio
      </div>
      <span className="badge">
        <span className="dot blue" />
        {ctx.identity.label} · {ctx.identity.editorId.slice(0, 10)}
      </span>
      <span className="badge" title="草稿修订号，每次保存/发布/丢弃单调递增">
        草稿 <span className="mono">r{ctx.revision}</span>
        {dirty && <span className="muted">（{ctx.editLog.length} 处未发布改动）</span>}
      </span>
      <span className="badge">
        <span className={`dot ${errorCount ? "red" : "green"}`} />
        {errorCount ? `${errorCount} 个阻断错误` : warnCount ? `${warnCount} 个警告` : "草稿可发布"}
      </span>
      <div className="spacer" />
      {ctx.published && (
        <span className="badge" title={`已发布版本 ${ctx.published.id}`}>
          正式 <b className="mono">{ctx.published.id}</b>
          <span className="muted mono">serial {ctx.published.serial}</span>
        </span>
      )}
      {busy && <span className="badge muted">处理中…</span>}
    </div>
  );
}
