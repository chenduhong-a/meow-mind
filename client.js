// meow-mind · 侧边栏「记忆审议」标签（client 半）
// 形态照 dsh-better-sidebar / dsh-visual-card 的 client.js：先注册模块，
// 由宿主用 require 喂 react，不用 JSX、不打包。
window.__ModuleLoader__.load({
  id: 'meow-mind',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require('react');
    const h = react.createElement;
    const { useState, useEffect, useCallback, useMemo } = react;

    const API = '/meow-mind/api';

    async function callApi(method, payload) {
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      const data = await res.json().catch(() => ({ ok: false, error: '响应不是 JSON' }));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    const C = {
      text: 'var(--v-text, #2a2925)',
      dim: 'var(--v-text-dim, #8a8378)',
      bg: 'var(--v-bg-base, #f8f6f1)',
      layer1: 'var(--v-bg-layer-1, #ffffff)',
      layer2: 'var(--v-bg-layer-2, #f1ece0)',
      border: 'var(--v-border, #e3ded3)',
      brand: 'var(--v-brand, #5d6b4a)',
      ok: 'var(--v-success, #4a7c59)',
      warn: 'var(--v-error, #b0413e)',
    };

    const S = {
      wrap: { padding: '12px 12px 24px', color: C.text, fontSize: '13px', lineHeight: 1.55, background: C.bg, height: '100%', overflowY: 'auto', boxSizing: 'border-box' },
      bar: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'nowrap', marginBottom: '10px' },
      stat: { padding: '2px 8px', borderRadius: '10px', background: C.layer2, fontSize: '11.5px', color: C.dim, whiteSpace: 'nowrap' },
      sel: { border: `1px solid ${C.border}`, background: C.layer1, color: C.text, borderRadius: '6px', padding: '3px 6px', fontSize: '12px', cursor: 'pointer', maxWidth: '132px' },
      btn: { border: `1px solid ${C.border}`, background: C.layer1, color: C.text, borderRadius: '6px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' },
      btnOn: { border: `1px solid ${C.brand}`, background: C.brand, color: '#fff', borderRadius: '6px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' },
      group: { marginTop: '14px' },
      groupHead: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '6px', paddingBottom: '4px', borderBottom: `1px solid ${C.border}` },
      groupName: { fontWeight: 600, fontSize: '13px' },
      groupCount: { fontSize: '11.5px', color: C.dim },
      card: { background: C.layer1, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '9px 11px', marginBottom: '7px' },
      cardMarked: { background: C.layer1, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '9px 11px', marginBottom: '7px', opacity: 0.62 },
      title: { fontSize: '12.5px', fontWeight: 600, marginBottom: '3px', wordBreak: 'break-word' },
      snippet: { fontSize: '12px', color: C.dim, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: '6px' },
      meta: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      tag: { fontSize: '11px', color: C.dim, background: C.layer2, borderRadius: '4px', padding: '1px 6px' },
      time: { fontSize: '11px', color: C.dim, whiteSpace: 'nowrap', fontFamily: 'ui-monospace, Consolas, monospace' },
      author: {
        fontSize: '10.5px',
        fontFamily: 'ui-monospace, Consolas, monospace',
        color: C.dim,
        background: C.layer2,
        padding: '1px 6px',
        borderRadius: 4,
        marginRight: 6,
        whiteSpace: 'nowrap',
      },
      note: { marginTop: '7px', width: '100%', boxSizing: 'border-box', border: `1px dashed ${C.border}`, background: 'transparent', color: C.text, borderRadius: '6px', padding: '5px 8px', fontSize: '11.5px', lineHeight: 1.5, resize: 'vertical', minHeight: '28px', fontFamily: 'inherit', outline: 'none' },
      noteSaved: { marginTop: '7px', width: '100%', boxSizing: 'border-box', border: `1px solid ${C.ok}`, background: 'transparent', color: C.text, borderRadius: '6px', padding: '5px 8px', fontSize: '11.5px', lineHeight: 1.5, resize: 'vertical', minHeight: '28px', fontFamily: 'inherit', outline: 'none' },
      act: (color) => ({ border: `1px solid ${color}`, background: 'transparent', color, borderRadius: '5px', padding: '2px 9px', fontSize: '11.5px', cursor: 'pointer' }),
      actSolid: (color) => ({ border: `1px solid ${color}`, background: color, color: '#fff', borderRadius: '5px', padding: '2px 9px', fontSize: '11.5px', cursor: 'pointer' }),
      empty: { padding: '30px 10px', textAlign: 'center', color: C.dim, fontSize: '12.5px' },
      err: { padding: '10px 12px', borderRadius: '8px', background: 'rgba(176,65,62,.1)', color: C.warn, fontSize: '12px', marginBottom: '10px' },
    };

    const LEVELS = [
  ['all', '全部层'],
  ['todo', '待办'],
  ['user', '用户偏好'],
  ['soul', '自我设定'],
  ['rules', '全局准则'],
  ['project', '项目总览'],
  ['fact', '事实'],
  ['lesson', '经验坑'],
  ['principle', '经验准则'],
  ['topic', '主题'],
];

const FILTERS = [
      ['all', '全部'],
      ['unmarked', '未标记'],
      ['useful', '有用'],
      ['useless', '无用'],
    ];

    // 单条卡片：自带评语草稿状态，失焦或回车才保存——没写就不发请求。
    function Row(props) {
      const { it, busy, onMark } = props;
      const [draft, setDraft] = useState(it.note || '');
      const [savedOnce, setSavedOnce] = useState(false);
      useEffect(() => { setDraft(it.note || ''); }, [it.note]);

      const saveNote = useCallback(async () => {
        const text = draft.trim();
        if (text === (it.note || '').trim()) return;
        const ok = await onMark(it.id, it.verdict || '', text);
        if (ok) {
          setSavedOnce(true);
          setTimeout(() => setSavedOnce(false), 1200);
        }
      }, [draft, it.id, it.note, it.verdict, onMark]);

      const marked = Boolean(it.verdict);
      const hasNote = Boolean((it.note || '').trim());
      return h(
        'div',
        { style: marked || hasNote ? S.cardMarked : S.card },
        h('div', { style: S.title }, it.title || it.id),
        h('div', { style: S.snippet }, it.snippet),
        h(
          'div',
          { style: S.meta },
          h('span', { style: S.tag }, it.id.slice(0, 9)),
          h('span', { style: S.tag }, `${it.chars} 字`),
          it.writtenAt
            ? h(
                'span',
                {
                  style: S.time,
                  title: '写入 ' + it.writtenAt + (it.updatedText && it.updatedText !== it.writtenAt ? ' · 更新 ' + it.updatedText : ''),
                },
                it.writtenAt.slice(5)
              )
            : null,
          it.status && it.status !== 'memory' ? h('span', { style: S.tag }, it.status) : null,
          it.project ? h('span', { style: S.tag }, it.project) : null,
          h('span', { style: { flex: '1 1 auto' } }),
          it.author
            ? h('span', { style: S.author, title: it.authorSession || '来源会话未知' }, it.author)
            : null,
          h('button', {
            type: 'button',
            disabled: busy,
            style: it.verdict === 'useful' ? S.actSolid(C.ok) : S.act(C.ok),
            onClick: () => onMark(it.id, it.verdict === 'useful' ? '' : 'useful', draft),
          }, '有用'),
          h('button', {
            type: 'button',
            disabled: busy,
            style: it.verdict === 'useless' ? S.actSolid(C.warn) : S.act(C.warn),
            onClick: () => onMark(it.id, it.verdict === 'useless' ? '' : 'useless', draft),
          }, '无用'),
        ),
        h('textarea', {
          style: savedOnce ? S.noteSaved : S.note,
          rows: 1,
          placeholder: '可选：给这条记忆的指示（不写也行）',
          value: draft,
          onChange: (e) => setDraft(e.target.value),
          onBlur: () => { saveNote(); },
          onKeyDown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              saveNote();
              e.currentTarget.blur();
            }
          },
        }),
      );
    }

    function ReviewTab() {
      const [data, setData] = useState(null);
      const [filter, setFilter] = useState('all');
      const [loading, setLoading] = useState(true);
      const [err, setErr] = useState('');
      const [busy, setBusy] = useState('');
      const [dbs, setDbs] = useState([]);
      const [dbId, setDbId] = useState('');
    const [level, setLevel] = useState('all');
    const [days, setDays] = useState('0');

      const load = useCallback(async (verdict, db) => {
        setLoading(true);
        setErr('');
        try {
          const res = await callApi('list', { verdict, level, limit: 200, days: Number(days) || 0, db });
          setData(res);
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      }, [level, days]);

      const mark = useCallback(async (id, verdict, note) => {
        setBusy(id);
        try {
          const res = await callApi('mark', { id, verdict, note, db: dbId });
          setData((prev) => {
            if (!prev) return prev;
            const groups = prev.groups.map((g) => ({
              ...g,
              items: g.items.map((it) => (it.id === id ? { ...it, verdict: res.verdict, note: res.note ?? '' } : it)),
            }));
            return { ...prev, groups };
          });
          return true;
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
          return false;
        } finally {
          setBusy('');
        }
      }, [dbId, level]);

      useEffect(() => {
        let alive = true;
        callApi('dbs')
          .then((d) => {
            if (!alive) return;
            const list = Array.isArray(d.dbs) ? d.dbs : [];
            setDbs(list);
            const byPath = list.find((x) => x.path === d.current);
            setDbId((prev) => prev || (byPath ? byPath.id : (list[0] ? list[0].id : '')));
          })
          .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
        return () => { alive = false; };
      }, []);

      useEffect(() => {
        let cancelled = false;
        let tries = 0;
        const tick = async () => {
          await load(filter, dbId, level);
          tries += 1;
          if (cancelled) return;
          setData((prev) => {
            const empty = !prev || prev.groups.every((g) => g.items.length === 0);
            if (empty && tries < 3) setTimeout(() => { if (!cancelled) tick(); }, 2200);
            return prev;
          });
        };
        const t = setTimeout(tick, 1200);
        return () => { cancelled = true; clearTimeout(t); };
      }, [filter, load, dbId, days]);

      const stats = useMemo(() => {
        if (!data) return { useful: 0, useless: 0, unmarked: 0, total: 0, noted: 0 };
        let useful = 0;
        let useless = 0;
        let noted = 0;
        for (const g of data.groups) {
          for (const it of g.items) {
            if (it.verdict === 'useful') useful += 1;
            else if (it.verdict === 'useless') useless += 1;
            if ((it.note || '').trim()) noted += 1;
          }
        }
        const total = data.groups.reduce((n, g) => n + g.items.length, 0);
        return { useful, useless, unmarked: total - useful - useless, total, noted };
      }, [data]);

      const visibleGroups = useMemo(() => {
        if (!data) return [];
        // 空的层不占位（例如 user 层已全部归档后会是 0 条）
        return data.groups.filter((g) => g.items.length > 0);
      }, [data, filter]);

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.bar },
          dbs.length > 1
            ? h('select', {
                style: S.sel,
                value: dbId,
                title: '选择记忆库',
                onChange: (e) => setDbId(e.target.value),
                disabled: loading,
              },
                ...dbs.map((d) => h('option', { key: d.id, value: d.id }, d.label)))
            : null,
          h(
            'select',
            {
              style: S.sel,
              value: level,
              title: '按记忆类型筛选',
              disabled: loading,
              onChange: (e) => setLevel(e.target.value),
            },
            LEVELS.map(([key, label]) => h('option', { key, value: key }, label)),
          ),
          h(
            'select',
            {
              style: S.sel,
              value: days,
              title: '按写入时间筛选',
              disabled: loading,
              onChange: (e) => setDays(e.target.value),
            },
            ...[['0', '全部时间'], ['7', '近 7 天'], ['30', '近 30 天']].map(([key, label]) => h('option', { key, value: key }, label)),
          ),
          h('button', {
            type: 'button',
            style: S.btn,
            title: '重新读取',
            onClick: () => load(filter, dbId, level),
          }, '↻'),
          ...FILTERS.map(([key, label]) =>
            h('button', {
              key,
              type: 'button',
              style: filter === key ? S.btnOn : S.btn,
              onClick: () => setFilter(key),
            }, label),
          ),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: S.stat }, `有用 ${stats.useful}`),
          h('span', { style: S.stat }, `无用 ${stats.useless}`),
          h('span', { style: S.stat }, `未标 ${stats.unmarked}`),
          stats.noted > 0 ? h('span', { style: S.stat }, `评语 ${stats.noted}`) : null,
          data && data.dbPath
            ? h('span', { style: { ...S.stat, fontSize: '10.5px' }, title: data.dbPath },
                data.dbPath.split(/[\\/]/).slice(-2).join('/'))
            : null,
        ),
        err ? h('div', { style: S.err }, err) : null,
        loading
          ? h('div', { style: S.empty }, '读取中…')
          : !data
            ? h('div', { style: S.empty }, '没有数据')
            : visibleGroups.length === 0
              ? h('div', { style: S.empty }, days !== '0' ? '这个时间窗里没有条目，换成「全部时间」看看' : (filter === 'unmarked' ? '这一层已经全部标过了' : '没有匹配的条目'))
              : visibleGroups.map((g) =>
                  h(
                    'div',
                    { key: g.level, style: S.group },
                    h(
                      'div',
                      { style: S.groupHead },
                      h('span', { style: S.groupName }, g.label),
                      h('span', { style: S.groupCount }, `${g.count} 条`),
                    ),
                    g.items.length === 0
                      ? h('div', { style: { ...S.empty, padding: '12px' } }, '（已全部标过）')
                      : g.items.map((it) =>
                          h(Row, {
                            key: it.id,
                            it,
                            busy: busy === it.id,
                            onMark: mark,
                          }),
                        ),
                  ),
                ),
      );
    }

    function apply(ctx) {
      const icon = (size) =>
        h('svg', {
          width: size || 14,
          height: size || 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
          h('path', { d: 'M2 4.2h12M2 8h8M2 11.8h5' }),
          h('path', { d: 'M11.6 9.4l1.4 1.4 2.2-2.6' }));

      // betterSidebar 是独立服务，可能晚于本模块就绪，用 inject 等它
      ctx.inject(['betterSidebar'], (c) => {
        try {
          c.betterSidebar.registerTab({
            id: 'meow-mind-review',
            title: '记忆审议',
            description: '逐条标记记忆有用 / 无用，可附评语',
            icon,
            order: 260,
            single: true,
            component: () => h(ReviewTab),
          });
        } catch (e) {
          ctx.logger?.warn?.('meow-mind: 注册记忆审议标签失败: ' + (e instanceof Error ? e.message : String(e)));
        }
      });
    }

    exports.apply = apply;
    exports.inject = ['slots', 'sessions', 'locale'];
    return module.exports;
  },
});
