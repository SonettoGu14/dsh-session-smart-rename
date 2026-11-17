/**
 * 本地冒烟：不启动 DSH，直接用假 ctx 验证宿主路由、模型工具与提示词拼装。
 * 运行：node smoke.mjs
 */
import { apply } from './index.js';

const events = [
  { type: 'session', data: { cwd: '/Users/gyk/Documents/Work/学生推荐信' } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我把这封推荐信导出成 PDF，模板用 XJTLU 那个。' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已经按模板排版并导出 PDF。' }] } } },
  { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
];

const session = {
  id: 's1',
  header: { cwd: '/Users/gyk/Documents/Work/学生推荐信' },
  snapshotEvents: () => events,
};

let capturedRoute;
let capturedTool;
let llmCalls = 0;
let capturedUserText = '';
let capturedMaxTokens = 0;
let rejectBigBudget = false;
let prepareAttempts = 0;
let shortBatchOnce = false;
let shortBatchCalls = 0;
let englishBatch = false;
const renamed = [];

const sessionTitle = {
  rename(target, title) {
    renamed.push({ sessionId: target.id, title });
    return { title, eventSeq: 42 };
  },
};

const ctx = {
  effect(fn) {
    return fn();
  },
  get(service) {
    return service === 'sessionTitle' ? sessionTitle : undefined;
  },
  webServer: {
    register(options) {
      capturedRoute = options;
      return () => {};
    },
  },
  tools: {
    register(definition) {
      capturedTool = definition;
      return () => {};
    },
  },
  sessions: {
    get(id) {
      return id === 's1' ? session : undefined;
    },
  },
  llm: {
    async prepareCall(route, signal, customize) {
      prepareAttempts += 1;
      console.log('prepareCall route:', JSON.stringify(route));
      if (rejectBigBudget && route.maxTokens > 700) {
        throw new Error('max_tokens 超出该模型上限');
      }
      return {
        config: { ...route },
        async *stream(options) {
          llmCalls += 1;
          if (typeof customize === 'function') customize({}, { reasoning: { efforts: [{ id: 'low' }] } });
          console.log('system 长度:', options.system.length, '| purpose:', options.purpose);
          console.log('user 提示:', options.messages[0].content[0].text.slice(0, 160).replace(/\n/g, ' | '));
          capturedUserText = options.messages[0].content[0].text;
          capturedMaxTokens = route.maxTokens;
          if (englishBatch) {
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                candidates: [
                  { category: 'Connectivity', title: 'Literal ok reply check', reason: 'checks the model echoes ok' },
                  { category: 'Instructions', title: 'Verbatim output compliance test', reason: 'checks literal obedience' },
                  { category: 'Placeholder', title: 'Empty session awaiting a real task', reason: 'nothing substantial yet' },
                ],
              }),
            };
            return;
          }
          if (shortBatchOnce) {
            shortBatchCalls += 1;
            const few = shortBatchCalls === 1
              ? [{ category: '文档', title: '推荐信排版导出 PDF', reason: '首轮只给一条' }]
              : [
                { category: '文档', title: '推荐信排版导出 PDF', reason: '重复的会被丢掉' },
                { category: '文档', title: 'XJTLU 模板推荐信', reason: '提到了具体模板' },
                { category: '其他', title: '推荐信 PDF 交付', reason: '强调交付物' },
              ];
            yield { type: 'text-delta', text: JSON.stringify({ candidates: few }) };
            return;
          }
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              candidates: [
                { category: '文档', title: '推荐信排版导出 PDF', reason: '会话在按模板排版并导出推荐信' },
                { category: '文档', title: 'XJTLU 模板推荐信', reason: '提到了具体模板' },
                { category: '其他', title: '推荐信 PDF 交付', reason: '强调交付物' },
              ],
            }),
          };
        },
      };
    },
  },
};

apply(ctx, {});
if (!capturedRoute) throw new Error('路由没有注册');
if (!capturedTool) throw new Error('模型工具没有注册');
console.log('route:', capturedRoute.kind, capturedRoute.path);
console.log('tool:', capturedTool.name, '| timeoutMs:', capturedTool.timeoutMs);

