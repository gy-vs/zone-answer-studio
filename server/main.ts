// HTTP 服务：/api/* 由本机权威状态支持；其余路径在开发模式交给 Vite，
// 在生产模式托管 dist/ 构建产物。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ApiError,
  EditorIdentity,
  MutateRequest,
  PublishRequest,
  QueryRequest,
  QuerySample,
  SampleReviewItem,
  SamplesReviewResponse,
  StateResponse,
} from "../shared/types.js";
import { isValidQueryType, normalizeName } from "./domain/names.js";
import { diffZones } from "./domain/diff.js";
import { resolveQuery, type VersionMeta } from "./domain/resolver.js";
import {
  PublishBlocked,
  RevisionConflict,
  ZoneStore,
} from "./store.js";

const PORT = Number(process.env.PORT ?? 5173);

const store = new ZoneStore();

// ---------------------------------------------------------------- helpers

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function checkEditor(e: any): EditorIdentity {
  if (!e || typeof e.editorId !== "string") throw httpError(400, "缺少编辑者标识");
  return {
    editorId: e.editorId.slice(0, 64),
    label: String(e.label ?? "编辑窗口").slice(0, 40),
  };
}

function httpError(status: number, message: string, extra?: Partial<ApiError>) {
  return Object.assign(new Error(message), { status, extra });
}

function conflictBody(err: RevisionConflict): ApiError {
  return {
    error: "草稿已被其他窗口更新（修订号冲突）",
    code: "conflict",
    conflict: {
      currentRevision: err.current.revision,
      currentEditor: err.current.editLog.at(-1)?.editorId ?? "",
      newerEdits: err.current.editLog,
      currentZone: err.current.draft,
      findings: err.findings,
    },
  };
}

// ---------------------------------------------------------------- state

function stateResponse(): StateResponse {
  const s = store.snapshot;
  const latest = store.latestPublished();
  const findings = store.draftFindings();
  return {
    revision: s.revision,
    publishedRevision: s.publishedRevision,
    draft: s.draft,
    draftFindings: findings,
    editLog: s.editLog,
    canPublish: !findings.some((f) => f.severity === "error"),
    published: latest,
    history: s.history.map((v) => ({
      id: v.id,
      serial: v.serial,
      publishedAt: v.publishedAt,
      editorLabel: v.editorId,
      note: v.note,
      changesSummary: v.changes.slice(0, 8).map((c) => c.summary),
    })),
    samples: s.samples,
  };
}

// ---------------------------------------------------------------- query

function resolveTarget(target: string): { zone: StateResponse["draft"]; vm: VersionMeta; blocking: ReturnType<ZoneStore["draftFindings"]> } | { error: ApiError } {
  const s = store.snapshot;
  if (target === "draft") {
    const findings = store.draftFindings();
    const blocking = findings.filter((f) => f.severity === "error");
    return {
      zone: s.draft,
      vm: { versionId: "draft", versionLabel: `草稿 r${s.revision}` },
      blocking,
    };
  }
  if (target === "published") {
    const v = store.latestPublished();
    if (!v) throw httpError(400, "尚无已发布版本");
    return { zone: v.zone, vm: { versionId: v.id, versionLabel: `${v.id}（serial ${v.serial}）` }, blocking: [] };
  }
  const v = store.getVersion(target);
  if (!v) throw httpError(404, `找不到历史版本 ${target}`);
  return { zone: v.zone, vm: { versionId: v.id, versionLabel: `历史版本 ${v.id}（serial ${v.serial}）` }, blocking: [] };
}

function answerSignature(r: SampleReviewItem["published"]): string {
  return JSON.stringify({
    kind: r.kind,
    answer: r.answer.map((a) => `${a.name} ${a.type} ${JSON.stringify(a.rdata)}`),
    authority: r.authority.map((a) => `${a.name} ${a.type}`),
  });
}

