// 服务端权威状态：草稿、已发布版本历史、查询样例。
// 持久化到本机 JSON 文件；所有写操作在同一事件循环中串行完成并整体落盘，
// 因此任何浏览器读到的状态都是某个完整版本，不会出现“新 SOA + 旧记录”的撕裂态。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AnswerKind,
  EditLogEntry,
  EditOperation,
  QuerySample,
  ResourceRecord,
  Zone,
  ZoneVersion,
} from "../shared/types.js";
import { defaultSoa, normalizeName } from "./domain/names.js";
import { hasErrors, validateZone } from "./domain/validator.js";

const DATA_FILE =
  process.env.ZAS_DATA_FILE ?? join(process.cwd(), "data", "state.json");

export interface PersistedState {
  revision: number;
  publishedRevision: number;
  draft: Zone;
  editLog: EditLogEntry[];
  history: ZoneVersion[];
  samples: QuerySample[];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function newId(prefix = "r"): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function seedState(): PersistedState {
  const origin = "example.net";
  const mk = (
    name: string,
    type: ResourceRecord["type"],
    ttl: number,
    rdata: ResourceRecord["rdata"],
  ): ResourceRecord => ({ id: newId(), name, type, ttl, rdata });

  const draft: Zone = {
    origin,
    soa: defaultSoa(origin, 1),
    records: [
      mk(origin, "NS", 86400, { value: `ns1.${origin}` }),
      mk(origin, "NS", 86400, { value: `ns2.${origin}` }),
      mk(`ns1.${origin}`, "A", 86400, { value: "192.0.2.10" }),
      mk(`ns2.${origin}`, "A", 86400, { value: "192.0.2.11" }),
      mk(`www.${origin}`, "A", 3600, { value: "192.0.2.20" }),
      mk(`app.${origin}`, "CNAME", 3600, { value: `www.${origin}` }),
      mk(`mail.${origin}`, "A", 3600, { value: "192.0.2.30" }),
      mk(origin, "MX", 3600, { priority: 10, host: `mail.${origin}` }),
      // 通配：*.example.net 指向一个固定页面服务器
      mk(`*.${origin}`, "A", 60, { value: "192.0.2.99" }),
    ],
  };

  const firstVersion: ZoneVersion = {
    id: "v1",
    serial: 1,
    publishedAt: Date.now(),
    editorId: "system",
    note: "初始区域",
    zone: clone(draft),
    changes: [],
  };
  // 已发布态的记录不携带草稿编辑标记
  stripEditIds(firstVersion.zone);

  return {
    revision: 1,
    publishedRevision: 1,
    draft,
    editLog: [],
    history: [firstVersion],
    samples: [
      {
        id: newId("s"),
        qname: `www.${origin}`,
        qtype: "A",
        label: "网站主机",
        createdAt: Date.now(),
      },
      {
        id: newId("s"),
        qname: `app.${origin}`,
        qtype: "A",
        label: "应用别名",
        createdAt: Date.now(),
      },
      {
        id: newId("s"),
        qname: `anything.${origin}`,
        qtype: "A",
        label: "通配匹配",
        createdAt: Date.now(),
      },
    ],
  };
}

function stripEditIds(zone: Zone): void {
  for (const r of zone.records) delete r.editId;
}

// ---------------------------------------------------------------------------

export class ZoneStore {
  private state: PersistedState;
  private saving = Promise.resolve();

  constructor() {
    this.state = this.load();
  }

  private load(): PersistedState {
    if (existsSync(DATA_FILE)) {
      try {
        const raw = JSON.parse(readFileSync(DATA_FILE, "utf8")) as PersistedState;
        if (raw && raw.draft && Array.isArray(raw.history)) return raw;
      } catch (e) {
        console.error(`[store] 状态文件无法解析，改用种子数据：${(e as Error).message}`);
      }
    }
    return seedState();
  }

  /** 串行化写盘，调用方在 await 之后即可确定已持久化。 */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.saving = this.saving.then(() => {
      mkdirSync(dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + ".tmp";
      writeFileSync(tmp, snapshot);
      renameSync(tmp, DATA_FILE);
    });
    return this.saving;
  }

  get snapshot(): PersistedState {
    return this.state;
  }

  get currentRevision(): number {
    return this.state.revision;
  }

  latestPublished(): ZoneVersion | null {
    return this.state.history[this.state.history.length - 1] ?? null;
  }

  getVersion(id: string): ZoneVersion | null {
    return this.state.history.find((v) => v.id === id) ?? null;
  }

  draftFindings() {
    return validateZone(this.state.draft);
  }

  // ---------------- 编辑 ----------------

