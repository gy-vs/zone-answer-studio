// 已发布版本与当前草稿之间的记录级差异。
import type {
  RecordChange,
  ResourceRecord,
  RRType,
  SOAFields,
  SoaChange,
  Zone,
  ZoneDiff,
} from "../../shared/types.js";
import { rdataToText } from "./names.js";

function rrSig(r: ResourceRecord): string {
  return rdataToText(r.type, r.rdata);
}

function rrText(r: ResourceRecord): string {
  return `${r.ttl}  ${rdataToText(r.type, r.rdata)}`;
}

function groupByRRset(zone: Zone) {
  const map = new Map<string, ResourceRecord[]>();
  for (const r of zone.records) {
    const key = `${r.name}|${r.type}`;
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return map;
}

const SOA_FIELDS: (keyof SOAFields)[] = [
  "mname",
  "rname",
  "serial",
  "refresh",
  "retry",
  "expire",
  "minimum",
  "ttl",
];

export function diffZones(published: Zone | null, draft: Zone): ZoneDiff {
  const records: RecordChange[] = [];
  let added = 0;
  let deleted = 0;
  let modified = 0;

  const pubMap = published
    ? groupByRRset(published)
    : new Map<string, ResourceRecord[]>();
  const draftMap = groupByRRset(draft);

  const allKeys = new Set([...pubMap.keys(), ...draftMap.keys()]);
  for (const key of [...allKeys].sort()) {
    const [name, type] = key.split("|") as [string, RRType];
    const pub = pubMap.get(key) ?? [];
    const drf = draftMap.get(key) ?? [];

    const pubSigs = new Map<string, ResourceRecord>(
      pub.map((r) => [rrSig(r), r]),
    );
    const drfSigs = new Map<string, ResourceRecord>(
      drf.map((r) => [rrSig(r), r]),
    );

    for (const [sig, r] of drfSigs) {
      if (!pubSigs.has(sig)) {
        const counterpart = pub[0];
        // 同名同类型但内容不同：视为修改（展示 before/after），
        // 而不是简单的一增一删。
        if (counterpart && pubSigs.size === 1 && drfSigs.size === 1) {
          const ttlChanged = counterpart.ttl !== r.ttl;
          records.push({
            kind: ttlChanged && rrSig(counterpart) === sig ? "ttl" : "rdata",
            name,
            type,
            before: rrText(counterpart),
            after: rrText(r),
            editIds: r.editId ? [r.editId] : undefined,
            draftRecordId: r.id,
          });
          modified++;
        } else {
          records.push({
            kind: "added",
            name,
            type,
            after: rrText(r),
            editIds: r.editId ? [r.editId] : undefined,
            draftRecordId: r.id,
          });
          added++;
        }
      }
    }
    for (const [sig, r] of pubSigs) {
      if (!drfSigs.has(sig)) {
        const counterpart = drf[0];
        if (counterpart && pubSigs.size === 1 && drfSigs.size === 1) {
          // 已在上面的修改分支处理
          continue;
        }
        records.push({
          kind: "deleted",
          name,
          type,
          before: rrText(r),
        });
        deleted++;
      }
    }
  }

  const soa: SoaChange[] = [];
  if (published) {
    for (const f of SOA_FIELDS) {
      if (published.soa[f] !== draft.soa[f]) {
        soa.push({ field: f, before: published.soa[f], after: draft.soa[f] });
      }
    }
  }

  return {
    originChanged:
      published && published.origin !== draft.origin
        ? { from: published.origin, to: draft.origin }
        : undefined,
    soa,
    records,
    counts: { added, deleted, modified },
  };
}

/** 判断一条记录变化（按名字/类型）是否可能影响某个查询的应答。 */
export function changeTouchesQuery(
  change: { name: string; type: RRType },
  qname: string,
  origin: string,
): boolean {
  // 精确拥有者 / NS 切点 / glue 目标 / CNAME 目标 等都按名字前缀近似：
  // 宁可多报“受影响样例”，由用户打开对照确认；这里用于提醒而非证明等价。
  if (change.name === qname) return true;
  if (change.type === "NS" && qname.endsWith("." + change.name)) return true;
  if (change.name.endsWith("." + qname)) return true; // ENT 或通配上层变化
  if (("*." + qname) === change.name) return true;
  const qLabels = qname.split(".");
  for (let i = 1; i < qLabels.length; i++) {
    const wildcard = "*." + qLabels.slice(i).join(".");
    if (wildcard === change.name) return true;
  }
  if (change.name === origin) return true; // 起点 SOA/NS 变化影响 authority 段
  return false;
}
