// 名字与 RDATA 的规范化、展示文本、合法性检查。
// 本工具只处理普通的单标签通配 "*"，不支持电子邮件风格的 "\\000" 等转义，
// 但允许标签内常见的下划线（_sip._tcp）与连字符。
import type {
  QueryType,
  RData,
  RRType,
  ResourceRecord,
  SOAFields,
  Zone,
} from "../../shared/types.js";

export function normalizeName(raw: string): string {
  let s = (raw ?? "").trim().toLowerCase();
  if (s === "@" || s === "") return "";
  if (s.endsWith(".")) s = s.slice(0, -1);
  return s;
}

/** 校验名字语法；通配仅允许作为最左标签 "*"。返回错误信息或 null。 */
export function validateNameSyntax(raw: string, label = "名字"): string | null {
  const name = normalizeName(raw);
  if (!name) return `${label}不能为空`;
  const labels = name.split(".");
  for (let i = 0; i < labels.length; i++) {
    const lab = labels[i];
    if (lab === "*") {
      if (i !== 0) return `通配符 * 只能作为最左标签（${name}）`;
      continue;
    }
    if (lab.length === 0) return `${label}含有空标签（${name}）`;
    if (lab.length > 63) return `${label}的标签超过 63 字符（${lab}）`;
    if (i === 0 && lab.startsWith("*") && lab !== "*") {
      return `不支持标签内通配（${lab}），只支持整标签 *`;
    }
    if (!/^[a-z0-9_]([a-z0-9_-]*[a-z0-9])?$/.test(lab)) {
      return `${label}含有非法标签 “${lab}”`;
    }
  }
  if (name.length > 253) return `${label}总长超过 253 字符`;
  return null;
}

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIPv6(s: string): boolean {
  // 轻量 IPv6 校验，覆盖压缩写法。
  const parts = s.split("::");
  if (parts.length > 2) return false;
  const group = /^[0-9a-f]{1,4}$/i;
  const countGroups = (p: string) =>
    p === "" ? 0 : p.split(":").filter((g) => group.test(g)).length ===
      (p.split(":").length)
      ? p.split(":").length
      : -1;
  if (parts.length === 1) {
    const gs = s.split(":");
    return gs.length === 8 && gs.every((g) => group.test(g));
  }
  const [a, b] = parts;
  const na = a === "" ? 0 : countGroups(a);
  const nb = b === "" ? 0 : countGroups(b);
  if (na < 0 || nb < 0) return false;
  return na + nb <= 7;
}

export function rdataToText(type: RRType, r: RData): string {
  switch (type) {
    case "A":
    case "AAAA":
      return r.value ?? "";
    case "CNAME":
    case "NS":
    case "PTR":
      return appendDot(r.value ?? "");
    case "MX":
      return `${r.priority ?? 0} ${appendDot(r.host ?? "")}`;
    case "SRV":
      return `${r.priority ?? 0} ${r.weight ?? 0} ${r.port ?? 0} ${appendDot(
        r.host ?? "",
      )}`;
    case "TXT":
      return quoteTxt(r.text ?? "");
    case "CAA":
      return `${r.flags ?? 0} ${r.tag ?? ""} ${quoteTxt(r.value ?? "")}`;
    default:
      return "";
  }
}

export function appendDot(name: string): string {
  const n = normalizeName(name);
  return n ? n + "." : ".";
}

function quoteTxt(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 把单条 rdata 文本解析为结构化形式；名字一律按 FQDN（无尾点）规范化。 */
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
      const err = validateNameSyntax(name, "目标名字");
      if (err) return { error: err };
      return { rdata: { value: name } };
    }
    case "MX": {
      const m = t.match(/^(\d+)\s+(\S+)$/);
      if (!m) return { error: "MX 格式应为 “优先级 目标主机.”" };
      const host = normalizeName(m[2]);
      const err = validateNameSyntax(host, "MX 目标");
      if (err) return { error: err };
      return {
        rdata: { priority: Number(m[1]), host },
      };
    }
    case "SRV": {
      const m = t.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
      if (!m) return { error: "SRV 格式应为 “优先级 权重 端口 目标.”" };
      const host = normalizeName(m[4]);
      const err = validateNameSyntax(host, "SRV 目标");
      if (err) return { error: err };
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
      if (t.length < 2 || !(t.startsWith('"') && t.endsWith('"'))) {
        return { error: "TXT 内容请用双引号包裹" };
      }
      const inner = t
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      return { rdata: { text: inner } };
    }
    case "CAA": {
      const m = t.match(/^(\d+)\s+(\S+)\s+"(.*)"$/s);
      if (!m) return { error: "CAA 格式应为：flags tag \"value\"" };
      return {
        rdata: { flags: Number(m[1]), tag: m[2], value: m[3] },
      };
    }
    default:
      return { error: "不支持的记录类型" };
  }
}

export function soaToText(soa: SOAFields): string {
  return `${appendDot(soa.mname)} ${appendDot(soa.rname)} ${soa.serial} ${
    soa.refresh
  } ${soa.retry} ${soa.expire} ${soa.minimum}`;
}

export function rrKey(r: Pick<ResourceRecord, "name" | "type">): string {
  return `${r.name}/${r.type}`;
}

export function isNameInZone(name: string, origin: string): boolean {
  if (name === origin) return true;
  return name.endsWith("." + origin);
}

/** 返回名字相对 origin 的标签数差：origin 自身为 0，子域为 1…… 区域外为 -1。 */
export function labelsBelow(name: string, origin: string): number {
  if (!isNameInZone(name, origin)) return -1;
  const a = name === origin ? 0 : name.slice(0, -(origin.length + 1)).split(".").length;
  return a;
}

export function isValidQueryType(t: string): t is QueryType {
  return t === "ANY" || RR_TYPE_SET.has(t as RRType);
}

export const RR_TYPE_SET = new Set<RRType>([
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
]);

export function makeZoneOrigin(): string {
  return "example.net";
}

export function defaultSoa(origin: string, serial = 1): SOAFields {
  return {
    mname: `ns1.${origin}`,
    rname: `hostmaster.${origin}`,
    serial,
    refresh: 7200,
    retry: 3600,
    expire: 1209600,
    minimum: 3600,
    ttl: 86400,
  };
}

export function emptyZone(origin: string): Zone {
  return { origin, soa: defaultSoa(origin), records: [] };
}
