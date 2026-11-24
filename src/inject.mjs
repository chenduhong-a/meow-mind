// 注入块构建：首轮（长期记忆 + 准则）与每消息（命中摘要）。
import { listMemories, allVectors } from './store.mjs';
import { fusedSearch, bm25Candidates, cosine } from './bm25.mjs';
import { l0, l1 } from './summary.mjs';
import { buildBriefNarrative } from './profile.mjs';
import { mailboxStats, listLetters } from './mailbox.mjs';
import { docIndexLine } from './docs.mjs';
import { findPersona, listTraits, currentSituation } from './timeline.mjs';

/** CJK 感知的 token 估算：中文 1.5，其余 0.3。 */
export function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.5 + other * 0.3);
}

// 首行是常驻语言提醒：rules 层里那条「思考用中文」会被预算挤掉或埋在几十条准则里，
// 而这句每次注入都出现在段落最前，不占规则配额。
const LANG_RULE = '思考过程（reasoning）与回复一律用中文书写；代码、命令、路径、专有名词、引用原文照原样，不硬译。';

const GUIDE = [
  LANG_RULE,
  '本块是跨会话记忆，不是用户本轮的原话。',
  '需要更多细节用 memory_search / memory_read；要写新记忆用 memory_remember（必须给 project 与 8-13 个 keywords）。',
  '标记为「回顾」的条目已完结，不再展开；被截断的条数见块尾。'
].join('\n');

function fmtLine(m, maxChars) {
  const kw = Array.isArray(m.keywords) && m.keywords.length > 0 ? `｜key: ${m.keywords.slice(0, 4).join(', ') || '-'}` : '';
  return `- ${l0(m.content, maxChars)}${kw}`;
}

