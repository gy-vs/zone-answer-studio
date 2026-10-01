// 权威查询解析：按区域语义（RFC 1034/2308/4592 的本地模型）回答
// “这份区域在给定查询下会给出什么”。
//
// 关键语义：
// - 委派切点（非起点的 NS）之下的任何名字：父区返回转介（referral，AA=0），
//   authority 放切点 NS，additional 放 in-bailiwick glue；父区不再直接作答。
// - 通配 "*" 只合成“恰好一个标签”，且不能穿过已存在的名字（RFC 4592）。
// - 区分 NXDOMAIN（名字不存在）与 NODATA（名字存在但无该类型）。
// - CNAME 独立于查询类型跟随；记录链路中的每一跳都保留出处；
//   目标在区域外则链路在本区停止，目标在已委派子域则随转介停止。
import type {
  AnswerKind,
  AnswerRecord,
  CnameHop,
  QueryResult,
  QueryType,
  RData,
  ResourceRecord,
  SOAFields,
  ValidationFinding,
  Zone,
} from "../../shared/types.js";
import {
  isNameInZone,
  normalizeName,
  rdataToText,
  validateNameSyntax,
} from "./names.js";
import { cutAbove, findZoneCuts, type ZoneCut } from "./validator.js";

export interface VersionMeta {
  versionId: string;
  versionLabel: string;
}

function soaRecord(zone: Zone): ResourceRecord {
  const rdata: RData = { soa: zone.soa };
  return { id: "@@soa", name: zone.origin, type: "SOA", ttl: zone.soa.ttl, rdata };
}

function toAnswer(
  zone: Zone,
  rec: ResourceRecord,
  vm: VersionMeta,
  section: AnswerRecord["provenance"]["section"],
  opts: { presentedName?: string; delegationPoint?: string; note?: string } = {},
): AnswerRecord {
  return {
    id: rec.id,
    name: opts.presentedName ?? rec.name,
    type: rec.type,
    ttl: rec.ttl,
    rdata: rec.rdata,
    provenance: {
      ownerName: rec.name,
      synthesizedFrom:
        opts.presentedName && opts.presentedName !== rec.name
          ? rec.name
          : undefined,
      versionId: vm.versionId,
      versionLabel: vm.versionLabel,
      section,
      delegationPoint: opts.delegationPoint,
      note: opts.note,
    },
  };
}

interface OwnerIndex {
  byName: Map<string, ResourceRecord[]>;
  allNames: string[];
}

function indexZone(zone: Zone): OwnerIndex {
  const byName = new Map<string, ResourceRecord[]>();
  for (const r of zone.records) {
    const list = byName.get(r.name) ?? [];
    list.push(r);
    byName.set(r.name, list);
  }
  // SOA 保存在 zone.soa 中；在解析视角里它是起点上真实存在的 RRset，
  // 因此把合成 SOA 记录并入起点拥有者（不影响校验/存储）。
  const apex = byName.get(zone.origin) ?? [];
  apex.unshift(soaRecord(zone));
  byName.set(zone.origin, apex);
  return { byName, allNames: [...byName.keys()] };
}

/** 名字是否作为“存在的名字”：自身有记录，或是其下有记录的空非终结点。 */
function nameExists(name: string, idx: OwnerIndex): boolean {
  if (idx.byName.has(name)) return true;
  const prefix = name + ".";
  return idx.allNames.some((n) => n.startsWith(prefix));
}

interface LookupOutcome {
  records: ResourceRecord[]; // 该名字该层级可用于回答的记录（不含 CNAME 跟随）
  synthesizedFrom?: string; // 通配合成时的真实拥有者
  existence: "exact" | "wildcard" | "ent" | "absent";
}

/**
 * 在不跨越委派、不跟随 CNAME 的前提下，解析一个名字的直接记录。
 * 通配按 RFC 4592：只能合成“源节点之下恰好一级”的名字，
 * 且查询名与通配源之间若存在更近的已存在名字，通配即被阻断。
 */
function lookupName(
  qname: string,
  idx: OwnerIndex,
  origin: string,
): LookupOutcome {
  const direct = idx.byName.get(qname);
  if (direct) return { records: direct, existence: "exact" };

  const labels = qname.split(".");
  for (let i = 1; i < labels.length; i++) {
    const ancestor = labels.slice(i).join(".");
    if (ancestor.length < origin.length) break;
    const wildcardOwner = "*." + ancestor;
    const hasWild = idx.byName.has(wildcardOwner);
    if (hasWild && i === 1) {
      return {
        records: idx.byName.get(wildcardOwner)!,
        synthesizedFrom: wildcardOwner,
        existence: "wildcard",
      };
    }
    if (idx.byName.has(ancestor)) {
      // 更近的已存在名字阻断其上层通配
      break;
    }
    if (hasWild) {
      // 通配源在两级以上，不能跨级合成
      break;
    }
  }

  if (nameExists(qname, idx)) {
    return { records: [], existence: "ent" };
  }
  return { records: [], existence: "absent" };
}

