/**
 * dsh-session-smart-rename — 宿主半体。
 *
 * 两条入口共用同一段分析（读会话事件流 → 会话自己的模型路由 → 分类 + 主题）：
 *
 * 1. `POST /api/dsh-session-smart-rename/suggest` —— 浏览器半体的确认框用；
 * 2. 模型工具 `smart_rename_session` —— 会话自己改标题；不满意时人仍可点侧边栏
 *    「智能重命名」再改一次（两条路都写 `source.kind: "user"` 的标题，后来者覆盖）。
 *
 * 工具名没有用 `rename_session`：那个名字被 9Ashwin/dsh-session-rename 占用，
 * 两个插件同时安装时同名的工具会撞车。
 *
 * @module dsh-session-smart-rename
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** 客户端模块 id、locale 命名空间与包名共用同一个值。 */
export const name = 'dsh-session-smart-rename';

/** 路由、会话读取、模型调用、工具注册。 */
export const inject = ['webServer', 'sessions', 'llm', 'tools'];

const ROUTE = '/api/dsh-session-smart-rename/suggest';
const TOOL_NAME = 'smart_rename_session';
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_MESSAGE_CHARS = 700;
const LLM_TIMEOUT_MS = 25000;
const LLM_MAX_TOKENS = 700;
const TOOL_TIMEOUT_MS = 40000;

/** 工具路径拿不到浏览器里的自定义 tag，这里给一份与客户端默认值一致的候选分类。 */
const DEFAULT_CATEGORIES = ['文档', 'DSH', '插件', '维护', '空会话', '代码', '调研'];

/* ------------------------------------------------------------------ *
 * HTTP 小工具（跟 dsh-mcp-status 同款闸门）
 * ------------------------------------------------------------------ */

/** 只接受回环地址。 */
function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 浏览器跨站请求会带 Origin，和 Host 对不上就拒绝。 */
function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJsonBody(request, limitBytes = 65536) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/* ------------------------------------------------------------------ *
 * 会话内容 → 转录
 * ------------------------------------------------------------------ */

/** 从消息 content 里取可见文本（跳过 reasoning / tool-call）。 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** 压平事件流：只要真实用户消息与助手可见回复。 */
function collectMessages(events) {
  const messages = [];
  for (const event of events) {
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const text = textOf(event.data.content);
      if (text) messages.push({ role: '用户', text });
      continue;
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content);
      if (text) messages.push({ role: '助手', text });
    }
  }
  return messages;
}

/** 首尾保留式截断：开头几轮定题、结尾几轮定结果，中间省略。 */
function buildTranscript(messages) {
  const clipped = messages.map((message) => ({
    role: message.role,
    text: message.text.length > MAX_MESSAGE_CHARS ? message.text.slice(0, MAX_MESSAGE_CHARS) + '…' : message.text,
  }));
  let picked = clipped;
  const sizeOf = (list) => list.reduce((sum, item) => sum + item.role.length + item.text.length + 6, 0);
  if (sizeOf(picked) > MAX_TRANSCRIPT_CHARS && clipped.length > 8) {
    const head = clipped.slice(0, 5);
    const tail = clipped.slice(-4);
    picked = [...head, { role: '……', text: '（中间省略）' }, ...tail];
  }
  let budget = MAX_TRANSCRIPT_CHARS;
  const lines = [];
  for (const message of picked) {
    const line = `[${message.role}] ${message.text}`;
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length;
  }
  return lines.join('\n');
}

/** 从 request/header 事件里取会话自己的模型路由。 */
function routeOf(events, fallback) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'request/header') continue;
    const config = event.data?.header?.config;
    if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model };
    }
  }
  return fallback;
}

/** 工作目录：优先 session.header，其次首条 session 事件。 */
function cwdOf(session, events) {
  const headerCwd = session?.header?.cwd;
  if (typeof headerCwd === 'string' && headerCwd) return headerCwd;
  for (const event of events) {
    if (event.type === 'session' && typeof event.data?.cwd === 'string') return event.data.cwd;
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 冷会话：宿主没加载过的会话，直接读磁盘上的会话日志
 * ------------------------------------------------------------------ */

const SESSION_LOG_NAME = 'session.v4.jsonl.zstd';
const MAX_LOG_BYTES = 64 * 1024 * 1024;

/** 会话日志根目录：$DSH_HOME/sessions。 */
function sessionsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'sessions');
}

/** 在 sessions/<workspace>/<session dir>/ 里找目标会话的日志。 */
async function findSessionLog(sessionId) {
  const root = sessionsRoot();
  let workspaces = [];
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return undefined;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = join(root, workspace.name);
    let entries = [];
    try {
      entries = await readdir(workspacePath, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== sessionId && entry.name !== 'session-' + sessionId) continue;
      const candidate = join(workspacePath, entry.name, SESSION_LOG_NAME);
      try {
        const info = await stat(candidate);
        return info.isFile() && info.size <= MAX_LOG_BYTES ? candidate : undefined;
      } catch (error) {
        return undefined;
      }
    }
  }
  return undefined;
}

