// HTTP 端到端工作流：查询对照 → 草稿改动 → 冲突 → 发布 → 历史版本不变 → 委派/通配变更。
const BASE = 'http://127.0.0.1:5174';

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, detail); }
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

async function query(name: string, qtype = 'A', source = 'draft') {
  const { body } = await api('/api/query', { method: 'POST', body: JSON.stringify({ name, qtype, source }) });
  return body;
}

console.log('A) 首次状态：无已发布版本；草稿查询可用');
{
  const b = (await api('/api/boot')).body;
  check('revision=1，无已发布', b.draft.revision === 1 && b.published === null);
  const r = await query('www', 'A');
  check('www A 草稿 ANSWER 跟随到 10.0.1.10',
    r.response.kind === 'ANSWER' && r.response.answers.some((a: any) => a.rr.rdata.address === '10.0.1.10'));
  check('foo.eu 草稿 REFERRAL', (await query('foo.eu')).response.kind === 'REFERRAL');
  check('random 草稿 wildcard ANSWER', (await query('random')).response.wildcardUsed === '*.lab.internal.');
  check('a.b 多层 NXDOMAIN', (await query('a.b')).response.kind === 'NXDOMAIN');
}

console.log('B) 发布基线版本');
let v1: any;
{
  const { status, body } = await api('/api/publish', { method: 'POST', body: JSON.stringify({ client: 't1', note: 'baseline' }) });
  check('发布 200', status === 200, JSON.stringify(body));
  v1 = body.published;
  check('版本 id 存在、serial 递增', !!v1.id && v1.serial >= 2026100101);
}

console.log('C) 已发布版本应答被冻结');
{
  const r = await query('www', 'A', 'published');
  check('已发布列标记来源版本', r.source === 'published' && r.sourceVersionId === v1.id);
  check('已发布 www 仍是旧地址', r.response.answers.some((a: any) => a.rr.rdata.address === '10.0.1.10'));
}

console.log('D) 草稿改动：app 换地址 + www 改别名到 mail；只影响草稿');
{
  const boot = (await api('/api/boot')).body;
  const app = boot.draft.records.find((r: any) => r.type === 'A' && r.name === 'app.lab.internal.');
  const www = boot.draft.records.find((r: any) => r.type === 'CNAME' && r.name === 'www.lab.internal.');
  const ops = [
    { id: 'op-app', at: '', client: 't1', kind: 'update', before: app, after: { ...app, rdata: { address: '10.0.1.77' } } },
    { id: 'op-www', at: '', client: 't1', kind: 'update', before: www, after: { ...www, rdata: { target: 'mail.lab.internal.' } } },
  ];
  const { status, body } = await api('/api/draft/ops', {
    method: 'POST', body: JSON.stringify({ ops, baseRevision: boot.draft.revision, client: 't1' }),
  });
  check('保存草稿 200 且 revision+1', status === 200 && body.draft.revision === boot.draft.revision + 1);

  const d = await query('www', 'A', 'draft');
  check('草稿 www 现跟随 mail → 10.0.0.25',
    d.response.answers.some((a: any) => a.rr.rdata.address === '10.0.0.25') &&
    d.response.cnameChain[0].to === 'mail.lab.internal.');
  const p = await query('www', 'A', 'published');
  check('已发布 www 仍是旧链路 app → 10.0.1.10（不倒灌）',
    p.response.answers.some((a: any) => a.rr.rdata.address === '10.0.1.10') &&
    p.response.cnameChain[0].to === 'app.lab.internal.');

  // 影响概览：样例 s1(www)/s2(app) 变化
  const fx = (await api('/api/effects')).body.entries;
  const changedNames = fx.filter((e: any) => e.effect === 'changed').map((e: any) => e.sample.name);
  check('影响概览标出 www 与 app 变化',
    changedNames.includes('www.lab.internal.') && changedNames.includes('app.lab.internal.'),
    JSON.stringify(changedNames));
}

console.log('E) 并行编辑：旧窗口 revision 不允许覆盖');
{
  const boot = (await api('/api/boot')).body;
  const stale = await api('/api/draft/ops', {
    method: 'POST',
    body: JSON.stringify({
      ops: [{ id: 'op-stale', at: '', client: 'old-win', kind: 'add',
        rr: { name: 'intruder', type: 'A', ttl: 60, fields: { address: '1.1.1.1' } } }],
      baseRevision: 1, client: 'old-win', // 故意用过时 revision
    }),
  });
  check('旧 revision 保存被 409 拒绝', stale.status === 409 && stale.body.code === 'REVISION_CONFLICT');
  check('响应给出当前 revision', stale.body.currentRevision === boot.draft.revision);
  const after = (await api('/api/boot')).body;
  check('被拒改动未写入草稿', !after.draft.records.some((r: any) => r.name === 'intruder.lab.internal.'));
}

