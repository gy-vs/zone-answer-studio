// 前后端共享的领域模型与 API 契约。
// 所有名字在区域内部一律使用小写、不带尾点的绝对名字（FQDN）表示，
// 区域起点 origin 例如 "example.net"，根区不在本工具支持范围内。

export const RR_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "NS",
  "SOA",
  "MX",
  "TXT",
  "PTR",
  "SRV",
  "CAA",
] as const;
export type RRType = (typeof RR_TYPES)[number];

/** 查询类型，ANY 是查询专用类型，不允许出现在记录里。 */
export type QueryType = RRType | "ANY";

/**
 * 记录数据。按类型使用结构化字段，避免把 "10 mail." 之类的文本
 * 在每次解析时重复切分。
 */
export interface RData {
  // A / AAAA / CNAME / NS / PTR
  value?: string; // IP 或域名
  // MX / SRV
  priority?: number;
  host?: string; // MX target / SRV target
  // TXT
  text?: string;
  // SRV
  weight?: number;
  port?: number;
  // CAA
  flags?: number;
  tag?: string;
  // 合成 SOA 应答记录（区域 SOA 的结构化镜像）
  soa?: SOAFields;
}

export interface ResourceRecord {
  id: string;
  name: string; // 绝对名字，小写无尾点
  type: RRType;
  ttl: number;
  rdata: RData;
  /** 该记录由哪次草稿编辑产生；已发布记录上不带此标记。 */
  editId?: string;
}

export interface SOAFields {
  mname: string; // 主域名服务器（无尾点 FQDN）
  rname: string; // 管理员邮箱（域名编码形式，无尾点）
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minimum: number;
  ttl: number;
}

export interface Zone {
  origin: string;
  soa: SOAFields;
  records: ResourceRecord[];
}

export interface EditLogEntry {
  id: string; // 编辑 id（前端生成的 uuid）
  at: number; // 时间戳 ms
  editorId: string;
  summary: string;
  /** 操作摘要的人类可读描述，用于“是哪次改动导致冲突”。 */
  action:
    | { kind: "add"; name: string; type: RRType; text: string }
    | { kind: "replace"; name: string; type: RRType; text: string }
    | {
        kind: "delete";
        name?: string;
        type?: RRType;
        text?: string;
      }
    | { kind: "soa"; fields: Partial<SOAFields> }
    | { kind: "origin"; from: string; to: string };
}

// ---------------- 校验 ----------------

export type Severity = "error" | "warning";

export interface ValidationFinding {
  severity: Severity;
  code: string;
  message: string;
  name?: string;
  type?: RRType;
  /** 关联的记录 id（可能有多条，如 CNAME 并存冲突的双方）。 */
  recordIds?: string[];
  /** 导致该问题的草稿编辑 id 列表。 */
  editIds?: string[];
}

// ---------------- 查询（权威语义） ----------------

/** 应答类别（对应用户关心的“名字不存在 vs 无此类型”等区分）。 */
export type AnswerKind =
  | "positive" // 名字存在且有所问类型（含 CNAME 链后的最终应答）
  | "nxdomain" // 名字不存在（NXDOMAIN）
  | "nodata" // 名字存在但没有所问类型（NOERROR + 空应答）
  | "referral" // 父区域转介（delegation）
  | "cname-target-external" // CNAME 指向区域外：本区能给出的链路到此停止
  | "cname-loop" // CNAME 环
  | "refused" // 查询名不在本区域管辖内
  | "invalid"; // 区域本身未通过校验，无法给出权威应答

export interface Provenance {
  /** 记录所属的名字节点。 */
  ownerName: string;
  /** 通配合成：真实拥有者是 *.x，应答名字是查询名。 */
  synthesizedFrom?: string;
  /** 该记录来自的区域版本标识。 */
  versionId: string;
  versionLabel: string;
  /** delegation 切点（仅 referral 时）。 */
  delegationPoint?: string;
  /** 该记录在报文里的角色。 */
  section: "answer" | "authority" | "additional";
  note?: string;
}

export interface AnswerRecord {
  id: string;
  name: string; // 应答中的拥有者（通配场景为合成名）
  type: RRType;
  ttl: number;
  rdata: RData;
  provenance: Provenance;
}

export interface CnameHop {
  index: number;
  alias: string; // 查询到该跳时的名字
  cnameRecord: AnswerRecord;
  target: string;
  targetStatus:
    | "in-zone-positive"
    | "in-zone-nodata"
    | "in-zone-nxdomain"
    | "delegated"
    | "out-of-zone";
  note: string;
}