  async applyMutations(
    baseRevision: number,
    editor: { editorId: string; label: string },
    operations: EditOperation[],
  ): Promise<{ state: PersistedState; findings: ReturnType<typeof validateZone> }> {
    if (baseRevision !== this.state.revision) {
      const err = new RevisionConflict(this.state, this.draftFindings());
      throw err;
    }
    const newLog: EditLogEntry[] = [];
    const now = Date.now();

    for (const op of operations) {
      const draft = this.state.draft;
      if (op.op === "setOrigin") {
        const from = draft.origin;
        const to = normalizeName(op.origin);
        draft.origin = to;
        newLog.push({
          id: newId("e"),
          at: now,
          editorId: editor.editorId,
          summary: `起点改为 ${to}`,
          action: { kind: "origin", from, to },
        });
      } else if (op.op === "setSoa") {
        Object.assign(draft.soa, op.fields);
        newLog.push({
          id: newId("e"),
          at: now,
          editorId: editor.editorId,
          summary: `编辑 SOA：${Object.keys(op.fields).join(", ")}`,
          action: { kind: "soa", fields: op.fields },
        });
      } else if (op.op === "addRecord") {
        const rec: ResourceRecord = {
          id: newId(),
          name: normalizeName(op.name),
          type: op.type,
          ttl: op.ttl,
          rdata: op.rdata,
          editId: op.editId,
        };
        draft.records.push(rec);
        newLog.push({
          // 日志条目直接采用客户端 editId，使“校验发现 → 记录 → 肇事编辑”三者可互相定位
          id: op.editId,
          at: now,
          editorId: editor.editorId,
          summary: `新增 ${rec.name} ${rec.type}`,
          action: {
            kind: "add",
            name: rec.name,
            type: rec.type,
            text: describeRr(rec),
          },
        });
      } else if (op.op === "replaceRecord") {
        const idx = draft.records.findIndex((r) => r.id === op.recordId);
        if (idx < 0) continue;
        const before = draft.records[idx];
        const rec: ResourceRecord = {
          id: newId(),
          name: normalizeName(op.name),
          type: op.type,
          ttl: op.ttl,
          rdata: op.rdata,
          editId: op.editId,
        };
        draft.records[idx] = rec;
        newLog.push({
          id: op.editId,
          at: now,
          editorId: editor.editorId,
          summary: `替换 ${rec.name} ${rec.type}`,
          action: {
            kind: "replace",
            name: rec.name,
            type: rec.type,
            text: describeRr(rec),
          },
        });
        void before;
      } else if (op.op === "deleteRecords") {
        const removed: ResourceRecord[] = [];
        draft.records = draft.records.filter((r) => {
          if (op.recordIds.includes(r.id)) {
            removed.push(r);
            return false;
          }
          return true;
        });
        for (let i = 0; i < removed.length; i++) {
          const r = removed[i];
          newLog.push({
            // 一次删除可能含多条记录：首条用 editId，其余加序号保证唯一
            id: i === 0 ? op.editId : `${op.editId}-${i}`,
            at: now,
            editorId: editor.editorId,
            summary: `删除 ${r.name} ${r.type}`,
            action: {
              kind: "delete",
              name: r.name,
              type: r.type,
              text: describeRr(r),
            },
          });
        }
      }
    }

    this.state.editLog.push(...newLog);
    this.state.revision += 1;
    await this.persist();
    return { state: this.state, findings: validateZone(this.state.draft) };
  }

  // ---------------- 发布 / 丢弃 ----------------

  async publish(
    baseRevision: number,
    editor: { editorId: string; label: string },
    note: string,
  ): Promise<ZoneVersion> {
    if (baseRevision !== this.state.revision) {
      throw new RevisionConflict(this.state, this.draftFindings());
    }
    const findings = validateZone(this.state.draft);
    if (hasErrors(findings)) {
      throw new PublishBlocked(findings);
    }

    const last = this.latestPublished();
    const nextSerial = Math.max(
      (last?.serial ?? 0) + 1,
      Math.floor(Date.now() / 1000),
      this.state.draft.soa.serial + 1,
    );
    this.state.draft.soa.serial = nextSerial;

    const version: ZoneVersion = {
      id: `v${(last ? Number(last.id.slice(1)) : 0) + 1}`,
      serial: nextSerial,
      publishedAt: Date.now(),
      editorId: editor.editorId,
      note: note.trim() || "发布草稿",
      zone: clone(this.state.draft),
      changes: clone(this.state.editLog),
    };
    stripEditIds(version.zone);
    this.state.history.push(version);
    this.state.revision += 1;
    this.state.publishedRevision = this.state.revision;
    // 发布后草稿以已发布版本为基线
    this.state.draft = clone(version.zone);
    this.state.editLog = [];
    await this.persist();
    return version;
  }

  async discard(baseRevision: number) {
    if (baseRevision !== this.state.revision) {
      throw new RevisionConflict(this.state, this.draftFindings());
    }
    const latest = this.latestPublished();
    if (latest) {
      this.state.draft = clone(latest.zone);
      this.state.editLog = [];
      this.state.revision += 1;
      await this.persist();
    }
    return { state: this.state, findings: validateZone(this.state.draft) };
  }

  // ---------------- 查询样例 ----------------
  // 样例是评审注解，不与草稿编辑争用修订号：增删样例不推进 revision。

  async addSample(sample: Omit<QuerySample, "id" | "createdAt">) {
    this.state.samples.push({
      ...sample,
      id: newId("s"),
      createdAt: Date.now(),
    });
    await this.persist();
    return this.state;
  }

  async deleteSample(id: string) {
    this.state.samples = this.state.samples.filter((s) => s.id !== id);
    await this.persist();
    return this.state;
  }

  async touchSampleReviews(
    reviewed: Array<{
      id: string;
      same: boolean;
      publishedKind: AnswerKind;
      draftKind: AnswerKind;
    }>,
  ) {
    // 评审结果只是注解，不与编辑争用修订号，静默更新即可。
    for (const r of reviewed) {
      const s = this.state.samples.find((x) => x.id === r.id);
      if (s) {
        s.lastReview = {
          at: Date.now(),
          same: r.same,
          publishedKind: r.publishedKind,
          draftKind: r.draftKind,
        };
      }
    }
    await this.persist();
  }
}

function describeRr(r: ResourceRecord): string {
  return `${r.ttl} ${r.type} ${JSON.stringify(r.rdata)}`;
}

export class RevisionConflict extends Error {
  constructor(
    public readonly current: PersistedState,
    public readonly findings: ReturnType<typeof validateZone>,
  ) {
    super("revision conflict");
  }
}

export class PublishBlocked extends Error {
  constructor(public readonly findings: ReturnType<typeof validateZone>) {
    super("publish blocked");
  }
}
