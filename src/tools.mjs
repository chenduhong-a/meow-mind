// 21 个 memory_* 工具。全部走 ctx.tools.register，output 必须是真 JSON Schema。
import { KINDS, LEVELS, LINKABLE_KINDS, STATUSES, preflight, tableOf } from './db.mjs';
import { recordToolIssue, listToolIssues, markToolIssue, toolIssueStats, insertMemory, getMemory, getMemoryAnyLevel, updateMemory, listMemories, stats, recordEvent, addEvidence, evidenceCount, countVectors, touchAccess, saveVector, allVectors, addRelation, removeRelation, linkRelated, getRelations, countRelations, rebuildRelations, findDuplicates, mergeMemory, splitLongMemory, findSinkCandidates } from './store.mjs';
import { findPluginGaps } from './plugins.mjs';
import { addNoteEvidence, listEvidence, slimMemory, fmtStamp } from './store.mjs';
import { findConflicts, pendingMemories, getProfile, TOPICS, upsertSection, deleteSection, refreshNarrative, setCursor } from './profile.mjs';
import { fusedSearch, summarize } from './bm25.mjs';
import { findPersona, listPersonas, createEpisode, closeEpisode, createPhase, completePhase, createDecision, createPersona, inheritPersona, addTrait } from './timeline.mjs';
import { l0, l1 } from './summary.mjs';
import { buildFirstTurnBlock, estimateTokens, semanticScores } from './inject.mjs';
import { tokenize } from './vocab.mjs';
import { decorate, sessionIdFrom } from './code.mjs';
import { sessionCode } from './code.mjs';
import { addLog, listLog, removeLog, logStats, renderLog } from './changelog.mjs';
import { postLetter, listLetters, readLetter, archiveLetter, mailboxStats, renderLetters } from './mailbox.mjs';
import { putDoc, getDoc, listDocs, delDoc, renderDocs } from './docs.mjs';

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] };

