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
      console.log('prepareCall route:', JSON.stringify(route));
      return {
        config: { ...route },
        async *stream(options) {
          llmCalls += 1;
          if (typeof customize === 'function') customize({}, { reasoning: { efforts: [{ id: 'low' }] } });
          console.log('system 长度:', options.system.length, '| purpose:', options.purpose);
          console.log('user 提示:', options.messages[0].content[0].text.slice(0, 160).replace(/\n/g, ' | '));
          yield { type: 'text-delta', text: '{"category":"文档","title":"推荐信排版导出 PDF","reason":"会话在按模板排版并导出推荐信"}' };
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

/* 1) 浏览器确认框：HTTP 路由 */
const suggested = makeResponse();
await capturedRoute.handler(makeRequest({ sessionId: 's1', tags: ['文档', 'DSH'] }), suggested);
console.log('路由:', suggested.state.status, JSON.stringify(suggested.state.body));
if (suggested.state.status !== 200 || suggested.state.body.suggested !== '文档 · 推荐信排版导出 PDF') {
  console.error('FAIL: 期望 200 且 suggested 正确');
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

console.log('写标题记录:', JSON.stringify(renamed));
console.log('SMOKE OK');
