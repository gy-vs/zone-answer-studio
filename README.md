# Zone Answer Studio

本机运行的 DNS 区域编辑与**权威查询预览**全栈工具。它不查询公共 DNS、不注册域名、
不碰云账号；它回答的唯一问题是：**这份保存在本机的区域，在给定查询下会给出什么权威结果。**

## 它解决什么

手工审区域时最容易混的几件事，这里都按区域语义区分开：

- **NXDOMAIN vs NODATA**：名字不存在（NXDOMAIN）与名字存在但没有所问类型（NOERROR 空应答）分别展示，否定应答 authority 段给出 SOA。
- **通配不是字符串匹配**：`*.example.net` 只合成其下**恰好一个标签**的名字，且不能穿过已存在的名字（RFC 4592）。`a.b.example.net` 不会被 `*.example.net` 命中。
- **委派是转介**：给非起点名字加 NS 即产生委派切点；切点之下任意深度的查询都返回 AA=0 的 referral——authority 放切点 NS，additional 放 in-bailiwick glue。父区域残留的同名普通记录不会作答（会被标记为 `shadowed-by-delegation` 警告）。
- **CNAME 链有出处**：别名目标仍在本区域时给出完整链路与最终记录；目标在区域外时链路在本区停止（`cname-target-external`），目标落入已委派子域时给转介；别名环单独报出。
- **冲突阻止发布**：同一名字上 CNAME 与其他记录共存、起点出现 CNAME、CNAME 多重等是 error，直接阻断发布，并指出是**哪一次草稿编辑**造成的。
- **草稿与正式分离**：查询预览左右并列“当前草稿”与“已发布/任意历史版本”，应答记录带版本出处，不把当前记录倒灌给历史查询。
- **多窗口不互相静默覆盖**：每次保存带单调修订号做乐观并发；过期保存收到 409 并加载服务器最新草稿。状态整体原子落盘，刷新不会看到“新 SOA + 旧记录”的撕裂版本。

## 启动

```bash
npm install
npm run dev          # 开发模式，Vite 中间件，默认 http://localhost:5173
# 或
npm run build && npm start   # 生产模式：构建前端后由同一服务托管 dist/
```

端口可用 `PORT=xxxx` 覆盖。所有数据保存在 `data/state.json`（可用 `ZAS_DATA_FILE` 改路径），
删除该文件即恢复内置示例区域（example.net，含起点 SOA/NS、www、app 别名、MX 与通配）。

## 界面

- **左：区域树** —— 起点、SOA、NS 与各名字下的 RRset；紫色是委派切点，青色是通配节点。
- **中：记录集** —— 编辑 SOA、增删改记录（名字可填相对名，自动补 origin）；该名字相关的校验错误/警告就地显示。
- **右：查询预览** —— 输入查询名与类型，左右并列草稿与选定版本（正式/历史）的应答类别、
  ANSWER/AUTHORITY/ADDITIONAL 三段、每条记录的出处（版本、通配合成来源、委派切点）、CNAME 链每一跳的状态，以及完整解析过程。
- **底部三块**：
  - 待发布变更（记录级 diff + SOA 差异 + 阻断错误与肇事编辑 + 发布/丢弃）；
  - 查询样例对照（把关注的查询存为样例，一批比较草稿与正式的应答差异）；
  - 版本历史（不可变快照，可在查询预览中选为对照版本）。

## 验收

```bash
npm run test:semantics          # 29 项解析/校验语义测试（直接跑解析器）
# 端到端（需要一个干净实例）：
PORT=5299 npm start &
python3 server/acceptance.py    # 47 项 HTTP 级验收
```

端到端覆盖：草稿/正式对照、委派/别名/通配改动产生的不同应答、CNAME 冲突阻断发布并归因到编辑、
409 并发保存不覆盖、发布原子性、重启持久化、历史版本不被当前记录倒灌。

## 技术形态

- TypeScript + React 18（Vite）前端；Node.js 原生 `http` 后端，无第三方运行时依赖。
- 服务端负责区域校验（`server/domain/validator.ts`）、权威查询（`server/domain/resolver.ts`）、
  差异与版本保存（`server/domain/diff.ts`、`server/store.ts`）；前端只做编辑与对照展示，
  不在浏览器里硬编码任何应答。
- 写入串行化并以临时文件 rename 原子落盘；发布生成带 serial 的不可变版本快照。

## 支持的记录类型

A、AAAA、CNAME、NS、SOA（区域级）、MX、TXT、SRV、PTR、CAA；查询另支持 ANY。
名字只支持普通标签与整标签通配 `*`（必须是最左标签），不做 DNS 转义字符的完整实现。