function makeRequest(body) {
  return {
    method: 'POST',
    headers: { host: '127.0.0.1:55538' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
}

function makeResponse() {
  const state = {};
  return {
    writeHead(status) {
      state.status = status;
    },
    end(payload) {
      state.body = JSON.parse(payload);
    },
    state,
  };
}

/* 1) 浏览器确认框：HTTP 路由，应拿到 3 条候选 */
const suggested = makeResponse();
await capturedRoute.handler(makeRequest({ sessionId: 's1', tags: ['文档', 'DSH'] }), suggested);
console.log('路由:', suggested.state.status, JSON.stringify(suggested.state.body));
const routeBody = suggested.state.body;
if (routeBody.suggested !== '文档 · 推荐信排版导出 PDF') {
  console.error('FAIL: 期望单条字段仍向后兼容');
  process.exit(1);
}
if (!Array.isArray(routeBody.candidates) || routeBody.candidates.length !== 3) {
  console.error('FAIL: 期望返回 3 条候选');
  process.exit(1);
}
if (routeBody.category !== '文档' || routeBody.candidates[1].suggested !== '文档 · XJTLU 模板推荐信') {
  console.error('FAIL: 候选内容不对');
  process.exit(1);
}
if (capturedMaxTokens !== 2048) {
  console.error('FAIL: 首轮预算应为 2048，实际 ' + capturedMaxTokens);
  process.exit(1);
}

/* 1b) 换一批：上一批题名要进提示词，且不该重复问同样的内容 */
const again = makeResponse();
await capturedRoute.handler(
  makeRequest({ sessionId: 's1', tags: ['文档'], avoid: ['文档 · 推荐信排版导出 PDF'] }),
  again,
);
if (again.state.status !== 200 || !capturedUserText.includes('不要与这些已给过的标题重复')) {
  console.error('FAIL: 换一批应把已给过的标题带进提示词');
  process.exit(1);
}

/* 1c) 模型只回 1 条 → 自动补一次，凑满 3 条（重复的丢掉） */
shortBatchOnce = true;
const beforeTopUp = llmCalls;
const topped = makeResponse();
await capturedRoute.handler(makeRequest({ sessionId: 's1', tags: ['文档'] }), topped);
shortBatchOnce = false;
console.log('补齐候选:', topped.state.status, '| 模型调用 +', llmCalls - beforeTopUp, '| 候选', topped.state.body.candidates && topped.state.body.candidates.length);
if (topped.state.status !== 200 || llmCalls - beforeTopUp !== 2 || topped.state.body.candidates.length !== 3) {
  console.error('FAIL: 只回 1 条时应自动补一次凑满 3 条');
  process.exit(1);
}
if (topped.state.body.candidates[2].suggested !== '其他 · 推荐信 PDF 交付') {
  console.error('FAIL: 补齐的候选不对');
  process.exit(1);
}

/* 1d) 英文候选：分类不该被按字符数切掉（Connectivity 不能被切成 Connectivit…） */
englishBatch = true;
const en = makeResponse();
await capturedRoute.handler(makeRequest({ sessionId: 's1', tags: ['Docs'] }), en);
englishBatch = false;
console.log('英文候选:', en.state.status, '|', en.state.body.candidates && en.state.body.candidates[0].suggested);
if (en.state.body.candidates[0].category !== 'Connectivity' || en.state.body.candidates[0].theme !== 'Literal ok reply check') {
  console.error('FAIL: 英文分类/主题不该被按字符数截断');
  process.exit(1);
}

const missing = makeResponse();
await capturedRoute.handler(makeRequest({ sessionId: 'nope' }), missing);
console.log('未知会话:', missing.state.status, JSON.stringify(missing.state.body));
if (missing.state.status !== 404) {
  console.error('FAIL: 未知会话应 404');
  process.exit(1);
}

/* 2) 模型工具：不给 title → 走分析，自己拼「分类 · 主题」 */
const auto = await capturedTool.execute({}, { agent: { session } });
console.log('工具自动命名:', JSON.stringify(auto));
if (auto.title !== '文档 · 推荐信排版导出 PDF' || auto.source !== 'analyzed' || auto.seq !== 42) {
  console.error('FAIL: 工具自动命名结果不对');
  process.exit(1);
}

/* 3) 模型工具：给了 title → 直接钉住，不再调模型 */
const callsBefore = llmCalls;
const pinned = await capturedTool.execute({ title: 'PRD-042 推荐信导出' }, { agent: { session } });
console.log('工具直接命名:', JSON.stringify(pinned));
if (pinned.title !== 'PRD-042 推荐信导出' || pinned.source !== 'model') {
  console.error('FAIL: 工具直接命名结果不对');
  process.exit(1);
}
if (llmCalls !== callsBefore) {
  console.error('FAIL: 指定 title 时不应该再调模型');
  process.exit(1);
}

/* 4) 模型工具：未知会话（显式 session_id）→ 报错 */
let threw = false;
try {
  await capturedTool.execute({ session_id: 'nope' }, {});
} catch (error) {
  threw = true;
  console.log('工具未知会话:', error.message);
}
if (!threw) {
  console.error('FAIL: 未知 session_id 应抛错');
  process.exit(1);
}

/* 5) 模型工具：既无 session_id 也无归属会话 → 报错 */
threw = false;
try {
  await capturedTool.execute({}, {});
} catch (error) {
  threw = true;
  console.log('工具无归属会话:', error.message);
}
if (!threw) {
  console.error('FAIL: 没有归属会话时应抛错');
  process.exit(1);
}

/* 6) 网关嫌 2048 太大 → 自动退到 700 重试一次 */
rejectBigBudget = true;
const beforeRetry = prepareAttempts;
const fallback = makeResponse();
await capturedRoute.handler(makeRequest({ sessionId: 's1', tags: ['文档'] }), fallback);
rejectBigBudget = false;
console.log('预算回退:', fallback.state.status, '| prepareCall 次数 +', prepareAttempts - beforeRetry);
if (fallback.state.status !== 200 || prepareAttempts - beforeRetry !== 2 || capturedMaxTokens !== 700) {
  console.error('FAIL: 预算被拒时应退到 700 重试一次');
  process.exit(1);
}

console.log('写标题记录:', JSON.stringify(renamed));
console.log('SMOKE OK');
