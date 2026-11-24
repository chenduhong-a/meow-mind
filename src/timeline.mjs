// 时间线：事件（episodes）、阶段（phases）、决定（decisions）、人格（personas）。
// 这四张表不进八层，表结构各自不同；但都写进同一个 memory_fts，检索侧无感。
import { nextId, nowIso } from './db.mjs';
import { syncFts } from './store.mjs';

/** 按会话 id 反查它所属的 persona；没声明过就返回 null。 */
export function findPersona(db, sessionId) {
  if (!db || !sessionId) return null;
  let rows = [];
  try {
    rows = db.prepare('SELECT * FROM personas WHERE merged_into IS NULL').all();
  } catch {
    return null;
  }
  for (const r of rows) {
    let ids = [];
    try { ids = JSON.parse(r.session_ids || '[]'); } catch { ids = []; }
    if (Array.isArray(ids) && ids.includes(sessionId)) return r;
  }
  return null;
}

/** persona 的性状条目，按 sort_order 排。 */
export function listTraits(db, personaId) {
  if (!db || !personaId) return [];
  try {
    return db.prepare("SELECT * FROM persona_traits WHERE persona_id = ? AND status = 'memory' ORDER BY sort_order").all(personaId);
  } catch {
    return [];
  }
}

/** 当前处境：进行中的事件 + 它最近一个未归档的阶段。persona 为空时不按 persona 过滤。 */
export function currentSituation(db, personaId = '', limit = 2) {
  if (!db) return [];
  let eps = [];
  try {
    // 与检索侧 timelineScopeOk 保持同一口径（fail closed）：
    // 有 persona → 自己的 + 无主的；没有 persona → 只看无主的。
    // 2026-11-23 验收时发现原来「没有 persona 就看全部」，会把别人的活跃事件显示给无关会话。
    eps = personaId
      ? db
          .prepare(
            "SELECT * FROM episodes WHERE state = 'active' AND (persona_id = ? OR persona_id IS NULL OR persona_id = '') ORDER BY updated_at DESC LIMIT ?",
          )
          .all(personaId, limit)
      : db
          .prepare(
            "SELECT * FROM episodes WHERE state = 'active' AND (persona_id IS NULL OR persona_id = '') ORDER BY updated_at DESC LIMIT ?",
          )
          .all(limit);
  } catch {
    return [];
  }
  return eps.map((e) => {
    let phase = null;
    try {
      phase = db.prepare('SELECT * FROM phases WHERE episode_id = ? AND archived_at IS NULL ORDER BY seq DESC LIMIT 1').get(e.id) ?? null;
    } catch { /* 阶段表缺失时只报事件 */ }
    return { episode: e, phase };
  });
}

// ── 写入 ────────────────────────────────────────────────────────────
// 这三张表结构各自不同，insertMemory 用不了（它按九层表拼列）；但都要进同一个
// memory_fts，所以这里自己 INSERT，检索侧统一调 syncFts。

/** 把 keywords 数组存成 JSON 字符串。 */
const kw = (v) => JSON.stringify(Array.isArray(v) ? v : []);

/** 取当前会话所属 persona 的 id，没有就空串。 */
function personaOf(db, sessionId) {
  const p = findPersona(db, sessionId);
  return p ? p.id : '';
}

/** 建一个事件（episode）。state 默认 active。 */
export function createEpisode(db, data = {}) {
  const id = data.id ?? nextId();
  const ts = nowIso();
  const title = data.title || String(data.content ?? '').slice(0, 40);
  const keywords = Array.isArray(data.keywords) ? data.keywords : [];
  const persona_id = data.persona_id || personaOf(db, data.source_session);
  db.prepare(
    `INSERT INTO episodes (id, persona_id, title, content, goal, state, started_at, ended_at, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,NULL)`,
  ).run(
    id, persona_id, title, data.content ?? '', data.goal ?? null,
    data.state ?? 'active', data.started_at ?? ts, null,
    kw(keywords), 'memory', data.source_session ?? null, ts, ts,
  );
  syncFts(db, 'episode', { id, title, content: data.content ?? '', keywords });
  return { id, title, persona_id, state: data.state ?? 'active', content: data.content ?? '' };
}