function buildSamplesReview(): SamplesReviewResponse {
  const s = store.snapshot;
  const latest = store.latestPublished();
  const draftFindings = store.draftFindings().filter((f) => f.severity === "error");
  const diff = latest ? diffZones(latest.zone, s.draft) : null;

  const items: SampleReviewItem[] = s.samples.map((sample) => {
    const pub = latest
      ? resolveQuery(
          latest.zone,
          { versionId: latest.id, versionLabel: `${latest.id}（serial ${latest.serial}）` },
          sample.qname,
          sample.qtype,
        )
      : null;

    const draft = resolveQuery(
      s.draft,
      { versionId: "draft", versionLabel: `草稿 r${s.revision}` },
      sample.qname,
      sample.qtype,
      draftFindings,
    );

    const changed = !pub || answerSignature(pub) !== answerSignature(draft);
    const changes: string[] = [];
    if (pub && pub.kind !== draft.kind) {
      changes.push(`应答类别：${pub.title} → ${draft.title}`);
    } else if (pub && answerSignature(pub) !== answerSignature(draft)) {
      changes.push("应答记录发生变化");
    }
    if (diff) {
      for (const c of diff.records) {
        if (
          nameTouches(c.name, sample.qname) ||
          (c.type === "NS" && sample.qname.endsWith("." + c.name))
        ) {
          const verb = c.kind === "added" ? "新增" : c.kind === "deleted" ? "删除" : "修改";
          if (!changes.some((x) => x.includes(`${c.name} ${c.type}`))) {
            changes.push(`相关记录${verb}：${c.name} ${c.type}`);
          }
        }
      }
    }
    return {
      sample,
      published:
        pub ??
        resolveQuery(
          s.draft,
          { versionId: "none", versionLabel: "尚未发布" },
          sample.qname,
          sample.qtype,
          [{ severity: "error", code: "no-publish", message: "尚无已发布版本" }],
        ),
      draft,
      changed,
      changes,
    };
  });

  // 异步回写评审标记，不阻塞响应
  void store.touchSampleReviews(
    items.map((it) => ({
      id: it.sample.id,
      same: !it.changed,
      publishedKind: it.published.kind,
      draftKind: it.draft.kind,
    })),
  );

  return {
    revision: s.revision,
    publishedVersionId: latest?.id ?? "",
    items,
  };
}

function nameTouches(owner: string, qname: string): boolean {
  if (owner === qname) return true;
  if (owner.startsWith("*.") && qname.endsWith(owner.slice(1))) {
    // 通配恰好一级
    const base = owner.slice(2);
    const prefix = qname.slice(0, -(base.length + 1));
    return prefix.length > 0 && !prefix.includes(".");
  }
  return false;
}

