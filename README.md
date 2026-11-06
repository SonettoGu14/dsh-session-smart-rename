# dsh-session-smart-rename

A **session smart-rename** plugin for the DeepSeek Harness Web GUI: the sidebar session menu gains a **Smart rename** action that reads the conversation, asks the session's own model for a category and a short topic, and pre-fills `category · topic` for you to confirm or edit before saving.

DeepSeek Harness Web GUI 的**会话智能重命名**插件：侧边栏会话菜单里多一项「智能重命名」，读取对话后让**会话自己的模型**给出分类和简短主题，预填 `分类 · 主题` 供你确认或修改后再保存。

## Install / 安装

```sh
dsh plugin --profile <your-profile> add github:SonettoGu14/dsh-session-smart-rename
```

Or install it from the plugin manager in DSH Settings. / 也可以在 DSH 设置里的插件管理中安装。

Restart the app once after installing (the client bundle is loaded at boot). / 安装后重启一次应用（客户端 bundle 在启动时加载）。

## Usage / 用法

1. Sidebar session row → `…` menu → **Smart rename** / 侧边栏会话行 →「…」→ **智能重命名**；
2. The dialog is pre-filled with `category · topic`; the line above it shows the current title and why the model picked that category / 弹出确认框，已预填 `分类 · 主题`，上方小字显示当前标题与分类依据；
3. Click a category chip to switch category; click **＋ New tag** to add your own (stored in browser localStorage) / 点分类 chip 换分类，点 **＋ 新建 tag** 自定义（存浏览器 localStorage）；
4. Press Enter or **Save**. The rename pins the title, so automatic title generation will not overwrite it / 回车或保存。标题会被钉住，自动标题不会再覆盖。

## How it works / 实现

- Browser half registers two seats: `sidebar.workspaces.session.menu.item` (the menu row) and `shell.overlay` (the dialog);
- Host half adds `POST /api/dsh-session-smart-rename/suggest`: it reads the session's user messages and assistant replies, takes the model route from the session's own `request/header` event, and makes one LLM call that must return `{category, title, reason}`;
- Sessions the host has not loaded are read from disk (`~/.dsh/sessions/**/<id>/session.v4.jsonl.zstd`, decompressed with `zstd -dc` because the log is multiple concatenated frames);
- Rename itself goes through the host's existing `POST /api/session/rename`, so it behaves exactly like the built-in rename;
- Suggestions are cached per session for 5 minutes; if the model or the log is unavailable, the dialog falls back to local keyword rules and labels the source as `本地规则`;

## Requirements / 依赖

- DSH with `dsh.bundle` manifest support (this package declares `dsh.bundle.patch`);
- The desktop/web profile with the session sidebar;
- No npm dependencies; the host half uses only Node built-ins, the browser half only `react` and the harness-provided primitives.

## Known limits / 已知限制

- Subagent child sessions (`origin: subagent`) are refused by the host; the dialog shows the host's reason;
- Each click is one small model call (~1–3 s). Compressed or log-less sessions fall back to local rules;
- Custom tags live in the browser's localStorage, so they do not follow you to another browser.

## License

[MIT](LICENSE)
