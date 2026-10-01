// 区域索引与权威解析器。
// 严格按权威语义处理：区域起点、空非终端(ENT)、通配只匹配一层、
// 委派转介、CNAME 链在区内/区外的终止、NXDOMAIN 与 NODATA 的区分。
import type {
  RR, RRType, RRView, QueryResponse, AnswerKind, CnameChainHop, RRSource,
} from '../../shared/types.js';
import { isNameInZone, isSubName, parentName } from './name.js';

interface NodeInfo {
  name: string;                 // 规范拥有者名
  rrsets: Map<RRType, RR[]>;
}

interface FoundNode {
  exists: boolean;
  owner: string;                // 实际拥有者（合成时为通配名）
  answerName: string;           // 应答时使用的名字（合成时为查询名）
  source: 'exact' | 'wildcard';
  wildcardOwner?: string;
  node?: NodeInfo;
}

export class ZoneResolver {
  readonly zoneName: string;
  private nodes = new Map<string, NodeInfo>();

  constructor(zoneName: string, records: RR[]) {
    this.zoneName = zoneName;
    for (const rr of records) {
      let node = this.nodes.get(rr.name);
      if (!node) {
        node = { name: rr.name, rrsets: new Map() };
        this.nodes.set(rr.name, node);
      }
      const set = node.rrsets.get(rr.type) ?? [];
      set.push(rr);
      node.rrsets.set(rr.type, set);
    }
  }

  private get apex(): NodeInfo | undefined {
    return this.nodes.get(this.zoneName);
  }

  get soa(): RR | undefined {
    return this.apex?.rrsets.get('SOA')?.[0];
  }

  /** 节点是否存在：拥有记录，或是某拥有者名的后缀（空非终端 ENT）。 */
  nodeExists(name: string): boolean {
    if (this.nodes.has(name)) return true;
    for (const owner of this.nodes.keys()) {
      if (isSubName(owner, name)) return true;
    }
    return false;
  }

  /**
   * 找到 query 应使用的节点。
   * RFC 4592 语义：
   *  - 拥有记录的精确节点直接命中；
   *  - 查询名本身是空非终端(ENT，只有后代拥有记录)时，视为存在但无数据；
   *  - 否则向上找最近包围节点 CE；仅当查询名恰好在 CE 下一层
   *    （parentName(q) === CE）且 "*.<CE>" 拥有记录时，由该通配合成；
   *  - 多层缺失名字不会被通配“跨层”匹配。
   */
  private locate(queryName: string): FoundNode {
    const exact = this.nodes.get(queryName);
    if (exact) return { exists: true, owner: queryName, answerName: queryName, source: 'exact', node: exact };

    // 空非终端：名字存在但没有自己的 RRset -> NODATA
    if (this.nodeExists(queryName)) {
      return { exists: true, owner: queryName, answerName: queryName, source: 'exact', node: undefined };
    }

    // 最近包围节点（closest encloser）
    let ce: string | null = parentName(queryName);
    while (ce && !this.nodeExists(ce)) ce = parentName(ce);

    if (ce && parentName(queryName) === ce) {
      const wildcardOwner = '*.' + ce;
      const wnode = this.nodes.get(wildcardOwner);
      if (wnode) {
        return {
          exists: true, owner: wildcardOwner, answerName: queryName,
          source: 'wildcard', wildcardOwner, node: wnode,
        };
      }
    }
    return { exists: false, owner: queryName, answerName: queryName, source: 'exact' };
  }

  /** 最深委派点：拥有 NS 的、查询名之下或等于其名字的区域内节点（排除区域起点）。 */
  private findCut(queryName: string): { cut: string; ns: RR[] } | null {
    let best: { cut: string; ns: RR[] } | null = null;
    for (const [name, node] of this.nodes) {
      if (name === this.zoneName) continue;
      const ns = node.rrsets.get('NS');
      if (!ns || ns.length === 0) continue;
      if (queryName === name || isSubName(queryName, name)) {
        if (!best || isSubName(name, best.cut)) best = { cut: name, ns };
      }
    }
    return best;
  }

