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
/** 三条候选 + 推理模型的思考都吃这一份预算；非推理模型答完就停，抬预算不拖慢。 */
const LLM_MAX_TOKENS = 2048;
/** 某些网关会拒绝偏大的 maxTokens，退回原来的保守值再试一次。 */
const LLM_MAX_TOKENS_FALLBACK = 700;
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
  '{"candidates":[{"category":"…","title":"…","reason":"…"},{"category":"…","title":"…","reason":"…"},{"category":"…","title":"…","reason":"…"}]}',
  '规则：',
  '- 给 3 条候选，角度要真的不同（例如按产出、按主题、按下一步），不要只换同义词。',
  '- category：优先从给定候选分类中选；都不合适时自拟一个新分类（中文 2~5 字 / 英文 1~2 个词）。',
  '- title：说清实际产出或主题的名词短语，中文 4~16 字、英文 2~6 个词；语言与对话主要使用的语言一致。不要照抄用户原话，不要"帮我/请/能不能/我想"这类词，不要重复分类名，也不要再带「分类 · 」前缀。',
  '- reason：一句话说明这一条凭什么这么起，不超过 30 个字符，语言同 title。',
].join('\n');

/** 推理档：模型自己声明了「关」就用「关」，否则用声明列表里最低的一档。 */
function pickEffort(efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
  const off = efforts.find((item) => /^(off|none|disabled|no[-_ ]?think)/i.test(String(item?.id ?? '')));
  return (off ?? efforts[0])?.id;
}

/** 调一次模型，返回拼接后的文本。 */
async function streamOnce(ctx, route, userText, sessionId, maxTokens, controller) {
  const call = await ctx.llm.prepareCall(
    { provider: route.provider, model: route.model, maxTokens },
    controller.signal,
    (controls, model) => {
      // 标题类短任务：能关推理就关，关不掉退最低档，避免思考烧光输出预算。
      const effort = pickEffort(model?.reasoning?.efforts);
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
}

/**
 * 调模型，预算被网关拒绝时退回保守值重试一次（超时/取消不重试）。
 * @param ctx - 插件上下文。
 * @param route - provider/model。
 * @param userText - 用户侧提示词。
 * @param sessionId - 写进调用的会话 id。
 */
async function callModel(ctx, route, userText, sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('LLM 超时')), LLM_TIMEOUT_MS);
  try {
    try {
      return await streamOnce(ctx, route, userText, sessionId, LLM_MAX_TOKENS, controller);
    } catch (error) {
      if (controller.signal.aborted || LLM_MAX_TOKENS === LLM_MAX_TOKENS_FALLBACK) throw error;
      return await streamOnce(ctx, route, userText, sessionId, LLM_MAX_TOKENS_FALLBACK, controller);
    }
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

/** 显示宽度：CJK / 全角记 2，其余记 1（与浏览器半体同一口径）。 */
function displayWidth(text) {
  let total = 0;
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f)
      || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    total += wide ? 2 : 1;
  }
  return total;
}

/** 按显示宽度截断；英文尽量断在词边界，尾巴补省略号。 */
function clampWidth(text, max) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  if (max <= 1) return '…';
  if (displayWidth(value) <= max) return value;
  let used = 0;
  let cut = 0;
  let lastSpace = -1;
  for (const char of value) {
    const step = displayWidth(char);
    if (used + step > max - 1) break;
    used += step;
    cut += char.length;
    if (char === ' ') lastSpace = cut - 1;
  }
  let head = value.slice(0, cut).trimEnd();
  if (lastSpace > 1 && cut < value.length && displayWidth(value) - used > 4) {
    head = value.slice(0, lastSpace).trimEnd();
  }
  return head ? head + '…' : '…';
}

/** 模型偶尔把「分类 · 主题」整串塞进 title，剥掉分类部分。 */
function stripCategory(title) {
  return String(title ?? '').replace(/^[^·\n]{1,10} · /, '').trim();
}

/* ------------------------------------------------------------------ *
 * 分析：读会话内容 → 让会话自己的模型给出「分类 · 主题」
 * ------------------------------------------------------------------ */