// ---------------------------------------------------------------- router

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const route = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (route === "/api/state" && method === "GET") {
      return send(res, 200, stateResponse());
    }

    if (route === "/api/query" && method === "POST") {
      const body = (await readJson(req)) as QueryRequest;
      const qname = normalizeName(body.qname ?? "");
      if (!qname) throw httpError(400, "qname 不能为空");
      if (!isValidQueryType(body.qtype)) throw httpError(400, "不支持的查询类型");
      const target = body.target || "draft";
      const t = resolveTarget(target);
      if ("error" in t) throw httpError(404, t.error.error, t.error);
      const result = resolveQuery(t.zone, t.vm, qname, body.qtype, t.blocking);
      return send(res, 200, result);
    }

    if (route === "/api/mutate" && method === "POST") {
      const body = (await readJson(req)) as MutateRequest;
      const editor = checkEditor(body.editor);
      if (typeof body.baseRevision !== "number") throw httpError(400, "缺少 baseRevision");
      if (!Array.isArray(body.operations) || body.operations.length === 0)
        throw httpError(400, "operations 为空");
      const { findings } = await store.applyMutations(body.baseRevision, editor, body.operations);
      return send(res, 200, {
        revision: store.currentRevision,
        zone: store.snapshot.draft,
        editLog: store.snapshot.editLog,
        findings,
      });
    }

    if (route === "/api/publish" && method === "POST") {
      const body = (await readJson(req)) as PublishRequest;
      const editor = checkEditor(body.editor);
      const version = await store.publish(body.baseRevision, editor, body.note ?? "");
      return send(res, 200, {
        revision: store.currentRevision,
        version,
        zone: store.snapshot.draft,
        editLog: store.snapshot.editLog,
      });
    }

    if (route === "/api/discard" && method === "POST") {
      const body = (await readJson(req));
      const { findings } = await store.discard(Number(body.baseRevision));
      return send(res, 200, {
        revision: store.currentRevision,
        zone: store.snapshot.draft,
        editLog: store.snapshot.editLog,
        findings,
      });
    }

    if (route === "/api/samples" && method === "GET") {
      return send(res, 200, { revision: store.currentRevision, samples: store.snapshot.samples });
    }

    if (route === "/api/samples" && method === "POST") {
      const body = await readJson(req);
      const qname = normalizeName(body.qname ?? "");
      if (!qname || !isValidQueryType(body.qtype)) throw httpError(400, "样例的查询名/类型不合法");
      const sample: Omit<QuerySample, "id" | "createdAt"> = {
        qname,
        qtype: body.qtype,
        label: String(body.label || qname).slice(0, 80),
      };
      const st = await store.addSample(sample);
      return send(res, 200, { revision: st.revision, samples: st.samples });
    }

    if (route === "/api/samples/review" && method === "GET") {
      return send(res, 200, buildSamplesReview());
    }

    if (route?.startsWith("/api/samples/") && method === "DELETE") {
      const id = route.split("/").pop()!;
      const st = await store.deleteSample(id);
      return send(res, 200, { revision: st.revision, samples: st.samples });
    }

    if (route === "/api/history" && method === "GET") {
      return send(res, 200, { revision: store.currentRevision, history: stateResponse().history });
    }

    if (route?.startsWith("/api/history/") && method === "GET") {
      const id = decodeURIComponent(route.split("/").pop()!);
      const v = store.getVersion(id);
      if (!v) throw httpError(404, `找不到版本 ${id}`);
      return send(res, 200, v);
    }

    throw httpError(404, `未知接口 ${route}`);
  } catch (e) {
    if (e instanceof RevisionConflict) {
      return send(res, 409, conflictBody(e));
    }
    if (e instanceof PublishBlocked) {
      return send(res, 422, {
        error: "存在阻断性校验错误，不能发布",
        code: "publish-blocked",
        findings: e.findings,
      } satisfies ApiError);
    }
    const err = e as { status?: number; message?: string; extra?: Partial<ApiError> };
    const status = err.status ?? 400;
    return send(res, status, {
      error: err.message ?? "请求处理失败",
      code:
        status === 404
          ? "not-found"
          : status === 409
            ? "conflict"
            : "bad-request",
      ...err.extra,
    } satisfies ApiError);
  }
}

// ---------------------------------------------------------------- static / vite

const DIST = join(process.cwd(), "dist");

async function main(): Promise<void> {
  let viteMiddleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | null =
    null;
  const forceDev = process.env.ZAS_MODE === "dev";
  if (forceDev || !existsSync(join(DIST, "index.html"))) {
    try {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
        configFile: join(process.cwd(), "vite.config.ts"),
      });
      viteMiddleware = vite.middlewares;
      console.log("[zas] 开发模式（Vite 中间件）");
    } catch (e) {
      console.error("[zas] Vite 启动失败：", e);
      process.exit(1);
    }
  } else {
    console.log("[zas] 生产模式（托管 dist/）");
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url).catch((e) => {
        send(res, 500, { error: String(e?.message ?? e), code: "bad-request" });
      });
      return;
    }
    if (viteMiddleware) {
      viteMiddleware(req, res, () => {
        res.writeHead(404);
        res.end("not found");
      });
      return;
    }
    serveStatic(res, url.pathname);
  });

  server.listen(PORT, () => {
    console.log(`[zas] Zone Answer Studio: http://localhost:${PORT}`);
    console.log(`[zas] 数据文件: ${process.env.ZAS_DATA_FILE ?? join(process.cwd(), "data", "state.json")}`);
  });
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const safe = pathname.includes("..") ? "/" : pathname;
  const filePath = join(DIST, safe === "/" ? "index.html" : safe);
  try {
    const data = readFileSync(filePath);
    const ext = filePath.split(".").pop();
    const type =
      ext === "js"
        ? "text/javascript"
        : ext === "css"
          ? "text/css"
          : ext === "html"
            ? "text/html; charset=utf-8"
            : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  } catch {
    // SPA 回退
    const index = readFileSync(join(DIST, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(index);
  }
}

main();