// 写侧只认九层（时间线有自己的写入工具）；读侧要认全部 kind，否则时间线「搜得到、读不回」。
const S_LEVEL = { type: 'string', enum: LEVELS };
const S_KIND = { type: 'string', enum: KINDS };
const S_STATUS = { type: 'string', enum: STATUSES };

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function registerTools(ctx, deps) {
  const { dbFor, readCfg, embed } = deps;
  const disposers = [];

  // ── 两库路由：全局库关闭（cfg.globalDir 为空）或打不开时一律退回工作区库，行为与单库版一致 ──
  // project 归一：「全球」「global」一律当「全局」，避免错标后躺在工作区库（2026-11-21 邮箱来信指出）
const normProject = (v) => {
  const s = String(v ?? '').trim();
  return /^(全局|全球|global)$/i.test(s) ? '全局' : s;
};
const gdb = () => (typeof deps.globalFor === 'function' ? deps.globalFor() : null);
  // 工作区信箱要落盘到 <cwd>/.dsh-mind/mailbox，cwd 由宿主注入（2026-11-23）
  const cwdOf = () => (typeof deps.cwd === 'function' ? String(deps.cwd() ?? '') : '');
  /** 按 id 定位：先全局后工作区。返回 { db, found, scope } 或 null。 */
  const locate = (id) => {
    const g = gdb();
    const pool = g === null ? [dbFor()] : [g, dbFor()];
    for (const src of pool) {
      const found = getMemoryAnyLevel(src, id);
      if (found && found.memory !== null) return { db: src, found, scope: src === g ? 'global' : 'local' };
    }
    return null;
  };

  const add = (def) => {
    def.output ??= OUTPUT;
    // 包一层：工具执行抛错时先记一条问题，再原样抛出（绝不吞错，否则用户以为成功了）。
    // 记录本身失败也静默——不能让它把原本的错误替换掉。
    if (typeof def.execute === 'function') {
      const orig = def.execute;
      def.execute = async (args, exec) => {
        try {
          return await orig(args, exec);
        } catch (e) {
          try {
            const sid = sessionIdFrom(exec);
            recordToolIssue(dbFor(), {
              tool: def.name,
              error: e,
              paramNames: Object.keys(args ?? {}),
              sessionCode: sessionCode(sid) ?? '',
              sourceSession: sid
            });
          } catch {
            /* 记录失败不影响原错误 */
          }
          throw e;
        }
      };
    }
    def.timeoutMs ??= 15000;
    def.isConcurrencySafe ??= () => true;
    def.presentCall ??= (args) => ({ card: 'generic', title: def.name, kind: 'read', rawInput: args });
    // 注册前验 render 形状：内核要求返回内容块数组，返回字符串会让整次调用抛 content.some（2026-11-21 踩过）
    try {
      const probe = typeof def.output?.render === 'function' ? def.output.render({}, { ok: true }) : null;
      if (!Array.isArray(probe)) throw new Error('render 未返回内容块数组');
    } catch (e) {
      ctx.logger?.warn?.(`meow-mind: ${def.name} 的 output.render 不合规（${e instanceof Error ? e.message : String(e)}），已回退默认 render`);
      def.output = { ...(def.output ?? {}), render: OUTPUT.render };
    }
    try {
      const d = ctx.tools.register(def);
      if (typeof d === 'function') disposers.push(d);
    } catch (e) {
      ctx.logger?.warn?.(`meow-mind: 注册 ${def.name} 失败（工具不可用，其余照常）: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  add({
    name: 'memory_remember',
    description: '写入一条长期记忆。project 与 keywords 必填，关键词建议 8-13 个（太少会搜不到，代码不校验个数）。用户当面说「记住 X」时用；其余情况优先 memory_observe 观察、再经候选晋升。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '结论与判据（默认 ≤200 字，rules 与 lesson ≤250，别写成报告）；过程、实测、引用放 evidence' },
        project: { type: 'string', description: '归属：全局或项目名；多项目用英文逗号分隔' },
        keywords: { type: 'array', items: { type: 'string' }, description: '8-13 个检索关键词' },
        level: { ...S_LEVEL, description: '默认 fact；用户基本信息用 user，准则用 rules；soul 是全局人格底色（跨工作区），本会话人格由 persona 提供，别往 soul 里写本会话的事' },
        subcategory: { type: 'string', enum: ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'] },
        importance: { type: 'integer', description: '1-4' },
        goal: { type: 'string', description: 'topic 的目标句' },
        corrected: { type: 'boolean', description: 'lesson 是否为用户纠正' },
        source_kind: { type: 'string', description: '证据来源：user_statement/dialog/system 等，默认 user_statement' },
        title: { type: 'string', description: '可选标题；不给则取内容首句前 40 字' },
        evidence: { type: 'string', description: '证据与来龙去脉（原话、实测数字、报错、过程），存进证据表；正文只写结论与判据，控制在 160 字内' }
      },
      required: ['content', 'project', 'keywords']
    },
    async execute(args, exec) {
      // 写路由：project 为「全局」时进全局库，其余进工作区库
      const project = normProject(args.project);
      const toGlobal = project === '全局' && gdb() !== null;
      const db = toGlobal ? gdb() : dbFor();
      const level = LEVELS.includes(args.level) ? args.level : 'fact';
      // soul 只从全局库注入（inject.mjs:72 取 globalDb）：写进工作区库等于写完就丢，
      // 而工具会回执成功、检索也搜得到——静默丢人格设定，2026-11-23 审计 P0。
      if (level === 'soul' && !toGlobal) {
        return { ok: false, error: 'soul 只从全局库注入：project 要填「全局」，否则写进去永远不会出现在上下文里' };
      }
      // 会话识别码：正文末尾自动带「（码：XX-XXXXXXXX-XXXX）」，已带则不重复
      const content = decorate(args.content, exec);
      const evId = recordEvent(db, {
        kind: 'observe',
        level,
        payload: { content, sourceKind: args.source_kind ?? 'user_statement' },
        idempotencyKey: `remember:${level}:${tokenize(content).slice(0, 20).join(' ')}`
      });
      const m = insertMemory(db, level, {
        title: args.title ?? l0(content, 40),
        project,
        content,
        importance: args.importance ?? 1,
        keywords: args.keywords,
        status: 'memory',
        subcategory: args.subcategory,
        goal: args.goal,
        corrected: args.corrected,
        source_session: sessionIdFrom(exec),
      });
      addEvidence(db, { memoryId: m.id, eventId: evId, stance: 'supported', sourceKind: args.source_kind ?? 'user_statement' });
      if (args.evidence) addNoteEvidence(db, m.id, args.evidence);
      // 写入时顺手算向量，检索才能走语义通道；失败不影响记忆本身
      try {
        const v = await embed(content);
        if (v) saveVector(db, m.id, v, level);
      } catch {
        /* 语义通道不可用时静默跳过 */
      }
      // 顺手建同主题边：同 project + keywords 交集 ≥ 3
      let linked = 0;
      try {
        linked = linkRelated(db, m, level);
      } catch {
        /* 关系网失败不影响记忆本身 */
      }
      return { ok: true, id: m.id, level, status: m.status, linked, scope: toGlobal ? 'global' : 'local' };
    }
  });

  add({
    name: 'memory_observe',
    description: '记录一条原始观察（用户原话、外部内容、工具结果摘要），不直接成为长期记忆。写入幂等，可重复调用。注意：observation 态不进检索、不进注入，只能按 id 用 memory_read 读回；要能被搜到请改用 memory_remember。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        source_kind: { type: 'string', description: 'user_statement/dialog/video_observation/agent_inference/system/feedback' },
        idempotency_key: { type: 'string' },
        subject: { type: 'string', description: '这条观察关于谁/什么' }
      },
      required: ['content', 'source_kind']
    },
    async execute(args, exec) {
      const db = dbFor();
      const id = recordEvent(db, {
        kind: 'observe',
        payload: { content: decorate(args.content, exec), sourceKind: args.source_kind, subject: args.subject ?? null },
        idempotencyKey: args.idempotency_key ?? null
      });
      return { ok: id !== null, event_id: id, deduped: id === null };
    }
  });

  add({
    name: 'memory_search',
    description: '混合检索记忆（BM25 + 四因子）。默认返回 L1 摘要，需要全文用 memory_read。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        level: { type: 'string', description: '限定层，逗号分隔' },
        k: { type: 'integer', description: '默认 10' },
        explain: { type: 'boolean' },
        content_max: { type: 'integer', description: '每条截断字数，0=全文' },
        event: { type: 'string', description: '只看某个事件（episode id）下的阶段与决定' },
        tags: { type: 'string', description: '场景标签，逗号分隔；只匹配阶段的 env（如「租房,预算紧」）' }
      },
      required: ['query']
    },
    async execute(args, exec) {
      const db = dbFor();
      const cfg = readCfg();
      const levels = args.level ? String(args.level).split(',').map((s) => s.trim()) : null;
      const k = Math.min(Math.max(args.k ?? 10, 1), 50);
      let semantic = null;
      try {
        semantic = await semanticScores(db, args.query, cfg, deps.getEmbedder?.() ?? null, gdb());
      } catch {
        semantic = null;
      }
      // 时间线三张表按 persona 隔离；显式给 event 时不受限（要看这件事的全部记录）。
      let personaId = '';
      try {
        personaId = findPersona(db, sessionIdFrom(exec))?.id ?? '';
      } catch {
        /* 表缺失或 exec 不可用时退化为不隔离 */
      }
      const tags = args.tags
        ? (Array.isArray(args.tags) ? args.tags : String(args.tags).split(',')).map((x) => String(x).trim()).filter(Boolean)
        : null;
      const hits = fusedSearch(db, args.query, cfg, {
        limit: k, levels, includeExplain: !!args.explain, semantic, globalDb: gdb(),
        personaId, tags, eventId: args.event ? String(args.event) : ''
      });
      const max = args.content_max === 0 ? 100000 : args.content_max ?? 200;
      const g = gdb();
      for (const h of hits) touchAccess(h.scope === 'global' && g !== null ? g : db, h.level, h.id);
      return {
        query: args.query,
        k: hits.length,
        hits: hits.map((h) => ({
          id: h.id,
          level: h.level,
          ...(h.scope ? { scope: h.scope } : {}),
          title: h.title,
          at: fmtStamp(h.updated_at),
          text: h.content.length > max ? h.content.slice(0, max) + '…' : h.content,
          keywords: h.keywords,
          score: +h.score.toFixed(4),
          ...(h.explain ? { explain: h.explain } : {})
        }))
      };
    }
  });

  add({
    name: 'memory_read',
    description: '按 id 读记忆。detail: l0=一句话 / l1=首句加要点 / l2=全文（默认）；include_evidence=true 时带证据链与版本。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, level: S_KIND, detail: { type: 'string', enum: ['l0', 'l1', 'l2'] }, include_evidence: { type: 'boolean' } },
      required: ['id']
    },
    async execute(args) {
      const loc = locate(args.id);
      const db = loc ? loc.db : dbFor();
      const found = loc
        ? { level: loc.found.level, memory: loc.found.memory }
        : args.level ? { level: args.level, memory: getMemory(db, args.level, args.id) } : getMemoryAnyLevel(db, args.id);
      if (!found || found.memory === null) return { ok: false, error: '未找到该 id' };
      touchAccess(db, found.level, args.id);
      const detail = args.detail ?? 'l2';
      const memory = detail === 'l0'
        ? { ...found.memory, content: l0(found.memory.content, 60) }
        : detail === 'l1'
          ? { ...found.memory, content: l1(found.memory.content, 200) }
          : found.memory;
      const out = {
        ok: true, level: found.level, detail, scope: loc ? loc.scope : 'local',
        // 时间单独给一份可读格式：库里混着 ISO 与毫秒数字，直接看字段值不好认
        created: fmtStamp(found.memory.created_at),
        updated: fmtStamp(found.memory.updated_at),
        lastAccessed: fmtStamp(found.memory.last_accessed_at),
        memory
      };
      if (args.include_evidence) {
        out.evidence = listEvidence(db, args.id, 20)
          .map((e) => ({ ...e, at: fmtStamp(e.created_at) }));
        out.versions = db.prepare('SELECT version, status, created_at FROM memory_versions WHERE memory_id = ? ORDER BY version').all(args.id);
        out.relations = getRelations(db, args.id);
      }
      return out;
    }
  });

  add({
    name: 'memory_update',
    description: '更新记忆字段或状态，自动存版本快照。level 只用于定位（查哪张表），不是迁移——要换层请新建一条并把旧条置 review。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        level: S_KIND,
        title: { type: 'string' },
        content: { type: 'string' },
        importance: { type: 'integer' },
        status: S_STATUS,
        keywords: { type: 'array', items: { type: 'string' } },
        subcategory: { type: 'string' },
        goal: { type: 'string' },
        corrected: { type: 'boolean' },
        project: { type: 'string', description: '归属：全局 / 项目名；写「全局」即归全局记忆（跨工作区共享）' },
        evidence: { type: 'string', description: '本条的证据与过程；提供时只进证据表，不进正文' }
      },
      required: ['id']
    },
    async execute(args, exec) {
      const loc = locate(args.id);
      const db = loc ? loc.db : dbFor();
      const found = loc
        ? { level: loc.found.level, memory: loc.found.memory }
        : args.level ? { level: args.level, memory: getMemory(db, args.level, args.id) } : getMemoryAnyLevel(db, args.id);
      if (!found || found.memory === null) return { ok: false, error: '未找到该 id' };
      // project 归一：允许把「全球/global」这类错标就地改成「全局」（此前该列在工具层不可写）
      if (args.project !== undefined) args = { ...args, project: normProject(args.project) };
      // 改正文时同样补会话识别码；只改状态/标题时不动 content
      const patch = args.content === undefined ? args : { ...args, content: decorate(args.content, exec) };
        // 瘦身/改写时把旧正文挪进证据表，正文只留结论——原文不丢，可 memory_read 回溯
        if (args.content !== undefined && args.evidence === undefined) {
          const prev = String(found.memory.content ?? '');
          const next = String(patch.content ?? '');
          if (prev.trim().length > 0 && prev !== next) addNoteEvidence(db, args.id, prev);
        }
        if (args.evidence) addNoteEvidence(db, args.id, args.evidence);
      const updated = updateMemory(db, found.level, args.id, patch);
      recordEvent(db, { kind: 'update', level: found.level, payload: { id: args.id, fields: Object.keys(args).filter((k) => k !== 'id' && k !== 'level') } });
      return { ok: true, id: updated.id, level: found.level, status: updated.status };
    }
  });

  add({
    name: 'memory_context',
    description: '按 token 预算拼装一段可注入的上下文块（首轮块形态）。',
    parameters: {
      type: 'object',
      properties: { token_budget: { type: 'integer' }, level: { type: 'string' } },
      required: []
    },
    async execute(args, exec) {
      const db = dbFor();
      const cfg = readCfg();
      const custom = { ...cfg, injection: { ...cfg.injection, firstTurnBudget: args.token_budget ?? cfg.injection.firstTurnBudget } };
      // 不传 selfSession 时人格段与当前处境都是空的，与真实首轮块不一致
      const block = buildFirstTurnBlock(db, custom, gdb(), '', sessionIdFrom(exec));
      // dropped：预算低时被整段挤掉的段名（人格 / 画像 / 当前处境 / 样板 / 信箱）——
      // 不带上这个，调用方会把「看不见」当成「没写进去」（2026-11-23 实际发生过）
      return { ok: block !== null, tokens: block?.tokens ?? 0, text: block?.text ?? '', dropped: block?.dropped ?? [] };
    }
  });

  add({
    name: 'memory_project',
    description: '取某个项目的全景：按 project 归属跨九层聚合，给出各层条数与字数，内容取 L1 摘要；project 层额外按子类分组。（时间线四表没有 project 列，不参与聚合。）',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        limit: { type: 'integer', description: '每层最多返回几条（默认 20，上限 200）' }
      },
      required: ['project']
    },
    async execute(args) {
      const name = String(args.project ?? '').trim();
      if (!name) return { project: '', count: 0, chars: 0, groups: {}, error: 'project 不能为空' };
      const g0 = gdb();
      const dbs = g0 === null ? [dbFor()] : [g0, dbFor()];
      const per = Math.max(1, Math.min(200, Number(args.limit) || 20));
      const groups = {};
      let total = 0;
      let totalChars = 0;
      let truncated = false;
      for (const src of dbs) {
      for (const lv of LEVELS) {
        const rows = src
          .prepare(`SELECT * FROM ${lv} WHERE status = 'memory'`)
          .all()
          .filter((r) => {
            const p = String(r.project ?? '').trim();
            if (p) return p === name || p.split(/[,，]/).map((s) => s.trim()).includes(name);
            // 兼容旧数据：没有 project 列的条目靠标题 / 关键词兜底
            const kw = String(r.keywords ?? '');
            return r.title === name || kw.includes(name);
          });
        if (!rows.length) continue;
        const chars = rows.reduce((s, r) => s + String(r.content ?? '').length, 0);
        total += rows.length;
        totalChars += chars;
        if (rows.length > per) truncated = true;
        const items = rows
          .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
          .slice(0, per)
          .map((r) => ({
            id: r.id,
            title: r.title,
            importance: r.importance ?? null,
            subcategory: r.subcategory ?? null,
            chars: String(r.content ?? '').length,
            l1: l1(r.content, 160)
          }));
        const g = { count: rows.length, chars, items };
        if (lv === 'project') {
          const sub = {};
          for (const r of rows) (sub[r.subcategory ?? '未分类'] ??= []).push(r.id);
          g.bySubcategory = sub;
        }
        const tag = src === g0 ? 'global' : 'local';
        if (!groups[lv]) groups[lv] = { count: 0, chars: 0, items: [] };
        groups[lv].count += g.count;
        groups[lv].chars += g.chars;
        groups[lv].items.push(...g.items.map((x) => ({ ...x, scope: tag })));
        if (g.bySubcategory) {
          groups[lv].bySubcategory ??= {};
          for (const [k, v] of Object.entries(g.bySubcategory)) (groups[lv].bySubcategory[k] ??= []).push(...v);
        }
      }
      }
      return { project: name, count: total, chars: totalChars, truncated, groups };
    }
  });

  add({
    name: 'memory_home',
    description: '查看记忆库位置与目录：工作区库与全局库各一条路径，附各层条数（迁移或排查时用）。',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const local = stats(dbFor());
      const g = gdb();
      if (g === null) return { ok: true, scope: 'workspace', ...local };
      const global = stats(g);
      return { ok: true, scope: 'both', workspace: local, global };
    }
  });

  add({
    name: 'memory_dream',
    description: '整理窗口：把过期候选降为 review、合并内容重复、拆分超长条目、输出冲突与休眠清单。',
    parameters: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean' },
        rebuild_relations: { type: 'boolean', description: '全库重算同主题关系（O(n²)，900 条约 2-5 秒）' },
        merge: { type: 'boolean', description: '合并内容重复的条目（默认开，单次最多 5 对）' },
        split: { type: 'boolean', description: '拆分超长条目（默认开，单次最多 3 条）' },
        maxChars: { type: 'integer', description: '超过该字数就拆，默认 800' },
        slim: { type: 'boolean', description: '把超过 slimMax 的活跃记忆瘦身为「结论+判据」，原文挪进证据表（默认开）' },
        slimMax: { type: 'integer', description: '瘦身阈值（默认 200 字）' }
      },
      required: []
    },
    async execute(args) {
      const db = dbFor();
      const cfg = readCfg();
      const now = Date.now();
      const maxChars = args.maxChars ?? 800;
      // 原来只扫 fact 一层，其余八层的 candidate 永不过期；改成九层全扫（2026-11-23 验收发现）
      const cands = LEVELS.flatMap((lv) =>
        db.prepare(`SELECT id, created_at FROM ${lv} WHERE status = 'candidate'`).all().map((r) => ({ ...r, level: lv })),
      );
      const old = cands.filter((c) => (now - Date.parse(c.created_at)) / 86400000 > cfg.governance.candidateTtlDays);
      const conflicts = db.prepare("SELECT from_id, to_id FROM memory_relations WHERE relation = 'contradicts'").all();
      const dormant = LEVELS.flatMap((lv) =>
        db
          .prepare(`SELECT id, importance, last_accessed_at FROM ${lv} WHERE status = 'memory' AND importance <= 1`)
          .all()
          .filter((r) => r.last_accessed_at === null || (now - Date.parse(r.last_accessed_at)) / 86400000 > cfg.governance.staleDays)
          .map((r) => ({ id: r.id, level: lv }))
      );
      // 自洁两项：内容重复对（只在 same_topic 边上算）、超长条目
      const dupPairs = findDuplicates(db, cfg.governance.dupThreshold).slice(0, 5);
      const long = LEVELS.flatMap((lv) =>
        db
          .prepare(`SELECT id, length(content) AS n FROM ${lv} WHERE status = 'memory' AND length(content) > ?`)
          .all(maxChars)
          .map((r) => ({ id: r.id, level: lv, chars: r.n }))
      )
        .sort((a, b) => b.chars - a.chars)
        .slice(0, 3);
      // 沉淀候选：最近新写的 lesson/rules 里像「方法/坑」但没标过去向的（只列，不改任何技能文件）
      const sink = findSinkCandidates(db, 5, 1);
  const gap = findPluginGaps(db, 5, 7);
      // 画像侧：分节冲突 + 还没归纳进画像的 user 记忆。只报不改（改画像等于改「他是谁」）。
      let profileConf = { total: 0, conflicts: [] };
      let profilePend = { items: [], cursor: null };
      let profileNow = null;
      try {
        const pdb = deps.globalFor?.() ?? db;
        profileConf = findConflicts(pdb);
        profilePend = pendingMemories(pdb);
        profileNow = getProfile(pdb);
      } catch {
        /* 画像表不存在时跳过 */
      }
      if (!args.dry_run) {
        let rebuilt = 0;
        // 过期候选降为 review（原来是列了 id 却什么都不做，与 description「清理过期候选」不符）。
        // 不硬删：候选可能只是还没用上，退 review 后仍可按 id 读回。
        let candidatesArchived = 0;
        for (const c of old) {
          try {
            if (updateMemory(db, c.level, c.id, { status: 'review' }) !== null) candidatesArchived += 1;
          } catch { /* 单条失败不影响其余 */ }
        }
        const slimmed = [];
      if (args.slim !== false) {
        const max = Number(args.slimMax) > 0 ? Number(args.slimMax) : 200;
        try {
          for (const lv of LEVELS) {
            const rows = db.prepare(`SELECT id FROM ${lv} WHERE status = 'memory' AND length(content) > ? LIMIT 80`).all(max);
            for (const r of rows) {
              const res = slimMemory(db, lv, r.id, { maxChars: max });
              if (res.ok && !res.skipped) slimmed.push({ level: lv, id: r.id, before: res.before, after: res.after });
            }
          }
          if (slimmed.length > 0) db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
        } catch { /* 瘦身失败不影响其余步骤 */ }
      }
      const merged = [];
        const split = [];
        if (args.rebuild_relations) {
          try {
            rebuilt = rebuildRelations(db);
          } catch {
            /* 关系网重建失败不影响整理本身 */
          }
        }
        if (args.merge !== false) {
          for (const p of dupPairs) {
            try {
              const r = mergeMemory(db, p);
              if (r) merged.push(r);
            } catch {
              /* 单对合并失败不影响其余 */
            }
          }
        }
        if (args.split !== false) {
          for (const it of long) {
            try {
              const r = splitLongMemory(db, it.id, maxChars);
              if (r) {
                split.push(r);
                // 拆出来的新条要补向量，否则它只有词法通道、语义检索搜不到
                // （2026-11-21 实测：9 条「（续）」全缺向量）
                if (embed) {
                  try {
                    const v = await embed(String(r.tail).slice(0, 2000));
                    if (v) saveVector(db, r.newId, v, it.level ?? '');
                  } catch {
                    /* 补向量失败不影响拆分本身 */
                  }
                }
              }
            } catch {
              /* 单条拆分失败不影响其余 */
            }
          }
        }
        // 全局库同步骤整理：只做瘦身 + 去重合并（冲突/休眠清单仍按工作区库报，避免两套账本）
        const gg = gdb();
        let globalTouched = false;
        let globalSlimmed = 0;
        if (gg !== null) {
          try {
            const maxG = Number(args.slimMax) > 0 ? Number(args.slimMax) : 200;
            if (args.slim !== false) {
              for (const lv of LEVELS) {
                const rows = gg.prepare(`SELECT id FROM ${lv} WHERE status = 'memory' AND length(content) > ? LIMIT 80`).all(maxG);
                for (const r of rows) {
                  const res = slimMemory(gg, lv, r.id, { maxChars: maxG });
                  if (res && res.ok && !res.skipped) globalSlimmed += 1;
                }
              }
            }
            if (args.merge !== false) for (const p of findDuplicates(gg, cfg.governance.dupThreshold).slice(0, 5)) mergeMemory(gg, p);
            gg.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
            globalTouched = true;
          } catch {
            /* 全局库整理失败不影响工作区结果 */
          }
        }
        recordEvent(db, { kind: 'review', payload: { candidates: old.length, conflicts: conflicts.length, dormant: dormant.length, rebuilt, merged: merged.length, split: split.length, globalTouched } });
        return { dry_run: false, scope: globalTouched ? 'both' : 'workspace', candidatesExpired: old.map((c) => c.id), conflicts, dormant, rebuilt, merged, split, slimmed: slimmed.length + globalSlimmed, candidatesArchived, sinkCandidates: sink, pluginGaps: gap, profileConflicts: profileConf, profilePending: profilePend.items.length, profileVersion: profileNow?.version ?? 0 };
      }
      return { dry_run: true, candidatesExpired: old.map((c) => c.id), conflicts, dormant, duplicatePairs: dupPairs, long, sinkCandidates: sink, pluginGaps: gap, profileConflicts: profileConf, profilePending: profilePend.items.length, profileVersion: profileNow?.version ?? 0 };
    }
  });

  add({
    name: 'memory_find_similar',
    description: '找内容相似的记忆（embedding 可用时用余弦，否则用词面重叠），用于查重与找冲突。',
    parameters: { type: 'object', properties: { id: { type: 'string' }, k: { type: 'integer' }, content_max: { type: 'integer' } }, required: ['id'] },
    async execute(args) {
      const db = dbFor();
      const gs = gdb();
      const loc = locate(args.id);
      const found = loc ? loc.found : getMemoryAnyLevel(db, args.id);
      if (!found || found.memory === null) return { ok: false, error: '未找到该 id' };
      const k = Math.min(Math.max(args.k ?? 5, 1), 20);
      const base = found.memory.content;
      // 时间线三类也参与比较（它们有 content）；personas 无 content 列，不在 LINKABLE_KINDS 里
      const all = LINKABLE_KINDS.flatMap((lv) => db.prepare(`SELECT id, content FROM ${tableOf(lv)} WHERE id != ?`).all(args.id).map((r) => ({ ...r, level: lv, scope: 'local' })));
      if (gs !== null) {
        for (const lv of LINKABLE_KINDS) {
          try {
            for (const r of gs.prepare(`SELECT id, content FROM ${tableOf(lv)} WHERE id != ?`).all(args.id)) all.push({ ...r, level: lv, scope: 'global' });
          } catch {
            /* 全局库缺该层就跳过 */
          }
        }
      }
      // 读已存向量（一次全库 BLOB 扫描）。绝不逐条现场 embed——707 条串行会 70-135 秒，远超工具超时。
      const stored = new Map();
      try {
        for (const rec of allVectors(db)) stored.set(rec.id, rec.vec);
      } catch { /* 老库可能没有 memory_vectors */ }
      if (gs !== null) {
        try {
          for (const rec of allVectors(gs)) if (!stored.has(rec.id)) stored.set(rec.id, rec.vec);
        } catch {
          /* 全局库向量读失败只影响全局候选的余弦 */
        }
      }
      let v0 = stored.get(args.id) ?? null;
      if (!v0 && embed) {
        try { v0 = await embed(base); } catch { v0 = null; }
      }
      const baseTokens = v0 ? null : new Set(tokenize(base));
      const scored = [];
      let missing = 0;
      for (const row of all) {
        let s = 0;
        if (v0) {
          const v = stored.get(row.id);
          if (v) s = cosine(v0, v);
          else missing += 1;
        } else {
          const b = new Set(tokenize(row.content));
          let inter = 0;
          for (const t of baseTokens) if (b.has(t)) inter += 1;
          s = baseTokens.size === 0 || b.size === 0 ? 0 : inter / Math.sqrt(baseTokens.size * b.size);
        }
        if (s > 0.2) scored.push({ id: row.id, level: row.level, ...(row.scope === 'global' ? { scope: 'global' } : {}), score: +s.toFixed(3), text: summarize(row.content, args.content_max ?? 80) });
      }
      scored.sort((a, b) => b.score - a.score);
      return { ok: true, base: args.id, scanned: all.length, vectors: stored.size, missingVectors: missing, similar: scored.slice(0, k) };
    }
  });

  add({
    name: 'memory_forget',
    description: '软删（标记墓碑，不参与注入与检索）；hard=true 才真删。',
    parameters: { type: 'object', properties: { id: { type: 'string' }, hard: { type: 'boolean' } }, required: ['id'] },
    async execute(args) {
      const loc = locate(args.id);
      const db = loc ? loc.db : dbFor();
      const found = loc ? { level: loc.found.level, memory: loc.found.memory } : getMemoryAnyLevel(db, args.id);
      if (!found || found.memory === null) return { ok: false, error: '未找到该 id' };
      recordEvent(db, { kind: 'forget', level: found.level, payload: { id: args.id, hard: !!args.hard } });
      if (args.hard) {
        db.prepare(`DELETE FROM ${tableOf(found.level)} WHERE id = ?`).run(args.id);
        db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(args.id);
      } else {
        db.prepare(`UPDATE ${tableOf(found.level)} SET status = 'review', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), args.id);
        db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(args.id);
      }
      return { ok: true, id: args.id, hard: !!args.hard };
    }
  });

  add({
    name: 'memory_link',
    description: '建立或删除两条记忆之间的关系：same_topic（同主题）、supersedes（前者取代后者）、contradicts（互相冲突）。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '主体记忆 id' },
        to: { type: 'string', description: '客体记忆 id' },
        relation: { type: 'string', enum: ['same_topic', 'supersedes', 'contradicts'] },
        remove: { type: 'boolean', description: 'true 则删除这条关系' }
      },
      required: ['from', 'to', 'relation']
    },
    async execute(args) {
      const locA = locate(args.from);
      const locB = locate(args.to);
      if (!locA || !locB) return { ok: false, error: 'from 或 to 指定记忆不存在' };
      // 关系网不跨库：跨库建边会让 read 的 relations 与 dream 重建对不上账
      if (locA.db !== locB.db) return { ok: false, error: '两条记忆不在同一个库（一条在全局库、一条在工作区库），关系不能跨库建立' };
      const db = locA.db;
      const a = locA.found;
      const b = locB.found;
      if (args.from === args.to) return { ok: false, error: '不能连自己' };
      const done = args.remove
        ? removeRelation(db, args.from, args.to, args.relation)
        : addRelation(db, args.from, args.to, args.relation);
      if (!args.remove && done) {
        recordEvent(db, { kind: 'link', payload: { from: args.from, to: args.to, relation: args.relation } });
      }
      return { ok: done, from: args.from, to: args.to, relation: args.relation, removed: !!args.remove };
    }
  });

  add({
    name: 'memory_feedback',
    description: '给一条记忆打效果标记。wrong=内容不对，降为 review 待核对；useful=确实有用，只记一笔不改状态（有用是效用不是真值，不能拿它提升记忆）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id' },
        kind: { type: 'string', enum: ['wrong', 'useful'], description: 'wrong 或 useful' },
        note: { type: 'string', description: '可选备注' }
      },
      required: ['id', 'kind']
    },
    async execute(args) {
      const loc = locate(args.id);
      const db = loc ? loc.db : dbFor();
      const found = loc ? { level: loc.found.level, memory: loc.found.memory } : getMemoryAnyLevel(db, args.id);
      if (!found) return { ok: false, error: '记忆不存在' };
      const mem = found.memory;
      const wrong = args.kind === 'wrong';
      let status = mem.status;
      if (wrong && mem.status !== 'review') {
        updateMemory(db, found.level, mem.id, { status: 'review' });
        status = 'review';
      }
      recordEvent(db, {
        kind: 'feedback',
        level: found.level,
        payload: { memoryId: mem.id, kind: args.kind, note: args.note ?? null, statusChanged: wrong ? 'review' : null }
      });
      return { ok: true, id: mem.id, level: found.level, kind: args.kind, status };
    }
  });

  add({
    name: 'memory_health',
    description: '记忆库健康：条数、字数、事件数、向量数、embedding 是否可用、注入预算估算。',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(args, exec) {
      const local = dbFor();
      const cfg = readCfg();
      const g = gdb();
      const s = stats(local);
      const block = buildFirstTurnBlock(local, cfg, g, '', sessionIdFrom(exec));
      const pf = preflight(local);
      const base = {
        ok: true, ...s,
        relations: countRelations(local),
        vectors: countVectors(local),
        integrity: pf.ok,
        schemaVersion: pf.schemaVersion,
        embeddingAvailable: !!deps.embeddingReady?.(),
        firstTurnTokens: block?.tokens ?? 0
      };
      if (g === null) return { ...base, scope: 'workspace' };
      const gs = stats(g);
      return { ...base, scope: 'both', global: { ...gs, relations: countRelations(g) } };
    }
  });

  add({
      name: 'memory_profile',
      description:
        '读写跨会话的用户画像（分节式：身份 / 工作方式 / 交付偏好 / 取舍标准 / 沟通风格 / 查证偏好 / 长期目标）。' +
        'action=get 读全部分节与 narrative；action=upsert 写一节（topic+sub_topic+content，merge=append|replace|abort）；' +
        'action=delete 删一节；action=refresh 重算 narrative 并升版本；action=pending 列出还没归纳进画像的 user 记忆。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'upsert', 'delete', 'refresh', 'pending'], description: '默认 get' },
          topic: { type: 'string', description: '分节大类：identity / workflow / delivery / tradeoff / communication / info / goal（7 个，代码里 TOPICS 为准）' },
          sub_topic: { type: 'string', description: '分节小类，如 person / direction / body / minimal / upgrade' },
          content: { type: 'string', description: 'upsert 时要写入的结论句' },
          merge: { type: 'string', enum: ['append', 'replace', 'abort'], description: 'append 追加（默认）、replace 整条替换（旧名 update 仍兼容）、abort 丢弃不写' },
          limit: { type: 'number', description: 'pending / get 的返回条数上限，默认 20' },
          advance: { type: 'boolean', description: 'refresh 时把「已归纳」游标推到最新一条 user 记忆（确认这轮都归纳完了再传 true）' }
        },
        required: []
      },
      output: {
        schema: { type: 'object' },
        render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]
      },
      async execute(args = {}) {
        // 画像描述的是「这个人」，跨工作区都成立 → 优先落全局库；没有全局库时退回工作区库。
        const db = deps.globalFor?.() ?? dbFor();
        const action = String(args.action ?? 'get');
        if (action === 'pending') {
          const p = pendingMemories(db, Math.max(1, Math.min(200, Number(args.limit) || 20)));
          return { ok: true, action, pending: p.items.length, cursor: p.cursor, items: p.items.map((it) => ({ id: it.id, chars: String(it.content).length, content: it.content })) };
        }
        if (action === 'upsert') {
          const topic = String(args.topic ?? '').trim();
          const subTopic = String(args.sub_topic ?? '').trim();
          const content = String(args.content ?? '').trim();
          if (!topic || !subTopic || !content) return { ok: false, error: 'topic / sub_topic / content 三个都必填' };
          const r = upsertSection(db, { topic, subTopic, content, merge: args.merge ?? 'append' });
          refreshNarrative(db);
          return { ok: true, action, ...r, profile: getProfile(db) };
        }
        if (action === 'delete') {
          const topic = String(args.topic ?? '').trim();
          const subTopic = String(args.sub_topic ?? '').trim();
          if (!topic || !subTopic) return { ok: false, error: 'topic / sub_topic 都必填' };
          const removed = deleteSection(db, topic, subTopic);
          refreshNarrative(db);
          return { ok: true, action, removed };
        }
        if (action === 'refresh') {
          refreshNarrative(db);
          let advanced = 0;
          if (args.advance === true) {
            const p = pendingMemories(db, { limit: 500 });
            const last = p.items[p.items.length - 1];
            if (last?.updated_at) { setCursor(db, { lastMemoryAt: last.updated_at, lastMemoryId: last.id ?? "" }); advanced = p.items.length; }
          }
          const prof = getProfile(db);
          return { ok: true, action, version: prof.version, sections: prof.sections.length, narrative: prof.narrative.length, advanced };
        }
        const prof = getProfile(db);
        const conf = findConflicts(db);
        const pend = pendingMemories(db, 1);
        return { ok: true, action: 'get', topics: TOPICS, version: prof.version, sections: prof.sections, narrative: prof.narrative, conflicts: conf, pending: pend.items.length };
      }
  });

  add({
      name: 'memory_log',
      description:
        '版本变更流水账（谁在哪天从哪版升到哪版）。这类事件史不进记忆层：记忆只留「当前基线」与「选型判据」。' +
        'action=add 记一条（subject 必填，from/to 可空，day 默认今天）；action=list 按日期倒序查（since/until/subject/query/limit）；' +
        'action=remove 删一条；action=stats 看总条数与时间跨度。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'remove', 'stats'], description: '默认 list' },
          day: { type: 'string', description: 'add 用：YYYY-MM-DD，默认今天' },
          subject: { type: 'string', description: '升的是哪个包/哪个东西，如 cc-safety-net' },
          from: { type: 'string', description: '旧版本，可空' },
          to: { type: 'string', description: '新版本' },
          note: { type: 'string', description: '备注（如掉队数、来源、踩的坑）' },
          source: { type: 'string', description: '来源：npm / GitHub tgz / file: / 手工' },
          since: { type: 'string', description: 'list 用：起始日期 YYYY-MM-DD' },
          until: { type: 'string', description: 'list 用：截止日期' },
          query: { type: 'string', description: 'list 用：在对象、备注、版本号里模糊查' },
          limit: { type: 'number', description: 'list 返回条数上限，默认 30' },
          id: { type: 'string', description: 'remove 要删的记录 id' }
        },
        required: []
      },
      output: {
        schema: { type: 'object' },
        render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]
      },
      async execute(args = {}) {
        const db = dbFor();
        const action = String(args.action ?? 'list');
        if (action === 'add') {
          const r = addLog(db, { day: args.day, subject: args.subject, from: args.from, to: args.to, note: args.note, source: args.source });
          return { ...r, stats: logStats(db) };
        }
        if (action === 'remove') {
          if (!args.id) return { ok: false, error: 'remove 需要 id' };
          return { ...removeLog(db, args.id), stats: logStats(db) };
        }
        if (action === 'stats') return { ok: true, action, ...logStats(db) };
        const list = listLog(db, { since: args.since, until: args.until, subject: args.subject, query: args.query, limit: args.limit });
        return { ok: true, action: 'list', ...list, text: renderLog(list.items) };
      }
  });


  add({
      name: 'memory_mail',
      description:
        '跨会话信箱（共享库的 mailbox 目录，文件形式，人和模型都能读）。信箱装「这件事我要告诉另一个会话」，全局库装「这条知识对谁都成立」，两者不合并。' +
        'action=post 投一封（to 填会话码或「全体」，subject 一行标题，body 正文，status 缺省待办）；**投递前后都要先 list 一遍**——发之前看有没有人问过同一件事、有没有人回过你上一封，发之后看有没有新回信；只写不读＝自说自话；' +
        'action=list 列信（status/to/query/limit）；action=read 读一封全文（id）；' +
        'action=archive 归档一封（从 inbox 移进 archive/<月份>.md，状态改收档）；action=stats 看未办数。' +
        'scope=global（默认）写全局信箱、跨工作区共享；scope=local 写工作区信箱（<cwd>\\.dsh-mind\\mailbox），只属于当前工作区——判据「影响别的技能/插件/准则的事写全局，只影响这个工作区的事写本地」。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['post', 'list', 'read', 'archive', 'stats'], description: '默认 list' },
          to: { type: 'string', description: 'post 用：收件方（会话码或「全体」）' },
          subject: { type: 'string', description: 'post 用：一行标题；不给就取正文首行' },
          body: { type: 'string', description: 'post 用：正文' },
          status: { type: 'string', enum: ['待办', '已办', '阅知'], description: 'post 用：缺省待办' },
          id: { type: 'string', description: 'read/archive 用：信件编号（L 开头）' },
          time: { type: 'string', description: 'archive 兜底定位：信件时间，如 18:51（手工投的信编号可能不是真 id）' },
          query: { type: 'string', description: 'list 用：在标题、正文、发件码里模糊查' },
          limit: { type: 'number', description: 'list 返回条数上限，默认 20' },
          scope: { type: 'string', enum: ['global', 'local'], description: '默认 global；local 只写当前工作区的信箱' }
        },
        required: []
      },
      output: {
        schema: { type: 'object' },
        render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]
      },
      async execute(args = {}, exec) {
        const cfg = readCfg();
        const action = String(args.action ?? 'list');
        const code = sessionCode(sessionIdFrom(exec));
        if (action === 'post') {
          const opts = { scope: args.scope, cwd: cwdOf() };
          const r = postLetter(cfg, { code, to: args.to, subject: args.subject, body: args.body, status: args.status, ...opts });
          return { ...r, stats: mailboxStats(cfg, opts) };
        }
        if (action === 'read') {
          if (!args.id) return { ok: false, error: 'read 需要 id' };
          return readLetter(cfg, args.id, { scope: args.scope, cwd: cwdOf() });
        }
        if (action === 'archive') {
          if (!args.id && !args.time && !args.subject) {
            return { ok: false, error: 'archive 需要 id；手工投的信给 time + subject 定位' };
          }
          const opts = { scope: args.scope, cwd: cwdOf() };
          return { ...archiveLetter(cfg, { id: args.id, time: args.time, subject: args.subject }, new Date(), opts), stats: mailboxStats(cfg, opts) };
        }
        const opts = { scope: args.scope, cwd: cwdOf() };
        if (action === 'stats') return { ok: true, action, ...mailboxStats(cfg, opts) };
        const list = listLetters(cfg, { status: args.status, to: args.to, query: args.query, limit: args.limit, ...opts });
        return { ok: true, action: 'list', ...list, code, text: renderLetters(list.items ?? []) };
      }
  });


  add({
      name: 'memory_doc',
      description:
        '共享库样板（global_doc 表，存在全局库）。样板＝要整套读完才有用的长文（准则完整版、工具链手册），' +
        '与记忆相反：记忆取一句命中片段，样板整篇取回。判据「这条内容要整套读完才有用 → 样板；只取一句就够 → 记忆」。' +
        'action=list 列有哪些样板（名字、标题、字数、摘要）；action=get 取全文（name）；' +
        'action=put 写入或覆盖（name 小写字母数字连字符、title、summary、body）；action=del 删除。' +
        '全局库未启用（globalDir 为空）时工具报「全局库未启用」。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'put', 'del'], description: '默认 list' },
          name: { type: 'string', description: '样板名，如 guidelines / research-toolchain' },
          title: { type: 'string', description: 'put 用：一句标题' },
          summary: { type: 'string', description: 'put 用：一句话摘要（不给就取正文前 80 字）' },
          body: { type: 'string', description: 'put 用：样板全文（Markdown 也行）' }
        },
        required: []
      },
      output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] },
      async execute(args = {}) {
        const cfg = readCfg();
        const action = String(args.action ?? 'list');
        if (action === 'get') {
          if (!args.name) return { ok: false, error: 'get 需要 name' };
          return getDoc(cfg, args.name);
        }
        if (action === 'put') {
          if (!args.name || !args.body) return { ok: false, error: 'put 需要 name 与 body' };
          return putDoc(cfg, { name: args.name, title: args.title, summary: args.summary, body: args.body });
        }
        if (action === 'del') {
          if (!args.name) return { ok: false, error: 'del 需要 name' };
          return delDoc(cfg, args.name);
        }
        const list = listDocs(cfg);
        return { ok: true, action: 'list', ...list, text: renderDocs(list.items ?? []) };
      }
  });

  add({
    name: 'memory_episode',
    description: '时间线：建一个长期事件（episode）、开/补一个阶段、或关掉事件。事件是骨架（跨月存在），阶段按环境变化切（数周），每开新阶段会自动归档上一个未归档阶段。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['create', 'close', 'phase_start', 'phase_complete'], description: 'create 建事件／close 关事件／phase_start 开阶段／phase_complete 补全阶段' },
        episode_id: { type: 'string', description: 'close、phase_start 必填；create 时忽略' },
        id: { type: 'string', description: 'phase_complete 用的阶段 id' },
        title: { type: 'string', description: '事件或阶段的名字；不给则取 content 前 40 字' },
        content: { type: 'string', description: '事件目标，或阶段的判断与观察；不设字数上限，写全当时的处境' },
        goal: { type: 'string', description: '事件想达成什么（create 用）' },
        env: { type: 'string', description: '阶段的环境标签，逗号分隔，如「租房,预算紧,时间充裕」；同一事件内标签要复用，别每次换说法' },
        keywords: { type: 'array', items: { type: 'string' }, description: '检索关键词 3-8 个' }
      },
      required: ['op']
    },
    async execute(args = {}, exec) {
      const db = dbFor();
      const sid = sessionIdFrom(exec);
      if (args.op === 'create') {
        if (!args.content && !args.title) return { ok: false, error: 'create 需要 content 或 title' };
        const ep = createEpisode(db, { title: args.title, content: args.content ?? args.title ?? '', goal: args.goal, keywords: args.keywords, source_session: sid });
        return { ok: true, op: 'create', ...ep };
      }
      if (args.op === 'close') {
        if (!args.episode_id) return { ok: false, error: 'close 需要 episode_id' };
        const r = closeEpisode(db, args.episode_id);
        return r ? { ok: true, op: 'close', ...r } : { ok: false, error: '找不到这个事件' };
      }
      if (args.op === 'phase_start') {
        if (!args.episode_id) return { ok: false, error: 'phase_start 需要 episode_id' };
        // phases 没有外键：不查事件就会写出永远不出现在当前处境与检索里的孤儿阶段；
        // 已关闭的事件也不该再开阶段，否则这条阶段同样永远不显示（2026-11-23 审计 P1）。
        const ep = db.prepare('SELECT id, state FROM episodes WHERE id = ?').get(args.episode_id);
        if (!ep) return { ok: false, error: '找不到这个事件，phase_start 未执行' };
        if (ep.state !== 'active') return { ok: false, error: '这个事件已关闭，不能再开阶段（要续做请新建一个事件）' };
        const ph = createPhase(db, { episode_id: args.episode_id, title: args.title, content: args.content ?? '', env: args.env, keywords: args.keywords, source_session: sid });
        return ph ? { ok: true, op: 'phase_start', ...ph } : { ok: false, error: '开阶段失败' };
      }
      if (args.op === 'phase_complete') {
        if (!args.id) return { ok: false, error: 'phase_complete 需要 id' };
        const ph = completePhase(db, args.id, { content: args.content, env: args.env, keywords: args.keywords });
        return ph ? { ok: true, op: 'phase_complete', ...ph } : { ok: false, error: '找不到这个阶段' };
      }
      return { ok: false, error: 'op 只能是 create / close / phase_start / phase_complete' };
    }
  });

  add({
    name: 'memory_decision',
    description: '记一个决定：选了什么、当时的环境、为什么、当时没选什么。会限制以后怎么选的才值得记（「从此排除了国产品牌」值得，「选了 A 品牌」不值得）。被推翻时用 supersedes 指回旧决定，旧的那条会退成 review。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '决定本身＋为什么；不设字数上限，把当时的处境与放弃的选项一起写下来' },
        chosen: { type: 'string', description: '选了哪个' },
        rejected: { type: 'string', description: '当时没选什么——这是判断「判据变没变」最直接的证据' },
        supersedes: { type: 'string', description: '被这个决定推翻的旧决定 id' },
        episode_id: { type: 'string', description: '所属事件；不给则按当前 persona 的活跃事件推断' },
        phase_id: { type: 'string', description: '所属阶段；不给则取该事件最新未归档阶段' },
        keywords: { type: 'array', items: { type: 'string' }, description: '检索关键词 3-8 个' }
      },
      required: ['content']
    },
    async execute(args = {}, exec) {
      // content 必填却允许空串时，会写出一条检索不到、也读不回来的空决定
      if (!String(args.content ?? '').trim()) return { ok: false, error: 'content 不能为空——空决定检索不到，也读不回来' };
      const db = dbFor();
      const sid = sessionIdFrom(exec);
      let episodeId = args.episode_id;
      if (!episodeId && !args.phase_id) {
        const p = findPersona(db, sid);
        if (p) {
          const ep = db.prepare("SELECT id FROM episodes WHERE state = 'active' AND persona_id = ? ORDER BY updated_at DESC LIMIT 1").get(p.id);
          if (ep) episodeId = ep.id;
        }
      }
      // supersedes 指错时以前静默跳过：旧决定不会被降级，两条矛盾决定同时有效
      if (args.supersedes && !db.prepare('SELECT id FROM decisions WHERE id = ?').get(args.supersedes)) {
        return { ok: false, error: `找不到被推翻的决定 ${args.supersedes}，这次没有写入` };
      }
      const d = createDecision(db, { content: args.content, chosen: args.chosen, rejected: args.rejected, supersedes: args.supersedes, episode_id: episodeId, phase_id: args.phase_id, keywords: args.keywords, source_session: sid });
      // 注意：返回值里不能出现 undefined——宿主的序列化是 lossless JSON，会整条失败
      // （2026-11-23 踩过：hint: undefined 让 memory_decision 报 value is not lossless JSON）
      return { ok: true, ...d, ...(episodeId ? {} : { hint: '没挂到任何事件上（当时没有活跃事件，或没给 episode_id）' }) };
    }
  });

  add({
    name: 'memory_persona',
    description: '人格：建一个人格实体、把一个会话挂到已有的人格上（会话坏了新开时用）、或给它加一条性状。人格住在**工作区库**，只在这个工作区内的会话之间共享——list 只列当前工作区的 persona（全局库不存 persona，别的工作区也看不到本工作区的）；跨工作区的会话要各自 create。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['create', 'inherit', 'trait', 'list'], description: 'create 建人格／inherit 挂会话／trait 加一条性状／list 列出现有人格（拿 id 用）' },
        name: { type: 'string', description: '人格名，如「维护 DSH 插件」「挑商品」（create 用）' },
        description: { type: 'string', description: '这个人格负责什么（create 用）' },
        persona_id: { type: 'string', description: 'inherit / trait 必填' },
        session_id: { type: 'string', description: 'inherit：要挂哪个会话，默认当前；' },
        trait: { type: 'string', description: 'trait：一条性状，写成「他/我 习惯…」，一条只讲一个特质。三条判据：①换个用途的会话这条还成立吗？成立就不是 trait，该进 rules 或 AGENTS.md；②它说的是哪一种事——「他这个人」→ 画像，「我该怎么做」→ rules / AGENTS.md，「在这个用途里我们怎么配合」→ trait；③一条只讲一个特质' }
      },
      required: ['op']
    },
    async execute(args = {}, exec) {
      const db = dbFor();
      const sid = sessionIdFrom(exec);
      if (args.op === 'list') {
        return { ok: true, op: 'list', total: listPersonas(db).length, items: listPersonas(db) };
      }
      if (args.op === 'create') {
        if (!args.name) return { ok: false, error: 'create 需要 name' };
        // 显式给 session_id 就用它（给别的会话建人格），否则挂当前会话
        const target = args.session_id ?? sid;
        if (!target) return { ok: false, error: 'create 需要当前会话或显式 session_id' };
        const p = createPersona(db, { name: args.name, description: args.description, session_ids: [target] });
        return { ok: true, op: 'create', ...p };
      }
      if (args.op === 'inherit') {
        if (!args.persona_id) return { ok: false, error: 'inherit 需要 persona_id' };
        const r = inheritPersona(db, args.persona_id, args.session_id ?? sid);
        return r ? { ok: true, op: 'inherit', ...r } : { ok: false, error: '找不到这个人格' };
      }
      if (args.op === 'trait') {
        if (!args.persona_id || !args.trait) return { ok: false, error: 'trait 需要 persona_id 与 trait' };
        // persona_traits 没有外键：不查就写出永远不会被注入的孤儿性状
        if (!db.prepare('SELECT id FROM personas WHERE id = ?').get(args.persona_id)) {
          return { ok: false, error: '找不到这个人格，trait 未写入（用 memory_persona op=list 拿 id）' };
        }
        const t = addTrait(db, args.persona_id, args.trait, { source_session: sid });
        return t ? { ok: true, op: 'trait', ...t } : { ok: false, error: '加性状失败' };
      }
      return { ok: false, error: 'op 只能是 create / inherit / trait' };
    }
  });

  add({
    name: 'memory_issue',
    description: '工具问题：看插件自己捕获的工具执行错误、标已修或忽略。工具执行抛错时会自动记一条（同签名 24 小时内只累加计数），只记工具名、错误原文与参数名，不记参数值。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'mark', 'stats'], description: '默认 list' },
        id: { type: 'string', description: 'mark 用：问题 id' },
        status: { type: 'string', enum: ['open', 'fixed', 'ignored'], description: 'mark 用：改成哪个状态' },
        limit: { type: 'number', description: 'list 返回条数，默认 20' }
      },
      required: []
    },
    async execute(args = {}) {
      const db = dbFor();
      const action = args.action ?? 'list';
      if (action === 'stats') return { ok: true, action: 'stats', ...toolIssueStats(db) };
      if (action === 'mark') {
        if (!args.id) return { ok: false, error: 'mark 需要 id' };
        if (!args.status) return { ok: false, error: 'mark 需要 status（open / fixed / ignored）' };
        const r = markToolIssue(db, args.id, args.status);
        return r ? { ok: true, action: 'mark', ...r } : { ok: false, error: '找不到这条问题，或 status 不合法' };
      }
      const items = listToolIssues(db, { status: args.status ?? 'open', limit: Math.min(100, Number(args.limit) || 20) });
      return { ok: true, action: 'list', total: items.length, stats: toolIssueStats(db), items };
    }
  });

  const disposeAll = () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
  };
  disposeAll.count = disposers.length;
  return disposeAll;
}
