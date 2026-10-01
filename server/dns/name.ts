// 域名规范化与基本判断。
// 区域内统一使用小写 FQDN（末尾带点）。根标记为 "."。

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const UNDERSCORE_LABEL_RE = /^_[a-z0-9]([a-z0-9-_.]{0,61}[a-z0-9])?$/;

/** 把用户输入的名字规范化为小写 FQDN。允许相对名（拼到区域名后）。 */
export function canonicalizeName(input: string, zoneName: string): string {
  const raw = input.trim();
  if (!raw) throw new DnsNameError('名字为空');
  let s = raw.toLowerCase();
  // 去掉末尾点以统一处理，再决定是否拼区域名
  const absolute = s.endsWith('.');
  if (absolute) s = s.slice(0, -1);
  if (s.length === 0) return '.'; // 根
  const labels = s.split('.');
  for (const label of labels) validateLabel(label);
  let name = labels.join('.') + '.';
  if (!absolute) {
    // 相对名：若已经是区域名本身或其下缀则保持；否则拼接到区域名
    if (zoneName !== '.') {
      if (name === zoneName || isSubName(name, zoneName)) {
        // 用户写了完整后缀却没加点，仍视为绝对
        return name;
      }
      name = name === '.' ? zoneName : labels.join('.') + '.' + zoneName;
    }
  }
  return name;
}

function validateLabel(label: string): void {
  if (label.length === 0) throw new DnsNameError('存在空标签（连续的点）');
  if (label.length > 63) throw new DnsNameError(`标签过长: ${label}`);
  if (label === '*') return; // 通配标签
  if (label.startsWith('*')) {
    throw new DnsNameError('通配符 "*" 只能作为完整的最左标签，不能与其他字符混写');
  }
  if (UNDERSCORE_LABEL_RE.test(label)) return;
  if (!LABEL_RE.test(label)) {
    throw new DnsNameError(`非法标签: "${label}"（仅允许字母、数字、连字符）`);
  }
}

export class DnsNameError extends Error {}

/** a 是否等于 b */
export function namesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** child 是否为 parent 的严格子名（parent 是根时总成立） */
export function isSubName(child: string, parent: string): boolean {
  if (parent === '.') return child !== '.';
  return child !== parent && child.endsWith('.' + parent);
}

/** child 等于 parent 或是其子名 */
export function isNameInZone(name: string, zoneName: string): boolean {
  if (zoneName === '.') return true;
  return name === zoneName || isSubName(name, zoneName);
}

/** 去掉最左标签，返回父名；对区域起点返回 null */
export function parentName(name: string): string | null {
  if (name === '.') return null;
  const noDot = name.slice(0, -1);
  const idx = noDot.indexOf('.');
  if (idx === -1) return '.';
  return noDot.slice(idx + 1) + '.';
}

/** 最左标签 */
export function leftmostLabel(name: string): string {
  const noDot = name === '.' ? '' : name.slice(0, -1);
  const idx = noDot.indexOf('.');
  return idx === -1 ? noDot : noDot.slice(0, idx);
}

/** 是否为通配拥有者（最左标签是 *） */
export function isWildcardName(name: string): boolean {
  return leftmostLabel(name) === '*';
}

/**
 * 通配模板是否能合成出目标名。
 * 规则（RFC 4592 的实际权威语义）：通配只匹配“比某已存在节点恰好多一层”
 * 的名字，即 wildcardName 去掉 "*." 后必须等于 target 的父名。
 */
export function wildcardMatches(wildcardName: string, targetName: string): boolean {
  if (!isWildcardName(wildcardName)) return false;
  const suffix = wildcardName.slice(2); // 去掉 "*."
  const parent = parentName(targetName);
  return parent === suffix;
}

/** 展示用相对名：属于区域则去掉区域后缀 */
export function displayName(name: string, zoneName: string): string {
  if (name === zoneName) return '@';
  if (isSubName(name, zoneName)) return name.slice(0, name.length - zoneName.length - 1);
  return name;
}
