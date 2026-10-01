// 手工语义冒烟测试（不进入正式交付，仅开发期验证）。
import { resolveQuery } from "./domain/resolver.ts";
import { validateZone } from "./domain/validator.ts";
import { emptyZone, defaultSoa } from "./domain/names.ts";
import type { Zone, ResourceRecord } from "../shared/types.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

function z(origin: string, recs: Array<[string, string, any]>, serial = 1): Zone {
  const records: ResourceRecord[] = recs.map(([n, t, r], i) => ({
    id: `r${i}`,
    name: n,
    type: t as never,
    ttl: 3600,
    rdata: r,
  }));
  return { origin, soa: defaultSoa(origin, serial), records };
}

const vm = { versionId: "v1", versionLabel: "v1" };

// 区域：app 是指向 www 的别名；*.wild 通配；sub 被委派
const zone = z("example.net", [
  ["example.net", "NS", { value: "ns1.example.net" }],
  ["ns1.example.net", "A", { value: "192.0.2.1" }],
  ["www.example.net", "A", { value: "192.0.2.20" }],
  ["app.example.net", "CNAME", { value: "www.example.net" }],
  ["alias-out.example.net", "CNAME", { value: "other.example.org" }],
  ["alias-sub.example.net", "CNAME", { value: "host.ent.example.net" }],
  ["*.wild.example.net", "A", { value: "192.0.2.55" }],
  ["ent.example.net", "NS", { value: "ns.ent.example.net" }], // 这是委派切点
  ["ns.ent.example.net", "A", { value: "192.0.2.70" }], // glue
  ["deep.example.net", "A", { value: "192.0.2.80" }],
  ["mx.example.net", "MX", { priority: 10, host: "mail.example.net" }],
  ["mail.example.net", "A", { value: "192.0.2.30" }],
  ["loop1.example.net", "CNAME", { value: "loop2.example.net" }],
  ["loop2.example.net", "CNAME", { value: "loop1.example.net" }],
  ["txtonly.example.net", "TXT", { text: "hi" }],
]);

const q = (name: string, type: any) => resolveQuery(zone, vm, name, type);

// 1. 普通肯定应答
let r = q("www.example.net", "A");
check("精确 A", r.kind === "positive" && r.answer[0].rdata.value === "192.0.2.20", r.kind);

// 2. CNAME 链到本区
r = q("app.example.net", "A");
check(
  "CNAME 链最终 A",
  r.kind === "positive" &&
    r.answer[0].type === "CNAME" &&
    r.answer[1].type === "A" &&
    r.cnameChain[0].targetStatus === "in-zone-positive",
  JSON.stringify({ kind: r.kind, a: r.answer.map((x) => x.type), s: r.cnameChain[0]?.targetStatus }),
);

// 3. CNAME 查询本身不跟随
r = q("app.example.net", "CNAME");
check("查 CNAME 返回 CNAME", r.kind === "positive" && r.answer.length === 1 && r.answer[0].type === "CNAME");

// 4. CNAME 目标存在但无所问类型：链 + NODATA
r = q("app.example.net", "AAAA");
check("链到目标但无 AAAA = nodata", r.kind === "nodata" && r.answer.some((a) => a.type === "CNAME"), r.kind);

// 5. 别名指向区域外
r = q("alias-out.example.net", "A");
check("CNAME 出区停止", r.kind === "cname-target-external" && r.answer.length === 1, r.kind);

// 6. 别名指向已委派子域 → 转介
r = q("alias-sub.example.net", "A");
check(
  "CNAME 到委派子域 → referral",
  r.kind === "referral" &&
    r.authority.some((a) => a.type === "NS" && a.provenance.delegationPoint === "ent.example.net") &&
    r.additional.some((a) => a.rdata.value === "192.0.2.70"),
  r.kind + " auth=" + JSON.stringify(r.authority.map((a) => a.name)),
);

// 7. 委派切点下任意深度都转介
r = q("x.y.ent.example.net", "A");
check("子域下深层名字转介", r.kind === "referral" && r.authoritative === false, r.kind);

// 8. 切点本身查 A：也是转介（父区切点处的 A 不应作答）
r = q("ent.example.net", "A");
check("切点本身 A 查询也是转介", r.kind === "referral", r.kind);

// 9. 通配恰好一级
r = q("foo.wild.example.net", "A");
check(
  "通配一级命中",
  r.kind === "positive" &&
    r.answer[0].provenance.synthesizedFrom === "*.wild.example.net" &&
    r.answer[0].name === "foo.wild.example.net",
  r.kind,
);

// 10. 通配不能匹配两级
r = q("a.b.wild.example.net", "A");
check("通配不匹配多级 = NXDOMAIN", r.kind === "nxdomain", r.kind + " " + r.resolutionTrace.join("|"));

