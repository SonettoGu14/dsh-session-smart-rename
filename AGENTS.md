# AGENTS.md

本文件面向**在这个仓库里工作的所有 agent 与人**。它是项目级约定；与用户级 `~/.dsh/AGENTS.md` 冲突时，以本文件为准。改动本文件请一并提交。

## 项目是什么

DSH（DeepSeek Harness）Web GUI 插件：把会话标题命名成 `分类 · 主题`，两个入口共用同一段分析逻辑。

- **人侧**：侧边栏会话行「…」→ 智能重命名 → 确认框，可改字、换分类、新建 tag；
- **模型侧**：工具 `smart_rename_session`，agent 可自己改名；省略 `title` 时插件分析对话自动命名，给了 `title` 就只负责钉住。

两条路都写 `source.kind: "user"` 的标题，后写的覆盖先写的（人永远有最终决定权）。

已发布：npm [`dsh-session-smart-rename`](https://www.npmjs.com/package/dsh-session-smart-rename)（当前 `0.2.0`）；已收录进 [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（PR #12513，2026-11-07 合并）。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `index.js` | 宿主半体：`POST /api/dsh-session-smart-rename/suggest` 路由、`smart_rename_session` 工具注册、读会话/调模型/冷会话磁盘回退 |
| `client.js` | 浏览器半体：`sidebar.workspaces.session.menu.item` 菜单项 + `shell.overlay` 确认框；无构建步骤，`window.__ModuleLoader__.load` 包一层 |
| `cordis.patch.yml` | 插入宿主组合的一行（`id: session-smart-rename`，`name: dsh-session-smart-rename`） |
| `smoke.mjs` | 离线冒烟：假 ctx 跑路由、工具自动命名、工具直接命名、两种报错 |
| `package.json` | `dsh.bundle` + `dsh.client` 清单；`files` 决定发布内容 |
| `README.md` | 面向用户：安装、两个入口、实现、限制 |

## 宿主契约（已在本机 DSH 上核对，不要凭猜）

- 插件签名：`export const name`、`export const inject = ['webServer', 'sessions', 'llm', 'tools']`、`export function apply(ctx, rawConfig)`。
- 路由：`ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), '说明')`，必须把 disposer 包在 `ctx.effect` 里。
- 标题写入：`ctx.get('sessionTitle').rename(session, title)`。它要求 **session 处于 live 状态**（内部校验 `ctx.sessions.get(session.id) === session`），会规范化、空标题抛 `SessionTitleInvalidError`，并 append `session/title`（`source: { kind: 'user' }`），返回 `{ title, eventSeq }`。**不要自己 append `session/title` 事件。**
- 工具注册：`ctx.tools.register({ name, description, parameters, output: { schema, render }, execute(args, exec), timeoutMs, isConcurrencySafe })`。当前会话从 `exec.agent?.session` 取；显式 `session_id` 走 `ctx.sessions.get()`，未加载直接报错。
- 模型调用：`ctx.llm.prepareCall({ provider, model, maxTokens: 700 }, signal, (controls, model) => ...)`；路由取会话最后一条 `request/header` 的 `data.header.config`，读不到时回落 `deepseek-official` / `deepseek-flash`。标题类短任务**只取最低推理档**（`model.reasoning.efforts[0].id`），否则思考会吃光 700 token 预算。
- 浏览器改名的 RPC：`POST /api/session/rename`，body 为 `{type:'client-request', rpcId, method:'session/rename', payload:{args:{request:{sessionId,title}}}}`。

## 冷会话

宿主没加载过的会话只能读磁盘日志：`~/.dsh/sessions/<workspace>/<sid|session-sid>/session.v4.jsonl.zstd`。

**日志是多帧拼接的 zstd，Node 的 `zlib` 只能解第一帧**（表现为只读到 1 条事件）。必须用系统的 `zstd -dc <file>` 子进程解压。这是本项目最容易被"重构"坏的一段，改之前先跑冷会话用例。

## 硬约束（违反会直接坏功能）

1. **不 import 任何 `@deepseek-ai/*` 包**。以 `link:` / `github:` 安装时模块解析路径会跨版本，出现 "does not provide an export named …"。只用 Node 内置模块和 `ctx` 服务。
2. **工具名固定为 `smart_rename_session`**。`rename_session` 被 `9Ashwin/dsh-session-rename` 占用，改回去会导致两个插件同时安装时工具重名。
3. **不加构建步骤、不加运行时依赖**。`client.js` 就是浏览器直接加载的 ESM 变体；`package.json` 无 `dependencies`。
4. **改标题只能走 `sessionTitle.rename` 或 `session/rename` RPC**，保证 `source.kind: "user"` 钉住语义。
5. **不要改 `cordis.patch.yml` 的 `id` / `name`**，除非同步改 profile 里已安装的补丁行。
6. 不要提交任何 token、`.npmrc`、临时凭证文件。

## 验证流程（提交前跑）

```sh
node --check index.js && node --check client.js
node smoke.mjs
```

`smoke.mjs` 应输出 `SMOKE OK`，且覆盖：路由 200、未知会话 404、工具自动命名（`source: "analyzed"`）、工具直接命名（`source: "model"`，且不再调模型）、两种报错。

真机检查（改宿主半体后必须做一次）：

1. 在 DSH 里 reload 插件（插件管理里 disable → enable，或重启应用）；
2. 路由探活：`curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:<当前端口>/api/dsh-session-smart-rename/suggest`，期望 `500 {"ok":false,"error":"缺少 sessionId"}` —— 收到它就说明 `apply` 没抛错、服务注入成功；
3. 若注册了工具，宿主会向会话推送一次工具 schema 更新，说明 `tools.register` 被接受。

## 发布流程

1. 改 `package.json` 的 `version`（semver），提交；
2. `npm publish --access public`。**账号开了写操作 2FA**：全新包名的首发会被 npm 自动转成 staged，生成 `0.0.0-stage` 占位桩，需要维护者带 2FA 在 npmjs.com 的 Staged Packages 或 `npm stage approve <stage-id>` 批准后才公开——这不是失败；
3. 发布内容由 `files` 字段决定：`index.js` `client.js` `cordis.patch.yml` `README.md` `LICENSE`；
4. 发布后验证：`npm view dsh-session-smart-rename version`，或 `npm install dsh-session-smart-rename@<ver>` 到临时目录；
5. 用完即删临时 `.npmrc`（`shred -u`）。如果 agent 的沙箱不允许写 `~/.npm`，把 `npm_config_cache` 指到工作区内再跑 npm。

## 与 awesome-dsh-plugin 的关系

- 列表条目：`awesome-dsh-plugin/awesome-dsh-plugin` 仓库的 `data/plugins/SonettoGu14__dsh-session-smart-rename.yml`，一个插件一个文件；
- **不要手改列表的两个 README**，它们由 `scripts/generate-readme.mjs` 从数据生成；PR 只动自己那一个 yml；
- 描述即声明：改了功能（例如新增/移除工具、改变触发方式）要同步改条目描述，否则会被打回；
- 仓库年龄门槛（≥1 天）由 CI 的 `Submission gate` 检查，未满时会自行重跑，不需要重开 PR。

## 代码风格

- 2 空格缩进、单引号、语句带分号；中文 JSDoc 注释（与现有文件一致）；
- 导出函数用 JSDoc 说明参数与副作用；错误信息用中文短句（用户会在弹框里看到）；
- 新增宿主逻辑优先复用 `analyzeSession()`，不要在工具与路由里各写一套提示词。

## 已知限制（文档与 PR 里不要夸大）

- `session_id` 指向未加载会话会报错；传主会话 id 一定可用；
- 每次菜单点击 = 一次小模型调用（约 1~3 秒）；工具不传 `title` 时同理，传了就不调；
- 浏览器自定义 tag 存 localStorage，工具路径看不到，用内置默认分类；
- 子代理会话（`origin: subagent`）会被宿主拒绝改名；
- 压缩过 / 无用户消息的会话日志可能读不到内容，确认框会退回本地关键词规则并标注来源。

## 待办 / 可做但未做

- 仓库没有 CI workflow（只有 `smoke.mjs` 手动跑）；如果加，至少跑 `node --check` + `node smoke.mjs`；
- 还没有 git tag / GitHub Release（`v0.2.0` 未打），发布新版本时建议补上；
- 若要降低与 `9Ashwin/dsh-session-rename` 的重复度，可考虑把工具拆成独立包；目前策略是保留超集并在 PR 里说明差异。