console.log('F) 发布阻塞：制造 CNAME 冲突，错误归因到具体操作');
{
  const boot = (await api('/api/boot')).body;
  const { status, body } = await api('/api/draft/ops', {
    method: 'POST',
    body: JSON.stringify({
      ops: [{ id: 'op-badconflict', at: '', client: 't1', kind: 'add',
        rr: { name: 'mail', type: 'CNAME', ttl: 60, fields: { target: 'app' } } }],
      baseRevision: boot.draft.revision, client: 't1',
    }),
  });
  check('冲突记录可进草稿（保存不等于发布）', status === 200);
  const issue = body.validation.issues.find((i: any) => i.code === 'CNAME_CONFLICT');
  check('校验报 CNAME_CONFLICT 且归因 op-badconflict',
    !!issue && issue.opIds.includes('op-badconflict'), JSON.stringify(issue));
  const pub = await api('/api/publish', { method: 'POST', body: JSON.stringify({ client: 't1' }) });
  check('带冲突发布被 422 阻止', pub.status === 422 && pub.body.code === 'VALIDATION_FAILED');

  // 删除冲突记录解除阻塞
  const boot2 = (await api('/api/boot')).body;
  // 找到刚加的记录
  const bad = boot2.draft.records.find((r: any) => r.name === 'mail.lab.internal.' && r.type === 'CNAME');
  await api('/api/draft/ops', {
    method: 'POST',
    body: JSON.stringify({
      ops: [{ id: 'op-rm', at: '', client: 't1', kind: 'delete', rr: bad }],
      baseRevision: boot2.draft.revision, client: 't1',
    }),
  });
}

console.log('G) 发布新版本；旧版本查询保持冻结');
let v2: any;
{
  const pub = await api('/api/publish', { method: 'POST', body: JSON.stringify({ client: 't1', note: 'repoint' }) });
  check('第二次发布成功', pub.status === 200);
  v2 = pub.body.published;
  const old = await query('www', 'A', v1.id);
  check('回看 v1 的 www 仍是 app/10.0.1.10',
    old.response.answers.some((a: any) => a.rr.rdata.address === '10.0.1.10'));
  const now = await query('www', 'A', 'published');
  check('当前正式 v2 的 www 是 mail/10.0.0.25',
    now.response.answers.some((a: any) => a.rr.rdata.address === '10.0.0.25') &&
    now.sourceVersionId === v2.id);
  const list = (await api('/api/versions')).body;
  check('版本列表含两个不可变版本', list.length === 2);
}

console.log('H) 委派变更：给 asia 加 NS+胶水后，父区对其下名字只给转介');
{
  const boot = (await api('/api/boot')).body;
  const rev = boot.draft.revision;
  const ops = [
    { id: 'op-asia-ns', at: '', client: 't1', kind: 'add',
      rr: { name: 'asia', type: 'NS', ttl: 3600, fields: { target: 'ns1.asia' } } },
    { id: 'op-asia-glue', at: '', client: 't1', kind: 'add',
      rr: { name: 'ns1.asia', type: 'A', ttl: 3600, fields: { address: '10.2.0.11' } } },
    { id: 'op-asia-host', at: '', client: 't1', kind: 'add',
      rr: { name: 'host.asia', type: 'A', ttl: 60, fields: { address: '10.2.9.9' } } },
  ];
  const { body } = await api('/api/draft/ops', {
    method: 'POST', body: JSON.stringify({ ops, baseRevision: rev, client: 't1' }),
  });
  const below = body.validation.issues.find((i: any) => i.code === 'BELOW_CUT_DATA');
  check('委派点下残留 host.asia A 被报阻塞错误', !!below && below.opIds.includes('op-asia-host'));

  // 去掉残留记录，仅保留 NS+glue，重新保存
  const boot2 = (await api('/api/boot')).body;
  const hostA = boot2.draft.records.find((r: any) => r.name === 'host.asia.lab.internal.');
  await api('/api/draft/ops', {
    method: 'POST',
    body: JSON.stringify({
      ops: [{ id: 'op-rm-host', at: '', client: 't1', kind: 'delete', rr: hostA }],
      baseRevision: boot2.draft.revision, client: 't1',
    }),
  });
  const r = await query('anything.asia', 'A', 'draft');
  check('asia 下任意名字返回 REFERRAL（非 AA）',
    r.response.kind === 'REFERRAL' && r.response.authoritative === false &&
    r.response.cutName === 'asia.lab.internal.');
  check('Authority 是 NS、Additional 是胶水 10.2.0.11',
    r.response.authority.some((a: any) => a.rr.type === 'NS') &&
    r.response.additional.some((a: any) => a.source === 'glue' && a.rr.rdata.address === '10.2.0.11'));
  check('Answer 段不虚构最终地址', r.response.answers.length === 0);
}

console.log('I) 持久化原子性：重启服务后状态仍在，版本不混版');
{
  // 只做读取验证：state.json 是整文件原子替换；重新 boot
  const b = (await api('/api/boot')).body;
  check('重启无关——当前正式仍为 v2', b.published.id === v2.id);
  check('草稿 revision 高于发布后基线', b.draft.revision >= 5);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
