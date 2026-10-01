// 区域语义校验：发布前必须通过的硬错误，以及不阻塞发布的警告。
// 每个问题尽量归因到导致它的草稿操作。
import type {
  RR, RRType, ValidationIssue, ValidationResult, DraftOp, ZoneMeta,
} from '../../shared/types.js';
import { isNameInZone, isSubName, isWildcardName } from './name.js';
import { rdataEqual } from './rdata.js';

interface Index {
  byName: Map<string, Map<RRType, RR[]>>;
  ownerNames: Set<string>;
}

function buildIndex(records: RR[]): Index {
  const byName = new Map<string, Map<RRType, RR[]>>();
  for (const rr of records) {
    let m = byName.get(rr.name);
    if (!m) {
      m = new Map();
      byName.set(rr.name, m);
    }
    const list = m.get(rr.type) ?? [];
    list.push(rr);
    m.set(rr.type, list);
  }
  return { byName, ownerNames: new Set(byName.keys()) };
}

/** 构建“指纹 -> 最近一次影响它的操作”，用于问题归因。 */
export function fingerprint(rr: RR): string {
  return `${rr.name}|${rr.type}|${canonicalRdata(rr)}`;
}

function canonicalRdata(rr: RR): string {
  return JSON.stringify(rr.rdata);
}