/** 首轮块。按 importance 优先装入，超预算截断并注明条数。 */
export function buildFirstTurnBlock(db, cfg, globalDb = null, selfCode = '', selfSession = '') {
  const budget = cfg.injection.firstTurnBudget;
  const maxChars = cfg.injection.summaryChars;
  const lines = [];
  // 预留：GUIDE 本身 + 4 个节标题 + 最多 4 行「另 N 条未展开」的固定开销。
  // 不预留的话会出现「逐条累加没超、拼成整块却超」——头部与截断行是拼装时才产生的。
  let used = estimateTokens(GUIDE) + 200;
  // 被预算挤掉的段：不记下来的话，调用方只能从"看不见"猜"没写进去"（2026-11-23 实测踩到）
  const dropped = [];

  const take = (level, statuses, header, cap, srcDb = db, tag = '') => {
    // 会话人格已由 personas / persona_traits 接管（下面的「人格」段），
    // 全局库的 soul 是跨工作区底色、不需要过滤——原来的 sessionOnly 分支全目录无人传参，已删。
    let items = listMemories(srcDb, level, { limit: 300 }).filter((m) => statuses.includes(m.status));
    const kept = [];
    let truncated = 0;
    for (const m of items) {
      const line = fmtLine(m, maxChars);
      const cost = estimateTokens(line);
      if (used + cost > budget || kept.length >= cap) {
        truncated++;
        continue;
      }
      kept.push(line);
      used += cost;
    }
    if (kept.length > 0) {
      lines.push(`\n## ${header}${tag}`);
      lines.push(...kept);
      if (truncated > 0) lines.push(`（另 ${truncated} 条未展开，用 memory_search 查）`);
    } else if (items.length > 0) {
      // 整段被挤掉（标题 + 第一条就超预算）：以前这里什么都不留
      dropped.push(header + (tag || ''));
    }
  };

  // 全局库先占：跨工作区的准则与会话无关的事实，比本区细节更该先出现。
  if (globalDb !== null) {
    take('soul', ['memory'], '自我设定（soul）', 3, globalDb, '（全局）');
  // 13 而不是 12：2026-11-23 加「新会话先确认 persona」时发现，12 条上限会把最早那条「信箱要读也要写」挤出去
  take('rules', ['memory'], '全局准则（rules）', 13, globalDb, '（全局）');
  // 经验准则全在全局库（工作区库通常为 0）：不给名额的话 18 条方法论永远进不了上下文。
  take('principle', ['memory'], '经验准则', 8, globalDb, '（全局）');
    take('project', ['memory'], '项目', 3, globalDb, '（全局）');
  }

  // 人格（原 soul 岗位的接替者）：本会话所属 persona 的性状条目。
  // 「人格是共事长出来的」——所以它不在八层里手写，而是随事件与阶段积累。
  let personaId = '';
  try {
    const persona = findPersona(db, selfSession);
    if (persona) {
      personaId = persona.id;
      const traits = listTraits(db, persona.id);
      if (traits.length > 0) {
        const block = ['\n## 人格（本会话）', ...traits.map((t) => '- ' + t.content)].join('\n');
        const cost = estimateTokens(block);
        if (used + cost <= budget) {
          lines.push(block);
          used += cost;
        } else {
          dropped.push('人格（本会话）');
        }
      }
    }
  } catch {
    /* 人格表缺失不影响其余段 */
  }

  // 用户画像优先：结构化分节比散条 user 记忆更省、更少重复。
  // 画像是「这个人」，跨工作区都成立 → 优先读全局库；旧库还留在工作区时退回本地读。
  // 两处都为空（刚装/老库）时退回原来的散条注入。
  let profileInjected = false;
  try {
    const opts = { take: cfg.injection.profileTake ?? 2, maxChars: cfg.injection.profileChars ?? 1050 };
    let brief = '';
    if (globalDb) {
      try { brief = buildBriefNarrative(globalDb, opts); } catch { brief = ''; }
    }
    if (!brief.trim()) brief = buildBriefNarrative(db, opts);
    if (brief.trim().length > 0) {
      const block = `\n## 用户画像\n${brief}`;
      const cost = estimateTokens(block);
      if (used + cost <= budget) {
        lines.push(block);
        used += cost;
        profileInjected = true;
      } else {
        dropped.push('用户画像');
      }
    }
  } catch {
    // 画像模块不可用（表不存在等）时静默退回散条
  }
  if (!profileInjected) take('user', ['memory'], '长期记忆（user）', 25);

  // 当前处境：进行中的事件 + 它最近一个未归档的阶段。没有活跃事件时整段不出现。
  try {
    const sits = currentSituation(db, personaId, 2);
    if (sits.length > 0) {
      const rows = sits.map(({ episode, phase }) => {
        const name = l0(episode.title || episode.content, 40);
        const env = phase && phase.env ? '｜' + l0(phase.env, 40) : '';
        return '- ' + name + env;
      });
      const block = '\n## 当前处境\n' + rows.join('\n');
      const cost = estimateTokens(block);
      if (used + cost <= budget) {
        lines.push(block);
        used += cost;
      } else {
        dropped.push('当前处境');
      }
    }
  } catch {
    /* 时间线表缺失不影响其余段 */
  }

  take('rules', ['memory'], '全局准则（rules）', 25, db, '（本工作区）');
  // 经验准则（principle）此前没有名额，18 条永远进不了上下文；给 5 个名额，预算不够时自动少取。
  take('principle', ['memory'], '经验准则', 5);
  take('project', ['memory'], '项目', 8);
  take('todo', ['memory'], '待办（todo）', 3);

  // 样板索引：只列名字与一句话摘要，正文要 memory_doc get 取——长文不进首轮块。
  try {
    const docLine = docIndexLine(cfg);
    if (docLine) {
      const cost = estimateTokens(docLine);
      if (used + cost <= budget) {
        lines.push('\n' + docLine);
        used += cost;
      } else {
        dropped.push('共享库样板');
      }
    }
  } catch {
    /* 样板索引坏了不影响记忆注入 */
  }
  // 信箱：有未办信件时提醒。只列标题与编号，正文用 memory_mail read 取——避免把信的内容塞进上下文。
  try {
    const mb = mailboxStats(cfg);
    if (mb.enabled && mb.pending > 0) {
      // 自己发出的广播不必在首轮块里提醒自己；手工信的编号是占位串，显示成「手工信」更好读（2026-11-21 实测）
      const all = listLetters(cfg, { status: '待办', limit: 50 }).items ?? [];
      const mine = all.filter((l) => !selfCode || l.from !== selfCode);
      const items = mine.slice(0, 3);
      const rest = mine.length - items.length;
      const rows = items.map((l) => {
        const tag = /^[A-Za-z0-9]{8,}$/.test(String(l.id ?? '')) ? `[${l.id}] ` : '[手工信] ';
        return `- ${tag}${l.subject}（${l.from} → ${l.to}，${l.day} ${l.time}）`;
      });
      const head = `\n## 信箱（${mine.length} 封待办）`;
      const block = [head, ...rows, rest > 0 ? `（另 ${rest} 封，用 memory_mail list 看）` : ''].filter(Boolean).join('\n');
      const cost = estimateTokens(block);
      if (used + cost <= budget) {
        lines.push(block);
        used += cost;
      } else {
        dropped.push('信箱');
      }
    }
  } catch {
    /* 信箱坏了不影响记忆注入 */
  }

  if (lines.length === 0) return null;
  const text = `<meow-mind>\n## 记忆使用说明\n${GUIDE}\n${lines.join('\n')}\n</meow-mind>`;
  return { text, tokens: estimateTokens(text), dropped };
}

