# AGENTS.md

本文件面向**在这个仓库里工作的所有 agent 与人**。它是项目级约定；与用户级 `~/.dsh/AGENTS.md` 冲突时，以本文件为准。改动本文件请一并提交。

## 项目是什么

DSH（DeepSeek Harness）Web GUI 插件：把会话标题命名成 `分类 · 主题`，两个入口共用同一段分析逻辑。

- **人侧**：侧边栏会话行「…」→ 智能重命名 → 命名工作台：上层分类 chips（可新建 tag）、中层主题输入 + 「分类 · 主题」实时预览、下层 3 条 AI 建议（点选填入，可「换一批」）；
- **模型侧**：工具 `smart_rename_session`，agent 可自己改名；省略 `title` 时插件分析对话自动命名，给了 `title` 就只负责钉住。

两条路都写 `source.kind: "user"` 的标题，后写的覆盖先写的（人永远有最终决定权）。

已发布：npm [`dsh-session-smart-rename`](https://www.npmjs.com/package/dsh-session-smart-rename)（当前 `0.3.1`）；已收录进 [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（PR #12513，2026-11-07 合并）。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `index.js` | 宿主半体：`POST /api/dsh-session-smart-rename/suggest` 路由、`smart_rename_session` 工具注册、读会话/调模型/冷会话磁盘回退 |
| `client.js` | 浏览器半体：`sidebar.workspaces.session.menu.item` 菜单项 + `shell.overlay` 命名工作台；状态拆成 category / topic，标题由 `composeTitle()` 合成；无构建步骤，`window.__ModuleLoader__.load` 包一层 |
| `cordis.patch.yml` | 插入宿主组合的一行（`id: session-smart-rename`，`name: dsh-session-smart-rename`） |
| `smoke.mjs` | 离线冒烟：假 ctx 跑路由、工具自动命名、工具直接命名、两种报错 |
| `scripts/release.mjs` | 一条命令发版：检查 → 升版本 + tag → push，npm 与 Release 交给 CI（支持 `--dry-run` / `--local-publish`） |
| `.github/workflows/publish.yml` | tag 触发的发布流水线：检查 + Trusted Publishing 发 npm + `gh release create` |
| `package.json` | `dsh.bundle` + `dsh.client` 清单；`files` 决定发布内容 |
| `README.md` | 面向用户（英文，npm/GitHub 主入口）：安装、两个入口、实现、兼容性、本地化、限制 |
| `README.zh-CN.md` | 中文版 README，与英文版互链，内容对齐 |

## 宿主契约（已在本机 DSH 上核对，不要凭猜）

- 插件签名：`export const name`、`export const inject = ['webServer', 'sessions', 'llm', 'tools']`、`export function apply(ctx, rawConfig)`。
- 路由：`ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), '说明')`，必须把 disposer 包在 `ctx.effect` 里。
- 标题写入：`ctx.get('sessionTitle').rename(session, title)`。它要求 **session 处于 live 状态**（内部校验 `ctx.sessions.get(session.id) === session`），会规范化、空标题抛 `SessionTitleInvalidError`，并 append `session/title`（`source: { kind: 'user' }`），返回 `{ title, eventSeq }`。**不要自己 append `session/title` 事件。**
- 工具注册：`ctx.tools.register({ name, description, parameters, output: { schema, render }, execute(args, exec), timeoutMs, isConcurrencySafe })`。当前会话从 `exec.agent?.session` 取；显式 `session_id` 走 `ctx.sessions.get()`，未加载直接报错。
- 模型调用：`ctx.llm.prepareCall({ provider, model, maxTokens: 2048 }, signal, (controls, model) => ...)`；路由取会话最后一条 `request/header` 的 `data.header.config`，读不到时回落 `deepseek-official` / `deepseek-flash`。标题类短任务用 `pickEffort()` **尽量关掉推理**（模型声明了 off/none 就用它），否则退最低档——三条候选 + 思考共吃 2048；网关嫌大时 `callModel()` 退 700 重试一次（被 abort 不重试）。
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

`smoke.mjs` 应输出 `SMOKE OK`，且覆盖：路由 200 且返回 3 条 `candidates`（单条字段仍向后兼容）、换一批把 `avoid` 写进提示词、预算回退（2048 被拒 → 700 重试一次）、未知会话 404、工具自动命名（`source: "analyzed"`）、工具直接命名（`source: "model"`，且不再调模型）、两种报错。

真机检查（改宿主半体后必须做一次）：

1. 在 DSH 里 reload 插件（插件管理里 disable → enable，或重启应用）；
2. 路由探活：`curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:<当前端口>/api/dsh-session-smart-rename/suggest`，期望 `500 {"ok":false,"error":"缺少 sessionId"}` —— 收到它就说明 `apply` 没抛错、服务注入成功；
3. 若注册了工具，宿主会向会话推送一次工具 schema 更新，说明 `tools.register` 被接受。

## 发布流程

**一条命令：本地推 tag，CI 发 npm**（`scripts/release.mjs` + `.github/workflows/publish.yml`）：

```sh
npm run release patch                          # 0.3.1 -> 0.3.2
npm run release minor|major                    # 或直接给版本号 npm run release 0.4.0
npm run release patch -- --dry-run             # 只检查 + 打印将执行的命令，不改任何东西
npm run release patch -- --local-publish       # 兜底：本机直接 npm publish（跳过 CI）
```

本地脚本按序做：工作区/分支/同步/tag 冲突检查 → `node --check` ×2 + `smoke.mjs` → `npm version <ver>`（提交 + 打 `v<ver>` tag）→ `git push origin main --follow-tags`。之后 GitHub Actions（`publish.yml`，`on: push: tags: v*`）用 **Trusted Publishing**（OIDC，`permissions: id-token: write`）跑同样的检查、`npm publish --access public`、`gh release create --generate-notes`。本机不再需要可直发的 npm token。

Trusted Publishing 的三个硬要求（npm 官方文档）：npm CLI ≥ 11.5.1、Node ≥ 22.14、**必须跑在 CI 的 OIDC 环境**（GitHub Actions / GitLab / CircleCI；本机 mac 没有 OIDC issuer，所以无法在本地用）。workflow 里因此有 `npm install -g npm@^11.5.1` 一步。npmjs.com 侧需要一次性配置：包设置 → Trusted Publisher → GitHub Actions → Organization or user `SonettoGu14`、Repository `dsh-session-smart-rename`、Workflow filename `publish.yml`，并勾上 "Allow npm publish"（默认只允许 stage publish）。

失败处理：本地任一步失败即停，不会半途自动回滚——按报错补完，必要时 `git reset --hard HEAD~1 && git tag -d v<ver>`（未 push 时）重来。若 tag 已 push 而 CI 发版失败，修好后删 tag 重推，或在 Actions 页面 "Re-run jobs"（`workflow_dispatch` 也留了手动入口，但要求当前提交的版本号与所选 ref 一致）。

其余约束：

1. 发布内容由 `files` 字段决定：`index.js` `client.js` `cordis.patch.yml` `README.md` `README.zh-CN.md` `LICENSE`（`scripts/` 不发布）；
2. **默认路径不需要 token**；只有 `--local-publish` 才用 `~/.npmrc` 里那个"跳过 2FA 的 granular token"（2026-11-24 到期，npm 声明 2027-01 起吊销直发权限）。token 失效时 `npm publish` 会报 `EOTP` 并给出 `https://www.npmjs.com/auth/cli/<id>`，此时去 npmjs.com → Access Tokens → Generate New Token（勾 Bypass 2FA + Read and write），把新 token 写回 `~/.npmrc` 的 `//registry.npmjs.org/:_authToken=`；正路始终是 CI 的 Trusted Publishing；
3. 全新包名的首发会被 npm 自动转成 staged，生成 `0.0.0-stage` 占位桩，需带 2FA 在 Staged Packages 或 `npm stage approve <stage-id>` 批准——这不是失败；
4. 发布后验证：`npm view dsh-session-smart-rename version`，或 `npm install dsh-session-smart-rename@<ver>` 到临时目录（npm 12 默认拒绝装 remote tarball，用 `npm pack` 或普通 install）；
5. 用完即删临时 `.npmrc`。如果 agent 的沙箱不允许写 `~/.npm`，把 `npm_config_cache` 指到工作区内再跑 npm。

## 与 awesome-dsh-plugin 的关系

- 列表条目：`awesome-dsh-plugin/awesome-dsh-plugin` 仓库的 `data/plugins/SonettoGu14__dsh-session-smart-rename.yml`，一个插件一个文件；
- **不要手改列表的两个 README**，它们由 `scripts/generate-readme.mjs` 从数据生成；PR 只动自己那一个 yml；
- 描述即声明：改了功能（例如新增/移除工具、改变触发方式）要同步改条目描述，否则会被打回；
- 仓库年龄门槛（≥1 天）由 CI 的 `Submission gate` 检查，未满时会自行重跑，不需要重开 PR。

## 代码风格

- 2 空格缩进、单引号、语句带分号；中文 JSDoc 注释（与现有文件一致）；
- 导出函数用 JSDoc 说明参数与副作用；错误信息用中文短句（用户会在弹框里看到）；
- 新增宿主逻辑优先复用 `analyzeSession()`，不要在工具与路由里各写一套提示词。
- **所有用户可见文案走 `client.js` 顶部的 `TEXT` 表**：`zh` 与 `en` 两份的 key 必须一一对应（缺 key 会渲染成 `undefined`），组件里不硬编码中文；分类名走 `CATEGORY_LABELS` + `categoryLabel(key)`，规则只认内部 key（`docs`/`maintenance`/`plugin`/`dsh`/`code`/`research`/`empty`/`other`）。
- 界面语言取自浏览器（`navigator.language`，`zh` 开头用中文，其余英文）；**宿主提示词不要写死只有中文成立的约束**（"4~16 个汉字"），标题语言要跟随对话语言。

## 已知限制（文档与 PR 里不要夸大）

- `session_id` 指向未加载会话会报错；传主会话 id 一定可用；
- 每次菜单点击 = 一次小模型调用（约 1~3 秒）；工具不传 `title` 时同理，传了就不调；
- 浏览器自定义 tag 存 localStorage，工具路径看不到，用内置默认分类；
- 子代理会话（`origin: subagent`）会被宿主拒绝改名；
- 工具路径的候选分类来自配置 `categories`（默认中文七项），不随界面语言变化；
- 压缩过 / 无用户消息的会话日志可能读不到内容，工作台会退回本地关键词规则并标注来源（此时只有 1 条候选，「换一批」会提示没拿到新建议）。

## 待办 / 可做但未做

- 目前唯一的 CI 是 tag 触发的 `publish.yml`（发布用），PR 上还没有跑 `node --check` + `smoke.mjs` 的检查 workflow；
- `v0.3.1` 起每个版本都有 annotated tag + GitHub Release（更早的 `v0.2.0` / `v0.3.0` 没补）；
- v0.3.2 可做：按显示宽度截断标题（CJK 算 2 单位）、把浏览器 tag 落一份到宿主给工具路径用；
- v0.4 可做：批量「会话整理」面板（列表里按分类/关键词筛会话、批量改名）——用户明确表达过想要；
- 若要降低与 `9Ashwin/dsh-session-rename` 的重复度，可考虑把工具拆成独立包；目前策略是保留超集并在 PR 里说明差异。