  /** 委派点的胶水：名字落在 cut 处或其下、且与某 NS target 同名的 A/AAAA。 */
  private glueFor(cut: string, ns: RR[]): RRView[] {
    const targets = new Set(
      ns.map((r) => r.rdata.target).filter((t): t is string => !!t && isNameInZone(t, this.zoneName)),
    );
    const out: RRView[] = [];
    for (const [name, node] of this.nodes) {
      if (!(name === cut || isSubName(name, cut))) continue;
      if (!targets.has(name)) continue;
      for (const type of ['A', 'AAAA'] as RRType[]) {
        for (const rr of node.rrsets.get(type) ?? []) {
          out.push({
            rr, source: 'glue', section: 'additional',
            note: `胶水记录：仅为转介 ${cut} 而由父区域持有，不是父区域对该名字的权威应答`,
          });
        }
      }
    }
    return out;
  }

  private view(rr: RR, found: FoundNode, section: 'answer' | 'authority'): RRView {
    const useRR = found.source === 'wildcard' && section === 'answer'
      ? { ...rr, name: found.answerName }
      : rr;
    return {
      rr: useRR,
      source: found.source === 'wildcard' ? 'wildcard' : 'exact',
      section,
      synthesizedName: found.source === 'wildcard' ? found.answerName : undefined,
    };
  }

  private soaView(): RRView | null {
    const soa = this.soa;
    return soa ? { rr: soa, source: 'soa-negative', section: 'authority' } : null;
  }

  /** 主查询入口 */
  query(queryName: string, qtype: RRType | 'ANY'): QueryResponse {
    if (!isNameInZone(queryName, this.zoneName)) return this.outOfZone(queryName, qtype);

    // 1) 委派优先：名字落在某个 cut 处或其下 -> 转介
    const cutInfo = this.findCut(queryName);
    if (cutInfo) return this.referral(queryName, qtype, cutInfo.cut, cutInfo.ns);

    // 2) 定位节点（精确、ENT 或通配）
    const found = this.locate(queryName);
    if (!found.exists) return this.negative(queryName, qtype, found, 'NXDOMAIN');
    // 空非终端：名字存在但无任何 RRset
    if (!found.node) return this.negative(queryName, qtype, found, 'NODATA');

    // 3) CNAME（且问的不是 CNAME 自身/ANY）：进入链
    const cnameSet = found.node.rrsets.get('CNAME');
    if (qtype !== 'CNAME' && qtype !== 'ANY' && cnameSet && cnameSet.length > 0) {
      return this.chaseCname(queryName, qtype, found);
    }

    // 4) 普通 RRset
    return this.terminalAnswer(queryName, qtype, found);
  }

  private terminalAnswer(
    queryName: string, qtype: RRType | 'ANY', found: FoundNode,
    extraAnswers: RRView[] = [], chain: CnameChainHop[] = [],
  ): QueryResponse {
    const node = found.node!;
    const answers = [...extraAnswers];

    const pushSet = (set: RR[]) => {
      for (const rr of set) answers.push(this.view(rr, found, 'answer'));
    };

    if (qtype === 'ANY') {
      for (const [, set] of node.rrsets) pushSet(set);
    } else {
      pushSet(node.rrsets.get(qtype) ?? []);
    }

    const hasData = answers.length > extraAnswers.length;
    const authority: RRView[] = [];
    let kind: AnswerKind;
    if (hasData) {
      kind = 'ANSWER';
    } else {
      kind = 'NODATA';
      const soa = this.soaView();
      if (soa) authority.push(soa);
    }

    return {
      queryName, queryType: qtype, kind,
      authoritative: true, rcode: 'NOERROR',
      answers, authority, additional: [],
      cnameChain: chain,
      closestEncloser: this.closestEncloser(queryName),
      wildcardUsed: found.source === 'wildcard' ? found.wildcardOwner : undefined,
      explanation: this.explain(kind, found, chain, qtype),
    };
  }