export interface QueryResult {
  qname: string;
  qtype: QueryType;
  kind: AnswerKind;
  /** RFC 语义下的 RCODE / AA 标志，便于展示。 */
  rcode: "NOERROR" | "NXDOMAIN" | "REFUSED" | "SERVFAIL";
  authoritative: boolean;
  title: string; // 简短中文标题
  explanation: string; // 中文解释：为什么是这个类别
  answer: AnswerRecord[];
  authority: AnswerRecord[];
  additional: AnswerRecord[];
  cnameChain: CnameHop[];
  /** 参与决定该应答的关键名字（exact match / closest encloser / wildcard 等）。 */
  resolutionTrace: string[];
  zoneVersionId: string;
  zoneVersionLabel: string;
  /** 草稿态下附带的校验问题导致 invalid 时使用。 */
  blockedBy?: ValidationFinding[];
}

// ---------------- 版本 ----------------

export interface ZoneVersion {
  id: string; // v1, v2 ...
  serial: number;
  publishedAt: number;
  editorId: string;
  note: string;
  zone: Zone;
  /** 发布时包含的编辑。 */
  changes: EditLogEntry[];
}

// ---------------- 差异 ----------------

export type ChangeKind = "added" | "deleted" | "ttl" | "rdata";

export interface RecordChange {
  kind: ChangeKind;
  name: string;
  type: RRType;
  /** 展示用文本。 */
  before?: string;
  after?: string;
  editIds?: string[];
  /** 该记录在当前草稿中的 id。 */
  draftRecordId?: string;
}

export interface SoaChange {
  field: keyof SOAFields;
  before: string | number;
  after: string | number;
}

export interface ZoneDiff {
  originChanged?: { from: string; to: string };
  soa: SoaChange[];
  records: RecordChange[];
  counts: { added: number; deleted: number; modified: number };
}

// ---------------- 查询样例 ----------------

export interface QuerySample {
  id: string;
  qname: string;
  qtype: QueryType;
  label: string;
  createdAt: number;
  /** 最近一次对照结果（草稿 vs 已发布是否产生差异）。 */
  lastReview?: {
    at: number;
    same: boolean;
    publishedKind: AnswerKind;
    draftKind: AnswerKind;
  };
}

// ---------------- API ----------------

export interface EditorIdentity {
  editorId: string;
  label: string;
}

export interface MutateRequest {
  editor: EditorIdentity;
  /** 客户端持有的草稿修订号；不匹配则 409。 */
  baseRevision: number;
  operations: EditOperation[];
}

export type EditOperation =
  | { op: "setOrigin"; origin: string }
  | { op: "setSoa"; fields: Partial<SOAFields> }
  | {
      op: "addRecord";
      editId: string;
      name: string;
      type: RRType;
      ttl: number;
      rdata: RData;
    }
  | {
      op: "replaceRecord";
      editId: string;
      recordId: string;
      name: string;
      type: RRType;
      ttl: number;
      rdata: RData;
    }
  | { op: "deleteRecords"; editId: string; recordIds: string[] };

export interface MutateResponse {
  revision: number;
  zone: Zone;
  editLog: EditLogEntry[];
  findings: ValidationFinding[];
}

export interface PublishRequest {
  editor: EditorIdentity;
  baseRevision: number;
  note: string;
}

export interface PublishResponse {
  revision: number;
  version: ZoneVersion;
  zone: Zone;
  editLog: EditLogEntry[];
}

export interface DiscardResponse {
  revision: number;
  zone: Zone;
  editLog: EditLogEntry[];
  findings: ValidationFinding[];
}

export interface StateResponse {
  revision: number; // 草稿修订号（每次 mutate/publish/discard 单调递增）
  publishedRevision: number; // 已发布版本被并入草稿时的修订号
  draft: Zone;
  draftFindings: ValidationFinding[];
  editLog: EditLogEntry[];
  canPublish: boolean;
  published: ZoneVersion | null;
  history: Array<{
    id: string;
    serial: number;
    publishedAt: number;
    editorLabel: string;
    note: string;
    changesSummary: string[];
  }>;
  samples: QuerySample[];
}

export interface QueryRequest {
  qname: string;
  qtype: QueryType;
  /** draft | published | 历史版本 id */
  target: string;
}

export interface SampleReviewItem {
  sample: QuerySample;
  published: QueryResult;
  draft: QueryResult;
  changed: boolean;
  changes: string[];
}

export interface SamplesReviewResponse {
  revision: number;
  publishedVersionId: string;
  items: SampleReviewItem[];
}

export interface ApiError {
  error: string;
  code:
    | "bad-request"
    | "conflict"
    | "publish-blocked"
    | "not-found"
    | "invalid-target";
  conflict?: {
    currentRevision: number;
    currentEditor: string;
    /** 自客户端基线以来已发生的编辑摘要。 */
    newerEdits: EditLogEntry[];
    currentZone: Zone;
    findings: ValidationFinding[];
  };
  findings?: ValidationFinding[];
}
