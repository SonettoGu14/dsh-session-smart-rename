/**
 * 本地冒烟：不启动 DSH，直接用假 ctx 验证宿主路由 + 提示词拼装 + JSON 解析。
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
  header: { cwd: '/Users/gyk/Documents/Work/学生推荐信' },
  snapshotEvents: () => events,
};

let captured;
const ctx = {
  effect(fn) {
    return fn();
  },
  webServer: {
    register(options) {
      captured = options;
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
          console.log('system 长度:', options.system.length, '| purpose:', options.purpose);
          console.log('user 提示:', options.messages[0].content[0].text.slice(0, 160).replace(/\n/g, ' | '));
          yield { type: 'text-delta', text: '{"category":"文档","title":"推荐信排版导出 PDF","reason":"会话在按模板排版并导出推荐信"}' };
        },
      };
    },
  },
};

apply(ctx, {});
if (!captured) throw new Error('路由没有注册');
console.log('route:', captured.kind, captured.path);

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

const ok = makeResponse();
await captured.handler(makeRequest({ sessionId: 's1', tags: ['文档', 'DSH'] }), ok);
console.log('正常路径:', ok.state.status, JSON.stringify(ok.state.body));

if (ok.state.status !== 200 || ok.state.body.suggested !== '文档 · 推荐信排版导出 PDF') {
  console.error('FAIL: 期望 200 且 suggested 正确');
  process.exit(1);
}

const missing = makeResponse();
await captured.handler(makeRequest({ sessionId: 'nope' }), missing);
console.log('未知会话:', missing.state.status, JSON.stringify(missing.state.body));

console.log('SMOKE OK');
