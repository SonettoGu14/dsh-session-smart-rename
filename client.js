/**
 * dsh-session-smart-rename — 浏览器半体。
 *
 * 两个座位：
 *   - `sidebar.workspaces.session.menu.item`：会话行「…」菜单里的一项「智能重命名」；
 *   - `shell.overlay`：命名工作台（分类 chips / 主题输入 + 标题预览 / AI 建议与换一批）。
 *
 * 数据与改名都走宿主已有路由，不新增后端：
 *   POST /api/session/list   {args:{_request:{}}}
 *   POST /api/session/rename {args:{request:{sessionId,title}}}
 *
 * 无构建步骤：纯 React.createElement 渲染。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-smart-rename',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** 可选的原生菜单行组件：拿不到就退回普通按钮。 */
    let prim = null;
    try {
      prim = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      prim = null;
    }

    const NS = 'dsh-session-smart-rename';
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    const OVERLAY_SLOT = 'shell.overlay';
    const TAGS_KEY = 'dsh-smart-rename.tags.v1';

    /** 界面语言：浏览器语言以 zh 开头用中文，读不到语言时也按中文。 */
    const NAV_LANG = typeof navigator !== 'undefined' ? String(navigator.language || '') : '';
    const LOCALE = NAV_LANG === '' || /^zh/i.test(NAV_LANG) ? 'zh' : 'en';

    /** 分类的内部 key 与各语言下的名字：规则与出厂 tag 都从这里取名。 */
    const CATEGORY_LABELS = {
      zh: { docs: '文档', dsh: 'DSH', plugin: '插件', maintenance: '维护', empty: '空会话', code: '代码', research: '调研', other: '其他' },
      en: { docs: 'Docs', dsh: 'DSH', plugin: 'Plugins', maintenance: 'Maintenance', empty: 'Empty', code: 'Code', research: 'Research', other: 'Other' },
    };

    /** 界面文案：除中文外一律走英文，不做第三种语言的猜测。 */
    const TEXT = {
      zh: {
        menu: '智能重命名',
        menuBusy: '正在分析对话…',
        notAnalyzed: (error) => '（未做模型分析：' + error + '）',
        hostUnreachable: '连不上宿主：',
        httpFailed: (status) => '请求失败（HTTP ' + status + '）',
        callFailed: '调用失败',
        readFailed: '读取会话信息失败',
        untitled: '未命名',
        deletable: '可删',
        emptyNamed: '空会话（没有用户消息），用目录名标记出处',
        emptyPlain: '空会话（没有用户消息），可直接删',
        matched: (name) => '命中分类「' + name + '」',
        noMatch: '没有命中规则，归到「其他」',
        dialogTitle: '智能重命名',
        sourceLlm: '模型分析',
        sourceRules: '本地规则',
        fallbackReason: '先分类，再命名',
        currentLabel: '当前：',
        sectionCategory: '分类',
        newTagPlaceholder: 'tag 名称',
        addTag: '＋ 新建 tag',
        sectionTopic: '主题',
        topicPlaceholder: '这一段到底在做啥？',
        finalTitleLabel: '最终标题：',
        emptyTopic: '（还没填主题）',
        sectionSuggestions: 'AI 建议',
        refresh: '换一批',
        refreshing: '重新分析中…',
        emptyCandidates: '暂无建议，点「换一批」试试。',
        cancel: '取消',
        save: '保存',
        saving: '保存中…',
        needTopic: '先写个主题',
        noNewSuggestions: '没拿到新的建议',
      },
      en: {
        menu: 'Smart rename',
        menuBusy: 'Analyzing conversation…',
        notAnalyzed: (error) => ' (no model analysis: ' + error + ')',
        hostUnreachable: 'Cannot reach the host: ',
        httpFailed: (status) => 'Request failed (HTTP ' + status + ')',
        callFailed: 'Call failed',
        readFailed: 'Could not read this session',
        untitled: 'Untitled',
        deletable: 'Deletable',
        emptyNamed: 'Empty session (no user messages); the folder name marks where it came from',
        emptyPlain: 'Empty session (no user messages); safe to delete',
        matched: (name) => 'Matched category "' + name + '"',
        noMatch: 'No rule matched, filed under "Other"',
        dialogTitle: 'Smart rename',
        sourceLlm: 'Model analysis',
        sourceRules: 'Local rules',
        fallbackReason: 'Pick a category, then a topic',
        currentLabel: 'Current: ',
        sectionCategory: 'Category',
        newTagPlaceholder: 'tag name',
        addTag: '＋ New tag',
        sectionTopic: 'Topic',
        topicPlaceholder: 'What was this session really about?',
        finalTitleLabel: 'Final title: ',
        emptyTopic: '(no topic yet)',
        sectionSuggestions: 'AI suggestions',
        refresh: 'Another batch',
        refreshing: 'Re-analyzing…',
        emptyCandidates: 'No suggestions yet — try "Another batch".',
        cancel: 'Cancel',
        save: 'Save',
        saving: 'Saving…',
        needTopic: 'Add a topic first',
        noNewSuggestions: 'No new suggestions came back',
      },
    };

    const TX = TEXT[LOCALE];

    /** 取某个分类在当前语言下的名字。 */
    function categoryLabel(key) {
      return CATEGORY_LABELS[LOCALE][key] || key;
    }

    /** 出厂 tag：沿用之前人工整理时用的分类，按界面语言取名。 */
    const DEFAULT_TAGS = ['docs', 'dsh', 'plugin', 'maintenance', 'empty', 'code', 'research'].map(categoryLabel);

    /** 宿主分析端点：读会话内容并调一次模型。 */
    const SUGGEST_ENDPOINT = '/api/dsh-session-smart-rename/suggest';

    /** 同一会话 5 分钟内的建议复用，避免反复点菜单重复烧 token。 */
    const suggestionCache = new Map();
    const SUGGESTION_TTL_MS = 5 * 60 * 1000;

    /**
     * 请宿主按对话内容分析，返回若干候选。
     * 失败时返回 { supported:false, error }，由调用方退回本地规则。
     * @param sessionId - 目标会话。
     * @param tags - 候选分类，交给模型参考。
     * @param options - { force: 跳过缓存（换一批）, avoid: 上一批已给过的标题 }。
     */
    async function suggestFromHost(sessionId, tags, options) {
      const force = Boolean(options && options.force);
      const avoid = Array.isArray(options && options.avoid) ? options.avoid : [];
      const cached = suggestionCache.get(sessionId);
      if (!force && cached !== undefined && Date.now() - cached.at < SUGGESTION_TTL_MS) {
        return cached.value;
      }
      let response;
      try {
        response = await fetch(SUGGEST_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, tags, avoid }),
        });
      } catch (error) {
        return { supported: false, error: TX.hostUnreachable + String((error && error.message) || error) };
      }
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      if (!response.ok || body === null || body.ok !== true) {
        return { supported: false, error: (body && body.error) || ('HTTP ' + response.status) };
      }
      const candidates = normalizeSuggestions(body);
      const first = candidates[0] || { category: '', theme: '', suggested: '', reason: '' };
      const value = {
        supported: true,
        source: body.source === 'llm' ? 'llm' : 'rules',
        blank: body.blank === true,
        category: body.category || first.category,
        theme: body.theme || body.title || first.theme,
        suggested: body.suggested || first.suggested,
        reason: body.reason || first.reason,
        model: body.model || null,
        candidates,
      };
      if (!force) suggestionCache.set(sessionId, { at: Date.now(), value });
      return value;
    }

    /* ------------------------------------------------------------------ *
     * 宿主 RPC（浏览器自带同源 cookie，不需要额外鉴权）
     * ------------------------------------------------------------------ */

    function newRpcId() {
      try {
        return crypto.randomUUID();
      } catch (error) {
        return 'rpc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      }
    }

    /**
     * 调用一条宿主 unary Remote 端点。
     * @param endpoint - 例如 `session/rename`
     * @param args - 该端点声明的具名参数对象
     * @returns 端点的业务返回值
     */
    async function rpc(endpoint, args) {
      const response = await fetch('/api/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: newRpcId(),
          method: endpoint,
          payload: { args },
        }),
      });
      if (!response.ok) {
        throw new Error(TX.httpFailed(response.status));
      }
      const body = await response.json();
      const result = body && body.result;
      if (!result || result.ok !== true) {
        const failure = result && result.error;
        throw new Error((failure && (failure.message || failure.code)) || TX.callFailed);
      }
      return result.value;
    }

    /* ------------------------------------------------------------------ *
     * 取会话信息 + 分类
     * ------------------------------------------------------------------ */

    /** 读一次会话列表，挑出目标会话的分类线索。 */
    async function loadSessionInfo(sessionId, displayTitle) {
      let item = null;
      try {
        const value = await rpc('session/list', { _request: {} });
        const items = (value && value.items) || [];
        item = items.find((candidate) => candidate && candidate.sessionId === sessionId) || null;
      } catch (error) {
        item = null;
      }
      const values = (item && item.projections && item.projections.values) || {};
      const outline = Array.isArray(values.turnOutline) ? values.turnOutline : [];
      const firstPrompt = outline.length > 0 ? String(outline[0].prompt || '') : '';
      return {
        cwd: String((item && item.cwd) || ''),
        blank: Boolean(item && item.blank),
        title: String(values.title || displayTitle || ''),
        prompt: firstPrompt.replace(/\s+/g, ' ').trim(),
      };
    }

    /** 分类规则：按顺序命中，先具体后宽泛。 */
    const RULES = [
      {
        key: 'docs',
        keywords: /推荐信|letter|handout|slides?|课件|讲义|论文|文献|文档|报告|docx|pptx|pdf|提交|submission|模板|template/i,
        cwd: /学生推荐信|Handouts|Slides|Submissions|Letters|Templates|Documents\/Work/i,
      },
      {
        key: 'maintenance',
        keywords: /清理|整理|重命名|磁盘|临时|tmp|垃圾|归档|备份|体检|审查/i,
      },
      {
        key: 'plugin',
        keywords: /插件|plugin|市场|market|索引|index|opencode|drawio|mcp\s*server|扩展/i,
      },
      {
        key: 'dsh',
        keywords: /dsh|harness|mcp|agents|profile|配置|设置|会话|模型|token|用量/i,
      },
      {
        key: 'code',
        keywords: /代码|实现|重构|修复|bug|测试|仓库|git|编译|构建|脚本|函数|接口/i,
      },
      {
        key: 'research',
        keywords: /调研|研究|对比|方案|资料|搜索|查找|分析|评估|选型/i,
      },
    ];

    /** 去掉已有的「分类 · 」前缀。 */
    function stripCategory(text) {
      return String(text || '').replace(/^[^·\n]{1,10} · /, '').trim();
    }

    /** 标题像占位符时不算主题（空会话被复用后会留下这种旧名）。 */
    const STUB_TITLE = /^(无内容|可删|未命名|新建|新对话|untitled|new session)/i;

    /** 目录名兜底：`/a/b/default-workspace` → `default-workspace`。 */
    function cwdBaseName(cwd) {
      const segments = String(cwd || '').split('/').filter(Boolean);
      return segments.length > 0 ? segments[segments.length - 1] : '';
    }

    /** 会话标题/首条消息/工作目录里剥出主题，优先取真正有信息量的那个。 */
    function deriveTheme(info) {
      const title = stripCategory(info.title);
      if (title && !STUB_TITLE.test(title)) return clampText(title, 24);
      const prompt = stripCategory(info.prompt);
      if (prompt) return clampText(prompt, 20);
      const base = cwdBaseName(info.cwd);
      if (base) return clampText(base, 20);
      return title ? clampText(title, 24) : TX.untitled;
    }

    /** 按字符上限截断，尽量不切断词。 */
    function clampText(text, max) {
      const value = String(text || '').trim();
      if (value.length <= max) return value;
      return value.slice(0, max - 1).trimEnd() + '…';
    }

    /** 标题总宽预算（CJK 记 2 格）：侧栏一行大概放得下 26 格。 */
    const TITLE_WIDTH = 26;

    /** 单字符显示宽度：CJK / 全角记 2，其余记 1。 */
    function charWidth(codePoint) {
      const wide = (codePoint >= 0x1100 && codePoint <= 0x115f)
        || codePoint === 0x2329 || codePoint === 0x232a
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6);
      return wide ? 2 : 1;
    }

    /** 字符串的显示宽度。 */
    function displayWidth(text) {
      let total = 0;
      for (const char of String(text || '')) total += charWidth(char.codePointAt(0));
      return total;
    }

    /** 按显示宽度截断；英文尽量断在词边界，尾巴补省略号。 */
    function clampWidth(text, max) {
      const value = String(text || '').trim();
      if (max <= 1) return '…';
      if (displayWidth(value) <= max) return value;
      let used = 0;
      let cut = 0;
      let lastSpace = -1;
      for (const char of value) {
        const step = charWidth(char.codePointAt(0));
        if (used + step > max - 1) break;
        used += step;
        cut += char.length;
        if (char === ' ') lastSpace = cut - 1;
      }
      let head = value.slice(0, cut).trimEnd();
      // 只在切断的是英文单词时才退回词边界：中文没有空格，回退会把整个词都吃掉
      const tailWord = value.slice(lastSpace + 1);
      if (lastSpace > 1 && /^[A-Za-z0-9]/.test(tailWord) && cut < value.length && displayWidth(value) - used > 4) {
        head = value.slice(0, lastSpace).trimEnd();
      }
      return head ? head + '…' : '…';
    }

    /** 主题留给标题的预算：总宽减去「分类 · 」前缀。 */
    function fitTheme(category, topic) {
      const left = String(category || '').trim();
      const budget = left ? TITLE_WIDTH - displayWidth(left) - 3 : TITLE_WIDTH;
      return clampWidth(topic, Math.max(8, budget));
    }

    /** 先分类，再给出建议名。 */
    function classify(info) {
      if (info.blank) {
        const base = cwdBaseName(info.cwd);
        const named = base && base !== 'default-workspace';
        const theme = named ? clampText(base, 20) : TX.deletable;
        const empty = categoryLabel('empty');
        const fitted = fitTheme(empty, theme);
        return {
          category: empty,
          theme: fitted,
          suggested: composeTitle(empty, fitted),
          reason: named ? TX.emptyNamed : TX.emptyPlain,
        };
      }
      const haystack = [info.title, stripCategory(info.prompt), info.cwd].filter(Boolean).join(' \n ');
      for (const rule of RULES) {
        if (rule.keywords.test(haystack) || (rule.cwd && rule.cwd.test(info.cwd))) {
          const theme = deriveTheme(info);
          const category = categoryLabel(rule.key);
          const fitted = fitTheme(category, theme);
          return { category, theme: fitted, suggested: composeTitle(category, fitted), reason: TX.matched(category) };
        }
      }
      const theme = deriveTheme(info);
      const other = categoryLabel('other');
      const fitted = fitTheme(other, theme);
      return { category: other, theme: fitted, suggested: composeTitle(other, fitted), reason: TX.noMatch };
    }

    /* ------------------------------------------------------------------ *
     * tag 列表（localStorage，跟着浏览器走）
     * ------------------------------------------------------------------ */

    function loadTags() {
      try {
        const raw = localStorage.getItem(TAGS_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string' && tag.trim() !== '')) {
          const merged = [];
          for (const tag of DEFAULT_TAGS.concat(parsed)) {
            const name = String(tag).trim();
            if (name && !merged.includes(name)) merged.push(name);
          }
          return merged;
        }
      } catch (error) {
        /* 读不到就用出厂值 */
      }
      return DEFAULT_TAGS.slice();
    }

    function saveTags(tags) {
      try {
        localStorage.setItem(TAGS_KEY, JSON.stringify(tags));
      } catch (error) {
        /* 存不下不影响本次改名 */
      }
    }

    /* ------------------------------------------------------------------ *
     * 跨座位的小状态：菜单项发请求，浮层负责渲染
     * ------------------------------------------------------------------ */

    const store = { pending: null, listeners: new Set() };

    function setPending(next) {
      store.pending = next;
      for (const listener of store.listeners) {
        try {
          listener();
        } catch (error) {
          /* 单个订阅者失败不影响其它 */
        }
      }
    }

    function usePending() {
      const [pending, setLocal] = useState(store.pending);
      useEffect(() => {
        const listener = () => setLocal(store.pending);
        store.listeners.add(listener);
        return () => {
          store.listeners.delete(listener);
        };
      }, []);
      return pending;
    }

    /* ------------------------------------------------------------------ *
     * 样式
     * ------------------------------------------------------------------ */

    const menuRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      padding: '6px 10px',
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: '13px',
      textAlign: 'left',
      cursor: 'pointer',
      borderRadius: '6px',
    };

    const backdropStyle = {
      position: 'fixed',
      inset: '0',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.28)',
    };

    const cardStyle = {
      width: 'min(440px, calc(100vw - 48px))',
      borderRadius: '12px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))',
      background: 'var(--dsw-alias-bg-l1, #fff)',
      color: 'var(--dsw-alias-text-l1, #222)',
      boxShadow: '0 12px 40px rgba(0,0,0,0.22)',
      padding: '16px 18px',
      fontSize: '13px',
    };

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.18))',
      background: 'var(--dsw-alias-bg-l2, #f7f7f8)',
      color: 'inherit',
      font: 'inherit',
      fontSize: '14px',
      outline: 'none',
    };

    const chipStyle = (active) => ({
      padding: '4px 10px',
      borderRadius: '999px',
      border: '1px solid ' + (active ? 'var(--dsw-alias-brand-l1, #4d6bfe)' : 'var(--dsw-alias-border-l1, rgba(0,0,0,0.16))'),
      background: active ? 'rgba(77,107,254,0.12)' : 'transparent',
      color: active ? 'var(--dsw-alias-brand-l1, #4d6bfe)' : 'inherit',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    });

    const sectionLabelStyle = {
      marginTop: '14px',
      marginBottom: '6px',
      fontSize: '11px',
      fontWeight: 600,
      letterSpacing: '0.04em',
      opacity: 0.55,
    };

    const newTagInputStyle = {
      width: '96px',
      padding: '3px 8px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-brand-l1, #4d6bfe)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: '12px',
      outline: 'none',
    };

    const previewStyle = {
      marginTop: '8px',
      fontSize: '12px',
      opacity: 0.6,
    };

    const previewTitleStyle = {
      color: 'var(--dsw-alias-text-l1, #222)',
      opacity: 1,
      fontWeight: 500,
    };

    const linkButtonStyle = {
      padding: '0',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-brand-l1, #4d6bfe)',
      font: 'inherit',
      fontSize: '11px',
      cursor: 'pointer',
      opacity: 0.85,
    };

    const candidateRowStyle = (active) => ({
      display: 'block',
      width: '100%',
      textAlign: 'left',
      padding: '7px 10px',
      borderRadius: '8px',
      border: '1px solid ' + (active ? 'var(--dsw-alias-brand-l1, #4d6bfe)' : 'var(--dsw-alias-border-l1, rgba(0,0,0,0.12))'),
      background: active ? 'rgba(77,107,254,0.08)' : 'transparent',
      color: 'inherit',
      font: 'inherit',
      cursor: 'pointer',
    });

    const buttonStyle = (primary, disabled) => ({
      padding: '6px 14px',
      borderRadius: '8px',
      border: primary ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.16))',
      background: primary ? 'var(--dsw-alias-brand-l1, #4d6bfe)' : 'transparent',
      color: primary ? '#fff' : 'inherit',
      font: 'inherit',
      fontSize: '13px',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    });

    /* ------------------------------------------------------------------ *
     * 菜单项
     * ------------------------------------------------------------------ */

    function SmartRenameMenuItem(props) {
      const sessionId = props && props.sessionId;
      const displayTitle = props && props.displayTitle;
      const [busy, setBusy] = useState(false);

      const open = useCallback(async () => {
        if (!sessionId || busy) return;
        setBusy(true);
        try {
          const info = await loadSessionInfo(sessionId, displayTitle);
          let analysis = null;
          try {
            analysis = await suggestFromHost(sessionId, loadTags());
          } catch (error) {
            analysis = null;
          }
          if (analysis && analysis.supported) {
            setPending({
              sessionId,
              sourceTitle: info.title || displayTitle || '',
              blank: analysis.blank,
              category: analysis.category || '',
              topic: analysis.theme || '',
              candidates: analysis.candidates,
              reason: analysis.reason,
              source: analysis.source,
              model: analysis.model,
              error: null,
            });
          } else {
            const verdict = classify(info);
            const note = analysis && analysis.error && !info.blank ? TX.notAnalyzed(analysis.error) : '';
            setPending({
              sessionId,
              sourceTitle: info.title || displayTitle || '',
              blank: info.blank,
              category: verdict.category,
              topic: verdict.theme,
              candidates: [{
                category: verdict.category,
                theme: verdict.theme,
                suggested: verdict.suggested,
                reason: verdict.reason,
              }],
              reason: verdict.reason + note,
              source: 'rules',
              error: null,
            });
          }
        } catch (error) {
          setPending({
            sessionId,
            sourceTitle: displayTitle || '',
            blank: false,
            category: categoryLabel('other'),
            topic: '',
            candidates: [],
            reason: TX.readFailed,
            source: 'rules',
            error: String((error && error.message) || error),
          });
        } finally {
          setBusy(false);
        }
      }, [sessionId, displayTitle, busy]);

      const label = busy ? TX.menuBusy : TX.menu;

      if (prim && typeof prim.MenuItemButton === 'function') {
        const icon = prim.IconEditOutlineRegular ? h(prim.IconEditOutlineRegular, {}) : undefined;
        return h(prim.MenuItemButton, { icon, onSelect: open }, label);
      }
      return h(
        'button',
        { type: 'button', style: menuRowStyle, onClick: open, disabled: busy },
        label,
      );
    }

    /* ------------------------------------------------------------------ *
     * 确认对话框
     * ------------------------------------------------------------------ */

    /** 分类 + 主题拼成标题；缺一半就只留有的那半。 */
    function composeTitle(category, topic) {
      const left = String(category || '').trim();
      const right = String(topic || '').trim();
      if (left && right) return left + ' · ' + right;
      return left || right;
    }

    /** 把宿主返回值归一成候选数组：新形状 {candidates} 与旧单条形状都认。 */
    function normalizeSuggestions(body) {
      const source = body && Array.isArray(body.candidates) && body.candidates.length > 0
        ? body.candidates
        : [body];
      const out = [];
      for (const item of source) {
        if (item === null || typeof item !== 'object') continue;
        const category = typeof item.category === 'string' ? item.category.trim() : '';
        /* 候选项保留模型原话：列表里要看全，收窄交给预览与保存 */
        const theme = String(item.theme || item.title || '').trim();
        if (!theme) continue;
        out.push({
          category,
          theme,
          suggested: composeTitle(category, theme),
          reason: String(item.reason || '').trim(),
        });
        if (out.length === 3) break;
      }
      return out;
    }

    function SmartRenameDialog() {
      const pending = usePending();
      const [category, setCategory] = useState('');
      const [topic, setTopic] = useState('');
      const [tags, setTags] = useState(() => loadTags());
      const [candidates, setCandidates] = useState([]);
      const [refreshing, setRefreshing] = useState(false);
      const [adding, setAdding] = useState(false);
      const [newTag, setNewTag] = useState('');
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);
      const topicRef = useRef(null);
      const tagInputRef = useRef(null);

      /* 每次打开重置草稿 */
      useEffect(() => {
        if (!pending) return;
        setCategory(pending.category || '');
        setTopic(pending.topic || '');
        setCandidates(Array.isArray(pending.candidates) ? pending.candidates : []);
        setError(pending.error || null);
        setSaving(false);
        setRefreshing(false);
        setAdding(false);
        setNewTag('');
      }, [pending]);

      /* 打开时聚焦主题框并全选，方便直接改 */
      useEffect(() => {
        if (!pending) return;
        const timer = setTimeout(() => {
          const node = topicRef.current;
          if (node) {
            try {
              node.focus();
              node.select();
            } catch (focusError) {
              /* 焦点失败不影响输入 */
            }
          }
        }, 0);
        return () => clearTimeout(timer);
      }, [pending]);

      /* 新建 tag 输入框聚焦 */
      useEffect(() => {
        if (!adding) return;
        const timer = setTimeout(() => {
          const node = tagInputRef.current;
          if (node) {
            try {
              node.focus();
            } catch (focusError) {
              /* ignore */
            }
          }
        }, 0);
        return () => clearTimeout(timer);
      }, [adding]);

      const close = useCallback(() => {
        if (saving) return;
        setPending(null);
      }, [saving]);

      /* Esc 关闭 */
      useEffect(() => {
        if (!pending) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [pending, close]);

      /* 点候选：整条替换分类与主题，光标留在主题框 */
      const applyCandidate = useCallback((candidate) => {
        setCategory(candidate.category || '');
        setTopic(candidate.theme || '');
        const node = topicRef.current;
        if (node) {
          try {
            node.focus();
          } catch (focusError) {
            /* ignore */
          }
        }
      }, []);

      const commitNewTag = useCallback(() => {
        const name = newTag.trim();
        setAdding(false);
        setNewTag('');
        if (!name) return;
        setTags((previous) => {
          const next = previous.includes(name) ? previous : previous.concat([name]);
          saveTags(next);
          return next;
        });
        setCategory(name);
      }, [newTag]);

      const save = useCallback(async () => {
        if (!pending) return;
        const title = composeTitle(category, fitTheme(category, topic));
        if (!title) {
          setError(TX.needTopic);
          return;
        }
        setSaving(true);
        setError(null);
        try {
          await rpc('session/rename', { request: { sessionId: pending.sessionId, title } });
          suggestionCache.delete(pending.sessionId);
          setPending(null);
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
          setSaving(false);
        }
      }, [pending, category, topic]);

      /* 换一批：绕过缓存，把这一批已经给过的题名带去，让模型别重复 */
      const refresh = useCallback(async () => {
        if (!pending || refreshing) return;
        setRefreshing(true);
        setError(null);
        try {
          const analysis = await suggestFromHost(pending.sessionId, loadTags(), {
            force: true,
            avoid: candidates.map((candidate) => candidate.suggested),
          });
          if (analysis && analysis.supported && analysis.candidates.length > 0) {
            setCandidates(analysis.candidates);
          } else {
            setError((analysis && analysis.error) || TX.noNewSuggestions);
          }
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        } finally {
          setRefreshing(false);
        }
      }, [pending, refreshing, candidates]);

      if (!pending) return null;

      const finalTitle = composeTitle(category, fitTheme(category, topic));
      const disabled = saving || finalTitle === '';

      return h(
        'div',
        {
          style: backdropStyle,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close();
          },
        },
        h(
          'div',
          { style: cardStyle, role: 'dialog', 'aria-label': TX.dialogTitle },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '2px' } },
            h('div', { style: { fontSize: '15px', fontWeight: 600 } }, TX.dialogTitle),
            h('div', { style: { opacity: 0.5, fontSize: '11px' } }, pending.source === 'llm' ? TX.sourceLlm : TX.sourceRules),
          ),
          h(
            'div',
            { style: { opacity: 0.6, fontSize: '12px', marginBottom: '14px', lineHeight: 1.5 } },
            pending.reason || TX.fallbackReason,
            pending.sourceTitle
              ? h('div', { style: { marginTop: '2px', opacity: 0.85 } }, TX.currentLabel + pending.sourceTitle)
              : null,
          ),
          h('div', { style: sectionLabelStyle }, TX.sectionCategory),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
            ...tags.map((tag) =>
              h(
                'button',
                {
                  key: tag,
                  type: 'button',
                  style: chipStyle(category === tag),
                  onClick: () => setCategory(category === tag ? '' : tag),
                },
                tag,
              ),
            ),
            adding
              ? h('input', {
                  ref: tagInputRef,
                  style: newTagInputStyle,
                  value: newTag,
                  placeholder: TX.newTagPlaceholder,
                  onChange: (event) => setNewTag(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitNewTag();
                    } else if (event.key === 'Escape') {
                      event.stopPropagation();
                      setAdding(false);
                      setNewTag('');
                    }
                  },
                  onBlur: commitNewTag,
                })
              : h('button', { type: 'button', style: chipStyle(false), onClick: () => setAdding(true) }, TX.addTag),
          ),
          h('div', { style: sectionLabelStyle }, TX.sectionTopic),
          h('input', {
            ref: topicRef,
            style: inputStyle,
            value: topic,
            spellCheck: false,
            placeholder: TX.topicPlaceholder,
            onChange: (event) => setTopic(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
                event.preventDefault();
                save();
              }
            },
          }),
          h(
            'div',
            { style: previewStyle },
            TX.finalTitleLabel,
            h('span', { style: finalTitle ? previewTitleStyle : { opacity: 0.45 } }, finalTitle || TX.emptyTopic),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '14px' } },
            h('div', { style: { ...sectionLabelStyle, marginTop: 0, marginBottom: 0 } }, TX.sectionSuggestions),
            h(
              'button',
              { type: 'button', style: linkButtonStyle, onClick: refresh, disabled: refreshing },
              refreshing ? TX.refreshing : TX.refresh,
            ),
          ),
          candidates.length === 0
            ? h('div', { style: { fontSize: '12px', opacity: 0.5, lineHeight: 1.6 } }, TX.emptyCandidates)
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                ...candidates.map((candidate, index) =>
                  h(
                    'button',
                    {
                      key: candidate.suggested + index,
                      type: 'button',
                      style: candidateRowStyle(
                        candidate.category === category && candidate.theme === topic,
                      ),
                      onClick: () => applyCandidate(candidate),
                    },
                    h('div', { style: { fontSize: '13px', fontWeight: 500 } }, candidate.suggested),
                    candidate.reason
                      ? h('div', { style: { fontSize: '11px', opacity: 0.62, marginTop: '2px', lineHeight: 1.5 } }, candidate.reason)
                      : null,
                  ),
                ),
              ),
          error
            ? h('div', { style: { marginTop: '10px', fontSize: '12px', color: '#e5484d', lineHeight: 1.5 } }, error)
            : null,
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' } },
            h('button', { type: 'button', style: buttonStyle(false, saving), onClick: close }, TX.cancel),
            h('button', { type: 'button', style: buttonStyle(true, disabled), onClick: save, disabled }, saving ? TX.saving : TX.save),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * 插件本体
     * ------------------------------------------------------------------ */

    return {
      name: NS,
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject(MENU_SLOT, () =>
          ctx.slots.register(
            { name: MENU_SLOT, id: 'session-smart-rename', order: 210 },
            SmartRenameMenuItem,
          ),
        );
        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register(
            { name: OVERLAY_SLOT, id: 'session-smart-rename-dialog' },
            SmartRenameDialog,
          ),
        );
      },
    };
  },
});
