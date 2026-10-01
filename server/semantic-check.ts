// 端到端语义验收脚本（直接驱动服务端模块，不起 HTTP）。
// 覆盖：精确/ENT/通配层级、NODATA vs NXDOMAIN、委派+胶水、CNAME 链各类终止。
import { ZoneResolver } from './dns/resolver.js';
import { validateZone } from './dns/validate.js';
import { parseRdata } from './dns/rdata.js';
import type { RR, RRType } from '../shared/types.js';

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${detail}`); }
}

const Z = 'lab.internal.';
let seq = 0;
function rr(name: string, type: RRType, fields: Record<string, string>, ttl = 3600): RR {
  const n = name === '@' ? Z : name.endsWith('.') ? name : `${name}.${Z}`;
  return { id: `t${seq++}`, name: n, type, ttl, rdata: parseRdata(type, fields, { zoneName: Z }) };
}

function baseRecords(): RR[] {
  return [
    rr('@', 'SOA', { mname: 'ns1.' + Z, rname: 'hm.' + Z, serial: '1', refresh: '1', retry: '1', expire: '1', minimum: '60' }),
    rr('@', 'NS', { target: 'ns1.' + Z }),
    rr('ns1', 'A', { address: '10.0.0.11' }),
    rr('app', 'A', { address: '10.0.1.10' }),
    rr('app', 'TXT', { text: 'app-owner' }),
    rr('www', 'CNAME', { target: 'app' }),
    rr('*', 'A', { address: '10.0.9.9' }),
    // 已存在的中间节点 svc，其下有一个精确主机
    rr('a.svc', 'A', { address: '10.0.2.1' }),
    // 委派 eu
    rr('eu', 'NS', { target: 'ns1.eu' }),
    rr('ns1.eu', 'A', { address: '10.1.0.11' }),
    // 区外别名
    rr('ext', 'CNAME', { target: 'cdn.example.net.' }),
    // 环
    rr('loop1', 'CNAME', { target: 'loop2' }),
    rr('loop2', 'CNAME', { target: 'loop1' }),
    // 别名到无此类型的名字
    rr('txtonly', 'TXT', { text: 'hello' }),
    rr('via', 'CNAME', { target: 'txtonly' }),
    // 别名到不存在名字（跨两层，顶层通配也无法合成）
    rr('ghost', 'CNAME', { target: 'gone.away' }),
  ];
}

const records = baseRecords();
const resolver = new ZoneResolver(Z, records);
const q = (name: string, type: RRType | 'ANY' = 'A') =>
  resolver.query(name.endsWith('.') ? name : `${name}.${Z}`, type);

console.log('1) 基本应答');
check('精确 A 返回 ANSWER/AA', (() => {
  const r = q('app');
  return r.kind === 'ANSWER' && r.authoritative && r.answers[0].rr.rdata.address === '10.0.1.10' && r.answers[0].source === 'exact';
})());

console.log('2) NODATA vs NXDOMAIN');
check('app 的 AAAA 是 NODATA（名字在、类型无）', (() => {
  const r = q('app', 'AAAA');
  return r.kind === 'NODATA' && r.rcode === 'NOERROR' &&
    r.answers.length === 0 && r.authority[0]?.rr.type === 'SOA';
})());
check('空非终端 svc 的 A 查询是 NODATA（ENT 名字存在）', q('svc').kind === 'NODATA');
check('不存在主机（跨两层）是 NXDOMAIN', (() => {
  const r = q('zz.nope');
  return r.kind === 'NXDOMAIN' && r.rcode === 'NXDOMAIN' && r.authority[0]?.rr.type === 'SOA';
})());
check('svc 的 AAAA 同样是 NODATA 而非 NXDOMAIN', q('svc', 'AAAA').kind === 'NODATA');

console.log('3) 通配只匹配一层');
check('random 命中 * 通配（wildcard 来源、合成名）', (() => {
  const r = q('random');
  return r.kind === 'ANSWER' && r.answers[0].source === 'wildcard' &&
    r.wildcardUsed === `*.${Z}` && r.answers[0].rr.name === `random.${Z}`;
})());
check('多层 x.y 不命中通配 → NXDOMAIN', q('x.y').kind === 'NXDOMAIN');
check('已存在中间节点 svc 的任意直接子名（x.svc）不被顶层通配合成', (() => {
  const r = q('x.svc');
  return r.kind === 'NXDOMAIN';
})());
check('不存在的 a.svc 兄弟 b.svc 也不命中顶层 *', q('b.svc').kind === 'NXDOMAIN');
check('精确记录优先于通配（app）', q('app').answers[0].rr.rdata.address === '10.0.1.10');
check('问通配自身 *.lab 类型为 A 时返回通配节点', q('*').answers.length === 1);

console.log('4) 委派与胶水');
check('eu 下名字 foo.eu 返回 REFERRAL/非AA', (() => {
  const r = q('foo.eu');
  return r.kind === 'REFERRAL' && !r.authoritative && r.cutName === `eu.${Z}` &&
    r.authority.some((a) => a.rr.type === 'NS') &&
    r.additional.some((a) => a.source === 'glue' && a.rr.rdata.address === '10.1.0.11');
})());
check('深层 a.b.eu 仍是到 eu 的转介，不返回虚构地址', (() => {
  const r = q('a.b.eu');
  return r.kind === 'REFERRAL' && r.answers.filter((x) => x.rr.type === 'A').length === 0;
})());
check('直接问 eu NS：既是转介也按惯例在 answer 放 NS', (() => {
  const r = q('eu', 'NS');
  return r.kind === 'REFERRAL' && r.answers.some((a) => a.rr.type === 'NS');
})());
check('委派点胶水地址不会被父区当成普通 A 应答（eu 的 A 不是 glue target）',
  q('ns1.eu', 'A').kind === 'REFERRAL');

console.log('5) CNAME 链');
check('www A 跟随到 app，链 1 跳且最终 AA', (() => {
  const r = q('www');
  return r.kind === 'ANSWER' && r.cnameChain.length === 1 &&
    r.answers[0].rr.type === 'CNAME' && r.answers[1].rr.rdata.address === '10.0.1.10' &&
    r.authoritative;
})());
check('www TXT 跟随到 app 的 TXT', q('www', 'TXT').answers.some((a) => a.rr.type === 'TXT'));
check('直接问 www CNAME 只返回 CNAME 本身', (() => {
  const r = q('www', 'CNAME');
  return r.answers.length === 1 && r.answers[0].rr.type === 'CNAME';
})());
check('www AAAA 是链终结 NODATA（CNAME_MISS）', q('www', 'AAAA').kind === 'CNAME_MISS');
check('via A：链到 txtonly 无 A → CNAME_MISS', q('via').kind === 'CNAME_MISS');
check('ghost A：链到不存在名字 → CNAME_NXDOMAIN 且链上有 CNAME', (() => {
  const r = q('ghost');
  return r.kind === 'CNAME_NXDOMAIN' && r.rcode === 'NXDOMAIN' && r.answers[0].rr.type === 'CNAME';
})());
check('ext A：区外目标 → CNAME_EXTERNAL，AA=0，链止', (() => {
  const r = q('ext');
  return r.kind === 'CNAME_EXTERNAL' && !r.authoritative &&
    r.answers[0].rr.type === 'CNAME' && r.cnameChain[0].inZone === false;
})());
check('loop1 A：成环 → CNAME_LOOP', q('loop1').kind === 'CNAME_LOOP');

console.log('6) 区外');
check('example.org A → OUT_OF_ZONE/REFUSED', q('host.example.org.', 'A').kind === 'OUT_OF_ZONE');

console.log('7) 校验：冲突与委派');
const v1 = validateZone({ zoneName: Z }, records, []);
check('基线区域无阻塞错误', v1.ok, JSON.stringify(v1.issues.filter((i) => i.severity === 'error')));

// CNAME 与同名 A 冲突
const conflict = [
  ...records,
  rr('app', 'CNAME', { target: 'other' }),
];
check('同名 CNAME+A 报错 CNAME_CONFLICT',
  !validateZone({ zoneName: Z }, conflict, []).ok &&
  validateZone({ zoneName: Z }, conflict, []).issues.some((i) => i.code === 'CNAME_CONFLICT'));

// 委派点下残留普通记录
const belowCut = [
  ...records,
  rr('foo.eu', 'A', { address: '10.9.9.9' }),
];
check('委派点下的普通 A 报 BELOW_CUT_DATA',
  validateZone({ zoneName: Z }, belowCut, []).issues.some((i) => i.code === 'BELOW_CUT_DATA'));

// 起点 SOA 缺失
const noSoa = records.filter((r) => r.type !== 'SOA');
check('缺 SOA 报 APEX_SOA_MISSING',
  validateZone({ zoneName: Z }, noSoa, []).issues.some((i) => i.code === 'APEX_SOA_MISSING'));

// 多条 SOA
const twoSoa = [...records, rr('@', 'SOA', { mname: 'x', rname: 'y', serial: '2', refresh: '1', retry: '1', expire: '1', minimum: '1' })];
check('两条 SOA 报 APEX_SOA_MULTIPLE',
  validateZone({ zoneName: Z }, twoSoa, []).issues.some((i) => i.code === 'APEX_SOA_MULTIPLE'));

console.log('8) 操作归因');
{
  const badRR = rr('app', 'CNAME', { target: 'other' });
  const ops = [{ id: 'op-xyz', at: '', client: 't', kind: 'add' as const, rr: badRR }];
  const v = validateZone({ zoneName: Z }, [...records, badRR], ops);
  const issue = v.issues.find((i) => i.code === 'CNAME_CONFLICT');
  check('CNAME 冲突能归因到具体草稿操作 op-xyz', !!issue?.opIds?.includes('op-xyz'));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
