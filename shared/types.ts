// 前后端共享的领域模型与 API 契约。
// 区域内的名字一律以规范形式存储：FQDN、小写、末尾带点（如 "host.lab.internal."）。

export type RRType =
  | 'SOA'
  | 'NS'
  | 'A'
  | 'AAAA'
  | 'CNAME'
  | 'MX'
  | 'TXT'
  | 'SRV'
  | 'CAA'
  | 'PTR';

export const RR_TYPES: RRType[] = [
  'SOA', 'NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'PTR',
];

// 需要名字形态 rdata 的类型（指向区域内/外名字）
export const NAME_RDATA_TYPES: RRType[] = ['NS', 'CNAME', 'PTR'];

// 各类型 rdata 的 JSON 形态
export interface RData {
  // SOA
  mname?: string;   // 主服务器 FQDN
  rname?: string;   // 管理员邮箱（编码为主机名形式）
  serial?: number;
  refresh?: number;
  retry?: number;
  expire?: number;
  minimum?: number;
  // NS / CNAME / PTR
  target?: string;
  // A / AAAA
  address?: string;
  // MX
  preference?: number;
  exchange?: string;
  // TXT
  text?: string;
  // SRV
  priority?: number;
  weight?: number;
  port?: number;
  // CAA
  flags?: number;
  tag?: string;
  value?: string;
}

export interface RR {
  id: string;
  name: string; // FQDN
  type: RRType;
  ttl: number;
  rdata: RData;
}

// 草稿操作（带来源，用于把发布失败归因到具体一次改动）
export type DraftOp =
  | { id: string; at: string; client: string; kind: 'add'; rr: RR }
  | { id: string; at: string; client: string; kind: 'update'; before: RR; after: RR }
  | { id: string; at: string; client: string; kind: 'delete'; rr: RR }
  | { id: string; at: string; client: string; kind: 'reset' };

export interface ZoneMeta {
  zoneName: string; // 区域起点 FQDN，如 "lab.internal."
}

export interface ZoneData {
  records: RR[];
}

export interface DraftState {
  meta: ZoneMeta;
  records: RR[];
  revision: number;
  updatedAt: string;
  ops: DraftOp[];
}

export interface PublishedVersion {
  id: string;
  meta: ZoneMeta;
  records: RR[];
  serial: number;
  publishedAt: string;
  note?: string;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  names?: string[];
  opIds?: string[]; // 导致该问题的草稿操作
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

// ---------- 查询与应答 ----------

// 应答类别（区分"名字不存在"与"名字存在但无此类型"）
export type AnswerKind =
  | 'ANSWER'        // AA 权威最终应答（含 CNAME 链终结于本区数据）
  | 'NODATA'        // 名字存在（精确或通配合成），但无请求类型；SOA 权威否定应答
  | 'NXDOMAIN'      // 名字在本区内不存在；SOA 权威否定应答
  | 'CNAME_MISS'    // CNAME 链终点名字存在但无请求类型
  | 'CNAME_NXDOMAIN'// CNAME 链指向的名字在区内不存在
  | 'CNAME_LOOP'    // CNAME 自引用/成环，链在本区停止
  | 'CNAME_EXTERNAL'// CNAME 指向区域外，本区权威责任在链接处停止
  | 'REFERRAL'      // 子域委派：父区域返回转介（NS，非 AA）
  | 'OUT_OF_ZONE';  // 查询名不属于本区域，本服务器对其无权威

export type RRSource =
  | 'exact'      // 精确名字的记录
  | 'wildcard'   // 通配符合成
  | 'glue'       // 委派点胶水记录（父区域仅为转介而持有）
  | 'soa-negative'; // 否定应答权威段中的 SOA

export interface RRView {
  rr: RR;
  source: RRSource;
  synthesizedName?: string; // 通配合成时的查询名
  section: 'answer' | 'authority' | 'additional';
  note?: string;
}

export interface CnameChainHop {
  index: number;
  from: string;
  to: string;
  source: 'exact' | 'wildcard';
  inZone: boolean;
  outcome: string;
}

export interface QueryResponse {
  queryName: string;
  queryType: RRType | 'ANY';
  kind: AnswerKind;
  authoritative: boolean; // AA
  rcode: 'NOERROR' | 'NXDOMAIN' | 'REFUSED';
  answers: RRView[];
  authority: RRView[];
  additional: RRView[];
  cnameChain: CnameChainHop[];
  closestEncloser?: string;
  wildcardUsed?: string; // 实际命中的通配拥有者名
  cutName?: string;      // 命中的委派点
  explanation: string;
}

// ---------- 查询样例 ----------

export interface QuerySample {
  id: string;
  name: string;   // FQDN
  qtype: RRType | 'ANY';
  label?: string;
}

// ---------- API ----------

export interface BootState {
  meta: ZoneMeta;
  draft: DraftState;
  published: PublishedVersion | null;
  draftValidation: ValidationResult;
  samples: QuerySample[];
}

export interface DraftUpdateRequest {
  ops: Exclude<DraftOp, { kind: 'reset' }>[];
  baseRevision: number;
  client: string;
}

export interface DraftResetRequest {
  client: string;
}

export interface PublishRequest {
  client: string;
  note?: string;
}

export interface QueryRequest {
  name: string;
  qtype: RRType | 'ANY';
  // 显式指定依据：draft 或已发布版本 id；缺省=draft
  source?: string;
}

export interface QueryResultResponse {
  source: 'draft' | 'published';
  sourceVersionId: string;
  sourceLabel: string;
  sourceRevision: number;
  response: QueryResponse;
}

export type SampleEffect =
  | 'same'         // 两版本应答一致
  | 'changed'      // 应答发生变化
  | 'draft-error'; // 草稿无法权威评估（仅对比层面）

export interface SampleEffectEntry {
  sample: QuerySample;
  effect: SampleEffect;
  published: QueryResponse | null; // 尚无已发布版本时为 null
  draft: QueryResponse;
  reasons: string[];
}

export interface EffectsResponse {
  entries: SampleEffectEntry[];
}

export interface DraftUpdateResponse {
  draft: DraftState;
  validation: ValidationResult;
  // 与全部样例比对的影响概览
  effects: SampleEffectEntry[];
}

export interface PublishResponse {
  published: PublishedVersion;
  draft: DraftState;
  validation: ValidationResult;
}

export interface ApiError {
  error: string;
  code: string;
  currentRevision?: number;
}
