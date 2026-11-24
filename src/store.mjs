// 存储层：九层 CRUD + 时间线四表 + 事件溯源 + 证据 + 版本 + FTS 同步。
import { KINDS, LEVELS, LINKABLE_KINDS, tableOf, nextId, nowIso } from './db.mjs';
import { l1 } from './summary.mjs';
import { buildBody, tokenize } from './vocab.mjs';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 时间线表与九层表列不同：personas 没有 title/content/status/keywords，
// 直接过 rowToMemory 会带出 undefined——宿主对工具返回值做无损 JSON 序列化，
// undefined 会让整条调用失败（2026-11-23 memory_decision 踩过同一个坑）。
function normalizeRow(kind, row) {
  if (!row) return row;
  if (kind === 'persona') {
    return { ...row, title: row.name ?? '', content: row.description ?? '', status: 'memory', keywords: null, importance: null, hit_count: 0, last_accessed_at: null };
  }
  if (kind === 'persona-trait') {
    return { ...row, title: '', keywords: null, importance: null, hit_count: 0, last_accessed_at: null };
  }
  return row;
}

function rowToMemory(row) {
  if (row === undefined) return null;
  let keywords = [];
  try {
    keywords = JSON.parse(row.keywords ?? '[]');
  } catch {
    keywords = [];
  }
  return { ...row, keywords, corrected: row.corrected === 1 };
}

export function recordEvent(db, { sessionId = null, turnId = null, kind, level = null, payload, idempotencyKey = null }) {
  const id = nextId();
  try {
    db.prepare(
      'INSERT INTO events(id, session_id, turn_id, kind, level, payload, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(id, sessionId, turnId, kind, level, JSON.stringify(payload ?? null), idempotencyKey, nowIso());
    return id;
  } catch (e) {
    // 幂等键冲突：视为已处理
    if (String(e?.message ?? '').includes('UNIQUE')) return null;
    throw e;
  }
}

/** 派生材料不能当「支持」类证据：模型推断、摘要、自评、生成内容都不算外部验证。
 *  判定表学 Mnemosyne `verification/assessment.py:34-38`。 */
const DERIVED_SOURCES = new Set(['inference', 'agent_inference', 'summary', 'model_output', 'self_eval', 'generated']);

export function addEvidence(db, { memoryId, eventId = null, stance = 'supported', sourceKind, quote = null }) {
  if (stance === 'supported' && sourceKind != null && DERIVED_SOURCES.has(String(sourceKind))) {
    return null;
  }
  const id = nextId();
  db.prepare('INSERT INTO memory_evidence(id, memory_id, event_id, stance, source_kind, quote, created_at) VALUES (?,?,?,?,?,?,?)').run(
    id,
    memoryId,
    eventId,
    stance,
    sourceKind,
    quote,
    nowIso()
  );
  return id;
}

export function addNoteEvidence(db, memoryId, text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  return addEvidence(db, { memoryId, sourceKind: 'note', quote: t.slice(0, 8000) });
}

export function listEvidence(db, memoryId, limit = 5) {
  return db
    .prepare('SELECT * FROM memory_evidence WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(memoryId, limit);
}

export function evidenceCount(db, memoryId) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM memory_evidence WHERE memory_id = ? AND stance = 'supported'").get(memoryId);
  return row ? Number(row.n) : 0;
}

export function snapshotVersion(db, memory, diff) {
  const last = db.prepare('SELECT MAX(version) AS v FROM memory_versions WHERE memory_id = ?').get(memory.id);
  const version = (last && last.v ? Number(last.v) : 0) + 1;
  db.prepare('INSERT INTO memory_versions(id, memory_id, version, content, status, diff, created_at) VALUES (?,?,?,?,?,?,?)').run(
    nextId(),
    memory.id,
    version,
    memory.content,
    memory.status,
    JSON.stringify(diff ?? null),
    nowIso()
  );
  return version;
}

export function syncFts(db, level, memory) {
  db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memory.id);
  const body = buildBody(memory.title, memory.content, memory.keywords);
  db.prepare('INSERT INTO memory_fts(memory_id, level, body) VALUES (?,?,?)').run(memory.id, level, body);
}