/**
 * 问模型一次并整理成候选。失败时返回 `{ok:false, failure}`，failure 就是直接回给客户端的响应体。
 *
 * @param ctx - 插件上下文（llm 已就绪）。
 * @param route - 模型路由。
 * @param userText - 已经拼好的提示词。
 * @param sessionId - 会话 id，仅用于日志。
 */
async function askCandidates(ctx, route, userText, sessionId) {
  const raw = await callModel(ctx, route, userText, sessionId);
  const parsed = parseLooseJson(raw);
  if (parsed === null) {
    return { ok: false, failure: { ok: false, status: 502, error: '模型没有返回可解析的 JSON', raw: cleanText(raw, 400) } };
  }
  const candidates = normalizeCandidates(parsed);
  if (candidates.length === 0) {
    return { ok: false, failure: { ok: false, status: 502, error: '模型返回的分类或标题为空' } };
  }
  return { ok: true, candidates };
}

/**
 * 分析一个会话，返回 `{ok:true, ...建议}` 或 `{ok:false, status, error}`。
 * 路由与模型工具共用，避免两套提示词漂移。
 *
 * @param ctx - 插件上下文（sessions、llm 已就绪）。
 * @param sessionId - 目标会话 id。
 * @param tags - 候选分类（客户端自定义 tag 或配置的默认值）。
 * @param fallbackRoute - 会话里读不到模型路由时的兜底。
 * @param avoid - 「换一批」时上一批已经给过的标题，提示模型别重复。
 */
async function analyzeSession(ctx, sessionId, tags, fallbackRoute, avoid = []) {
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
  const avoided = avoid
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .slice(0, 6);
  const buildPromptText = (avoidList) => [
    '候选分类：' + (tags.length > 0 ? tags.join('、') : '（无，自拟）'),
    '工作目录：' + (cwd || '（未知）'),
    '当前标题：' + (currentTitle || '（还没有标题）'),
    ...(avoidList.length > 0 ? ['换一批，不要与这些已给过的标题重复：' + avoidList.join('；')] : []),
    '',
    '对话记录：',
    buildTranscript(messages),
  ].join('\n');

  const first = await askCandidates(ctx, route, buildPromptText(avoided), sessionId);
  if (!first.ok) return first.failure;
  const candidates = first.candidates;

  // 模型偶尔只回 1~2 条：把已经拿到的标题并进 avoid 再补一次（最多补一次）。
  if (candidates.length < 3) {
    const seen = candidates.map((item) => item.suggested);
    const more = await askCandidates(ctx, route, buildPromptText(avoided.concat(seen).slice(0, 10)), sessionId);
    if (more.ok) {
      for (const item of more.candidates) {
        if (seen.includes(item.suggested)) continue;
        seen.push(item.suggested);
        candidates.push(item);
        if (candidates.length === 3) break;
      }
    }
  }

  const primary = candidates[0];
  return {
    ok: true,
    source: 'llm',
    model: route,
    category: primary.category,
    title: primary.theme,
    theme: primary.theme,
    suggested: primary.suggested,
    reason: primary.reason,
    candidates,
  };
}

/**
 * 把模型返回整理成 1~3 条候选。
 * 兼容旧的单条形状，也容忍候选里混进无效项或重复项。
 * @param parsed - 宽松 JSON 解析结果。
 */
function normalizeCandidates(parsed) {
  const list = Array.isArray(parsed?.candidates) ? parsed.candidates : [parsed];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    // 按显示宽度收口就够了，精确的一行预算由浏览器半体再裁一次：
    // 这里按字符数截会把 Connectivity 直接切成 Connectivit…。
    const category = clampWidth(cleanText(item.category, 40), 20);
    const theme = clampWidth(cleanText(stripCategory(item.title), 80), 40);
    if (!theme) continue;
    const suggested = category ? category + ' · ' + theme : theme;
    if (seen.has(suggested)) continue;
    seen.add(suggested);
    out.push({
      category,
      theme,
      suggested,
      reason: cleanText(item.reason, 40) || '由模型按对话内容归类',
    });
    if (out.length === 3) break;
  }
  return out;
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
        const avoid = Array.isArray(body.avoid)
          ? body.avoid.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, 6)
          : [];

        const result = await analyzeSession(ctx, sessionId, tags, fallbackRoute, avoid);
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
