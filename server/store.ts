// 本机持久化状态：单一 JSON 文件 + 原子写入；进程内互斥保证多次修改串行化。
// 已发布版本不可变；草稿带单调 revision 做乐观并发控制。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  BootState, DraftOp, DraftState, PublishedVersion, QuerySample, RR, RRType, ZoneMeta,
} from '../shared/types.js';
import { validateZone } from './dns/validate.js';
import { parseRdata } from './dns/rdata.js';

interface PersistShape {
  meta: ZoneMeta;
  draft: { records: RR[]; revision: number; updatedAt: string; ops: DraftOp[] };
  published: PublishedVersion | null;
  versions: PublishedVersion[];
  samples: QuerySample[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

export class ConflictError extends Error {
  code = 'REVISION_CONFLICT';
  currentRevision: number;
  constructor(currentRevision: number) {
    super(`草稿已被其他窗口更新（当前 revision=${currentRevision}），请刷新后基于最新草稿修改`);
    this.currentRevision = currentRevision;
  }
}

export class NoPublishedError extends Error {
  code = 'NO_PUBLISHED';
  constructor() {
    super('尚无已发布版本，草稿无法回到已发布状态');
  }
}

function rr(
  id: string, name: string, type: RRType, ttl: number,
  fields: Record<string, string>, zoneName: string,
): RR {
  return { id, name, type, ttl, rdata: parseRdata(type, fields, { zoneName }) };
}

function seedState(): PersistShape {
  const zoneName = 'lab.internal.';
  const z = (name: string) => (name === '@' ? zoneName : `${name}.${zoneName}`);

  const records: RR[] = [
    rr('seed-soa', z('@'), 'SOA', 3600, {
      mname: 'ns1.' + zoneName, rname: 'hostmaster.' + zoneName,
      serial: '2026100101', refresh: '7200', retry: '3600', expire: '1209600', minimum: '3600',
    }, zoneName),
    rr('seed-ns1', z('@'), 'NS', 86400, { target: 'ns1.' + zoneName }, zoneName),
    rr('seed-ns2', z('@'), 'NS', 86400, { target: 'ns2.' + zoneName }, zoneName),
    rr('seed-a-ns1', z('ns1'), 'A', 86400, { address: '10.0.0.11' }, zoneName),
    rr('seed-a-ns2', z('ns2'), 'A', 86400, { address: '10.0.0.12' }, zoneName),
    rr('seed-mx', z('@'), 'MX', 3600, { preference: '10', exchange: 'mail.' + zoneName }, zoneName),
    rr('seed-a-mail', z('mail'), 'A', 3600, { address: '10.0.0.25' }, zoneName),

    rr('seed-a-app', z('app'), 'A', 3600, { address: '10.0.1.10' }, zoneName),
    // www 是 app 的区内别名
    rr('seed-cname-www', z('www'), 'CNAME', 3600, { target: z('app') }, zoneName),
    // 通配：*.lab.internal
    rr('seed-wild', z('*'), 'A', 300, { address: '10.0.9.9' }, zoneName),

    // 已委派子域 eu（区内 NS 目标，带胶水）
    rr('seed-ns-eu1', z('eu'), 'NS', 86400, { target: 'ns1.eu.' + zoneName }, zoneName),
    rr('seed-ns-eu2', z('eu'), 'NS', 86400, { target: 'ns2.eu.' + zoneName }, zoneName),
    rr('seed-glue-eu1', z('ns1.eu'), 'A', 86400, { address: '10.1.0.11' }, zoneName),
    rr('seed-glue-eu2', z('ns2.eu'), 'A', 86400, { address: '10.1.0.12' }, zoneName),
  ];

  const meta: ZoneMeta = { zoneName };
  const now = new Date().toISOString();
  const draft: PersistShape['draft'] = { records, revision: 1, updatedAt: now, ops: [] };

  const samples: QuerySample[] = [
    { id: 's1', name: z('www'), qtype: 'A', label: 'www 别名取 app 地址' },
    { id: 's2', name: z('app'), qtype: 'A', label: 'app 精确 A' },
    { id: 's3', name: z('nope'), qtype: 'A', label: '不存在主机 NXDOMAIN' },
    { id: 's4', name: z('foo.eu'), qtype: 'A', label: '委派子域转介' },
    { id: 's5', name: z('random'), qtype: 'A', label: '通配一层匹配' },
    { id: 's6', name: z('a.b'), qtype: 'A', label: '多层不匹配' },
  ];

  return { meta, draft, published: null, versions: [], samples };
}

export class Store {
  private state: PersistShape | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  /** 串行执行变更，保证写-改-写的原子性 */
  async mutate<T>(fn: (s: PersistShape) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const s = await this.load();
      const result = fn(s);
      await this.persist();
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async read<T>(fn: (s: PersistShape) => T): Promise<T> {
    const s = await this.load();
    return fn(s);
  }

  private async load(): Promise<PersistShape> {
    if (this.state) return this.state;
    try {
      const raw = await fs.readFile(DATA_FILE, 'utf8');
      this.state = JSON.parse(raw) as PersistShape;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.state = seedState();
      await this.persist();
    }
    return this.state!;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    await fs.rename(tmp, DATA_FILE); // 同目录原子替换
  }

  // ---- 业务操作 ----

  async boot(): Promise<BootState> {
    return this.read((s) => ({
      meta: s.meta,
      draft: this.draftView(s),
      published: s.published,
      draftValidation: validateZone(s.meta, s.draft.records, s.draft.ops),
      samples: s.samples,
    }));
  }

  private draftView(s: PersistShape): DraftState {
    return {
      meta: s.meta,
      records: s.draft.records,
      revision: s.draft.revision,
      updatedAt: s.draft.updatedAt,
      ops: s.draft.ops,
    };
  }

  async applyOps(
    ops: Exclude<DraftOp, { kind: 'reset' }>[],
    baseRevision: number, client: string,
  ) {
    return this.mutate((s) => {
      if (s.draft.revision !== baseRevision) throw new ConflictError(s.draft.revision);
      const now = new Date().toISOString();
      let records = s.draft.records;
      const stamped: DraftOp[] = [];

      for (const incoming of ops) {
        // 服务端重新打时间戳，信任 op 内容
        const op: DraftOp = { ...incoming, at: now, client } as DraftOp;
        if (op.kind === 'add') {
          records = [...records, op.rr];
        } else if (op.kind === 'delete') {
          records = records.filter((r) => r.id !== op.rr.id);
        } else if (op.kind === 'update') {
          records = records.map((r) => (r.id === op.before.id ? { ...op.after, id: r.id } : r));
        }
        stamped.push(op);
      }

      s.draft = {
        ...s.draft,
        records,
        revision: s.draft.revision + 1,
        updatedAt: now,
        ops: [...s.draft.ops, ...stamped].slice(-500),
      };
      return { draft: this.draftView(s), validation: validateZone(s.meta, s.draft.records, s.draft.ops) };
    });
  }

  async resetDraft(client: string) {
    return this.mutate((s) => {
      if (!s.published) throw new NoPublishedError();
      const now = new Date().toISOString();
      const op: DraftOp = { id: randomUUID(), at: now, client, kind: 'reset' };
      s.draft = {
        records: s.published.records.map((r) => ({ ...r })),
        revision: s.draft.revision + 1,
        updatedAt: now,
        ops: [op],
      };
      return { draft: this.draftView(s), validation: validateZone(s.meta, s.draft.records, s.draft.ops) };
    });
  }

  async publish(client: string, note?: string) {
    return this.mutate((s) => {
      const validation = validateZone(s.meta, s.draft.records, s.draft.ops);
      if (!validation.ok) {
        const err = new Error('草稿存在阻塞发布的错误') as Error & { validation: typeof validation };
        err.validation = validation;
        throw err;
      }
      const now = new Date().toISOString();
      // 递增 SOA serial（取草稿 SOA 值与时间戳 serial 的较大者再 +1）
      let records = s.draft.records;
      const soa = records.find((r) => r.type === 'SOA' && r.name === s.meta.zoneName);
      if (soa) {
        const dateSerial = Number(now.slice(0, 10).replace(/-/g, '') + '00');
        const nextSerial = Math.max(soa.rdata.serial ?? 0, dateSerial) + 1;
        records = records.map((r) => r === soa ? { ...r, rdata: { ...r.rdata, serial: nextSerial } } : r);
      }
      const version: PublishedVersion = {
        id: 'v' + (s.versions.length + 1) + '-' + randomUUID().slice(0, 8),
        meta: s.meta,
        records,
        serial: soa?.rdata.serial ?? s.versions.length + 1,
        publishedAt: now,
        note,
      };
      s.versions.push(version);
      s.published = version;
      // 发布后草稿对齐新版本，revision 继续推进（防止旧窗口覆盖）
      s.draft = {
        records: records.map((r) => ({ ...r })),
        revision: s.draft.revision + 1,
        updatedAt: now,
        ops: [],
      };
      void client;
      return {
        published: version,
        draft: this.draftView(s),
        validation: validateZone(s.meta, s.draft.records, []),
      };
    });
  }

  async addSample(sample: Omit<QuerySample, 'id'>): Promise<QuerySample> {
    return this.mutate((s) => {
      const full: QuerySample = { ...sample, id: randomUUID() };
      s.samples.push(full);
      return full;
    });
  }

  async deleteSample(id: string): Promise<void> {
    return this.mutate((s) => {
      s.samples = s.samples.filter((x) => x.id !== id);
    });
  }

  getVersions() {
    return this.read((s) => [...s.versions].reverse());
  }

  findVersion(id: string) {
    return this.read((s) => s.versions.find((v) => v.id === id) ?? null);
  }

  getSamples() {
    return this.read((s) => s.samples);
  }

  getMeta() {
    return this.read((s) => s.meta);
  }

  getDraft() {
    return this.read((s) => this.draftView(s));
  }

  getPublished() {
    return this.read((s) => s.published);
  }
}

export const store = new Store();
