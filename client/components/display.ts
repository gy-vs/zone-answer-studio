// 前端展示用的纯函数（与服务端解耦，避免把 server 模块打进浏览器包）。
import type { RR, RRType, RData } from '@shared/types.js';

/** 属于区域则显示相对名，起点显示 @ */
export function displayName(name: string, zoneName: string): string {
  if (name === zoneName) return '@';
  if (zoneName !== '.' && name.endsWith('.' + zoneName)) {
    return name.slice(0, name.length - zoneName.length - 1);
  }
  return name;
}

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

export function rdataToInputs(rr: RR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rr.rdata)) out[k] = String(v);
  return out;
}
