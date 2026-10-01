// HTTP API：全部状态来自服务端；草稿写操作带 revision 乐观锁。
import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DraftUpdateRequest, DraftResetRequest, PublishRequest, QueryRequest,
  RRType, RR, QuerySample,
} from '../shared/types.js';
import { store, ConflictError, NoPublishedError } from './store.js';
import { canonicalizeName, DnsNameError } from './dns/name.js';
import { parseRdata, RdataError } from './dns/rdata.js';
import { resolveSnapshot, effectsFor } from './query-service.js';

const RR_TYPES = new Set<RRType>(['SOA', 'NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'PTR']);

const app = express();
app.use(express.json({ limit: '2mb' }));

function bad(res: express.Response, code: string, message: string, extra: Record<string, unknown> = {}) {
  res.status(400).json({ error: message, code, ...extra });
}

app.get('/api/boot', async (_req, res) => {
  res.json(await store.boot());
});

// 规范化一条由前端提交的记录
function normalizeRecord(input: unknown, zoneName: string): RR {
  const body = input as Partial<RR> & { fields?: Record<string, string> };
  if (!body || typeof body !== 'object') throw new RdataError('记录格式不正确');
  const nameRaw = body.name;
  const type = body.type as RRType;
  if (typeof nameRaw !== 'string' || !nameRaw.trim()) throw new RdataError('记录名为空');
  if (!RR_TYPES.has(type)) throw new RdataError(`不支持的类型: ${type}`);
  const ttl = Number(body.ttl);
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 2147483647) throw new RdataError('TTL 必须是 0..2147483647 的整数');
  const name = canonicalizeName(nameRaw, zoneName);
  const rdata = parseRdata(type, body.fields ?? (body.rdata as unknown as Record<string, string>) ?? {}, { zoneName });
  return { id: body.id || randomUUID(), name, type, ttl, rdata };
}

app.post('/api/draft/ops', async (req, res) => {
  const body = req.body as DraftUpdateRequest;
  const meta = await store.getMeta();
  if (!body || !Array.isArray(body.ops) || typeof body.baseRevision !== 'number') {
    return bad(res, 'BAD_REQUEST', '需要 ops[] 与 baseRevision');
  }
  try {
    const ops = body.ops.map((op) => {
      const id = op.id || randomUUID();
      if (op.kind === 'add') {
        return { id, at: '', client: body.client || 'unknown', kind: 'add' as const, rr: normalizeRecord(op.rr, meta.zoneName) };
      }
      if (op.kind === 'delete') {
        return { id, at: '', client: body.client || 'unknown', kind: 'delete' as const, rr: normalizeRecord(op.rr, meta.zoneName) };
      }
      return {
        id, at: '', client: body.client || 'unknown', kind: 'update' as const,
        before: normalizeRecord(op.before, meta.zoneName),
        after: normalizeRecord(op.after, meta.zoneName),
      };
    });
    const result = await store.applyOps(ops, body.baseRevision, body.client || 'unknown');
    const state = await store.boot();
    res.json({
      draft: result.draft,
      validation: result.validation,
      effects: effectsFor(state.samples, state.published, result.draft),
    });
  } catch (e) {
    if (e instanceof ConflictError) {
      return res.status(409).json({ error: e.message, code: e.code, currentRevision: e.currentRevision });
    }
    if (e instanceof RdataError || e instanceof DnsNameError) {
      return bad(res, 'BAD_RR', e.message);
    }
    throw e;
  }
});

app.post('/api/draft/reset', async (req, res) => {
  const body = req.body as DraftResetRequest;
  try {
    await store.resetDraft(body.client || 'unknown');
    const state = await store.boot();
    res.json({ draft: state.draft, validation: state.draftValidation });
  } catch (e) {
    if (e instanceof NoPublishedError) return res.status(409).json({ error: e.message, code: e.code });
    throw e;
  }
});

app.post('/api/publish', async (req, res) => {
  const body = req.body as PublishRequest;
  try {
    const result = await store.publish(body.client || 'unknown', body.note);
    res.json(result);
  } catch (e) {
    const err = e as Error & { validation?: unknown };
    if (err.validation) {
      return res.status(422).json({ error: err.message, code: 'VALIDATION_FAILED', validation: err.validation });
    }
    throw e;
  }
});

app.post('/api/query', async (req, res) => {
  const body = req.body as QueryRequest;
  if (!body || typeof body.name !== 'string') return bad(res, 'BAD_REQUEST', '需要 name');
  const qtype = (body.qtype ?? 'A') as RRType | 'ANY';
  if (qtype !== 'ANY' && !RR_TYPES.has(qtype)) return bad(res, 'BAD_QTYPE', `不支持的查询类型: ${qtype}`);

  const source = body.source ?? 'draft';
  const state = await store.boot();

  if (source === 'draft') {
    const r = resolveSnapshot(state.meta, state.draft.records, body.name, qtype);
    if (!r.ok) return bad(res, 'BAD_NAME', r.error);
    return res.json({
      source: 'draft',
      sourceVersionId: 'draft',
      sourceLabel: `当前草稿 (revision ${state.draft.revision})`,
      sourceRevision: state.draft.revision,
      response: r.response,
    });
  }

  // 已发布：source 可以是 "published"（最新）或具体版本 id
  let version: import('../shared/types.js').PublishedVersion | null = state.published;
  if (source !== 'published') {
    version = await store.findVersion(source);
    if (!version) return res.status(404).json({ error: `找不到版本 ${source}`, code: 'VERSION_NOT_FOUND' });
  }
  if (!version) {
    return res.status(409).json({ error: '尚无已发布版本', code: 'NO_PUBLISHED' });
  }
  const r = resolveSnapshot(version.meta, version.records, body.name, qtype);
  if (!r.ok) return bad(res, 'BAD_NAME', r.error);
  res.json({
    source: 'published',
    sourceVersionId: version.id,
    sourceLabel: `已发布版本 ${version.id} (${version.publishedAt})`,
    sourceRevision: version.serial,
    response: r.response,
  });
});

app.get('/api/effects', async (_req, res) => {
  const state = await store.boot();
  res.json({ entries: effectsFor(state.samples, state.published, state.draft) });
});

app.get('/api/versions', async (_req, res) => {
  res.json(await store.getVersions());
});

app.get('/api/samples', async (_req, res) => {
  res.json(await store.getSamples());
});

app.post('/api/samples', async (req, res) => {
  const { name, qtype, label } = req.body as { name?: string; qtype?: RRType | 'ANY'; label?: string };
  const meta = await store.getMeta();
  if (!name) return bad(res, 'BAD_REQUEST', '需要 name');
  const qt = (qtype ?? 'A') as RRType | 'ANY';
  let cname: string;
  try {
    cname = canonicalizeName(name, meta.zoneName);
  } catch (e) {
    return bad(res, 'BAD_NAME', e instanceof DnsNameError ? e.message : '非法名字');
  }
  const sample: QuerySample = await store.addSample({ name: cname, qtype: qt, label });
  res.json(sample);
});

app.delete('/api/samples/:id', async (req, res) => {
  await store.deleteSample(req.params.id);
  res.status(204).end();
});

// 生产环境：托管构建后的前端（项目根/dist）
const webDist = path.resolve(process.cwd(), 'dist');
app.use(express.static(webDist));
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) next();
  });
});

// 统一错误处理
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: err.message, code: 'INTERNAL' });
});

const PORT = Number(process.env.PORT ?? 5174);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`zone-draft-preview server on http://localhost:${PORT}`);
});
