// 区域校验。错误（error）会阻止发布；警告（warning）只提示，不阻止。
// 每条发现尽量关联到记录 id 与草稿编辑 id，便于回答
// “是哪次草稿改动导致发布不能完成”。
import type {
  ResourceRecord,
  SOAFields,
  ValidationFinding,
  Zone,
} from "../../shared/types.js";
import {
  isNameInZone,
  labelsBelow,
  rdataToText,
  validateNameSyntax,
} from "./names.js";

export interface ZoneCut {
  name: string;
  ns: ResourceRecord[];
  nsTargets: string[];
}

/** 找出区域内的委派切点：非起点且拥有 NS RRset 的名字。 */
export function findZoneCuts(zone: Zone): ZoneCut[] {
  const byOwner = new Map<string, ResourceRecord[]>();
  for (const r of zone.records) {
    if (r.type !== "NS") continue;
    if (r.name === zone.origin) continue;
    const list = byOwner.get(r.name) ?? [];
    list.push(r);
    byOwner.set(r.name, list);
  }
  return [...byOwner.entries()]
    .map(([name, ns]) => ({
      name,
      ns,
      nsTargets: ns.map((r) => r.rdata.value!),
    }))
    .sort((a, b) => (a.name < b.name ? 1 : -1)); // 长名字优先
}

/** 严格包含 name 的最近切点（name 自身即切点时不算）。 */
export function cutAbove(name: string, cuts: ZoneCut[]): ZoneCut | null {
  let best: ZoneCut | null = null;
  for (const c of cuts) {
    if (name === c.name) continue;
    if (name.endsWith("." + c.name)) {
      if (!best || c.name.length > best.name.length) best = c;
    }
  }
  return best;
}

function editIdsOf(records: ResourceRecord[]): string[] | undefined {
  const ids = records.map((r) => r.editId).filter((x): x is string => !!x);
  return ids.length ? [...new Set(ids)] : undefined;
}

function soaFinding(soa: SOAFields): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  for (const [field, label] of [
    ["mname", "主域名服务器"],
    ["rname", "管理员邮箱"],
  ] as const) {
    const err = validateNameSyntax(soa[field], label);
    if (err) {
      out.push({ severity: "error", code: "soa-field", message: err });
    }
  }
  for (const [field, label] of [
    ["serial", "序列号"],
    ["refresh", "refresh"],
    ["retry", "retry"],
    ["expire", "expire"],
    ["minimum", "minimum"],
    ["ttl", "TTL"],
  ] as const) {
    const v = soa[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      out.push({
        severity: "error",
        code: "soa-field",
        message: `SOA ${label} 必须是非负整数`,
      });
    }
  }
  if (soa.ttl <= 0) {
    out.push({
      severity: "error",
      code: "soa-field",
      message: "SOA TTL 必须大于 0",
    });
  }
  return out;
}