  /** 沿 CNAME 链解析；链上每跳区分来源，终点决定类别。 */
  private chaseCname(queryName: string, qtype: RRType | 'ANY', first: FoundNode): QueryResponse {
    const answers: RRView[] = [];
    const chain: CnameChainHop[] = [];
    const seen = new Set<string>([queryName.toLowerCase()]);
    let found: FoundNode = first;

    const appendCname = (f: FoundNode): string => {
      const cnameRR = f.node!.rrsets.get('CNAME')![0];
      answers.push(this.view(cnameRR, f, 'answer'));
      return cnameRR.rdata.target!;
    };

    let nextName = appendCname(first);
    chain.push({
      index: 1, from: queryName, to: nextName,
      source: first.source, inZone: isNameInZone(nextName, this.zoneName),
      outcome: isNameInZone(nextName, this.zoneName)
        ? `继续在本区内解析 ${nextName}`
        : `${nextName} 位于区域外`,
    });

    for (let guard = 0; guard < 16; guard++) {
      // 成环 / 自引用
      if (seen.has(nextName.toLowerCase())) {
        return this.cnameStop(queryName, qtype, 'CNAME_LOOP', answers, chain, nextName, found);
      }
      seen.add(nextName.toLowerCase());

      // 区域外：本区责任结束
      if (!isNameInZone(nextName, this.zoneName)) {
        return this.cnameStop(queryName, qtype, 'CNAME_EXTERNAL', answers, chain, nextName, found);
      }

      // 目标落入委派：带着已解析的 CNAME 链返回转介
      const cut = this.findCut(nextName);
      if (cut) return this.referral(queryName, qtype, cut.cut, cut.ns, answers, chain);

      const nf = this.locate(nextName);
      if (!nf.exists || !nf.node) {
        return this.negative(queryName, qtype, nf, 'CNAME_NXDOMAIN', answers, chain);
      }
      found = nf;
      const cset = nf.node.rrsets.get('CNAME');
      if (cset && cset.length > 0) {
        const target = appendCname(nf);
        chain.push({
          index: chain.length + 1, from: nextName, to: target, source: nf.source,
          inZone: isNameInZone(target, this.zoneName),
          outcome: isNameInZone(target, this.zoneName)
            ? `继续在本区内解析 ${target}`
            : `${target} 位于区域外`,
        });
        nextName = target;
        continue;
      }

      // 链终点：普通节点
      const term = this.terminalAnswer(queryName, qtype, found, answers, chain);
      if (term.answers.length === answers.length) {
        return this.negative(queryName, qtype, found, 'CNAME_MISS', answers, chain);
      }
      term.explanation = this.explain('ANSWER', first, chain, qtype);
      return term;
    }

    return this.cnameStop(queryName, qtype, 'CNAME_LOOP', answers, chain, nextName, found);
  }

  private cnameStop(
    queryName: string, qtype: RRType | 'ANY', kind: AnswerKind,
    answers: RRView[], chain: CnameChainHop[], stopTarget: string, found: FoundNode,
  ): QueryResponse {
    const authority: RRView[] = [];
    if (kind === 'CNAME_LOOP' || kind === 'CNAME_MISS' || kind === 'CNAME_NXDOMAIN') {
      const soa = this.soaView();
      if (soa) authority.push(soa);
    }
    return {
      queryName, queryType: qtype, kind,
      authoritative: kind !== 'CNAME_EXTERNAL',
      rcode: kind === 'CNAME_NXDOMAIN' ? 'NXDOMAIN' : 'NOERROR',
      answers, authority, additional: [],
      cnameChain: chain,
      closestEncloser: this.closestEncloser(queryName),
      wildcardUsed: found.source === 'wildcard' ? found.wildcardOwner : undefined,
      explanation: this.explain(kind, found, chain, qtype, stopTarget),
    };
  }

  private negative(
    queryName: string, qtype: RRType | 'ANY', found: FoundNode, kind: AnswerKind,
    extraAnswers: RRView[] = [], chain: CnameChainHop[] = [],
  ): QueryResponse {
    const authority: RRView[] = [];
    const soa = this.soaView();
    if (soa) authority.push(soa);
    return {
      queryName, queryType: qtype, kind,
      authoritative: true,
      rcode: (kind === 'NXDOMAIN' || kind === 'CNAME_NXDOMAIN') ? 'NXDOMAIN' : 'NOERROR',
      answers: extraAnswers, authority, additional: [],
      cnameChain: chain,
      closestEncloser: this.closestEncloser(queryName),
      wildcardUsed: undefined,
      explanation: this.explain(kind, found, chain, qtype),
    };
  }