export function insertMemory(db, level, data) {
  const table = tableOf(level);
  const id = data.id ?? nextId();
  const ts = nowIso();
  const row = {
    id,
    title: data.title ?? '',
    content: data.content,
    importance: data.importance ?? 1,
    keywords: JSON.stringify(data.keywords ?? []),
    status: data.status ?? 'memory',
    source_session: data.source_session ?? data.sourceSession ?? null,
    project: data.project ?? null,
    hit_count: data.hit_count ?? 0,
    created_at: data.created_at ?? ts,
    updated_at: data.updated_at ?? ts,
    last_accessed_at: data.last_accessed_at ?? null,
    subcategory: data.subcategory ?? 'overview',
    goal: data.goal ?? null,
    corrected: data.corrected ? 1 : 0
  };
  const cols = Object.keys(row).filter((k) => !(table !== 'project' && k === 'subcategory') && !(table !== 'topic' && k === 'goal') && !(table !== 'lesson' && k === 'corrected'));
  db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
  const created = getMemory(db, level, id);
  syncFts(db, level, created);
  snapshotVersion(db, created, { kind: 'create' });
  return created;
}

export function getMemory(db, level, id) {
  const row = db.prepare(`SELECT * FROM ${tableOf(level)} WHERE id = ?`).get(id);
  return rowToMemory(normalizeRow(level, row));
}

export function getMemoryAnyLevel(db, id) {
  // 遍历 KINDS 而不是 LEVELS：memory_search 会返回 episode/phase/decision/persona 的 id，
  // 只查九层就是「搜得到、读不回」（2026-11-23 审计 P0）。
  for (const kind of KINDS) {
    const m = getMemory(db, kind, id);
    if (m) return { level: kind, memory: m };
  }
  return null;
}

export function updateMemory(db, level, id, patch) {
  const table = tableOf(level);
  const before = getMemory(db, level, id);
  if (before === null) return null;
  const sets = [];
  const vals = [];
  const map = {
    title: 'title',
    content: 'content',
    importance: 'importance',
    status: 'status',
    source_session: 'source_session',
    subcategory: 'subcategory',
    goal: 'goal',
    project: 'project'
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) {
      sets.push(`${col} = ?`);
      vals.push(patch[k]);
    }
  }
  if (patch.keywords !== undefined) {
    sets.push('keywords = ?');
    vals.push(JSON.stringify(patch.keywords));
  }
  if (patch.corrected !== undefined && level === 'lesson') {
    sets.push('corrected = ?');
    vals.push(patch.corrected ? 1 : 0);
  }
  sets.push('updated_at = ?');
  vals.push(nowIso());
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  const after = getMemory(db, level, id);
  // 第二参是 kind（单数），不是表名——传表名会让 FTS.level 变成 episodes/decisions，
  // 而检索按 KINDS 匹配，那条记忆会静默搜不到（2026-11-23 验收发现）。
  syncFts(db, level, after);
  const diff = {};
  for (const k of ['content', 'status', 'importance', 'keywords', 'title', 'subcategory', 'goal', 'project']) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diff[k] = true;
  }
  snapshotVersion(db, after, { kind: 'update', fields: Object.keys(diff) });
  return after;
}

export function touchAccess(db, level, id) {
  // personas / persona_traits 没有 hit_count 与 last_accessed_at 列：跳过，而不是静默更新成 fact 表。
  if (level === 'persona' || level === 'persona-trait') return;
  db.prepare(`UPDATE ${tableOf(level)} SET hit_count = hit_count + 1, last_accessed_at = ? WHERE id = ?`).run(nowIso(), id);
}