export function validateZone(zone: Zone): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const originErr = validateNameSyntax(zone.origin, "区域起点");
  if (originErr) {
    findings.push({ severity: "error", code: "origin", message: originErr });
    return findings; // origin 不合法，后续判断无意义
  }
  findings.push(...soaFinding(zone.soa));

  const records = zone.records;

  // 1) 名字合法性 / 是否在区域内 / TTL
  for (const r of records) {
    const nameErr = validateNameSyntax(r.name, "记录名");
    if (nameErr) {
      findings.push({
        severity: "error",
        code: "bad-name",
        message: nameErr,
        name: r.name,
        type: r.type,
        recordIds: [r.id],
        editIds: editIdsOf([r]),
      });
      continue;
    }
    if (!isNameInZone(r.name, zone.origin)) {
      findings.push({
        severity: "error",
        code: "out-of-zone",
        message: `记录 ${r.name} ${r.type} 位于区域起点 ${zone.origin} 之外（通常是修改起点后遗留）`,
        name: r.name,
        type: r.type,
        recordIds: [r.id],
        editIds: editIdsOf([r]),
      });
    }
    if (r.ttl <= 0) {
      findings.push({
        severity: "error",
        code: "bad-ttl",
        message: `${r.name} ${r.type} 的 TTL 必须大于 0`,
        name: r.name,
        type: r.type,
        recordIds: [r.id],
      });
    }
  }

  const byOwner = new Map<string, ResourceRecord[]>();
  for (const r of records) {
    const list = byOwner.get(r.name) ?? [];
    list.push(r);
    byOwner.set(r.name, list);
  }

  // 2) CNAME 共存冲突
  for (const [owner, list] of byOwner) {
    const cnames = list.filter((r) => r.type === "CNAME");
    if (cnames.length === 0) continue;

    if (owner === zone.origin) {
      findings.push({
        severity: "error",
        code: "cname-at-apex",
        message: `区域起点 ${zone.origin} 不能拥有 CNAME 记录（起点必须同时存在 SOA 与 NS）`,
        name: owner,
        type: "CNAME",
        recordIds: list.map((r) => r.id),
        editIds: editIdsOf(list),
      });
      continue;
    }
    if (cnames.length > 1) {
      findings.push({
        severity: "error",
        code: "cname-multiple",
        message: `名字 ${owner} 上存在 ${cnames.length} 条 CNAME；一个名字至多有一条 CNAME`,
        name: owner,
        type: "CNAME",
        recordIds: cnames.map((r) => r.id),
        editIds: editIdsOf(cnames),
      });
    }
    const others = list.filter((r) => r.type !== "CNAME");
    if (others.length > 0) {
      findings.push({
        severity: "error",
        code: "cname-coexistence",
        message: `名字 ${owner} 同时存在 CNAME 与 ${[
          ...new Set(others.map((r) => r.type)),
        ].join("/")}；CNAME 记录必须独占该名字`,
        name: owner,
        recordIds: list.map((r) => r.id),
        editIds: editIdsOf(list),
      });
    }
  }

  // 3) 区域内 CNAME 环（含自指）
  const cnameMap = new Map<string, { target: string; rec: ResourceRecord }>();
  for (const r of records) {
    if (r.type === "CNAME") cnameMap.set(r.name, { target: r.rdata.value!, rec: r });
  }
  const reportedCycles = new Set<string>();
  for (const start of cnameMap.keys()) {
    const seen: string[] = [];
    let cur: string | undefined = start;
    const chainRecs: ResourceRecord[] = [];
    while (cur && cnameMap.has(cur) && isNameInZone(cur, zone.origin)) {
      if (seen.includes(cur)) {
        const cycleStart = seen.indexOf(cur);
        const cycleNodes = seen.slice(cycleStart);
        const key = [...cycleNodes].sort().join(",");
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          const recs = cycleNodes.map((n) => cnameMap.get(n)!.rec);
          findings.push({
            severity: "error",
            code: "cname-loop",
            message: `CNAME 构成环：${[...cycleNodes, cur].join(" → ")}`,
            name: start,
            type: "CNAME",
            recordIds: recs.map((r) => r.id),
            editIds: editIdsOf(recs),
          });
        }
        break;
      }
      seen.push(cur);
      const step: { target: string; rec: ResourceRecord } = cnameMap.get(cur)!;
      chainRecs.push(step.rec);
      cur = step.target;
    }
  }

  // 4) 起点 NS
  const apexNs = records.filter((r) => r.name === zone.origin && r.type === "NS");
  if (apexNs.length === 0) {
    findings.push({
      severity: "warning",
      code: "missing-apex-ns",
      message: `区域起点 ${zone.origin} 没有 NS 记录，区域无法被正常委派`,
      name: zone.origin,
      type: "NS",
    });
  }

  // 5) 委派切点：glue 与被遮蔽记录
  const cuts = findZoneCuts(zone);
  for (const cut of cuts) {
    const inBailiwick = cut.nsTargets.filter((t) => isNameInZone(t, cut.name));
    for (const target of inBailiwick) {
      const glue = records.filter(
        (r) =>
          r.name === target &&
          (r.type === "A" || r.type === "AAAA") &&
          labelsBelow(r.name, zone.origin) >= 0,
      );
      if (glue.length === 0) {
        findings.push({
          severity: "warning",
          code: "missing-glue",
          message: `委派 ${cut.name} 的权威服务器 ${target} 位于该子域内，但区域中没有提供 glue（A/AAAA）地址记录`,
          name: cut.name,
          type: "NS",
          recordIds: cut.ns.map((r) => r.id),
          editIds: editIdsOf(cut.ns),
        });
      }
    }

    const outOfZoneNs = cut.nsTargets.filter((t) => !isNameInZone(t, zone.origin));
    for (const target of outOfZoneNs) {
      const err = validateNameSyntax(target, "NS 目标");
      if (err) {
        findings.push({
          severity: "error",
          code: "bad-ns-target",
          message: `委派 ${cut.name} 的 NS 目标不合法：${err}`,
          name: cut.name,
          type: "NS",
          recordIds: cut.ns.filter((r) => r.rdata.value === target).map((r) => r.id),
        });
      }
    }
  }

  // 被切点遮蔽的父区残留记录（不阻止发布，但解析时按转介处理）
  for (const r of records) {
    if (r.type === "NS") continue; // 切点自身
    const cut = cutAbove(r.name, cuts);
    if (!cut) continue;
    const isGlue =
      (r.type === "A" || r.type === "AAAA") &&
      cut.nsTargets.includes(r.name) &&
      isNameInZone(r.name, cut.name);
    if (!isGlue) {
      findings.push({
        severity: "warning",
        code: "shadowed-by-delegation",
        message: `记录 ${r.name} ${r.type} 位于已委派子域 ${cut.name} 之下；父区域不会按普通记录回答该名字，应答将是到 ${cut.name} 的转介`,
        name: r.name,
        type: r.type,
        recordIds: [r.id],
        editIds: editIdsOf([r]),
      });
    }
  }

  // 6) 完全重复的记录
  const seen = new Map<string, ResourceRecord[]>();
  for (const r of records) {
    const key = `${r.name}|${r.type}|${r.ttl}|${rdataToText(r.type, r.rdata)}`;
    const list = seen.get(key) ?? [];
    list.push(r);
    seen.set(key, list);
  }
  for (const [, list] of seen) {
    if (list.length > 1) {
      findings.push({
        severity: "warning",
        code: "duplicate-rr",
        message: `完全相同的 ${list[0].name} ${list[0].type} 记录出现了 ${list.length} 次`,
        name: list[0].name,
        type: list[0].type,
        recordIds: list.map((r) => r.id),
        editIds: editIdsOf(list),
      });
    }
  }

  return findings;
}

export function hasErrors(findings: ValidationFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}
