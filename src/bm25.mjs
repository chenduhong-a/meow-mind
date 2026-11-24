// 检索：BM25（FTS5）+ 四因子融合。embedding 为可选的第二阶段重排。
import { KINDS, tableOf } from './db.mjs';
import { queryTerms } from './vocab.mjs';
import { evidenceCount } from './store.mjs';

const STATUS_WEIGHT = {
  memory: 1,
  review: 0.4,
  candidate: 0.3,
  evidence: 0.2,
  observation: 0.1
};

function ftsQuery(terms) {
  const safe = terms.filter((t) => t.length > 0 && !/["*()]/.test(t));
  if (safe.length === 0) return null;
  return safe.map((t) => `"${t}"`).join(' OR ');
}

function daysSince(v) {
  if (!v) return 999;
  let t = Date.parse(v);
  // 旧库迁来的时间戳是毫秒数字字符串（"1792647808084.0"），Date.parse 认不出
  if (Number.isNaN(t)) {
    const n = Number(v);
    // 极少数写入路径存过微秒（17 位），先折回毫秒，否则会被当成未来时间、recency 恒为 1
    if (Number.isFinite(n)) t = n > 1e14 ? n / 1000 : n;
  }
  if (Number.isNaN(t)) return 999;
  return Math.max(0, (Date.now() - t) / 86400000);
}

// 关系扩展系数：邻居只补召回、不抢位置，所以压到 0.35
const RELATION_FACTOR = 0.35;
const RELATION_SEEDS = 5;

// ── 意图分桶配额 ──
// 混排的问题：lesson 355 条、user 只有 39 条，一排序前几条常被某一层刷屏，
// 问「我的偏好」时 user 层根本进不来。按意图给每层分配名额，保住跨层问题。
// 思路来自 OpenViking 的 CODING_QUOTA_WEIGHTS（纯策略，不需要模型）。
const INTENT_PATTERNS = [
  ['preference', /偏好|喜欢|爱好|更倾向|prefer|favorite|like/i],
  ['howto', /怎么(修|弄|做|办|写|装|改|处理|解决|搞)|如何(修|弄|做|写|装|改|处理|解决)|步骤|流程|报错|how to|fix/i],
  ['where', /在哪|位置|路径|目录|where|path|dir/i],
  ['when', /什么时候|何时|哪天|what time|when/i]
];

const INTENT_QUOTAS = {
  preference: { user: 3, rules: 2, lesson: 1 },
  howto: { principle: 2, lesson: 3, rules: 1, fact: 1 },
  where: { fact: 3, project: 2 },
  when: { fact: 2, topic: 2 },
  general: { principle: 1, fact: 2, lesson: 2, rules: 1, user: 1 }
};

export function detectIntent(query) {
  for (const [name, re] of INTENT_PATTERNS) {
    if (re.test(String(query ?? ''))) return name;
  }
  return 'general';
}

/** 按意图配额从排好序的候选里取结果；配额没填满时按总分补齐，不浪费名额。 */
function bucketPick(sorted, intent, limit) {
  const quotas = INTENT_QUOTAS[intent] ?? INTENT_QUOTAS.general;
  const picked = [];
  const used = new Set();
  for (const [level, quota] of Object.entries(quotas)) {
    let n = 0;
    for (const item of sorted) {
      if (n >= quota) break;
      if (item.level !== level || used.has(item.id)) continue;
      used.add(item.id);
      picked.push(item);
      n++;
    }
  }
  for (const item of sorted) {
    if (picked.length >= limit) break;
    if (used.has(item.id)) continue;
    used.add(item.id);
    picked.push(item);
  }
  return picked.sort((a, b) => b.score - a.score).slice(0, limit);
}

function levelOf(db, id) {
  for (const lv of KINDS) {
    const hit = db.prepare(`SELECT 1 AS x FROM ${tableOf(lv)} WHERE id = ?`).get(id);
    if (hit) return lv;
  }
  return null;
}

/** 纯词法候选：返回 [{ id, level, raw }]，raw 为 BM25 分（越大越相关）。 */
export function bm25Candidates(db, query, { limit = 50, globalDb = null } = {}) {
  const terms = queryTerms(query);
  const q = ftsQuery(terms);
  if (q === null) return [];
  let rows;
  try {
    rows = db
      .prepare('SELECT memory_id, level, -bm25(memory_fts) AS score FROM memory_fts WHERE memory_fts MATCH ? ORDER BY score DESC LIMIT ?')
      .all(q, limit);
  } catch {
    return [];
  }
  const local = rows.map((r) => ({ id: r.memory_id, level: r.level, raw: Number(r.score), scope: 'local' }));
  if (globalDb === null) return local;
  // 两库各算各的 BM25：全局库只贡献候选，归一化在 fusedSearch 里按库分开做。
  try {
    const g = bm25Candidates(globalDb, query, { limit }).map((x) => ({ ...x, scope: 'global' }));
    const have = new Set(local.map((x) => x.id));
    return [...local, ...g.filter((x) => !have.has(x.id))];
  } catch {
    return local;
  }
}

// 时间线三张表按 persona 隔离：装修经历不该出现在挑商品的会话里。
// 显式查某个事件（eventId）时不受限——那是「我要看这件事的全部记录」。
const TIMELINE_KINDS = ['episode', 'phase', 'decision'];

// kind→表名映射统一在 db.mjs 的 tableOf 里（2026-11-23 审计：原先 store / bm25 / review 各一份）。

function timelineScopeOk(db, level, row, personaId, eventId) {
  const epId = level === 'episode' ? row.id : row.episode_id;
  if (eventId && epId === eventId) return true; // 显式查这件事，不受 persona 限制
  // 没有 persona 的会话（还没声明用途）只看「无主」时间线；
  // 有 persona 的会话看自己的 + 无主的。fail closed：宁可搜不到，也不要串味。
  if (!personaId) return !row.persona_id;
  if (level === 'episode') return !row.persona_id || row.persona_id === personaId;
  const ep = db.prepare('SELECT persona_id FROM episodes WHERE id = ?').get(epId);
  if (!ep) return false;
  return !ep.persona_id || ep.persona_id === personaId;
}

/** 场景标签过滤：只对阶段有意义（env 是标签组文本，如「租房 / 预算紧」）。 */
function tagsOk(db, level, row, tags) {
  let env = '';
  if (level === 'phase') {
    env = String(row.env ?? '');
  } else if (level === 'decision' && row.phase_id) {
    // 决定继承它所属阶段的场景标签——问「预算紧的时候我选了什么」要能带出决定。
    try {
      env = String(db.prepare('SELECT env FROM phases WHERE id = ?').get(row.phase_id)?.env ?? '');
    } catch {
      env = '';
    }
  } else {
    return true;
  }
  return tags.every((t) => env.includes(t));
}

function loadRow(db, level, id) {
  if (!KINDS.includes(level)) return null;
  try {
    return db.prepare(`SELECT * FROM ${tableOf(level)} WHERE id = ?`).get(id);
  } catch {
    return null;
  }
}

/**
 * 四因子融合排序。
 * score = w.lex*lexNorm + w.recency*exp(-d/30) + w.status*w + w.evidence*min(1,n/3)
 */
/** 余弦相似度（向量已 L2 归一，点积即余弦）。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function fusedOne(db, query, cfg, { limit = 6, levels = null, includeExplain = false, semantic = null, personaId = '', tags = null, eventId = '' } = {}) {
  const lexical = bm25Candidates(db, query, { limit: cfg.retrieval.hybridPool });
  // 双通道召回：词法候选 ∪ 语义 topN。只在词法候选内重排救不回「词法完全没命中」的条目。
  const pool = lexical.map((p) => ({ id: p.id, level: p.level, raw: p.raw }));
  const known = new Set(pool.map((p) => p.id));
  if (semantic !== null && semantic.size > 0) {
    const cap = typeof cfg.retrieval.semanticPool === 'number' ? cfg.retrieval.semanticPool : 20;
    const extra = [...semantic.entries()]
      .filter(([id]) => !known.has(id))
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, cap);
    for (const [id, info] of extra) pool.push({ id, level: info.level, raw: 0 });
  }
  if (pool.length === 0) return [];
  const maxRaw = Math.max(...pool.map((p) => p.raw), 1e-9);
  const w = cfg.retrieval.weights;
  const out = [];
  for (const cand of pool) {
    const row = loadRow(db, cand.level, cand.id);
    if (!row) continue; // node:sqlite 的 .get() 未命中返回 undefined，不是 null
    if (levels !== null && !levels.includes(cand.level)) continue;
    // personas 表没有 status 列：undefined 视为有效，否则人格永远被这条挡掉（2026-11-23 审计 P0）。
    if (row.status !== undefined && row.status !== 'memory') continue;
    if (TIMELINE_KINDS.includes(cand.level)) {
      if (!timelineScopeOk(db, cand.level, row, personaId, eventId)) continue;
      if (tags !== null && !tagsOk(db, cand.level, row, tags)) continue;
    }
    const evN = evidenceCount(db, cand.id);
    const lex = cand.raw / maxRaw;
    const sem = semantic === null ? undefined : semantic.get(row.id)?.score;
    const mix = typeof cfg.retrieval.semanticMix === 'number' ? cfg.retrieval.semanticMix : 0.5;
    // 双通道候选的合并规则：
    // - 只被语义召回的（raw=0）：语义分打五折——单一通道证据弱于双通道证据，
    //   不打折会挤掉那些词法已经排对的条目（实测 hit@5 从 79.2% 掉回 66.7%）
    // - 两个通道都召回的：按 semanticMix 混合
    // - 只有词法的：用词法分，避免整条记忆被系统性压低
    const lexNorm = sem === undefined
      ? lex
      : cand.raw === 0
        ? Math.max(0, sem) * 0.5
        : mix * Math.max(0, sem) + (1 - mix) * lex;
    const recency = Math.exp(-daysSince(row.last_accessed_at ?? row.updated_at) / 30);
    const st = STATUS_WEIGHT[row.status] ?? 0.3;
    const evidence = Math.min(1, evN / 3);
    const score = w.lex * lexNorm + w.recency * recency + w.status * st + w.evidence * evidence;
    let keywords = [];
    try {
      keywords = JSON.parse(row.keywords ?? '[]');
    } catch {
      keywords = [];
    }
    out.push({
      id: row.id,
      level: cand.level,
      title: row.title,
      content: row.content,
      importance: row.importance,
      keywords,
      status: row.status,
      updated_at: row.updated_at,
      score,
      ...(includeExplain ? { explain: { lex: +lex.toFixed(3), recency: +recency.toFixed(3), status: st, evidence: +evidence.toFixed(3) } } : {})
    });
  }
  out.sort((a, b) => b.score - a.score);
  // ── 关系扩展：命中的前 N 条带出同主题邻居 ──
  // 邻居只补召回、不抢位置：分数 = 种子分 × 0.35，且不改变已有条目的排序。
  // 关系网只有 14.7% 覆盖（阈值 3 只认强关联），所以扩展是「加分项」不是「主力」。
  if (out.length > 0) {
    const seeds = out.slice(0, RELATION_SEEDS);
    const have = new Set(out.map((o) => o.id));
    const added = [];
    for (const seed of seeds) {
      let neighbors = [];
      try {
        neighbors = db
          .prepare("SELECT to_id FROM memory_relations WHERE from_id = ? AND relation = 'same_topic'")
          .all(seed.id);
      } catch {
        neighbors = [];
      }
      for (const nb of neighbors) {
        if (have.has(nb.to_id)) continue;
        have.add(nb.to_id);
        const lv = levelOf(db, nb.to_id);
        if (lv === null) continue;
        if (levels !== null && !levels.includes(lv)) continue;
        const row = loadRow(db, lv, nb.to_id);
        if (row === null) continue;
        if (row.status !== undefined && row.status !== 'memory') continue;
        if (TIMELINE_KINDS.includes(lv) && !timelineScopeOk(db, lv, row, personaId, eventId)) continue;
        let keywords = [];
        try {
          keywords = JSON.parse(row.keywords ?? '[]');
        } catch {
          keywords = [];
        }
        added.push({
          id: row.id,
          level: lv,
          title: row.title,
          content: row.content,
          importance: row.importance,
          keywords,
          status: row.status,
          updated_at: row.updated_at,
          score: seed.score * RELATION_FACTOR,
          ...(includeExplain ? { explain: { via: 'relation', seed: seed.id, factor: RELATION_FACTOR } } : {})
        });
      }
    }
    if (added.length > 0) {
      out.push(...added);
      out.sort((a, b) => b.score - a.score);
    }
  }
  // 意图分桶：默认开。关掉退回纯分数截断（`retrieval.intentQuota: false`）。
  if (cfg.retrieval?.intentQuota !== false) {
    return bucketPick(out, detectIntent(query), limit);
  }
  return out.slice(0, limit);
}

/**
 * 两库合并检索。全局库单独跑一遍再并起来——BM25 分是按库归一化的，
 * 混在一个 pool 里会让条目多的库系统性压住条目少的库。
 * 合并后统一按意图配额再挑一次，保持「跨层不吃亏」。
 */
export function fusedSearch(db, query, cfg, opts = {}) {
  const { globalDb = null, ...rest } = opts;
  const local = fusedOne(db, query, cfg, rest);
  if (globalDb === null) return local;
  let cross = [];
  try {
    cross = fusedOne(globalDb, query, cfg, rest).map((r) => ({ ...r, scope: 'global' }));
  } catch {
    return local;
  }
  const seen = new Set();
  const merged = [];
  for (const r of [...local, ...cross]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  merged.sort((a, b) => b.score - a.score);
  const limit = rest.limit ?? 6;
  return cfg.retrieval?.intentQuota !== false ? bucketPick(merged, detectIntent(query), limit) : merged.slice(0, limit);
}

/** L0 摘要：取首句，去代码块与多余空白。 */
export function summarize(text, max = 60) {
  const clean = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'));
  return (stop > max * 0.5 ? cut.slice(0, stop) : cut).trim() + '…';
}
