// 前端使用的纯函数：RDATA 文本渲染/解析（与服务端展示语义保持一致）。
import type { QueryType, RData, RRType, SOAFields } from "./types";

export const RR_TYPE_OPTIONS: QueryType[] = [
  "A",
  "AAAA",
  "CNAME",
  "NS",
  "MX",
  "TXT",
  "SRV",
  "PTR",
  "CAA",
];

export function normalizeName(raw: string): string {
  let s = (raw ?? "").trim().toLowerCase();
  if (s === "@") return "";
  if (s.endsWith(".")) s = s.slice(0, -1);
  return s;
}

export function rdataToText(type: RRType | "SOA", r: RData): string {
  if (type === "SOA" && r.soa) {
    const s: SOAFields = r.soa;
    return `${dot(s.mname)} ${dot(s.rname)} ${s.serial} ${s.refresh} ${s.retry} ${s.expire} ${s.minimum}`;
  }
  switch (type) {
    case "A":
    case "AAAA":
      return r.value ?? "";
    case "CNAME":
    case "NS":
    case "PTR":
      return dot(r.value ?? "");
    case "MX":
      return `${r.priority ?? 0} ${dot(r.host ?? "")}`;
    case "SRV":
      return `${r.priority ?? 0} ${r.weight ?? 0} ${r.port ?? 0} ${dot(r.host ?? "")}`;
    case "TXT":
      return quote(r.text ?? "");
    case "CAA":
      return `${r.flags ?? 0} ${r.tag ?? ""} ${quote(r.value ?? "")}`;
    default:
      return "";
  }
}

function dot(n: string) {
  const v = normalizeName(n);
  return v ? v + "." : ".";
}
function quote(s: string) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function placeholderFor(type: RRType): string {
  switch (type) {
    case "A":
      return "192.0.2.10";
    case "AAAA":
      return "2001:db8::1";
    case "CNAME":
    case "NS":
    case "PTR":
      return "target.example.net.";
    case "MX":
      return "10 mail.example.net.";
    case "SRV":
      return "10 60 5060 sip.example.net.";
    case "TXT":
      return '"v=spf1 -all"';
    case "CAA":
      return '0 issue "letsencrypt.org"';
    default:
      return "";
  }
}

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIPv6(s: string): boolean {
  const parts = s.split("::");
  if (parts.length > 2) return false;
  const group = /^[0-9a-f]{1,4}$/i;
  const count = (p: string): number => {
    if (p === "") return 0;
    const gs = p.split(":");
    return gs.every((g) => group.test(g)) ? gs.length : -1;
  };
  if (parts.length === 1) {
    const gs = s.split(":");
    return gs.length === 8 && gs.every((g) => group.test(g));
  }
  const na = count(parts[0]);
  const nb = count(parts[1]);
  return na >= 0 && nb >= 0 && na + nb <= 7;
}

export function nameSyntaxOk(raw: string): boolean {
  const name = normalizeName(raw);
  if (!name) return false;
  const labels = name.split(".");
  for (let i = 0; i < labels.length; i++) {
    const lab = labels[i];
    if (lab === "*") {
      if (i !== 0) return false;
      continue;
    }
    if (lab.length === 0 || lab.length > 63) return false;
    if (i === 0 && lab.startsWith("*") && lab !== "*") return false;
    if (!/^[a-z0-9_]([a-z0-9_-]*[a-z0-9])?$/.test(lab)) return false;
  }
  return name.length <= 253;
}

export function parseRdata(
  type: RRType,
  text: string,
): { rdata?: RData; error?: string } {
  const t = text.trim();
  switch (type) {
    case "A":
      if (!IPV4.test(t)) return { error: "不是合法 IPv4 地址" };
      return { rdata: { value: t } };
    case "AAAA":
      if (!isIPv6(t)) return { error: "不是合法 IPv6 地址" };
      return { rdata: { value: t.toLowerCase() } };
    case "CNAME":
    case "NS":
    case "PTR": {
      const name = normalizeName(t);
      if (!nameSyntaxOk(name)) return { error: "目标名字不合法" };
      return { rdata: { value: name } };
    }
    case "MX": {
      const m = t.match(/^(\d+)\s+(\S+)$/);
      if (!m) return { error: "格式：优先级 目标主机." };
      const host = normalizeName(m[2]);
      if (!nameSyntaxOk(host)) return { error: "MX 目标不合法" };
      return { rdata: { priority: Number(m[1]), host } };
    }
    case "SRV": {
      const m = t.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
      if (!m) return { error: "格式：优先级 权重 端口 目标." };
      const host = normalizeName(m[4]);
      if (!nameSyntaxOk(host)) return { error: "SRV 目标不合法" };
      return {
        rdata: {
          priority: Number(m[1]),
          weight: Number(m[2]),
          port: Number(m[3]),
          host,
        },
      };
    }
    case "TXT": {
      if (t.length < 2 || !(t.startsWith('"') && t.endsWith('"')))
        return { error: 'TXT 内容请用双引号包裹，如 "hello"' };
      const inner = t
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      return { rdata: { text: inner } };
    }
    case "CAA": {
      const m = t.match(/^(\d+)\s+(\S+)\s+"(.*)"$/s);
      if (!m) return { error: '格式：flags tag "value"' };
      return { rdata: { flags: Number(m[1]), tag: m[2], value: m[3] } };
    }
    default:
      return { error: "不支持的类型" };
  }
}

export function uid(prefix = "e"): string {
  return prefix + "_" + Math.random().toString(36).slice(2, 10);
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function isNameInZone(name: string, origin: string): boolean {
  if (name === origin) return true;
  return name.endsWith("." + origin);
}
