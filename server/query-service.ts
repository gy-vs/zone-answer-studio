// 在指定版本（草稿或某已发布版本）上执行权威查询，并比较不同版本间的应答。
import type {
  QueryResponse, QuerySample, SampleEffectEntry, RRType, PublishedVersion,
  DraftState, ZoneMeta,
} from '../shared/types.js';
import { canonicalizeName, DnsNameError } from './dns/name.js';
import { ZoneResolver } from './dns/resolver.js';

export function resolveSnapshot(
  meta: ZoneMeta,
  records: { id: string; name: string; type: RRType; ttl: number; rdata: unknown }[],
  nameInput: string,
  qtype: RRType | 'ANY',
): { ok: true; response: QueryResponse } | { ok: false; error: string } {
  let name: string;
  try {
    name = canonicalizeName(nameInput, meta.zoneName);
  } catch (e) {
    return { ok: false, error: e instanceof DnsNameError ? e.message : '非法查询名' };
  }
  const resolver = new ZoneResolver(meta.zoneName, records as QueryResponse['answers'][number]['rr'][]);
  return { ok: true, response: resolver.query(name, qtype) };
}

function signature(resp: QueryResponse): string {
  // 用于判断两版本应答是否语义一致：类别 + 应答记录（名字/类型/rdata）+ 委派点 + 通配
  const ans = resp.answers
    .map((a) => `${a.rr.name} ${a.rr.type} ${JSON.stringify(a.rr.rdata)}`)
    .sort();
  const auth = resp.authority
    .map((a) => `${a.rr.name} ${a.rr.type} ${JSON.stringify(a.rr.rdata)}`)
    .sort();
  return JSON.stringify({
    kind: resp.kind,
    rcode: resp.rcode,
    aa: resp.authoritative,
    cut: resp.cutName ?? null,
    wildcard: resp.wildcardUsed ?? null,
    ans,
    auth,
  });
}

export function compareSample(
  sample: QuerySample,
  published: PublishedVersion | null,
  draft: DraftState,
): SampleEffectEntry {
  const draftResult = resolveSnapshot(draft.meta, draft.records, sample.name, sample.qtype);
  const draftResp = draftResult.ok
    ? draftResult.response
    : brokenResponse(sample.name, sample.qtype, draftResult.error);

  const reasons: string[] = [];
  let effect: SampleEffectEntry['effect'];

  if (!published) {
    effect = draftResult.ok ? 'changed' : 'draft-error';
    reasons.push('尚无已发布版本，该样例将在首次发布后建立基线');
    return { sample, effect, published: null, draft: draftResp, reasons };
  }

  const pubResult = resolveSnapshot(published.meta, published.records, sample.name, sample.qtype);
  const pubResp = pubResult.ok
    ? pubResult.response
    : brokenResponse(sample.name, sample.qtype, pubResult.error);

  if (!draftResult.ok) {
    effect = 'draft-error';
    reasons.push(`草稿无法评估：${draftResult.error}`);
  } else if (signature(pubResp) === signature(draftResp)) {
    effect = 'same';
  } else {
    effect = 'changed';
    if (pubResp.kind !== draftResp.kind) {
      reasons.push(`应答类别变化：${pubResp.kind} → ${draftResp.kind}`);
    }
    const pubAns = new Set(pubResp.answers.map((a) => `${a.rr.name} ${a.rr.type} ${JSON.stringify(a.rr.rdata)}`));
    const draftAns = new Set(draftResp.answers.map((a) => `${a.rr.name} ${a.rr.type} ${JSON.stringify(a.rr.rdata)}`));
    for (const a of pubAns) if (!draftAns.has(a)) reasons.push(`移除应答: ${a}`);
    for (const a of draftAns) if (!pubAns.has(a)) reasons.push(`新增应答: ${a}`);
    if (pubResp.cutName !== draftResp.cutName) {
      reasons.push(`委派点变化：${pubResp.cutName ?? '无'} → ${draftResp.cutName ?? '无'}`);
    }
    if (pubResp.wildcardUsed !== draftResp.wildcardUsed) {
      reasons.push(`通配命中变化：${pubResp.wildcardUsed ?? '无'} → ${draftResp.wildcardUsed ?? '无'}`);
    }
    if (reasons.length === 0) reasons.push('应答记录内容有差异');
  }

  return { sample, effect, published: pubResp, draft: draftResp, reasons };
}

export function effectsFor(samples: QuerySample[], published: PublishedVersion | null, draft: DraftState) {
  return samples.map((s) => compareSample(s, published, draft));
}

function brokenResponse(name: string, qtype: RRType | 'ANY', error: string): QueryResponse {
  return {
    queryName: name, queryType: qtype, kind: 'NODATA',
    authoritative: false, rcode: 'NOERROR',
    answers: [], authority: [], additional: [], cnameChain: [],
    explanation: `评估失败: ${error}`,
  };
}
