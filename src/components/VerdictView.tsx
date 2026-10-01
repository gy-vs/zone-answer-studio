import type { AnswerRecord, QueryResult } from "../types";
import { rdataToText } from "../dnslib";

export function VerdictView({ r, compact }: { r: QueryResult; compact?: boolean }) {
  return (
    <div>
      <div className={`verdict ${r.kind}`}>
        <h3>
          {r.title}{" "}
          <span className="meta">
            {r.rcode} · {r.authoritative ? "AA=1 权威" : "AA=0 非权威"}
          </span>
        </h3>
        {!compact && <p>{r.explanation}</p>}
        {compact && (
          <p style={{ fontSize: 11.5 }}>{r.explanation}</p>
        )}
        <div className="meta" style={{ marginTop: 6 }}>
          依据版本：{r.zoneVersionLabel}
        </div>
      </div>

      {r.blockedBy && r.blockedBy.length > 0 && (
        <div className="section-block">
          <h4>阻断问题</h4>
          {r.blockedBy.map((f, i) => (
            <div key={i} className="finding error">
              <span className="code">{f.code}</span>
              <span>{f.message}</span>
            </div>
          ))}
        </div>
      )}

      {r.cnameChain.length > 0 && (
        <div className="cname-chain">
          <h4 style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6, margin: "4px 0" }}>
            CNAME 链
          </h4>
          {r.cnameChain.map((h) => (
            <div key={h.index} className="hop">
              <span className="idx">{h.index}</span>
              <span>{h.alias}</span>
              <span>→</span>
              <span>{h.target}</span>
              <span className={`st ${h.targetStatus}`} title={h.note}>
                {statusLabel(h.targetStatus)}
              </span>
            </div>
          ))}
        </div>
      )}

      {r.answer.length > 0 && <Section title="ANSWER 应答段" lines={r.answer} />}
      {r.authority.length > 0 && <Section title="AUTHORITY 权威段" lines={r.authority} />}
      {r.additional.length > 0 && <Section title="ADDITIONAL 附加段" lines={r.additional} />}

      {r.answer.length === 0 && r.authority.length === 0 && r.kind !== "invalid" && (
        <div className="muted" style={{ fontSize: 11.5, padding: "4px 8px" }}>
          应答中无记录{["nxdomain", "nodata"].includes(r.kind) ? "（见上方 authority 段的 SOA）" : ""}
        </div>
      )}

      {!compact && r.resolutionTrace.length > 0 && (
        <details className="trace" style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer" }}>解析过程</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {r.resolutionTrace.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function statusLabel(s: string): string {
  switch (s) {
    case "in-zone-positive":
      return "本区有最终记录";
    case "in-zone-nodata":
      return "本区名字在·无此类型";
    case "in-zone-nxdomain":
      return "本区名字不存在";
    case "delegated":
      return "落入委派·转介";
    case "out-of-zone":
      return "区外·链路停止";
    default:
      return s;
  }
}

function Section({ title, lines }: { title: string; lines: AnswerRecord[] }) {
  return (
    <div className="section-block">
      <h4>{title}</h4>
      {lines.map((a, i) => (
        <div key={a.id + i} className={`ans-line ${a.provenance.section}`}>
          <div className="rr">
            {a.name}. {a.ttl} {a.type} {rdataToText(a.type, a.rdata)}
          </div>
          <div className="prov">
            {a.provenance.synthesizedFrom && (
              <>
                通配合成自 <b>{a.provenance.synthesizedFrom}.</b>{" "}
              </>
            )}
            {a.provenance.delegationPoint && (
              <>
                切点 <b>{a.provenance.delegationPoint}.</b>{" "}
              </>
            )}
            {a.provenance.note && <>{a.provenance.note} · </>}
            出处 {a.provenance.versionLabel}
          </div>
        </div>
      ))}
    </div>
  );
}