/** 关掉一个事件：state=done + 其所有未归档阶段一起归档。 */
export function closeEpisode(db, id) {
  const ts = nowIso();
  const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
  if (!ep) return null;
  db.prepare("UPDATE episodes SET state = 'done', ended_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);
  const phases = db.prepare('SELECT id FROM phases WHERE episode_id = ? AND archived_at IS NULL').all(id);
  for (const p of phases) {
    db.prepare('UPDATE phases SET archived_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, p.id);
  }
  return { id, title: ep.title, state: 'done', archivedPhases: phases.length };
}

/**
 * 开一个阶段。自动做三件事：
 * 1. seq = 该事件已有阶段数 + 1
 * 2. 把该事件上一个未归档阶段归档（出现新阶段＝上一阶段结束）
 * 3. 写 FTS
 */
export function createPhase(db, data = {}) {
  if (!data.episode_id) return null;
  const ts = nowIso();
  const prev = db.prepare('SELECT id, seq FROM phases WHERE episode_id = ? AND archived_at IS NULL ORDER BY seq DESC').all(data.episode_id);
  for (const p of prev) {
    db.prepare('UPDATE phases SET archived_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, p.id);
  }
  const seq = (prev[0]?.seq ?? 0) + 1;
  const id = data.id ?? nextId();
  const title = data.title || `阶段 ${seq}`;
  const keywords = Array.isArray(data.keywords) ? data.keywords : [];
  const persona_id = data.persona_id || personaOf(db, data.source_session);
  db.prepare(
    `INSERT INTO phases (id, episode_id, persona_id, title, content, env, seq, started_at, archived_at, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at)
     VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,0,?,?,NULL)`,
  ).run(
    id, data.episode_id, persona_id, title, data.content ?? '', data.env ?? null,
    seq, data.started_at ?? ts, kw(keywords), 'memory', data.source_session ?? null, ts, ts,
  );
  syncFts(db, 'phase', { id, title, content: `${data.content ?? ''} ${data.env ?? ''}`, keywords });
  return { id, episode_id: data.episode_id, title, seq, env: data.env ?? null, archivedPrev: prev.length };
}

/** 补全一个阶段（收尾时写选择与没选），可改 env。 */
export function completePhase(db, id, patch = {}) {
  const ts = nowIso();
  const p = db.prepare('SELECT * FROM phases WHERE id = ?').get(id);
  if (!p) return null;
  const content = patch.content ?? p.content;
  const env = patch.env ?? p.env;
  const keywords = patch.keywords ? JSON.stringify(patch.keywords) : p.keywords;
  db.prepare('UPDATE phases SET content = ?, env = ?, keywords = ?, updated_at = ? WHERE id = ?').run(content, env, keywords, ts, id);
  syncFts(db, 'phase', { id, title: p.title, content: `${content} ${env ?? ''}`, keywords: patch.keywords ?? JSON.parse(p.keywords || '[]') });
  return { id, title: p.title, content, env };
}

/**
 * 记一个决定。带 supersedes（被推翻的决定 id）时：
 * 旧决定 superseded_by 指向新决定、状态降 review；新决定正常入 memory。
 * 取舍是成对出现的，只记新的会让旧的那条继续被检索到，看起来像在自相矛盾。
 */
export function createDecision(db, data = {}) {
  const ts = nowIso();
  const id = data.id ?? nextId();
  const title = data.title || String(data.content ?? '').slice(0, 40);
  const keywords = Array.isArray(data.keywords) ? data.keywords : [];
  const persona_id = data.persona_id || personaOf(db, data.source_session);
  let phase_id = data.phase_id ?? null;
  let episode_id = data.episode_id ?? null;
  if (!phase_id && episode_id) {
    phase_id = db.prepare('SELECT id FROM phases WHERE episode_id = ? AND archived_at IS NULL ORDER BY seq DESC LIMIT 1').get(episode_id)?.id ?? null;
  }
  if (!episode_id && phase_id) {
    episode_id = db.prepare('SELECT episode_id FROM phases WHERE id = ?').get(phase_id)?.episode_id ?? null;
  }
  db.prepare(
    `INSERT INTO decisions (id, phase_id, episode_id, persona_id, title, content, chosen, rejected, occurred_at, superseded_by, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?,0,?,?,NULL)`,
  ).run(
    id, phase_id, episode_id, persona_id, title, data.content ?? '',
    data.chosen ?? null, data.rejected ?? null, data.occurred_at ?? ts,
    kw(keywords), 'memory', data.source_session ?? null, ts, ts,
  );
  let superseded = null;
  if (data.supersedes) {
    const old = db.prepare('SELECT id, title FROM decisions WHERE id = ?').get(data.supersedes);
    if (old) {
      db.prepare("UPDATE decisions SET superseded_by = ?, status = 'review', updated_at = ? WHERE id = ?").run(id, ts, data.supersedes);
      superseded = { id: old.id, title: old.title };
    }
  }
  syncFts(db, 'decision', { id, title, content: `${data.content ?? ''} ${data.chosen ?? ''} ${data.rejected ?? ''}`, keywords });
  return { id, title, phase_id, episode_id, chosen: data.chosen ?? null, rejected: data.rejected ?? null, superseded };
}

/** 列出现有的人格。id 是 inherit / trait 的必需参数，没有 list 就只能靠创建时记着。 */
export function listPersonas(db) {
  try {
    return db.prepare(
      'SELECT id, name, description, session_ids, created_at, updated_at FROM personas WHERE merged_into IS NULL ORDER BY created_at DESC',
    ).all();
  } catch {
    return []; // 旧库没有 personas 表时不影响其余工具
  }
}

/** 建一个人格。sessionIds 可空，后续用 inheritPersona 挂会话。 */
export function createPersona(db, data = {}) {
  const ts = nowIso();
  const id = data.id ?? nextId();
  const sessionIds = JSON.stringify(Array.isArray(data.session_ids) ? data.session_ids : []);
  db.prepare(
    'INSERT INTO personas (id, name, description, session_ids, merged_into, created_at, updated_at) VALUES (?,?,?,?,NULL,?,?)',
  ).run(id, data.name ?? '', data.description ?? null, sessionIds, ts, ts);
  syncFts(db, 'persona', { id, title: data.name ?? '', content: data.description ?? '', keywords: [] });
  return { id, name: data.name ?? '', session_ids: JSON.parse(sessionIds) };
}

/** 把新会话挂到已有 persona 上（会话坏了新开时用）。重复挂不会重复写。 */
export function inheritPersona(db, personaId, sessionId) {
  if (!personaId || !sessionId) return null;
  const p = db.prepare('SELECT * FROM personas WHERE id = ?').get(personaId);
  if (!p) return null;
  let ids = [];
  try { ids = JSON.parse(p.session_ids || '[]'); } catch { ids = []; }
  if (!Array.isArray(ids)) ids = [];
  if (!ids.includes(sessionId)) {
    ids.push(sessionId);
    db.prepare('UPDATE personas SET session_ids = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(ids), nowIso(), personaId);
  }
  return { id: personaId, name: p.name, session_ids: ids };
}

/** 给 persona 加一条性状；sort_order 不填就排到末尾。 */
export function addTrait(db, personaId, content, opts = {}) {
  if (!personaId || !content) return null;
  const ts = nowIso();
  const last = db.prepare('SELECT MAX(sort_order) m FROM persona_traits WHERE persona_id = ?').get(personaId);
  const order = Number.isInteger(opts.sortOrder) ? opts.sortOrder : (last?.m ?? 0) + 1;
  const id = opts.id ?? nextId();
  db.prepare(
    'INSERT INTO persona_traits (id, persona_id, content, source_session, status, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, personaId, content, opts.source_session ?? null, 'memory', order, ts, ts);
  return { id, persona_id: personaId, content, sort_order: order };
}
