import type { QueryResultResponse, RRView } from '@shared/types.js';
import { KindBadge, SourceTag } from './ui.js';
import { displayName, renderRdata } from './display.js';

function Section({
  title, items, zoneName, empty,
}: {
  title: string;
  items: RRView[];
  zoneName: string;
  empty?: string;
}) {
  return (
    <div className={`rr-section ${items.length === 0 ? 'empty' : ''}`}>
      <h4>{title} <span className="count">{items.length}</span></h4>
      {items.length === 0 ? (
        <div className="section-empty">{empty ?? '（空）'}</div>
      ) : (
        <ul>
          {items.map((v, i) => (
            <li key={i} className={`rr-row src-${v.source}`}>
              <SourceTag source={v.source} />
              <span className="rr-name">{displayName(v.rr.name, zoneName) === '@' ? '@' : v.rr.name}</span>
              <span className="rr-ttl">{v.rr.ttl}</span>
              <span className="rr-type">{v.rr.type}</span>
              <span className="rr-data">{renderRdata(v.rr.type, v.rr.rdata)}</span>
              {v.synthesizedName && (
                <span className="synth">通配合成为 {v.synthesizedName}</span>
              )}
              {v.note && <span className="rr-note">{v.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function QueryResult({
  result, zoneName,
}: {
  result: QueryResultResponse | null;
  zoneName: string;
}) {
  if (!result) return <div className="query-empty">输入查询名与类型后执行预览。</div>;
  const r = result.response;
  return (
    <div className={`query-result kind-${r.kind.toLowerCase().replace(/_/g, '-')}`}>
      <div className="result-head">
        <KindBadge kind={r.kind} />
        <span className="rcode">RCODE {r.rcode}</span>
        <span className={`aa ${r.authoritative ? 'yes' : 'no'}`}>
          AA {r.authoritative ? '= 1（本服务器权威）' : '= 0（转介/区外）'}
        </span>
        {r.cutName && <span className="cut">委派点 {r.cutName}</span>}
        {r.wildcardUsed && <span className="wild">命中通配 {r.wildcardUsed}</span>}
        {r.closestEncloser && <span className="ce">最近包围节点 {r.closestEncloser}</span>}
      </div>

      <p className="explanation">{r.explanation}</p>

      <Section title="Answer 应答段" items={r.answers} zoneName={zoneName}
        empty="无应答记录（否定应答或转介）" />
      <Section title="Authority 权威段" items={r.authority} zoneName={zoneName}
        empty="无" />
      <Section title="Additional 附加段（胶水）" items={r.additional} zoneName={zoneName}
        empty="无胶水" />

      {r.cnameChain.length > 0 && (
        <div className="cname-chain">
          <h4>CNAME 链路</h4>
          <ol>
            {r.cnameChain.map((h) => (
              <li key={h.index} className={`hop ${h.inZone ? 'in' : 'out'}`}>
                <span className="hop-idx">{h.index}</span>
                <code>{h.from}</code>
                <span className="arrow">{h.source === 'wildcard' ? '（通配）→' : '→'}</span>
                <code>{h.to}</code>
                <span className={`inzone-tag ${h.inZone ? 'in' : 'out'}`}>
                  {h.inZone ? '区内' : '区外·链止'}
                </span>
                <span className="hop-outcome">{h.outcome}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="result-foot">
        依据：{result.sourceLabel}
      </div>
    </div>
  );
}