function recordsOfType(
  records: ResourceRecord[],
  qtype: QueryType,
): ResourceRecord[] {
  if (qtype === "ANY") return records;
  return records.filter((r) => r.type === qtype);
}

function referralResult(
  zone: Zone,
  vm: VersionMeta,
  qname: string,
  qtype: QueryType,
  cut: ZoneCut,
  trace: string[],
  prefixCnames: AnswerRecord[],
  cnameChain: CnameHop[],
): QueryResult {
  const answer = [...prefixCnames];
  const authority = cut.ns.map((r) =>
    toAnswer(zone, r, vm, "authority", {
      presentedName: cut.name,
      delegationPoint: cut.name,
      note: `委派切点 ${cut.name} 的 NS`,
    }),
  );
  const additional: AnswerRecord[] = [];
  for (const ns of cut.nsTargets) {
    if (!isNameInZone(ns, cut.name)) continue; // 仅 in-bailiwick 才随附 glue
    for (const r of zone.records) {
      if (
        r.name === ns &&
        (r.type === "A" || r.type === "AAAA")
      ) {
        additional.push(
          toAnswer(zone, r, vm, "additional", {
            delegationPoint: cut.name,
            note: `为 ${ns}. 提供的 glue`,
          }),
        );
      }
    }
  }
  const kind: AnswerKind = prefixCnames.length ? "referral" : "referral";
  return {
    qname,
    qtype,
    kind,
    rcode: "NOERROR",
    authoritative: false,
    title: prefixCnames
      ? `CNAME 链落入已委派子域 ${cut.name}：父区域给出转介`
      : `转介（referral）：${cut.name} 已委派给其他权威服务器`,
    explanation: prefixCnames
      ? `别名链最终指向 ${cut.name} 子域内的名字。${zone.origin} 区域在切点 ${cut.name} 处已委派，父区域不知道该子域内部名字的最终地址；应答中 authority 段是切点的 NS，additional 段是父区提供的 glue（如有）。`
      : `查询名位于已委派子域 ${cut.name} 之内（或就是切点本身）。按权威语义，父区域 ${zone.origin} 不替子区域作答：AA=0，authority 段给出切点的 NS 记录，additional 段给出 in-bailiwick glue。父区里即使残留该子域下的普通记录也不会用于应答。`,
    answer,
    authority,
    additional,
    cnameChain,
    resolutionTrace: [
      ...trace,
      `命中委派切点 ${cut.name}（非起点 NS 记录即子域委派），停止向子域内部解析`,
    ],
    zoneVersionId: vm.versionId,
    zoneVersionLabel: vm.versionLabel,
  };
}

function negativeResult(
  zone: Zone,
  vm: VersionMeta,
  qname: string,
  qtype: QueryType,
  kind: Extract<AnswerKind, "nxdomain" | "nodata">,
  trace: string[],
  prefixCnames: AnswerRecord[],
  cnameChain: CnameHop[],
): QueryResult {
  const isNx = kind === "nxdomain";
  return {
    qname,
    qtype,
    kind,
    rcode: isNx ? "NXDOMAIN" : "NOERROR",
    authoritative: true,
    title: isNx
      ? "NXDOMAIN：名字不存在"
      : "NODATA：名字存在，但没有所问类型",
    explanation: isNx
      ? "区域中不存在该名字（也没有可应用的通配记录）。注意这与“名字存在但无此记录类型”不同：后者是 NOERROR 加空应答（NODATA）。"
      : "该名字在区域中存在（有精确记录、由通配合成，或是其下挂有名字的空非终结点），但其 RRset 中不含所问类型；返回 NOERROR 与空应答。",
    answer: prefixCnames,
    authority: [
      toAnswer(zone, soaRecord(zone), vm, "authority", {
        note: "否定应答 authority 段中的 SOA（negative TTL 取 SOA minimum）",
      }),
    ],
    additional: [],
    cnameChain,
    resolutionTrace: trace,
    zoneVersionId: vm.versionId,
    zoneVersionLabel: vm.versionLabel,
  };
}