export function validateZone(
  meta: ZoneMeta,
  records: RR[],
  ops: DraftOp[] = [],
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const idx = buildIndex(records);

  const opFor = (rr: RR): string[] => {
    // 倒序找最近引用该记录指纹的操作
    const fp = fingerprint(rr);
    const ids: string[] = [];
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (op.kind === 'reset') continue;
      const candidates = op.kind === 'delete' ? [op.rr]
        : op.kind === 'add' ? [op.rr]
          : [op.after, op.before];
      if (candidates.some((c) => fingerprint(c) === fp)) {
        ids.push(op.id);
        break;
      }
    }
    return ids;
  };

  const push = (issue: ValidationIssue) => issues.push(issue);

  // 1) 区域起点必须有且仅有一条 SOA、至少一条 NS
  const apex = idx.byName.get(meta.zoneName);
  const soas = apex?.get('SOA') ?? [];
  const nss = apex?.get('NS') ?? [];
  if (soas.length === 0) {
    push({ severity: 'error', code: 'APEX_SOA_MISSING', message: `区域起点 ${meta.zoneName} 缺少 SOA 记录` });
  } else if (soas.length > 1) {
    push({
      severity: 'error', code: 'APEX_SOA_MULTIPLE',
      message: `区域起点只能有一条 SOA，当前有 ${soas.length} 条`,
      names: [meta.zoneName], opIds: soas.flatMap(opFor),
    });
  }
  if (nss.length === 0) {
    push({ severity: 'error', code: 'APEX_NS_MISSING', message: `区域起点 ${meta.zoneName} 缺少 NS 记录` });
  }

  // 2) 名字必须属于区域；SOA 只允许在起点
  for (const rr of records) {
    if (!isNameInZone(rr.name, meta.zoneName)) {
      push({
        severity: 'error', code: 'OUT_OF_ZONE_NAME',
        message: `记录名 ${rr.name} 不属于区域 ${meta.zoneName}`,
        names: [rr.name], opIds: opFor(rr),
      });
    }
    if (rr.type === 'SOA' && rr.name !== meta.zoneName) {
      push({
        severity: 'error', code: 'SOA_NOT_APEX',
        message: `SOA 只能位于区域起点，不能在 ${rr.name}`,
        names: [rr.name], opIds: opFor(rr),
      });
    }
  }

  // 3) 委派点与冲突
  // cut = 非起点且有 NS 的拥有者
  const cuts: { name: string; ns: RR[] }[] = [];
  for (const [name, sets] of idx.byName) {
    if (name === meta.zoneName) continue;
    const ns = sets.get('NS');
    if (ns && ns.length > 0) cuts.push({ name, ns });
  }

  for (const cut of cuts) {
    const sets = idx.byName.get(cut.name)!;
    // cut 处除 NS、必要 glue 外不应再有普通数据（DS 在真实 DNS 允许，此处未建模）
    for (const [type, list] of sets) {
      if (type === 'NS') continue;
      if (type === 'A' || type === 'AAAA') {
        // 仅当与 NS target 同名时可视为 glue；cut 自身的地址通常不应存在
        const targets = new Set(cut.ns.map((r) => r.rdata.target));
        if (!targets.has(cut.name)) {
          push({
            severity: 'error', code: 'CUT_OTHER_DATA',
            message: `委派点 ${cut.name} 同时持有 ${type} 记录；子域一旦委派，父区域不应把该名字当普通记录作答（该地址不属于 NS 目标胶水）`,
            names: [cut.name], opIds: list.flatMap(opFor),
          });
        }
        continue;
      }
      push({
        severity: 'error', code: 'CUT_OTHER_DATA',
        message: `委派点 ${cut.name} 同时持有 ${type} 记录，与 NS 委派冲突（父区域该名字应只作转介）`,
        names: [cut.name], opIds: list.flatMap(opFor),
      });
    }

    // cut 之下的任何普通记录都不应留在父区域（只有与 NS 目标同名的 glue 合法）
    const targets = new Set(cut.ns.map((r) => r.rdata.target));
    for (const [owner, ownerSets] of idx.byName) {
      if (!(owner !== cut.name && isSubName(owner, cut.name))) continue;
      for (const [type, list] of ownerSets) {
        const isGlue = (type === 'A' || type === 'AAAA') && targets.has(owner);
        if (!isGlue) {
          push({
            severity: 'error', code: 'BELOW_CUT_DATA',
            message: `记录 ${owner} ${type} 位于已委派子域 ${cut.name} 之下；委派后父区域不能对其作普通应答`,
            names: [owner], opIds: list.flatMap(opFor),
          });
        }
      }
    }

    // 区内 NS target 缺少 glue 警告
    for (const nsrr of cut.ns) {
      const t = nsrr.rdata.target!;
      if (isNameInZone(t, meta.zoneName) && (t === cut.name || isSubName(t, cut.name))) {
        const tnode = idx.byName.get(t);
        const hasGlue = !!(tnode && (tnode.get('A')?.length || tnode.get('AAAA')?.length));
        if (!hasGlue) {
          push({
            severity: 'warning', code: 'GLUE_MISSING',
            message: `委派点 ${cut.name} 的区内权威服务器 ${t} 缺少胶水 A/AAAA 记录，转介无法附带地址`,
            names: [t], opIds: opFor(nsrr),
          });
        }
      }
    }
  }

  // 4) CNAME 与同名其他类型冲突；CNAME 唯一
  for (const [name, sets] of idx.byName) {
    const cnames = sets.get('CNAME');
    if (!cnames) continue;
    if (cnames.length > 1) {
      push({
        severity: 'error', code: 'CNAME_MULTIPLE',
        message: `${name} 存在多条 CNAME；一个名字最多一条别名`,
        names: [name], opIds: cnames.flatMap(opFor),
      });
    }
    for (const [type, list] of sets) {
      if (type === 'CNAME') continue;
      push({
        severity: 'error', code: 'CNAME_CONFLICT',
        message: `${name} 同时有 CNAME 和 ${type} 记录；CNAME 不能与其他数据（除 DNSSEC 签名外）共存`,
        names: [name], opIds: [...cnames.flatMap(opFor), ...list.flatMap(opFor)],
      });
    }
    if (name === meta.zoneName) {
      push({
        severity: 'error', code: 'CNAME_AT_APEX',
        message: `区域起点 ${name} 不能是 CNAME（起点必须保留 SOA/NS）`,
        names: [name], opIds: cnames.flatMap(opFor),
      });
    }
  }

  // 5) 通配位置
  for (const name of idx.ownerNames) {
    if (isWildcardName(name)) {
      const suffix = name.slice(2);
      if (isWildcardName(suffix)) {
        push({
          severity: 'warning', code: 'WILDCARD_MULTI_LABEL',
          message: `通配 ${name} 的后缀中仍含 "*"；通配只能在最左标签，多层通配不产生匹配`,
          names: [name],
        });
      }
      const sets = idx.byName.get(name)!;
      if (sets.has('NS')) {
        push({
          severity: 'error', code: 'WILDCARD_NS',
          message: `通配拥有者 ${name} 不能持有 NS（委派点必须是确定名字）`,
          names: [name],
        });
      }
    }
  }

  // 6) 完全重复记录与同集 TTL 不一致
  const seen = new Map<string, RR>();
  for (const rr of records) {
    const fp = fingerprint(rr);
    const prev = seen.get(fp);
    if (prev) {
      if (prev.ttl === rr.ttl) {
        push({
          severity: 'warning', code: 'DUPLICATE_RR',
          message: `记录重复：${rr.name} ${rr.type} ${canonicalRdata(rr)}`,
          names: [rr.name], opIds: opFor(rr),
        });
      } else {
        push({
          severity: 'error', code: 'SAME_RR_DIFF_TTL',
          message: `${rr.name} ${rr.type} 存在内容相同但 TTL 不同的记录（${prev.ttl} vs ${rr.ttl}）`,
          names: [rr.name], opIds: opFor(rr),
        });
      }
    } else {
      seen.set(fp, rr);
    }
  }

  // 同 RRset 内 TTL 应一致
  for (const [, sets] of idx.byName) {
    for (const [, list] of sets) {
      const ttls = new Set(list.map((r) => r.ttl));
      if (ttls.size > 1) {
        push({
          severity: 'warning', code: 'RRSET_TTL_MISMATCH',
          message: `${list[0].name} 的 ${list[0].type} RRset 内 TTL 不一致：${[...ttls].join(', ')}`,
          names: [list[0].name], opIds: list.flatMap(opFor),
        });
      }
    }
  }

  // 7) CNAME 环（警告：可保存，预览会显示链路停止）
  const cnameTarget = new Map<string, string>();
  for (const [name, sets] of idx.byName) {
    const c = sets.get('CNAME')?.[0];
    if (c) cnameTarget.set(name, c.rdata.target!.toLowerCase());
  }
  for (const [start] of cnameTarget) {
    const visited = new Set<string>([start]);
    let cur = cnameTarget.get(start)!;
    let loop = false;
    for (let i = 0; i < 16; i++) {
      if (cur === start) { loop = true; break; }
      if (visited.has(cur)) break;
      visited.add(cur);
      const nxt = cnameTarget.get(cur);
      if (!nxt) break;
      cur = nxt;
    }
    if (loop) {
      push({
        severity: 'warning', code: 'CNAME_LOOP',
        message: `从 ${start} 出发的 CNAME 链形成环，查询将在环处停止`,
        names: [start],
      });
      break;
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  return { ok: errors.length === 0, issues };
}

// 保留给后续可能的语义化比较使用
export function rrsMatch(a: RR, b: RR): boolean {
  return a.name === b.name && a.type === b.type && rdataEqual(a.type, a.rdata, b.rdata);
}