const execFileAsync = promisify(execFile);

/**
 * 解压并解析 JSONL 会话日志。
 * 会话日志是**多帧拼接的 zstd**（每次追加一帧），Node 的 zlib 只能解第一帧，
 * 所以这里交给系统的 `zstd -dc` 一次解完。
 */
async function readColdEvents(sessionId) {
  const file = await findSessionLog(sessionId);
  if (file === undefined) return { error: '找不到会话日志文件' };
  let text;
  try {
    const result = await execFileAsync('zstd', ['-dc', file], {
      encoding: 'utf8',
      maxBuffer: MAX_LOG_BYTES * 4,
    });
    text = result.stdout;
  } catch (error) {
    if (error?.code === 'ENOENT') return { error: '系统里找不到 zstd 命令' };
    return { error: '解压会话日志失败：' + String(error?.message ?? error) };
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      /* 跳过坏行 */
    }
  }
  return { events };
}

/* ------------------------------------------------------------------ *
 * LLM 调用
 * ------------------------------------------------------------------ */

const SYSTEM_PROMPT = [
  '你是 DSH 会话命名助手。阅读对话记录，判断这次会话真正在做什么，然后输出严格 JSON（不要 markdown 代码块）：',
  '{"category":"…","title":"…","reason":"…"}',
  '规则：',
  '- category：优先从给定候选分类中选；都不合适时自拟 2~5 字的新分类。',
  '- title：4~16 个汉字的名词短语，说清实际产出或主题；不要照抄用户原话，不要"帮我/请/能不能/我想"这类词，不要重复分类名。',
  '- reason：一句话（不超过 30 字）说明凭什么这么分类。',
].join('\n');

/** 调一次模型，返回拼接后的文本。 */
async function callModel(ctx, route, userText, sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('LLM 超时')), LLM_TIMEOUT_MS);
  try {
    const call = await ctx.llm.prepareCall(
      { provider: route.provider, model: route.model, maxTokens: LLM_MAX_TOKENS },
      controller.signal,
      (controls, model) => {
        // 与官方标题插件一致：标题类短任务只取最低推理档，避免思考烧光输出预算。
        const effort = model?.reasoning?.efforts?.[0]?.id;
        return effort === undefined ? controls : { ...controls, reasoningEffort: effort };
      },
    );
    const messages = [{
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: userText }],
      source: { kind: 'dsh-session-smart-rename' },
    }];
    const options = {
      ...(call.config ?? {}),
      messages,
      system: SYSTEM_PROMPT,
      sessionId,
      purpose: 'session-smart-rename',
      signal: controller.signal,
    };
    let output = '';
    for await (const chunk of call.stream(options)) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text;
      else if (chunk.type === 'text' && typeof chunk.text === 'string') output += chunk.text;
    }
    return output;
  } finally {
    clearTimeout(timer);
  }
}

/** 宽松解析：容忍 ```json 围栏和前后废话。 */
function parseLooseJson(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanText(value, max) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

/** 模型偶尔把「分类 · 主题」整串塞进 title，剥掉分类部分。 */
function stripCategory(title) {
  return String(title ?? '').replace(/^[^·\n]{1,10} · /, '').trim();
}

/* ------------------------------------------------------------------ *
 * 分析：读会话内容 → 让会话自己的模型给出「分类 · 主题」
 * ------------------------------------------------------------------ */

/**
 * 分析一个会话，返回 `{ok:true, ...建议}` 或 `{ok:false, status, error}`。
 * 路由与模型工具共用，避免两套提示词漂移。
 *
 * @param ctx - 插件上下文（sessions、llm 已就绪）。
 * @param sessionId - 目标会话 id。
 * @param tags - 候选分类（客户端自定义 tag 或配置的默认值）。
 * @param fallbackRoute - 会话里读不到模型路由时的兜底。
 */
async function analyzeSession(ctx, sessionId, tags, fallbackRoute) {
  const session = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined;
  let events = session !== undefined && typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  let cwd = cwdOf(session, events);
  if (events.length === 0) {
    const cold = await readColdEvents(sessionId);
    if (cold.events !== undefined) {
      events = cold.events;
      cwd = cwd || cwdOf(undefined, events);
    } else if (session === undefined) {
      return { ok: false, status: 404, error: '读取不到会话：' + (cold.error || sessionId) };
    }
  }

  const messages = collectMessages(events);
  if (messages.length === 0) {
    return { ok: false, status: 200, error: '日志里没有可读的用户消息' };
  }

  const titleEvent = [...events].reverse().find((event) => event.type === 'session/title');
  const currentTitle = typeof titleEvent?.data?.title === 'string' ? titleEvent.data.title : '';
  const route = routeOf(events, fallbackRoute);
  const userText = [
    '候选分类：' + (tags.length > 0 ? tags.join('、') : '（无，自拟）'),
    '工作目录：' + (cwd || '（未知）'),
    '当前标题：' + (currentTitle || '（还没有标题）'),
    '',
    '对话记录：',
    buildTranscript(messages),
  ].join('\n');

  const raw = await callModel(ctx, route, userText, sessionId);
  const parsed = parseLooseJson(raw);
  if (parsed === null) {
    return { ok: false, status: 502, error: '模型没有返回可解析的 JSON', raw: cleanText(raw, 400) };
  }

  const category = cleanText(parsed.category, 12);
  const theme = cleanText(stripCategory(parsed.title), 24);
  if (!category || !theme) {
    return { ok: false, status: 502, error: '模型返回的分类或标题为空' };
  }

  return {
    ok: true,
    source: 'llm',
    model: route,
    category,
    title: theme,
    theme,
    suggested: category + ' · ' + theme,
    reason: cleanText(parsed.reason, 40) || '由模型按对话内容归类',
  };
}

/* ------------------------------------------------------------------ *
 * 入口一：HTTP 路由（浏览器确认框）
 * ------------------------------------------------------------------ */

function registerSuggestRoute(ctx, fallbackRoute) {
  return ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (request, response) => {
      if (!isLoopback(request)) return sendJson(response, 403, { ok: false, error: '只接受本机请求' });
      if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: '只支持 POST' });
      if (!isSameOrigin(request)) return sendJson(response, 403, { ok: false, error: '跨站请求被拒绝' });

      try {
        const body = await readJsonBody(request);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (!sessionId) throw new Error('缺少 sessionId');
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').slice(0, 12)
          : [];

        const result = await analyzeSession(ctx, sessionId, tags, fallbackRoute);
        if (!result.ok) {
          const body = { ok: false, error: result.error };
          if (result.raw !== undefined) body.raw = result.raw;
          return sendJson(response, result.status, body);
        }
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }), 'dsh-session-smart-rename: suggest route');
}