/** 为 MX/SRV 应答补充 additional 段中的目标地址（仅区域内精确名字）。 */
function additionalForTargets(
  zone: Zone,
  vm: VersionMeta,
  final: ResourceRecord[],
  presentedName: string,
): AnswerRecord[] {
  const mxTargets = new Set<string>();
  const srvTargets = new Set<string>();
  for (const r of final) {
    if (r.type === "MX" && r.rdata.host) mxTargets.add(r.rdata.host);
    if (r.type === "SRV" && r.rdata.host) srvTargets.add(r.rdata.host);
  }
  const describe = (t: string) =>
    mxTargets.has(t) && srvTargets.has(t)
      ? "MX/SRV"
      : mxTargets.has(t)
        ? "MX"
        : "SRV";
  const out: AnswerRecord[] = [];
  for (const t of new Set([...mxTargets, ...srvTargets])) {
    for (const r of zone.records) {
      if (r.name === t && (r.type === "A" || r.type === "AAAA")) {
        out.push(
          toAnswer(zone, r, vm, "additional", {
            note: `${presentedName} 的 ${describe(t)} 目标 ${t} 的地址`,
          }),
        );
      }
    }
  }
  return out;
}

export function resolveQuery(
  zone: Zone,
  vm: VersionMeta,
  rawQname: string,
  rawQtype: QueryType,
  blockingFindings: ValidationFinding[] = [],
): QueryResult {
  const qname = normalizeName(rawQname);
  const qtype = rawQtype;

  if (blockingFindings.length > 0) {
    return {
      qname: rawQname.trim(),
      qtype,
      kind: "invalid",
      rcode: "SERVFAIL",
      authoritative: false,
      title: "区域草稿存在阻断性错误，无法给出权威应答",
      explanation:
        "以下校验错误会阻止发布，也使当前草稿无法作为权威区域被查询；请先修正再预览。",
      answer: [],
      authority: [],
      additional: [],
      cnameChain: [],
      resolutionTrace: [],
      zoneVersionId: vm.versionId,
      zoneVersionLabel: vm.versionLabel,
      blockedBy: blockingFindings,
    };
  }

  const nameErr = validateNameSyntax(qname, "查询名");
  if (nameErr) {
    return {
      qname: rawQname.trim(),
      qtype,
      kind: "refused",
      rcode: "REFUSED",
      authoritative: false,
      title: "查询名无法解析",
      explanation: nameErr,
      answer: [],
      authority: [],
      additional: [],
      cnameChain: [],
      resolutionTrace: [],
      zoneVersionId: vm.versionId,
      zoneVersionLabel: vm.versionLabel,
    };
  }

  if (!isNameInZone(qname, zone.origin)) {
    return {
      qname,
      qtype,
      kind: "refused",
      rcode: "REFUSED",
      authoritative: false,
      title: `REFUSED：${qname} 不在本区域 ${zone.origin} 的管辖范围内`,
      explanation:
        "本工具只对自身保存的区域作权威回答；区域外的名字不会被递归解析，也不会访问公共 DNS。",
      answer: [],
      authority: [],
      additional: [],
      cnameChain: [],
      resolutionTrace: [`查询名不以 ${zone.origin} 结尾`],
      zoneVersionId: vm.versionId,
      zoneVersionLabel: vm.versionLabel,
    };
  }

  const idx = indexZone(zone);
  const cuts = findZoneCuts(zone);
  const trace: string[] = [`查询 ${qname} ${qtype}，区域起点 ${zone.origin}`];

  const cnameAnswers: AnswerRecord[] = [];
  const cnameChain: CnameHop[] = [];
  const visited = new Set<string>();
  let current = qname;
  let hops = 0;

  // 起点 SOA 总是在“记录集”视图中出现
  void idx;

  for (;;) {
    hops++;

    // 当前名字落入委派？
    const cut =
      cuts.find((c) => c.name === current || current.endsWith("." + c.name)) ??
      null;
    if (cut) {
      if (cnameChain.length) {
        const last = cnameChain[cnameChain.length - 1];
        last.targetStatus = "delegated";
        last.note = `目标位于已委派子域 ${cut.name}，本区只给转介`;
      }
      trace.push(`CNAME 链当前名字 ${current} 位于委派切点 ${cut.name}`);
      return referralResult(
        zone,
        vm,
        qname,
        qtype,
        cut,
        trace,
        cnameAnswers,
        cnameChain,
      );
    }

    const lookup = lookupName(current, idx, zone.origin);
    if (lookup.synthesizedFrom) {
      trace.push(
        `名字 ${current} 无精确记录；通配 ${lookup.synthesizedFrom} 恰好匹配其下一级标签，合成该名字`,
      );
    }

    const cnameRec = lookup.records.find((r) => r.type === "CNAME");

    // 查询 CNAME 类型时：CNAME 记录自身就是答案，不跟随。
    if (qtype === "CNAME") {
      if (cnameRec) {
        return finalPositive(
          zone,
          vm,
          qname,
          qtype,
          [cnameRec],
          lookup,
          trace,
          cnameAnswers,
          cnameChain,
          current,
        );
      }
      return noCnameNegative(zone, vm, qname, qtype, lookup, trace, cnameAnswers, cnameChain, current);
    }

    if (cnameRec) {
      if (visited.has(current)) {
        trace.push(`CNAME 环：${current} 已在链路中出现过`);
        const loopRec = toAnswer(zone, cnameRec, vm, "answer", {
          presentedName: current,
          note: lookup.synthesizedFrom
            ? `由通配 ${lookup.synthesizedFrom} 合成`
            : undefined,
        });
        return {
          qname,
          qtype,
          kind: "cname-loop",
          rcode: "SERVFAIL",
          authoritative: true,
          title: "CNAME 环：别名链回到了链路上的名字",
          explanation: `跟随 CNAME 时再次到达 ${current}，链路无法终止。权威服务器通常对这种应答返回 SERVFAIL。`,
          answer: [...cnameAnswers, loopRec],
          authority: [],
          additional: [],
          cnameChain,
          resolutionTrace: trace,
          zoneVersionId: vm.versionId,
          zoneVersionLabel: vm.versionLabel,
        };
      }
      visited.add(current);
      const target = cnameRec.rdata.value!;
      const cnameAns = toAnswer(zone, cnameRec, vm, "answer", {
        presentedName: current,
        note: lookup.synthesizedFrom
          ? `CNAME 由通配 ${lookup.synthesizedFrom} 合成到查询名`
          : undefined,
      });
      cnameAnswers.push(cnameAns);
      const inZone = isNameInZone(target, zone.origin);
      const targetCut = inZone
        ? cuts.find((c) => c.name === target || target.endsWith("." + c.name))
        : undefined;
      let status: CnameHop["targetStatus"];
      let note: string;
      if (!inZone) {
        status = "out-of-zone";
        note = `目标 ${target} 在区域 ${zone.origin} 之外，本区域的应答到此停止（不代为递归查询）`;
      } else if (targetCut) {
        status = "delegated";
        note = `目标位于已委派子域 ${targetCut.name}，只能给出转介`;
      } else {
        const tLook = lookupName(target, idx, zone.origin);
        const hit = tLook.records.some((r) => qtype === "ANY" || r.type === qtype);
        status = hit
          ? "in-zone-positive"
          : tLook.records.length > 0 || tLook.existence === "wildcard"
            ? "in-zone-nodata"
            : tLook.existence === "ent"
              ? "in-zone-nodata"
              : "in-zone-nxdomain";
        note =
          status === "in-zone-positive"
            ? `目标在本区域内且存在 ${qtype} 记录`
            : status === "in-zone-nodata"
              ? `目标在本区域内存在，但没有 ${qtype} 记录`
              : `目标名字在本区域内不存在`;
      }
      cnameChain.push({
        index: cnameChain.length + 1,
        alias: current,
        cnameRecord: cnameAns,
        target,
        targetStatus: status,
        note,
      });
      trace.push(`CNAME ${current} → ${target}（${note}）`);

      if (!inZone) {
        return {
          qname,
          qtype,
          kind: "cname-target-external",
          rcode: "NOERROR",
          authoritative: true,
          title: `CNAME 指向区域外名字 ${target}：本区应答在此停止`,
          explanation: `别名链的最终目标不属于 ${zone.origin}。本工具只表达本区域权威持有的内容：answer 段给出完整的 CNAME 链，但不会去查询外部权威服务器，因此链路之后能得到什么记录不在本区应答范围内。`,
          answer: cnameAnswers,
          authority: [],
          additional: [],
          cnameChain,
          resolutionTrace: trace,
          zoneVersionId: vm.versionId,
          zoneVersionLabel: vm.versionLabel,
        };
      }
      current = target;
      if (hops > 32) {
        return {
          qname,
          qtype,
          kind: "cname-loop",
          rcode: "SERVFAIL",
          authoritative: true,
          title: "CNAME 链过长",
          explanation: "跟随超过 32 跳仍未终止，按环处理。",
          answer: cnameAnswers,
          authority: [],
          additional: [],
          cnameChain,
          resolutionTrace: trace,
          zoneVersionId: vm.versionId,
          zoneVersionLabel: vm.versionLabel,
        };
      }
      continue;
    }

    // 无 CNAME：按所问类型直接回答
    const hit = recordsOfType(lookup.records, qtype);
    if (hit.length > 0) {
      return finalPositive(
        zone,
        vm,
        qname,
        qtype,
        hit,
        lookup,
        trace,
        cnameAnswers,
        cnameChain,
        current,
      );
    }

    return noCnameNegative(
      zone,
      vm,
      qname,
      qtype,
      lookup,
      trace,
      cnameAnswers,
      cnameChain,
      current,
    );
  }
}

