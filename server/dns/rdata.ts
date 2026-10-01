// 各记录类型 rdata 的解析、规范化与渲染。
import type { RRType, RData } from '../../shared/types.js';
import { canonicalizeName, DnsNameError } from './name.js';

export interface RdataContext {
  zoneName: string;
}

function parseUInt(input: string, field: string, min: number, max: number): number {
  if (!/^\d+$/.test(input.trim())) {
    throw new RdataError(`${field} 必须是非负整数，收到: "${input}"`);
  }
  const v = Number(input.trim());
  if (v < min || v > max) throw new RdataError(`${field} 超出范围 [${min}, ${max}]: ${v}`);
  return v;
}

export class RdataError extends Error {}

/**
 * 把表单提交的字符串字段解析为规范化 RData。
 * fields 的键就是 RData 字段名。
 */
export function parseRdata(type: RRType, fields: Record<string, string>, ctx: RdataContext): RData {
  try {
    switch (type) {
      case 'A': {
        const address = fields.address?.trim() ?? '';
        if (!isIPv4(address)) throw new RdataError(`非法 IPv4 地址: ${address}`);
        return { address };
      }
      case 'AAAA': {
        const address = fields.address?.trim()?.toLowerCase() ?? '';
        if (!isIPv6(address)) throw new RdataError(`非法 IPv6 地址: ${address}`);
        return { address };
      }
      case 'NS':
      case 'PTR':
        return { target: canonicalizeName(fields.target ?? '', ctx.zoneName) };
      case 'CNAME':
        return { target: canonicalizeName(fields.target ?? '', ctx.zoneName) };
      case 'MX':
        return {
          preference: parseUInt(fields.preference ?? '', 'priority', 0, 65535),
          exchange: canonicalizeName(fields.exchange ?? '', ctx.zoneName),
        };
      case 'TXT': {
        const text = fields.text ?? '';
        if (text.length === 0) throw new RdataError('TXT 文本不能为空');
        return { text };
      }
      case 'SRV':
        return {
          priority: parseUInt(fields.priority ?? '', 'priority', 0, 65535),
          weight: parseUInt(fields.weight ?? '', 'weight', 0, 65535),
          port: parseUInt(fields.port ?? '', 'port', 0, 65535),
          target: canonicalizeName(fields.target ?? '', ctx.zoneName),
        };
      case 'CAA': {
        const tag = fields.tag?.trim() ?? '';
        if (!/^[a-z0-9]{1,15}$/i.test(tag)) throw new RdataError(`非法 CAA tag: ${tag}`);
        return {
          flags: parseUInt(fields.flags ?? '', 'flags', 0, 255),
          tag: tag.toLowerCase(),
          value: fields.value ?? '',
        };
      }
      case 'SOA':
        return {
          mname: canonicalizeName(fields.mname ?? '', ctx.zoneName),
          rname: canonicalizeName(fields.rname ?? '', ctx.zoneName),
          serial: parseUInt(fields.serial ?? '', 'serial', 0, 4294967295),
          refresh: parseUInt(fields.refresh ?? '', 'refresh', 0, 2147483647),
          retry: parseUInt(fields.retry ?? '', 'retry', 0, 2147483647),
          expire: parseUInt(fields.expire ?? '', 'expire', 0, 2147483647),
          minimum: parseUInt(fields.minimum ?? '', 'minimum', 0, 2147483647),
        };
      default:
        throw new RdataError(`不支持的类型: ${type}`);
    }
  } catch (e) {
    if (e instanceof DnsNameError) throw new RdataError(e.message);
    throw e;
  }
}

/** 渲染为单行展示文本（zone 风格） */
export function renderRdata(type: RRType, r: RData): string {
  switch (type) {
    case 'A':
    case 'AAAA':
      return r.address ?? '';
    case 'NS':
    case 'CNAME':
    case 'PTR':
      return r.target ?? '';
    case 'MX':
      return `${r.preference} ${r.exchange}`;
    case 'TXT':
      return `"${r.text}"`;
    case 'SRV':
      return `${r.priority} ${r.weight} ${r.port} ${r.target}`;
    case 'CAA':
      return `${r.flags} ${r.tag} "${r.value}"`;
    case 'SOA':
      return `${r.mname} ${r.rname} ${r.serial} ${r.refresh} ${r.retry} ${r.expire} ${r.minimum}`;
  }
}

/** 把 rdata 摊平为可编辑的字符串字段 */
export function rdataToFields(r: RData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) out[k] = String(v);
  return out;
}

/** 同类型两条 rdata 是否语义相同 */
export function rdataEqual(type: RRType, a: RData, b: RData): boolean {
  return renderRdata(type, a) === renderRdata(type, b);
}

function isIPv4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function isIPv6(s: string): boolean {
  // 接受标准缩写形式
  if (!s.includes(':')) return false;
  if ((s.match(/::/g) ?? []).length > 1) return false;
  const head = s.split('#')[0];
  void head;
  try {
    // 用 URL 技巧不可靠，改为手工展开校验
    return expandIPv6(s) !== null;
  } catch {
    return false;
  }
}

function expandIPv6(s: string): number[] | null {
  let sides = s.split('::');
  let left: string[] = [];
  let right: string[] = [];
  if (sides.length === 2) {
    left = sides[0] ? sides[0].split(':') : [];
    right = sides[1] ? sides[1].split(':') : [];
  } else if (sides.length === 1) {
    left = s.split(':');
  } else {
    return null;
  }
  if (left.length + right.length > 7 && s.includes('::')) return null;
  if (!s.includes('::') && left.length !== 8) return null;
  const groups: string[] = [];
  groups.push(...left);
  while (groups.length + right.length < 8) groups.push('0');
  groups.push(...right);
  if (groups.length !== 8) return null;
  const nums: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    nums.push(parseInt(g, 16));
  }
  return nums;
}
