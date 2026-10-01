#!/usr/bin/env python3
"""端到端验收：通过 HTTP API 驱动真实服务端状态，覆盖
保存/发布、草稿与正式对照、委派/别名/通配语义、并发冲突与版本不变性。"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

PORT = int(os.environ.get("PORT", "5299"))
BASE = f"http://localhost:{PORT}"

passed = 0
failed = 0


def call(method, path, body=None, expect=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            payload = json.loads(r.read())
            code = r.status
    except urllib.error.HTTPError as e:
        payload = json.loads(e.read())
        code = e.code
    if expect is not None and code != expect:
        raise AssertionError(f"{method} {path} expected {expect}, got {code}: {payload}")
    return code, payload


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✗ {name}  {detail}")


def query(qname, qtype, target):
    _, r = call("POST", "/api/query", {"qname": qname, "qtype": qtype, "target": target})
    return r


def mutate(rev, ops, editor="win_alpha"):
    return call("POST", "/api/mutate", {
        "editor": {"editorId": editor, "label": editor},
        "baseRevision": rev,
        "operations": ops,
    })


def add(rev, edit_id, name, t, rdata, ttl=3600, editor="win_alpha"):
    return mutate(rev, [
        {"op": "addRecord", "editId": edit_id, "name": name, "type": t, "ttl": ttl, "rdata": rdata}
    ], editor)


def main():
    # 等服务起来
    for _ in range(40):
        try:
            call("GET", "/api/state")
            break
        except Exception:
            time.sleep(0.25)

    print("【1】初始区域：正式版与草稿一致")
    _, st = call("GET", "/api/state")
    rev = st["revision"]
    check("种子区域已发布 v1", st["published"]["id"] == "v1")
    check("草稿无未发布改动", st["editLog"] == [])

    for qn, qt in [("www.example.net", "A"), ("app.example.net", "A"),
                   ("anything.example.net", "A"), ("nope.example.net", "MX")]:
        pub = query(qn, qt, "published")
        drf = query(qn, qt, "draft")
        check(f"对照一致 {qn} {qt}: {pub['kind']}", pub["kind"] == drf["kind"])

    print("【2】NXDOMAIN vs NODATA 不被混淆")
    # 注意：ghost.example.net 会被种子通配 *.example.net 命中；
    # 真正“不存在”要取通配够不到的两级名字
    r = query("a.ghost.example.net", "A", "published")
    check("两级之下无记录 = NXDOMAIN（通配只能合成一级）",
          r["kind"] == "nxdomain" and r["rcode"] == "NXDOMAIN", r["kind"])
    r1 = query("ghost.example.net", "A", "published")
    check("一级名字反而被通配合成为肯定应答", r1["kind"] == "positive", r1["kind"])
    r = query("www.example.net", "AAAA", "published")
    check("名字在但无 AAAA = NODATA", r["kind"] == "nodata" and r["rcode"] == "NOERROR")
    check("否定应答 authority 带 SOA", any(a["type"] == "SOA" for a in r["authority"]))

    print("【3】通配不是任意层级字符串匹配")
    r = query("one.example.net", "A", "published")
    check("一级标签命中 *.example.net",
          r["kind"] == "positive"
          and r["answer"][0]["provenance"]["synthesizedFrom"] == "*.example.net")
    r = query("a.b.example.net", "A", "published")
    check("两级标签不被 * 匹配 = NXDOMAIN", r["kind"] == "nxdomain", r["kind"])

    print("【4】草稿：新增子域委派（NS+glue）")
    code, r = mutate(rev, [
        {"op": "addRecord", "editId": "e_eu_ns", "name": "eu.example.net",
         "type": "NS", "ttl": 3600, "rdata": {"value": "ns1.eu.example.net"}},
        {"op": "addRecord", "editId": "e_eu_glue", "name": "ns1.eu.example.net",
         "type": "A", "ttl": 3600, "rdata": {"value": "10.20.0.1"}},
        {"op": "addRecord", "editId": "e_eu_stray", "name": "cache.eu.example.net",
         "type": "A", "ttl": 60, "rdata": {"value": "10.20.9.9"}},
    ])
    rev = r["revision"]
    check("父区残留记录产生 shadowed 警告且归因到具体编辑",
          any(f["code"] == "shadowed-by-delegation" and f.get("editIds") == ["e_eu_stray"]
              for f in r["findings"]))

    draft_r = query("deep.cache.eu.example.net", "A", "draft")
    pub_r = query("deep.cache.eu.example.net", "A", "published")
    check("草稿：子域内任意深度 = 转介 AA=0",
          draft_r["kind"] == "referral" and draft_r["authoritative"] is False)
    check("转介 authority 是切点 NS",
          any(a["type"] == "NS" and a["provenance"]["delegationPoint"] == "eu.example.net"
              for a in draft_r["authority"]))
    check("转介 additional 带 in-bailiwick glue",
          any(a["name"] == "ns1.eu.example.net" and a["rdata"].get("value") == "10.20.0.1"
              for a in draft_r["additional"]))
    check("父区残留地址不在应答里",
          not any(a["rdata"].get("value") == "10.20.9.9" for a in draft_r["answer"]))
    check("正式版本不受草稿影响：同名字仍 NXDOMAIN",
          pub_r["kind"] == "nxdomain", pub_r["kind"])

    print("【5】草稿：把别名改指向区域外")
    # 用替换：找到 app CNAME 记录 id
    _, st = call("GET", "/api/state")
    app_id = [x["id"] for x in st["draft"]["records"]
              if x["name"] == "app.example.net" and x["type"] == "CNAME"][0]
    code, r = mutate(rev, [{
        "op": "replaceRecord", "editId": "e_app_ext", "recordId": app_id,
        "name": "app.example.net", "type": "CNAME", "ttl": 300,
        "rdata": {"value": "app.cdn.example.org"},
    }])
    rev = r["revision"]
    r = query("app.example.net", "A", "draft")
    check("草稿别名出区：链路在本区停止",
          r["kind"] == "cname-target-external"
          and r["cnameChain"][0]["targetStatus"] == "out-of-zone"
          and r["answer"][0]["type"] == "CNAME"
          and len(r["answer"]) == 1)
    r0 = query("app.example.net", "A", "published")
    check("正式别名仍在本区内解析到 www",
          r0["kind"] == "positive"
          and [a["type"] for a in r0["answer"]] == ["CNAME", "A"])

    print("【6】草稿：通配改为 CNAME，通配语义跟随别名链")
    _, st = call("GET", "/api/state")
    star_id = [x["id"] for x in st["draft"]["records"]
               if x["name"] == "*.example.net" and x["type"] == "A"][0]
    code, r = mutate(rev, [{
        "op": "replaceRecord", "editId": "e_star_cname", "recordId": star_id,
        "name": "*.example.net", "type": "CNAME", "ttl": 60,
        "rdata": {"value": "www.example.net"},
    }])
    rev = r["revision"]
    check("通配改 CNAME 与什么都不冲突（通配下原本无他类记录）",
          not [f for f in r["findings"] if f["severity"] == "error"])
    r = query("rand123.example.net", "A", "draft")
    check("通配合成后再跟随 CNAME 到最终 A",
          r["kind"] == "positive"
          and [a["type"] for a in r["answer"]] == ["CNAME", "A"]
          and r["answer"][0]["provenance"]["synthesizedFrom"] == "*.example.net")
    r = query("x.y.example.net", "A", "draft")
    check("多级仍不匹配通配（别名不改变层级规则）", r["kind"] == "nxdomain", r["kind"])

    print("【7】CNAME 与同名他类记录冲突 → 阻断发布并指出肇事编辑")
    code, r = mutate(rev, [
        {"op": "addRecord", "editId": "e_dup_cname", "name": "dup.example.net",
         "type": "CNAME", "ttl": 60, "rdata": {"value": "www.example.net"}},
        {"op": "addRecord", "editId": "e_dup_a", "name": "dup.example.net",
         "type": "A", "ttl": 60, "rdata": {"value": "1.1.1.1"}},
    ])
    rev = r["revision"]
    block = [f for f in r["findings"] if f["code"] == "cname-coexistence"]
    check("校验报 cname-coexistence", len(block) == 1)
    check("肇事编辑被精确标注",
          set(block[0]["editIds"]) == {"e_dup_cname", "e_dup_a"})
    code, r = call("POST", "/api/publish", {
        "editor": {"editorId": "win_alpha", "label": "alpha"},
        "baseRevision": rev, "note": "应被拒绝",
    }, expect=422)
    check("发布返回 422 publish-blocked", r["code"] == "publish-blocked")
    check("阻断原因可追到编辑 id",
          any(set(f.get("editIds", [])) >= {"e_dup_a"} for f in r["findings"]))
    # 修复：删掉 A
    _, st = call("GET", "/api/state")
    dup_a_id = [x["id"] for x in st["draft"]["records"]
                if x["name"] == "dup.example.net" and x["type"] == "A"][0]
    code, r = mutate(rev, [
        {"op": "deleteRecords", "editId": "e_fix_dup", "recordIds": [dup_a_id]}])
    rev = r["revision"]
    check("修复后无阻断错误", not [f for f in r["findings"] if f["severity"] == "error"])

    print("【8】并行编辑：旧窗口的过期保存被 409 拒绝且不覆盖新草稿")
    # 窗口 beta 在当前 rev 之上抢先保存
    code, rb = mutate(rev, [
        {"op": "addRecord", "editId": "e_beta", "name": "beta.example.net",
         "type": "TXT", "ttl": 60, "rdata": {"text": "from beta"}}
    ], editor="win_beta")
    new_rev = rb["revision"]
    check("beta 保存成功", code == 200)
    # alpha 仍拿着旧 rev 保存
    code, rc = mutate(rev, [
        {"op": "addRecord", "editId": "e_alpha_late", "name": "alpha-late.example.net",
         "type": "A", "ttl": 60, "rdata": {"value": "8.8.8.8"}}
    ], editor="win_alpha")
    check("alpha 过期保存 → 409", code == 409 and rc["code"] == "conflict")
    check("冲突体带回服务器当前修订号", rc["conflict"]["currentRevision"] == new_rev)
    check("beta 的改动在服务器草稿里",
          any(x["name"] == "beta.example.net" for x in rc["conflict"]["currentZone"]["records"]))
    check("alpha 的迟到改动未被写入",
          not any(x["name"] == "alpha-late.example.net"
                  for x in rc["conflict"]["currentZone"]["records"]))
    rev = new_rev  # alpha 按提示同步到新基线

    print("【9】发布前：样例批量对照能指出受影响查询")
    code, rv = call("GET", "/api/samples/review")
    check("对照修订号为当前草稿修订", rv["revision"] == rev)
    by_q = {it["sample"]["qname"] + "/" + it["sample"]["qtype"]: it for it in rv["items"]}
    app_it = by_q["app.example.net/A"]
    any_it = by_q["anything.example.net/A"]
    check("app 样例被标记为已变化", app_it["changed"] is True)
    check("变化说明提到应答类别改变",
          any("应答类别" in c for c in app_it["changes"]))
    check("通配样例（anything）被标记为受影响", any_it["changed"] is True)
    check("www 样例未受影响", by_q["www.example.net/A"]["changed"] is False)

    print("【10】发布为原子新版本")
    code, r = call("POST", "/api/publish", {
        "editor": {"editorId": "win_alpha", "label": "alpha"},
        "baseRevision": rev, "note": "委派 eu + 别名与通配调整",
    }, expect=200)
    v_new = r["version"]["id"]
    rev = r["revision"]
    check("发布产生新版本（v1 之后为 v2）", v_new == "v2", v_new)
    check("发布后草稿编辑日志清空", r["editLog"] == [])
    check("发布后 serial 自动推进", isinstance(r["version"]["serial"], int))

    print("【11】发布后批量对照全部回到一致")
    code, rv = call("GET", "/api/samples/review")
    check("所有样例草稿与正式一致", all(not it["changed"] for it in rv["items"]))

    print("【12】历史版本不可变：当前记录不倒灌进旧结果")
    # v1: eu 子域不存在（NXDOMAIN）；新版本: 转介
    r_v1 = query("cache.eu.example.net", "A", "v1")
    r_v3 = query("cache.eu.example.net", "A", v_new)
    r_pub = query("cache.eu.example.net", "A", "published")
    check("v1 历史结果仍是 NXDOMAIN", r_v1["kind"] == "nxdomain" and r_v1["zoneVersionId"] == "v1")
    check("新版本结果是转介", r_v3["kind"] == "referral" and r_v3["zoneVersionId"] == v_new)
    check("published 指向新版本", r_pub["kind"] == "referral")
    # v1: app CNAME 在区内；新版本: app 出区
    check("v1 的 app 仍区内正向解析",
          query("app.example.net", "A", "v1")["kind"] == "positive")
    check("新版本的 app 出区停止",
          query("app.example.net", "A", v_new)["kind"] == "cname-target-external")

    print(f"\n结果：{passed} 通过，{failed} 失败")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
