# dsh-session-smart-rename

A **session smart-rename** plugin for the DeepSeek Harness Web GUI. It names sessions as `category · topic` and offers the same capability to two callers:

- a **sidebar action** — you click it, the plugin reads the conversation, asks the session's own model for a category and short topic, and pre-fills a dialog you can edit;
- a **model-facing tool** `smart_rename_session` — the agent can rename the session it is running in, with no dialog, when the topic has clearly moved on.

DeepSeek Harness Web GUI 的**会话智能重命名**插件，把「分类 · 主题」这套命名同时交给两个入口：人点侧边栏菜单（弹出确认框，可改可换分类），或由 agent 在对话里调用 `smart_rename_session` 工具直接改名。

## Install / 安装

```sh
# from npm — prebuilt, skips the build-approval step
dsh plugin --profile <your-profile> add dsh-session-smart-rename

# or straight from this repo
dsh plugin --profile <your-profile> add github:SonettoGu14/dsh-session-smart-rename
```

Published on npm as [`dsh-session-smart-rename`](https://www.npmjs.com/package/dsh-session-smart-rename) (v0.2.0). You can also install it from the plugin manager in DSH Settings. / 也可以在 DSH 设置里的插件管理中安装。

Restart the app once after installing (the client bundle is loaded at boot). / 安装后重启一次应用（客户端 bundle 在启动时加载）。

## Entry 1 — sidebar action / 人侧

1. Sidebar session row → `…` menu → **Smart rename** / 侧边栏会话行 →「…」→ **智能重命名**；
2. The dialog is pre-filled with `category · topic`; the line above shows the current title and why the model picked that category / 弹框预填 `分类 · 主题`，上方显示当前标题与分类依据；
3. Click a category chip to switch; click **＋ New tag** to add your own (stored in browser localStorage) / 点 chip 换分类，**＋ 新建 tag** 自定义（存 localStorage）；
4. Enter or **Save**. The rename pins the title / 回车或保存，标题被钉住。

## Entry 2 — model tool / 模型侧

`smart_rename_session`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 否 | 要钉住的标题。**省略时**插件自己读对话、给出 `分类 · 主题`。 |
| `session_id` | 否 | 目标会话；省略即当前会话（必须已加载）。 |

返回 `{ session_id, title, seq, source }`，`source` 是 `model`（模型给了 title）或 `analyzed`（插件分析出来的）。

两种调用形态：

- `smart_rename_session({})` —— 让插件按内容自动分类命名，最省事；
- `smart_rename_session({ title: "PRD-042 推荐信导出" })` —— 模型自己拼标题，插件只负责钉住（不再多调一次模型）。

想让 agent 在任务换挡时自己更新标题，把这条加进 `AGENTS.md`：

```md
- 当一次会话的工作明显转到新主题、旧标题已经不准确时，调用 `smart_rename_session`（不传 title），
  让插件按对话内容重新命名。
```

改完不满意？直接用侧边栏的 **智能重命名** 再改一次即可——两条路都写 `source.kind: "user"` 的标题，后写的覆盖先写的。

### 不与 `9Ashwin/dsh-session-rename` 撞名

那个插件注册的工具叫 `rename_session`，本插件叫 `smart_rename_session`，所以两者可以同时安装。区别是：它的标题完全由模型拼，本插件还有「让插件分析后自动命名」的形态，以及人侧菜单和确认框。

## How it works / 实现

- Browser half registers two seats: `sidebar.workspaces.session.menu.item` (the menu row) and `shell.overlay` (the dialog);
- Host half exposes one analyzer shared by both entries: read the session's user messages and assistant replies, take the model route from the session's own `request/header` event, ask for strict JSON `{category, title, reason}`;
- Host route `POST /api/dsh-session-smart-rename/suggest` serves the dialog; the tool serves the agent;
- Sessions the host has not loaded are read from disk (`~/.dsh/sessions/**/<id>/session.v4.jsonl.zstd`, decompressed with `zstd -dc` because the log is multiple concatenated frames);
- Both entries write the title through the host's `sessionTitle.rename(session, title)` (the dialog goes through `POST /api/session/rename`), so the title is pinned exactly like the built-in rename;
- Suggestions are cached per session for 5 minutes in the dialog; if the model or the log is unavailable, the dialog falls back to local keyword rules and labels the source as `本地规则`.

## Requirements / 依赖

- DSH with `dsh.bundle` manifest support (this package declares `dsh.bundle.patch`);
- The desktop/web profile with the session sidebar;
- No npm dependencies; the host half uses only Node built-ins, the browser half only `react` and the harness-provided primitives.

## Known limits / 已知限制

- `session_id` 指向未加载的会话会报错（当前会话永远可用）；
- Each sidebar click is one small model call (~1–3 s); a tool call that lets the plugin name the session costs one too (passing `title` costs none). Compressed or log-less sessions fall back to local rules;
- Custom tags live in the browser's localStorage and are not visible to the tool path (the tool uses the plugin's default category list);
- Subagent child sessions (`origin: subagent`) are still refused by the host.

## License

[MIT](LICENSE)