/* ------------------------------------------------------------------ *
 * 入口二：模型工具（会话自己改名）
 * ------------------------------------------------------------------ */

const TOOL_DESCRIPTION = [
  'Rename a DeepSeek Harness session by pinning an explicit title.',
  'Omit `title` to let the plugin read the conversation and name the session "<category> · <topic>"; pass `title` only when the user explicitly asked for a specific name.',
  'Use it when the user asks to rename the session, or when the work has clearly moved to a different subject and the current title no longer describes it.',
  'A pinned title (source: user) is not overwritten by automatic title generation; the user can still rename it later from the sidebar menu.',
].join(' ');

function registerRenameTool(ctx, fallbackRoute, categories) {
  ctx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'Exact title to pin. Omit to auto-name from the conversation.',
        },
        session_id: {
          type: 'string',
          description: 'Target session id. Omit to rename the session you are running in.',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string' },
          title: { type: 'string' },
          seq: { type: 'integer' },
          source: { type: 'string' },
        },
        required: ['session_id', 'title', 'seq', 'source'],
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const wanted = typeof input.title === 'string' ? input.title.trim() : '';
      const sessionId = typeof input.session_id === 'string' ? input.session_id.trim() : '';

      let session;
      if (sessionId) {
        session = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined;
        if (session === undefined) {
          throw new Error(`会话 ${sessionId} 没有加载，先切换过去再改名`);
        }
      } else {
        session = exec?.agent?.session;
        if (session === undefined) {
          throw new Error('没有指定 session_id，这次调用也没有归属会话');
        }
      }

      let title = wanted;
      let source = 'model';
      if (!title) {
        const analysis = await analyzeSession(ctx, String(session.id), categories, fallbackRoute);
        if (!analysis.ok) throw new Error('智能命名失败：' + analysis.error);
        title = analysis.suggested;
        source = 'analyzed';
      }

      const sessionTitle = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined;
      if (sessionTitle === undefined || typeof sessionTitle.rename !== 'function') {
        throw new Error('sessionTitle 服务不可用，无法写标题');
      }

      const snapshot = sessionTitle.rename(session, title);
      const snapshotTitle = typeof snapshot?.title === 'string' ? snapshot.title : title;
      return {
        session_id: String(session.id),
        title: snapshotTitle,
        seq: typeof snapshot?.eventSeq === 'number' ? snapshot.eventSeq : 0,
        source,
      };
    },
  });
}

/* ------------------------------------------------------------------ *
 * 插件本体
 * ------------------------------------------------------------------ */

/**
 * 注册建议路由与改名工具。
 * @param ctx - 插件上下文（webServer、sessions、llm、tools 已就绪）。
 * @param rawConfig - 可选 `{provider, model}` 兜底路由、`{categories}` 工具用的候选分类。
 */
export function apply(ctx, rawConfig) {
  const fallbackRoute = {
    provider: typeof rawConfig?.provider === 'string' ? rawConfig.provider : 'deepseek-official',
    model: typeof rawConfig?.model === 'string' ? rawConfig.model : 'deepseek-flash',
  };
  const categories = Array.isArray(rawConfig?.categories) && rawConfig.categories.length > 0
    ? rawConfig.categories.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, 24)
    : DEFAULT_CATEGORIES;

  registerSuggestRoute(ctx, fallbackRoute);
  registerRenameTool(ctx, fallbackRoute, categories);
}