// 11. 通配不能穿过已存在名字
const zone2 = z("ex.net", [
  ["host.wild.ex.net", "TXT", { text: "x" }],
  ["*.wild.ex.net", "A", { value: "1.2.3.4" }],
]);
r = resolveQuery(zone2, vm, "host.wild.ex.net", "A");
check("通配被已存在名字阻断 → nodata", r.kind === "nodata", r.kind);

// 12. NXDOMAIN vs NODATA
r = q("nope.example.net", "A");
check("不存在名字 NXDOMAIN", r.kind === "nxdomain" && r.rcode === "NXDOMAIN", r.kind);
r = q("txtonly.example.net", "A");
check("名字存在无类型 NODATA", r.kind === "nodata" && r.rcode === "NOERROR", r.kind);
r = q("txtonly.example.net", "TXT");
check("名字存在有类型 positive", r.kind === "positive", r.kind);

// 13. 空非终结点
r = q("example.net", "AAAA"); // origin 无 AAAA
check("起点 NODATA（非 NXDOMAIN）", r.kind === "nodata", r.kind);

// 14. MX additional
r = q("mx.example.net", "MX");
check("MX 应答 + additional 地址", r.kind === "positive" && r.additional.some((a) => a.name === "mail.example.net"), r.kind);

// 15. CNAME 环
r = q("loop1.example.net", "A");
check("CNAME 环", r.kind === "cname-loop", r.kind);

// 16. 区域外查询拒绝
r = q("www.elsewhere.com", "A");
check("区外 refused", r.kind === "refused", r.kind);

// 17. 委派后父区残留记录不作答
const zone3 = z("p.net", [
  ["p.net", "NS", { value: "ns1.p.net" }],
  ["ns1.p.net", "A", { value: "10.0.0.1" }],
  ["sub.p.net", "NS", { value: "ns.sub.p.net" }],
  ["ns.sub.p.net", "A", { value: "10.0.0.2" }],
  ["stray.sub.p.net", "A", { value: "10.0.0.99" }],
]);
const f3 = validateZone(zone3);
check(
  "委派下残留记录被标记 warning",
  f3.some((f) => f.code === "shadowed-by-delegation" && f.name === "stray.sub.p.net"),
  f3.map((x) => x.code).join(","),
);
r = resolveQuery(zone3, vm, "stray.sub.p.net", "A");
check("残留记录查询仍为转介", r.kind === "referral" && !r.answer.some((a) => a.rdata.value === "10.0.0.99"), r.kind);

// 18. CNAME 与其他记录共存 = 阻断错误
const zone4 = z("p.net", [
  ["c.p.net", "CNAME", { value: "x.p.net" }],
  ["c.p.net", "A", { value: "1.1.1.1" }],
]);
const f4 = validateZone(zone4);
check("CNAME 共存错误", f4.some((f) => f.severity === "error" && f.code === "cname-coexistence"));

// 19. 起点 CNAME 错误
const zone5 = z("p.net", [["p.net", "CNAME", { value: "x.p.net" }]]);
check("起点 CNAME 错误", validateZone(zone5).some((f) => f.code === "cname-at-apex"));

// 20. 区外记录（改起点遗留）
const zone6: Zone = {
  ...z("new.net", [["old.old.net", "A", { value: "1.1.1.1" }]]),
};
check("区外记录错误", validateZone(zone6).some((f) => f.code === "out-of-zone"));

// 21. glue 缺失告警
const zone7 = z("p.net", [["sub.p.net", "NS", { value: "ns.sub.p.net" }]]);
check("缺 glue 告警", validateZone(zone7).some((f) => f.code === "missing-glue"));

// 22. 否定应答 authority 含 SOA
r = q("nope.example.net", "A");
check("NXDOMAIN authority 有 SOA", r.authority.some((a) => a.type === "SOA"));
r = q("txtonly.example.net", "AAAA");
check("NODATA authority 有 SOA", r.authority.some((a) => a.type === "SOA"));

// 23. 通配名字本身查不存在的类型
r = q("*.wild.example.net", "TXT");
check("通配拥有者自身无 TXT → nodata", r.kind === "nodata", r.kind);

// 24. 起点 SOA 查询应肯定应答（SOA 来自 zone.soa）
const rs = q("example.net", "SOA");
check("起点 SOA 查询 positive", rs.kind === "positive" && rs.answer.some((a) => a.type === "SOA" && a.rdata.soa?.serial === 1), rs.kind);
const ra = q("example.net", "ANY");
check("起点 ANY 含 SOA 与 NS", ra.kind === "positive" && ra.answer.some((a) => a.type === "SOA") && ra.answer.some((a) => a.type === "NS"), ra.kind);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
