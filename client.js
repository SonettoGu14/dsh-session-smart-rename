/**
 * dsh-session-smart-rename — 浏览器半体。
 *
 * 两个座位：
 *   - `sidebar.workspaces.session.menu.item`：会话行「…」菜单里的一项「智能重命名」；
 *   - `shell.overlay`：确认对话框（预填 `分类 · 主题`，可改分类、可新建 tag）。
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

    /** 出厂 tag：沿用之前人工整理时用的分类。 */
    const DEFAULT_TAGS = ['文档', 'DSH', '插件', '维护', '空会话', '代码', '调研'];

    /** 宿主分析端点：读会话内容并调一次模型。 */
    const SUGGEST_ENDPOINT = '/api/dsh-session-smart-rename/suggest';

    /** 同一会话 5 分钟内的建议复用，避免反复点菜单重复烧 token。 */
    const suggestionCache = new Map();
    const SUGGESTION_TTL_MS = 5 * 60 * 1000;

    /**
     * 请宿主按对话内容分析，返回分类建议。
     * 失败时返回 { supported:false, error }，由调用方退回本地规则。
     */
    async function suggestFromHost(sessionId, tags) {
      const cached = suggestionCache.get(sessionId);
      if (cached !== undefined && Date.now() - cached.at < SUGGESTION_TTL_MS) {
        return cached.value;
      }
      let response;
      try {
        response = await fetch(SUGGEST_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, tags }),
        });
      } catch (error) {
        return { supported: false, error: '连不上宿主：' + String((error && error.message) || error) };
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
      const value = {
        supported: true,
        source: body.source === 'llm' ? 'llm' : 'rules',
        blank: body.blank === true,
        category: body.category,
        theme: body.theme || body.title || '',
        suggested: body.suggested,
        reason: body.reason,
        model: body.model || null,
      };
      suggestionCache.set(sessionId, { at: Date.now(), value });
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
        throw new Error('请求失败（HTTP ' + response.status + '）');
      }
      const body = await response.json();
      const result = body && body.result;
      if (!result || result.ok !== true) {
        const failure = result && result.error;
        throw new Error((failure && (failure.message || failure.code)) || '调用失败');
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
        category: '文档',
        keywords: /推荐信|letter|handout|slides?|课件|讲义|论文|文献|文档|报告|docx|pptx|pdf|提交|submission|模板|template/i,
        cwd: /学生推荐信|Handouts|Slides|Submissions|Letters|Templates|Documents\/Work/i,
      },
      {
        category: '维护',
        keywords: /清理|整理|重命名|磁盘|临时|tmp|垃圾|归档|备份|体检|审查/i,
      },
      {
        category: '插件',
        keywords: /插件|plugin|市场|market|索引|index|opencode|drawio|mcp\s*server|扩展/i,
      },
      {
        category: 'DSH',
        keywords: /dsh|harness|mcp|agents|profile|配置|设置|会话|模型|token|用量/i,
      },
      {
        category: '代码',
        keywords: /代码|实现|重构|修复|bug|测试|仓库|git|编译|构建|脚本|函数|接口/i,
      },
      {
        category: '调研',
        keywords: /调研|研究|对比|方案|资料|搜索|查找|分析|评估|选型/i,
      },
    ];

    /** 去掉已有的「分类 · 」前缀。 */
    function stripCategory(text) {
      return String(text || '').replace(/^[^·\n]{1,10} · /, '').trim();
    }

    /** 取「分类 · 」里的分类。 */
    function categoryOf(text) {
      const match = String(text || '').match(/^([^·\n]{1,10}) · /);
      return match ? match[1].trim() : '';
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
      return title ? clampText(title, 24) : '未命名';
    }

    /** 按字符上限截断，尽量不切断词。 */
    function clampText(text, max) {
      const value = String(text || '').trim();
      if (value.length <= max) return value;
      return value.slice(0, max - 1).trimEnd() + '…';
    }

    /** 先分类，再给出建议名。 */
    function classify(info) {
      if (info.blank) {
        const base = cwdBaseName(info.cwd);
        const named = base && base !== 'default-workspace';
        const theme = named ? clampText(base, 20) : '可删';
        return {
          category: '空会话',
          theme,
          suggested: '空会话 · ' + theme,
          reason: named ? '空会话（没有用户消息），用目录名标记出处' : '空会话（没有用户消息），可直接删',
        };
      }
      const haystack = [info.title, stripCategory(info.prompt), info.cwd].filter(Boolean).join(' \n ');
      for (const rule of RULES) {
        if (rule.keywords.test(haystack) || (rule.cwd && rule.cwd.test(info.cwd))) {
          const theme = deriveTheme(info);
          return {
            category: rule.category,
            theme,
            suggested: rule.category + ' · ' + theme,
            reason: '命中分类「' + rule.category + '」',
          };
        }
      }
      const theme = deriveTheme(info);
      return { category: '其他', theme, suggested: '其他 · ' + theme, reason: '没有命中规则，归到「其他」' };
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
              category: analysis.category,
              theme: analysis.theme,
              reason: analysis.reason,
              suggested: analysis.suggested,
              source: analysis.source,
              model: analysis.model,
              error: null,
            });
          } else {
            const verdict = classify(info);
            const note = analysis && analysis.error && !info.blank ? '（未做模型分析：' + analysis.error + '）' : '';
            setPending({
              sessionId,
              sourceTitle: info.title || displayTitle || '',
              blank: info.blank,
              category: verdict.category,
              theme: verdict.theme,
              reason: verdict.reason + note,
              suggested: verdict.suggested,
              source: 'rules',
              error: null,
            });
          }
        } catch (error) {
          setPending({
            sessionId,
            sourceTitle: displayTitle || '',
            blank: false,
            category: '其他',
            theme: '',
            reason: '读取会话信息失败',
            suggested: '',
            source: 'rules',
            error: String((error && error.message) || error),
          });
        } finally {
          setBusy(false);
        }
      }, [sessionId, displayTitle, busy]);

      const label = busy ? '正在分析对话…' : '智能重命名';

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

    function SmartRenameDialog() {
      const pending = usePending();
      const [value, setValue] = useState('');
      const [tags, setTags] = useState(() => loadTags());
      const [adding, setAdding] = useState(false);
      const [newTag, setNewTag] = useState('');
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);
      const inputRef = useRef(null);
      const tagInputRef = useRef(null);

      /* 每次打开重置草稿 */
      useEffect(() => {
        if (!pending) return;
        setValue(pending.suggested || pending.sourceTitle || '');
        setError(pending.error || null);
        setSaving(false);
        setAdding(false);
        setNewTag('');
      }, [pending]);

      /* 打开时聚焦并全选，方便直接改 */
      useEffect(() => {
        if (!pending) return;
        const timer = setTimeout(() => {
          const node = inputRef.current;
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

      const applyCategory = useCallback((category) => {
        setValue((previous) => {
          const theme = stripCategory(previous);
          return theme ? category + ' · ' + theme : category + ' · ';
        });
      }, []);

      const commitNewTag = useCallback(() => {
        const name = newTag.trim();
        if (!name) {
          setAdding(false);
          setNewTag('');
          return;
        }
        setTags((previous) => {
          const next = previous.includes(name) ? previous : previous.concat([name]);
          saveTags(next);
          return next;
        });
        setValue((previous) => {
          const theme = stripCategory(previous);
          return theme ? name + ' · ' + theme : name + ' · ';
        });
        setAdding(false);
        setNewTag('');
      }, [newTag]);

      const save = useCallback(async () => {
        if (!pending) return;
        const title = value.trim();
        if (!title) {
          setError('名字不能为空');
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
      }, [pending, value]);

      if (!pending) return null;

      const activeCategory = categoryOf(value);
      const disabled = saving || value.trim() === '';

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
          { style: cardStyle, role: 'dialog', 'aria-label': '智能重命名' },
          h('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } }, '智能重命名'),
          h(
            'div',
            { style: { opacity: 0.6, fontSize: '12px', marginBottom: '10px', lineHeight: 1.5 } },
            (pending.source === 'llm' ? '模型分析 · ' : pending.source === 'rules' ? '本地规则 · ' : '')
              + (pending.reason || '先分类，再命名'),
            pending.sourceTitle
              ? h('div', { style: { marginTop: '2px', opacity: 0.85 } }, '当前：' + pending.sourceTitle)
              : null,
          ),
          h('input', {
            ref: inputRef,
            style: inputStyle,
            value,
            spellCheck: false,
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                save();
              }
            },
          }),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' } },
            ...tags.map((tag) =>
              h(
                'button',
                {
                  key: tag,
                  type: 'button',
                  style: chipStyle(activeCategory === tag),
                  onClick: () => applyCategory(tag),
                },
                tag,
              ),
            ),
            adding
              ? h('input', {
                  ref: tagInputRef,
                  style: {
                    width: '96px',
                    padding: '3px 8px',
                    borderRadius: '999px',
                    border: '1px solid var(--dsw-alias-brand-l1, #4d6bfe)',
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    fontSize: '12px',
                    outline: 'none',
                  },
                  value: newTag,
                  placeholder: 'tag 名称',
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
              : h(
                  'button',
                  {
                    type: 'button',
                    style: chipStyle(false),
                    onClick: () => setAdding(true),
                  },
                  '＋ 新建 tag',
                ),
          ),
          error
            ? h(
                'div',
                { style: { marginTop: '10px', fontSize: '12px', color: '#e5484d', lineHeight: 1.5 } },
                error,
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' } },
            h('button', { type: 'button', style: buttonStyle(false, saving), onClick: close }, '取消'),
            h('button', { type: 'button', style: buttonStyle(true, disabled), onClick: save, disabled }, saving ? '保存中…' : '保存'),
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