function finalPositive(
  zone: Zone,
  vm: VersionMeta,
  qname: string,
  qtype: QueryType,
  records: ResourceRecord[],
  lookup: LookupOutcome,
  trace: string[],
  cnameAnswers: AnswerRecord[],
  cnameChain: CnameHop[],
  resolvedName: string,
): QueryResult {
  const presented = resolvedName;
  if (!lookup.synthesizedFrom) {
    trace.push(`精确匹配拥有者 ${resolvedName}，取 ${qtype} RRset`);
  }
  const answerRecs = records.map((r) =>
    toAnswer(zone, r, vm, "answer", {
      presentedName: presented,
      note: lookup.synthesizedFrom
        ? `通配合成：真实拥有者 ${lookup.synthesizedFrom}`
        : undefined,
    }),
  );
  const additional = additionalForTargets(zone, vm, records, presented);
  return {
    qname,
    qtype,
    kind: "positive",
    rcode: "NOERROR",
    authoritative: true,
    title: cnameAnswers.length
      ? `肯定应答（经 ${cnameChain.length} 跳 CNAME 到达 ${resolvedName}）`
      : lookup.synthesizedFrom
        ? `肯定应答（由通配 ${lookup.synthesizedFrom} 合成）`
        : "肯定应答",
    explanation: cnameAnswers.length
      ? `answer 段先给出 CNAME 链，再给出最终名字 ${resolvedName} 的 ${qtype} 记录；所有记录均来自本区域同一版本。`
      : lookup.synthesizedFrom
        ? `查询名没有精确记录，但通配 ${lookup.synthesizedFrom} 按“恰好一个标签”规则合成了该名字；应答记录的真实拥有者是通配名。`
        : `名字 ${resolvedName} 存在且有所问类型，AA=1。`,
    answer: [...cnameAnswers, ...answerRecs],
    authority: [],
    additional,
    cnameChain,
    resolutionTrace: trace,
    zoneVersionId: vm.versionId,
    zoneVersionLabel: vm.versionLabel,
  };
}