export function listMemories(db, level, { status = null, limit = 100, project = null } = {}) {
  const table = tableOf(level);
  const where = [];
  const vals = [];
  if (status) {
    where.push('status = ?');
    vals.push(status);
  }
  if (project && level === 'project') {
    where.push('subcategory = ?');
    vals.push(project);
  }
  const sql = `SELECT * FROM ${table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY importance DESC, updated_at DESC LIMIT ?`;
  return db.prepare(sql).all(...vals, limit).map(rowToMemory);
}

export function stats(db) {
  const byLevel = {};
  let total = 0;
  // 统计覆盖 KINDS（含时间线）：原先只算九层，memory_health 报的「总共 N 条」把人格/事件/阶段/决定全漏了。
  const CHAR_EXPR = { persona: "LENGTH(COALESCE(description,''))" };
  for (const kind of KINDS) {
    const expr = CHAR_EXPR[kind] ?? "LENGTH(COALESCE(content,''))";
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${expr}),0) AS chars FROM ${tableOf(kind)}`).get();
      byLevel[kind] = { count: Number(r.n), chars: Number(r.chars) };
      total += Number(r.n);
    } catch {
      byLevel[kind] = { count: 0, chars: 0 };
    }
  }
  const ev = db.prepare('SELECT COUNT(*) AS n FROM events').get();
  const vec = db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get();
  return { byLevel, total, events: Number(ev.n), vectors: Number(vec.n) };
}

// ── 语义通道：向量存取 ────────────────────────────────────────
const VEC_MODEL = 'bge-base-zh-v1.5';

export function saveVector(db, memoryId, vec, level = '', model = VEC_MODEL) {
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  db.prepare(
    'INSERT OR REPLACE INTO memory_vectors (memory_id, level, dim, vec, model, updated_at) VALUES (?,?,?,?,?,?)'
  ).run(memoryId, level, vec.length, buf, model, new Date().toISOString());
}

/** 读向量：返回 Map<id, { vec, level }>。 */
export function getVectors(db, ids) {
  const out = new Map();
  if (!Array.isArray(ids) || ids.length === 0) return out;
  const stmt = db.prepare('SELECT level, vec FROM memory_vectors WHERE memory_id = ?');
  for (const id of ids) {
    const row = stmt.get(id);
    if (!row) continue;
    const b = Buffer.from(row.vec);
    // sqlite 返回的 BLOB 在 Buffer pool 里可能非 4 字节对齐，复制一份再当 Float32Array 用
    const aligned = new ArrayBuffer(b.length);
    new Uint8Array(aligned).set(b);
    out.set(id, { vec: new Float32Array(aligned), level: row.level });
  }
  return out;
}

/** 全库向量（语义召回用）：返回 [{ id, level, vec }]。超过上限时截断，避免大库把每次检索拖垮。 */
export function allVectors(db, max = 5000) {
  const rows = db.prepare('SELECT memory_id, level, vec FROM memory_vectors LIMIT ?').all(max);
  const out = [];
  for (const row of rows) {
    const b = Buffer.from(row.vec);
    const aligned = new ArrayBuffer(b.length);
    new Uint8Array(aligned).set(b);
    out.push({ id: row.memory_id, level: row.level, vec: new Float32Array(aligned) });
  }
  return out;
}

export function countVectors(db) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get();
  return r ? Number(r.n) : 0;
}

/** 某层里还没有向量的记忆 id（回填用）。 */
export function idsMissingVectors(db, level, limit = 200) {
  if (!LEVELS.includes(level)) return [];
  const rows = db.prepare(
    `SELECT t.id FROM ${level} t LEFT JOIN memory_vectors v ON v.memory_id = t.id
     WHERE v.memory_id IS NULL LIMIT ?`
  ).all(limit);
  return rows.map((r) => r.id);
}


// ── 关系网 ───────────────────────────────────────────────────────────
// same_topic：同 project（或一方为空）+ keywords 交集 ≥ minShared
// supersedes：新条目取代旧条目（查重合并时由调用方显式建边）
// contradicts：冲突（dream 判定，已有读取方）

export function addRelation(db, fromId, toId, relation) {
  if (!fromId || !toId || fromId === toId || !relation) return false;
  try {
    db.prepare(
      'INSERT OR IGNORE INTO memory_relations (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)'
    ).run(fromId, toId, relation, nowIso());
    return true;
  } catch {
    return false;
  }
}

export function removeRelation(db, fromId, toId, relation) {
  try {
    db.prepare('DELETE FROM memory_relations WHERE from_id = ? AND to_id = ? AND relation = ?')
      .run(fromId, toId, relation);
    return true;
  } catch {
    return false;
  }
}

export function getRelations(db, id) {
  const outgoing = db
    .prepare('SELECT to_id AS id, relation FROM memory_relations WHERE from_id = ?')
    .all(id);
  const incoming = db
    .prepare('SELECT from_id AS id, relation FROM memory_relations WHERE to_id = ?')
    .all(id);
  return { out: outgoing, in: incoming };
}

export function countRelations(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM memory_relations').get();
  return row?.n ?? 0;
}

function keywordsOf(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter(Boolean) : [];
  } catch {
    return [];
  }
}

// 写入后增量建边：只比同层 + 其他层的既有条目，project 不同则跳过
export function linkRelated(db, memory, level, minShared = 3) {
  const mine = new Set(keywordsOf(memory.keywords));
  if (mine.size < minShared) return 0;
  let linked = 0;
  for (const lv of LINKABLE_KINDS) {
    // 时间线三类没有 project 列（只有九层有），查它要补一个 NULL，否则 no such column
    const projExpr = LEVELS.includes(lv) ? 'project' : 'NULL AS project';
    const rows = db
      .prepare(`SELECT id, keywords, ${projExpr} FROM ${tableOf(lv)} WHERE id != ? LIMIT 500`)
      .all(memory.id);
    for (const row of rows) {
      if (row.project && memory.project && row.project !== memory.project) continue;
      const shared = keywordsOf(row.keywords).filter((k) => mine.has(k)).length;
      if (shared >= minShared) {
        addRelation(db, memory.id, row.id, 'same_topic');
        addRelation(db, row.id, memory.id, 'same_topic');
        linked += 1;
      }
    }
  }
  return linked;
}

// 全库重建同主题边（dream 用）。O(n²) 但只在手动 dream 时跑。
export function rebuildRelations(db, minShared = 3) {
  db.prepare("DELETE FROM memory_relations WHERE relation = 'same_topic'").run();
  const all = [];
  for (const lv of LINKABLE_KINDS) {
    const projExpr = LEVELS.includes(lv) ? 'project' : 'NULL AS project';
    const rows = db.prepare(`SELECT id, keywords, ${projExpr} FROM ${tableOf(lv)}`).all();
    for (const row of rows) {
      const kw = keywordsOf(row.keywords);
      if (kw.length >= minShared) all.push({ id: row.id, project: row.project, kw: new Set(kw) });
    }
  }
  let pairs = 0;
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      if (a.project && b.project && a.project !== b.project) continue;
      let shared = 0;
      for (const k of a.kw) {
        if (b.kw.has(k)) shared += 1;
        if (shared >= minShared) break;
      }
      if (shared >= minShared) {
        addRelation(db, a.id, b.id, 'same_topic');
        addRelation(db, b.id, a.id, 'same_topic');
        pairs += 1;
      }
    }
  }
  return pairs;
}

// ── dream 的三种自洁动作（2026-11-20 加强） ──

// 瘦身：正文降为「结论 + 判据」（L1 摘要，≤maxChars），原文整体挪进证据表。
// 判据：记忆只留结论与判据，过程、实测与引用归证据——原文不丢，memory_read 可回溯。
export function slimMemory(db, level, id, { maxChars = 160 } = {}) {
  const row = db.prepare(`SELECT id, content FROM ${tableOf(level)} WHERE id = ?`).get(id);
  if (!row) return { ok: false, reason: 'not_found' };
  const before = String(row.content ?? '');
  if (before.length <= maxChars) return { ok: true, skipped: true, before: before.length };
  // 先取 L1 摘要，再回退到最近的完整句末——记忆正文不该以「…」结尾
  let after = l1(before, maxChars);
  if (after.endsWith('…')) {
    const cut = Math.max(after.lastIndexOf('。'), after.lastIndexOf('；'), after.lastIndexOf('！'), after.lastIndexOf('？'));
    after = cut > 20 ? after.slice(0, cut + 1) : after.slice(0, -1) + '。';
  }
  if (!after || after.length >= before.length) return { ok: true, skipped: true, before: before.length };
  addNoteEvidence(db, id, before);
  db.prepare(`UPDATE ${tableOf(level)} SET content = ?, updated_at = ? WHERE id = ?`).run(after, nowIso(), id);
  return { ok: true, id, level, before: before.length, after: after.length };
}

/** 内容重复对：只在 same_topic 边上算，避免 O(n²) 全库两两比较。 */
export function findDuplicates(db, threshold = 0.92) {
  const pairs = db
    .prepare("SELECT from_id, to_id FROM memory_relations WHERE relation = 'same_topic' AND from_id < to_id")
    .all();
  const out = [];
  for (const p of pairs) {
    const a = getMemoryAnyLevel(db, p.from_id);
    const b = getMemoryAnyLevel(db, p.to_id);
    if (!a?.memory || !b?.memory) continue;
    if (a.memory.status !== 'memory' || b.memory.status !== 'memory') continue;
    const sa = new Set(tokenize(a.memory.content));
    const sb = new Set(tokenize(b.memory.content));
    if (sa.size === 0 || sb.size === 0) continue;
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter += 1;
    const sim = inter / Math.sqrt(sa.size * sb.size);
    if (sim < threshold) continue;
    const aNewer = String(a.memory.updated_at ?? '') >= String(b.memory.updated_at ?? '');
    out.push({
      keep: aNewer ? { id: a.memory.id, level: a.level } : { id: b.memory.id, level: b.level },
      drop: aNewer ? { id: b.memory.id, level: b.level } : { id: a.memory.id, level: a.level },
      sim: +sim.toFixed(3)
    });
  }
  return out;
}

/** 把 drop 合并进 keep：关键词并集、drop 标 review、记一条 supersedes。 */
export function mergeMemory(db, keep) {
  const a = getMemoryAnyLevel(db, keep.keep.id);
  const b = getMemoryAnyLevel(db, keep.drop.id);
  if (!a?.memory || !b?.memory) return null;
  const merged = Array.from(new Set([...(a.memory.keywords ?? []), ...(b.memory.keywords ?? [])])).slice(0, 13);
  updateMemory(db, a.level, a.memory.id, { keywords: merged });
  db.prepare(`UPDATE ${tableOf(b.level)} SET status = 'review', updated_at = ? WHERE id = ?`).run(nowIso(), b.memory.id);
  db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(b.memory.id);
  addRelation(db, a.memory.id, b.memory.id, 'supersedes');
  return { keep: a.memory.id, drop: b.memory.id, keywords: merged.length };
}

/** 超长拆分：按句切两半，前半留原条、后半建新条并互连 same_topic。 */
export function splitLongMemory(db, id, maxChars = 800) {
  const found = getMemoryAnyLevel(db, id);
  if (!found?.memory) return null;
  const text = String(found.memory.content ?? '');
  if (text.length <= maxChars) return null;
  const mid = Math.floor(text.length / 2);
  let cut = -1;
  for (let d = 0; d < 300 && cut < 0; d += 1) {
    for (const i of [mid + d, mid - d]) {
      if (i > 120 && i < text.length - 120) {
        const ch = text[i];
        if (ch === '。' || ch === '；' || ch === '\n') {
          cut = i + 1;
          break;
        }
      }
    }
  }
  if (cut < 0) cut = mid;
  const head = text.slice(0, cut).trim();
  const tail = text.slice(cut).trim();
  if (head.length < 80 || tail.length < 80) return null;
  updateMemory(db, found.level, id, { content: head });
  const created = insertMemory(db, found.level, {
    title: `${found.memory.title ?? ''}（续）`,
    content: tail,
    importance: found.memory.importance,
    keywords: found.memory.keywords,
    status: found.memory.status,
    project: found.memory.project
  });
  addRelation(db, id, created.id, 'same_topic');
  addRelation(db, created.id, id, 'same_topic');
  // tail 一并返回：调用方（memory_dream / /dream）要拿它补向量，否则新条只有词法通道
  return { id, newId: created.id, headLen: head.length, tailLen: tail.length, tail };
}

// ── 沉淀候选：哪些 lesson/rules 可能该进技能（只列，不改任何文件）────────────
const SKILL_HINTS = ['dsh','memory-collab','skill-authoring','windows','bili-transcript','doc-parsing','html-card','study-flow','study-intake','good-learning','shopping-guide'];
const METHOD_WORDS = /必须|应该|不要|判据|步骤|先|再|然后|否则|正确做法|坑|报错|症状|红线|注意/;
const SUNK_MARK = /已写进|沉淀到|见 skill|归入技能|已归技能/;

let _skillTokens = null;
function loadSkillTokens() {
  if (_skillTokens) return _skillTokens;
  _skillTokens = new Map();
  const dir = process.env.MEOW_MIND_SKILLS_DIR || join(homedir(), '.agents', 'skills');
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const f = join(dir, e.name, 'SKILL.md');
      if (!existsSync(f)) continue;
      try { _skillTokens.set(e.name, new Set(tokenize(readFileSync(f, 'utf8')))); } catch { /* 单个技能读失败不影响其余 */ }
    }
  } catch { /* 没有技能目录就当没有已沉淀内容 */ }
  return _skillTokens;
}

// 沉淀候选：最近新写的 lesson/rules 里像「方法/坑」、且与现有技能内容重合度不高的
// 重合度高 = 已经写进技能了，不该再列；中等 = 猜它该进哪个技能。只列，不改任何文件。
export function findSinkCandidates(db, limit = 5, sinceDays = 1) {
  const since = Date.now() - sinceDays * 86400000;
  const skills = loadSkillTokens();
  const out = [];
  for (const lv of ['lesson', 'principle', 'rules']) {
    let rows = [];
    try { rows = db.prepare(`SELECT id, title, content, status, created_at FROM ${lv} WHERE status = 'memory'`).all(); } catch { continue; }
    for (const r of rows) {
      const c = String(r.content ?? '');
      if (c.length < 60) continue;
      const ts = parseStamp(r.created_at);
      if (ts > 0 && ts < since) continue;
      if (!METHOD_WORDS.test(c)) continue;
      if (SUNK_MARK.test(c)) continue;
      const cand = new Set(tokenize(c));
      let best = 0;
      let bestName = null;
      for (const [name, set] of skills) {
        let inter = 0;
        for (const w of cand) if (set.has(w)) inter++;
        const ratio = inter / Math.max(1, cand.size);
        if (ratio > best) { best = ratio; bestName = name; }
      }
      if (best > 0.5) continue;              // 已经写进技能了
      out.push({ id: r.id, level: lv, title: r.title ?? '', chars: c.length, hintSkill: best > 0.12 ? bestName : null, overlap: Number(best.toFixed(2)) });
    }
  }
  out.sort((a, b) => (b.hintSkill ? 1 : 0) - (a.hintSkill ? 1 : 0) || b.chars - a.chars);
  return { total: out.length, items: out.slice(0, limit) };
}

// ── 插件侧沉淀候选：记忆里提到的符号在自建插件源码里 grep 不到 ──────────────
// 技能侧比的是 token 重合率（都是自然语言）；插件是代码，重合率没意义，改比「符号」：
// 如果一条记忆点名了某个函数名 / 配置键 / 报错串，而所有自建插件源码里都找不到它，
// 那要么是插件缺这个能力，要么是行为已经变了。只列不改，假阳率高但能捞真缺口。
export function parseStamp(v) {
  if (v == null) return 0;
  let t = Date.parse(v);
  if (Number.isNaN(t)) {
    const n = Number(v);
    // 早期批量写入曾存微秒（17 位），先折回毫秒，否则会被当成未来时间
    if (Number.isFinite(n)) t = n > 1e14 ? n / 1000 : n;
  }
  return Number.isNaN(t) ? 0 : t;
}

// 给工具输出用：统一成本机时区的「2026-11-21 16:39」，取不到就返回 null。
// 库里的时间戳混着 ISO 字符串与毫秒数字（旧库迁来），所以两条路都要认。
const TIME_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});
export function fmtStamp(v) {
  const t = parseStamp(v);
  if (!t) return null;
  return TIME_FMT.format(new Date(t));
}

// ── 工具问题（2026-11-23 加）─────────────────────────────────────────
// 三条约束：不记参数值；同签名 24 小时内只累加计数；任何失败都由调用方静默吞掉。

/** 记一条工具问题。返回 { id, duplicated, count }；出错时由调用方 try/catch 兜住。 */
export function recordToolIssue(db, { tool, error, paramNames = [], sessionCode = '', sourceSession = null } = {}) {
  if (!db || !tool) return null;
  const msg = String(error && error.message ? error.message : error ?? '').slice(0, 500);
  const firstLine = msg.split('\n')[0].slice(0, 80);
  const signature = tool + '::' + firstLine;
  const ts = nowIso();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const recent = db
    .prepare('SELECT id, count FROM tool_issues WHERE signature = ? AND updated_at > ? ORDER BY updated_at DESC LIMIT 1')
    .get(signature, since);
  if (recent) {
    db.prepare('UPDATE tool_issues SET count = count + 1, updated_at = ?, error = ? WHERE id = ?').run(ts, msg, recent.id);
    return { id: recent.id, duplicated: true, count: recent.count + 1 };
  }
  const id = nextId();
  db.prepare(
    `INSERT INTO tool_issues (id, tool, signature, error, param_names, session_code, source_session, count, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,1,'open',?,?)`,
  ).run(id, tool, signature, msg, JSON.stringify(Array.isArray(paramNames) ? paramNames : []), sessionCode, sourceSession, ts, ts);
  return { id, duplicated: false, count: 1 };
}

/** 列问题；默认只看未处理的。 */
export function listToolIssues(db, { status = 'open', limit = 20 } = {}) {
  if (!db) return [];
  try {
    const rows = status
      ? db.prepare('SELECT * FROM tool_issues WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, limit)
      : db.prepare('SELECT * FROM tool_issues ORDER BY updated_at DESC LIMIT ?').all(limit);
    return rows.map((r) => ({
      ...r,
      param_names: (() => { try { return JSON.parse(r.param_names || '[]'); } catch { return []; } })(),
    }));
  } catch {
    return [];
  }
}

/** 标已修 / 忽略 / 重新打开。 */
export function markToolIssue(db, id, status) {
  const allowed = ['open', 'fixed', 'ignored'];
  if (!db || !allowed.includes(status)) return null;
  const row = db.prepare('SELECT id FROM tool_issues WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('UPDATE tool_issues SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
  return { id, status };
}

/** 统计：未处理条数 / 涉及几个工具 / 总发生次数。 */
export function toolIssueStats(db) {
  if (!db) return { open: 0, tools: 0, hits: 0 };
  try {
    const open = db.prepare("SELECT COUNT(*) c FROM tool_issues WHERE status = 'open'").get().c;
    const tools = db.prepare("SELECT COUNT(DISTINCT tool) c FROM tool_issues WHERE status = 'open'").get().c;
    const hits = db.prepare("SELECT COALESCE(SUM(count), 0) c FROM tool_issues WHERE status = 'open'").get().c;
    return { open, tools, hits };
  } catch {
    return { open: 0, tools: 0, hits: 0 };
  }
}