/**
 * 全库语义召回：对每条有向量的记忆算余弦，返回 Map<id, { score, level }>。
 * 不限于词法候选——否则「词法完全没命中」的条目永远进不来（这正是 hit@1 上不去的原因）。
 * 431 条 × 768 维约 1ms；库大到 5 万条时靠 allVectors 的上限截断，需要 ANN 时再上。
 */
export async function semanticScores(db, query, cfg, embedder, globalDb = null) {
  if (embedder === null || embedder === undefined) return null;
  const vectors = allVectors(db, cfg.retrieval.vectorScanMax ?? 5000);
  if (vectors.length === 0) return null;
  const qv = await embedder.embed(query);
  if (qv === null) return null;
  const map = new Map();
  for (const v of vectors) map.set(v.id, { score: cosine(qv, v.vec), level: v.level, scope: 'local' });
  if (globalDb !== null) {
    try {
      const gv = allVectors(globalDb, cfg.retrieval.vectorScanMax ?? 5000);
      for (const v of gv) if (!map.has(v.id)) map.set(v.id, { score: cosine(qv, v.vec), level: v.level, scope: 'global' });
    } catch {
      /* 全局库向量读失败不影响本区召回 */
    }
  }
  return map;
}

/** 每消息命中块。返回 null 表示不注入（太短/无命中/全见过）。 */
export async function buildHitBlock(db, cfg, query, seen, embedder = null, globalDb = null, selfSession = '') {
  if (typeof query !== 'string' || query.trim().length < cfg.injection.minQueryChars) return null;
  let semantic = null;
  try {
    semantic = await semanticScores(db, query, cfg, embedder, globalDb);
  } catch {
    semantic = null; // 语义通道出错不拖累词法通道
  }
  // 与 memory_search 对齐：不带 personaId 时，本会话人格的时间线会被隔离规则全部过滤掉
  //（手搜能到、自动命中永远看不到，2026-11-23 审计 P1）
  const personaId = findPersona(db, selfSession)?.id ?? '';
  const hits = fusedSearch(db, query, cfg, { limit: cfg.injection.topK + 4, semantic, globalDb, personaId });
  const fresh = hits.filter((h) => !seen.has(h.id)).slice(0, cfg.injection.topK);
  if (fresh.length === 0) return null;
  const budget = cfg.injection.perMessageBudget;
  const lines = [];
  let used = 20;
  for (const h of fresh) {
    const line = `- [${h.level}]${h.scope === 'global' ? '[全局]' : ''} ${l1(h.content, cfg.injection.hitChars ?? 200)}`;
    const cost = estimateTokens(line);
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
  }
  if (lines.length === 0) return null;
  for (const h of fresh.slice(0, lines.length)) seen.add(h.id);
  return { text: `<meow-mind-hit>\n${lines.join('\n')}\n</meow-mind-hit>`, tokens: used, ids: fresh.slice(0, lines.length).map((h) => h.id) };
}