function noCnameNegative(
  zone: Zone,
  vm: VersionMeta,
  qname: string,
  qtype: QueryType,
  lookup: LookupOutcome,
  trace: string[],
  cnameAnswers: AnswerRecord[],
  cnameChain: CnameHop[],
  resolvedName: string,
): QueryResult {
  if (lookup.existence === "absent") {
    trace.push(
      `名字 ${resolvedName} 无精确记录、无可用通配，判定为名字不存在（NXDOMAIN）`,
    );
    return negativeResult(
      zone,
      vm,
      qname,
      qtype,
      "nxdomain",
      trace,
      cnameAnswers,
      cnameChain,
    );
  }
  // exact 但无该类型 / wildcard 但该类型缺失 / 空非终结点
  if (lookup.synthesizedFrom) {
    trace.push(
      `通配 ${lookup.synthesizedFrom} 合成了名字，但其上没有 ${qtype} 记录：NODATA`,
    );
  } else if (lookup.existence === "ent") {
    trace.push(
      `${resolvedName} 是空非终结点（其下挂有名字，自身无记录），名字存在但无 ${qtype}：NODATA`,
    );
  } else {
    trace.push(`精确拥有者 ${resolvedName} 存在，但没有 ${qtype} RRset：NODATA`);
  }
  return negativeResult(
    zone,
    vm,
    qname,
    qtype,
    "nodata",
    trace,
    cnameAnswers,
    cnameChain,
  );
}

// 让 SOA rdata 也能走统一文本渲染
export function renderRdata(type: string, rdata: RData): string {
  if (type === "SOA" && rdata.soa) {
    const s: SOAFields = rdata.soa;
    return `${s.mname}. ${s.rname}. ${s.serial} ${s.refresh} ${s.retry} ${s.expire} ${s.minimum}`;
  }
  return rdataToText(type as never, rdata);
}

export { cutAbove };