  private referral(
    queryName: string, qtype: RRType | 'ANY', cut: string, ns: RR[],
    cnameAnswers: RRView[] = [], chain: CnameChainHop[] = [],
  ): QueryResponse {
    const authority: RRView[] = ns.map((rr) => ({
      rr, source: 'exact' as RRSource, section: 'authority' as const,
      note: `委派点 ${cut} 的 NS，来自父区域 ${this.zoneName}`,
    }));
    const additional = this.glueFor(cut, ns);
    const answers = [...cnameAnswers];

    // 恰好问 cut 自身的 NS（或 ANY）：按解析惯例同时放入 answer
    if (queryName === cut && (qtype === 'NS' || qtype === 'ANY')) {
      for (const rr of ns) answers.push({ rr, source: 'exact', section: 'answer' });
    }

    return {
      queryName, queryType: qtype, kind: 'REFERRAL',
      authoritative: false, rcode: 'NOERROR',
      answers, authority, additional,
      cnameChain: chain,
      cutName: cut,
      explanation:
        `${queryName} 位于子域委派点 ${cut} 处或其下。父区域 ${this.zoneName} 不掌握该名字的最终记录，` +
        `应答 Authority 段给出子域权威服务器（非 AA 转介）；Additional 段仅提供解析所需胶水地址。`,
    };
  }

  private outOfZone(queryName: string, qtype: RRType | 'ANY'): QueryResponse {
    return {
      queryName, queryType: qtype, kind: 'OUT_OF_ZONE',
      authoritative: false, rcode: 'REFUSED',
      answers: [], authority: [], additional: [], cnameChain: [],
      explanation:
        `${queryName} 不属于本区域 ${this.zoneName}。该工具只对自身保存的区域给出权威结果，` +
        `不会代为访问公共 DNS，因此对此名字拒绝作答(REFUSED)。`,
    };
  }

  private closestEncloser(name: string): string | undefined {
    let p: string | null = name;
    while (p) {
      if (this.nodeExists(p)) return p;
      p = parentName(p);
    }
    return undefined;
  }

  private explain(
    kind: AnswerKind, found: FoundNode, chain: CnameChainHop[] | undefined,
    qtype: RRType | 'ANY', stopTarget?: string,
  ): string {
    switch (kind) {
      case 'ANSWER': {
        const via = chain && chain.length ? `，经 ${chain.length} 跳 CNAME 链` : '';
        const wc = found.source === 'wildcard'
          ? ` 记录由通配 ${found.wildcardOwner} 合成为 ${found.answerName}（通配仅匹配一层标签）。`
          : '';
        return `本区对 ${found.answerName} 的 ${qtype} 查询给出权威最终应答(AA)${via}。${wc}`;
      }
      case 'NODATA':
        return `名字 ${found.answerName} 在区内存在（${found.source === 'wildcard' ? '由通配 ' + found.wildcardOwner + ' 合成' : '精确名字'}），` +
          `但没有 ${qtype} 类型记录。这是 NODATA（NOERROR + 空 Answer + SOA），与“名字不存在”的 NXDOMAIN 不同。`;
      case 'NXDOMAIN':
        return `名字 ${found.answerName} 在区域 ${this.zoneName} 中不存在（NXDOMAIN）。` +
          `通配只匹配比已存在节点恰好多一层的名字；最近包围节点为 ${this.closestEncloser(found.answerName) ?? '区域起点'}，` +
          `且没有可合成的通配。Authority 段放 SOA 表示权威否定。`;
      case 'CNAME_MISS':
        return `CNAME 链到达 ${stopTarget}，该名字在区内存在但没有 ${qtype} 记录（链终结于 NODATA 性质）。`;
      case 'CNAME_NXDOMAIN':
        return `CNAME 链指向 ${stopTarget}，该名字在区域 ${this.zoneName} 中不存在（NXDOMAIN）。链上 CNAME 仍在 Answer 段。`;
      case 'CNAME_LOOP':
        return `CNAME 链在 ${stopTarget} 处形成环或自引用，解析按本区数据在此终止，无法得到最终 ${qtype}。`;
      case 'CNAME_EXTERNAL':
        return `别名最终指向区域外名字 ${stopTarget}。本区能权威给出完整 CNAME 链，但最终 ${qtype} 不属本区责任，链路在此停止。`;
      default:
        return '';
    }
  }
}
