import type { RR, RRType, RData, AnswerKind, RRSource } from '@shared/types.js';
import { renderRdata, displayName } from './display.js';

export function RRText({ rr, zoneName }: { rr: RR; zoneName: string }) {
  return (
    <span className="rr-text">
      <span className="rr-name">{displayName(rr.name, zoneName)}</span>
      <span className="rr-ttl">{rr.ttl}</span>
      <span className="rr-type">{rr.type}</span>
      <span className="rr-data">{renderRdata(rr.type, rr.rdata)}</span>
    </span>
  );
}

const KIND_STYLE: Record<AnswerKind, { cls: string; label: string; title: string }> = {
  ANSWER: { cls: 'k-answer', label: '权威应答 ANSWER (AA)', title: '本区给出最终数据' },
  NODATA: { cls: 'k-nodata', label: 'NODATA (名字在/无此类型)', title: '名字存在但没有所问类型，NOERROR + SOA' },
  NXDOMAIN: { cls: 'k-nxdomain', label: 'NXDOMAIN (名字不存在)', title: '名字在区内不存在，SOA 否定应答' },
  CNAME_MISS: { cls: 'k-nodata', label: 'CNAME 链终结·无此类型', title: '别名目标存在但无请求类型' },
  CNAME_NXDOMAIN: { cls: 'k-nxdomain', label: 'CNAME 链终结·名字不存在', title: '别名目标在区内不存在' },
  CNAME_LOOP: { cls: 'k-loop', label: 'CNAME 环', title: '别名链形成环，链路停止' },
  CNAME_EXTERNAL: { cls: 'k-external', label: 'CNAME 指向区外·链止', title: '本区责任到 CNAME 为止' },
  REFERRAL: { cls: 'k-referral', label: '委派转介 REFERRAL (非 AA)', title: '父区域只给子域 NS 与胶水' },
  OUT_OF_ZONE: { cls: 'k-out', label: '区外名字 REFUSED', title: '本服务器对该名字无权威' },
};

export function KindBadge({ kind }: { kind: AnswerKind }) {
  const s = KIND_STYLE[kind];
  return <span className={`kind-badge ${s.cls}`} title={s.title}>{s.label}</span>;
}

const SOURCE_LABEL: Record<RRSource, string> = {
  exact: '精确名字',
  wildcard: '通配合成',
  glue: '胶水记录',
  'soa-negative': '否定应答 SOA',
};

export function SourceTag({ source }: { source: RRSource }) {
  return <span className={`source-tag src-${source}`}>{SOURCE_LABEL[source]}</span>;
}

// ---------- rdata 编辑表单 ----------

export interface FieldDef {
  key: keyof RData;
  label: string;
  placeholder?: string;
  width?: number;
}

export const RDATA_FIELDS: Record<RRType, FieldDef[]> = {
  A: [{ key: 'address', label: 'IPv4 地址', placeholder: '10.0.0.10' }],
  AAAA: [{ key: 'address', label: 'IPv6 地址', placeholder: 'fd00::1' }],
  NS: [{ key: 'target', label: '权威服务器名字', placeholder: 'ns1 或 ns1.example.com.' }],
  PTR: [{ key: 'target', label: '指向名字', placeholder: 'host' }],
  CNAME: [{ key: 'target', label: '别名目标', placeholder: 'app 或 app.lab.internal.' }],
  MX: [
    { key: 'preference', label: '优先级', placeholder: '10', width: 4 },
    { key: 'exchange', label: '邮件交换器', placeholder: 'mail' },
  ],
  TXT: [{ key: 'text', label: '文本', placeholder: 'v=spf1 -all' }],
  SRV: [
    { key: 'priority', label: '优先级', width: 4 },
    { key: 'weight', label: '权重', width: 4 },
    { key: 'port', label: '端口', width: 4 },
    { key: 'target', label: '目标' },
  ],
  CAA: [
    { key: 'flags', label: 'flags', width: 4 },
    { key: 'tag', label: 'tag (issue/issuewild/iodef)', width: 6 },
    { key: 'value', label: 'value' },
  ],
  SOA: [
    { key: 'mname', label: '主服务器' },
    { key: 'rname', label: '管理员邮箱(主机名形式)' },
    { key: 'serial', label: 'serial', width: 6 },
    { key: 'refresh', label: 'refresh', width: 4 },
    { key: 'retry', label: 'retry', width: 4 },
    { key: 'expire', label: 'expire', width: 4 },
    { key: 'minimum', label: 'minimum/否定TTL', width: 4 },
  ],
};

export function RdataFields({
  type, values, onChange,
}: {
  type: RRType;
  values: Record<string, string>;
  onChange: (key: string, v: string) => void;
}) {
  return (
    <div className="rdata-fields">
      {RDATA_FIELDS[type].map((f) => (
        <label key={String(f.key)} className={f.width ? `w${f.width}` : ''}>
          <span>{f.label}</span>
          <input
            value={values[String(f.key)] ?? ''}
            placeholder={f.placeholder}
            onChange={(e) => onChange(String(f.key), e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

export function rdataToInputs(rr: RR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rr.rdata)) out[k] = String(v);
  return out;
}
