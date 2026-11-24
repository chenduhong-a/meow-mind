// 用户画像：结构化分节 + 可持续迭代
import { tableOf } from './db.mjs';
// 参考：Memobase（topic/sub_topic + merge 三动作 + ≤5 句）、Letta Code（revision not append）、
//      Zep（5 条问句）、Mnemosyne 2.0（暂时状态不直接变永久）
// 与 user 层的关系：user 层是「证据」，影像是「结论」。改影像不删证据。

const PROFILE_ID = 'default';

// 8 个分节。前六个从 19 条既有偏好归纳而来，后两个预留。
export const TOPICS = [
  ['identity', '身份'],
  ['workflow', '工作方式'],
  ['delivery', '交付偏好'],
  ['tradeoff', '取舍标准'],
  ['communication', '沟通风格'],
  ['info', '查证偏好'],
  ['goal', '长期目标']
];

export const TOPIC_LABEL = Object.fromEntries(TOPICS);

// 分节内子项的人工排序（不按字母序，按「先说人、再说事、最后说禁忌」的阅读顺序）
const SUB_ORDER = {
  identity: ['person', 'direction', 'body'],
  workflow: ['plan-first', 'criteria-first', 'subagent', 'review'],
  delivery: ['card-plus-text', 'single-file', 'order', 'format'],
  tradeoff: ['minimal', 'delete-hard', 'evaluate-first', 'upgrade', 'native', 'consolidate', 'other'],
  communication: ['chinese'],
  info: ['verify', 'bilibili', 'search', 'other'],
  goal: ['grad']
};

function orderOf(topic, subTopic) {
  const list = SUB_ORDER[topic] || [];
  const i = list.indexOf(subTopic);
  return i === -1 ? list.length + 1 : i;
}

const DDL = `
CREATE TABLE IF NOT EXISTS user_profile (
  id          TEXT PRIMARY KEY,
  narrative   TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profile_section (
  profile_id    TEXT NOT NULL,
  topic         TEXT NOT NULL,
  sub_topic     TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  confidence    INTEGER NOT NULL DEFAULT 1,
  mention_dates TEXT NOT NULL DEFAULT '[]',
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (profile_id, topic, sub_topic)
);

CREATE TABLE IF NOT EXISTS user_profile_cursor (
  id             TEXT PRIMARY KEY,
  last_memory_at TEXT NOT NULL,
  last_memory_id TEXT,
  updated_at     TEXT NOT NULL
);
`;

const nowIso = () => new Date().toISOString();

export function ensureProfileTables(db) {
  db.exec(DDL);
}

function ensureRow(db) {
  const t = nowIso();
  db.prepare(
    'INSERT INTO user_profile(id, narrative, version, updated_at) VALUES(?, ?, 1, ?) ON CONFLICT(id) DO NOTHING'
  ).run(PROFILE_ID, '', t);
}

/** 读整份画像：一行 narrative + 全部分节 */
export function getProfile(db) {
  ensureProfileTables(db);
  ensureRow(db);
  const head = db.prepare('SELECT narrative, version, updated_at FROM user_profile WHERE id = ?').get(PROFILE_ID);
  const rows = db.prepare(
    'SELECT topic, sub_topic, content, confidence, mention_dates, updated_at FROM user_profile_section WHERE profile_id = ? ORDER BY topic, sub_topic'
  ).all(PROFILE_ID);
  const sections = rows.map((r) => ({
    topic: r.topic,
    label: TOPIC_LABEL[r.topic] || r.topic,
    subTopic: r.sub_topic,
    content: r.content,
    confidence: Number(r.confidence) || 1,
    mentionDates: safeJson(r.mention_dates),
    updatedAt: r.updated_at
  }));
  return {
    narrative: head?.narrative ?? '',
    version: Number(head?.version) || 1,
    updatedAt: head?.updated_at ?? '',
    sections,
    counts: countByTopic(sections)
  };
}

function safeJson(v) {
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function countByTopic(sections) {
  const out = {};
  for (const s of sections) out[s.topic] = (out[s.topic] || 0) + 1;
  return out;
}

/**
 * 写一个分节。
 * @param {object} opts { topic, subTopic='', content, mentionDate, merge }
 *   merge='append'（默认）内容相同则累加 confidence，不同则拼接；
 *   merge='replace'（旧名 'update' 仍兼容）整条覆盖——旧结论被修正时用；
 *   merge='abort' 丢弃本节，不写库。
 */
export function upsertSection(db, opts) {
  ensureProfileTables(db);
  ensureRow(db);
  const topic = String(opts.topic ?? '').trim();
  if (!TOPIC_LABEL[topic]) throw new Error(`未知分节: ${topic}`);
  const subTopic = String(opts.subTopic ?? '').trim();
  const content = String(opts.content ?? '').trim();
  if (!content) throw new Error('content 不能为空');
  const t = nowIso();
  // abort＝明确丢弃这一节：不写库、不改 confidence（2026-11-22 修：原先这行在 prev 判断之后，
  // 首次写入时 merge=abort 仍会 INSERT 一条，语义上 abort 必须连首次写入一起挡掉）
  if (opts.merge === 'abort') return { ok: true, action: 'abort' };
  const prev = db.prepare(
    'SELECT content, confidence, mention_dates FROM user_profile_section WHERE profile_id = ? AND topic = ? AND sub_topic = ?'
  ).get(PROFILE_ID, topic, subTopic);

  if (!prev) {
    db.prepare(
      'INSERT INTO user_profile_section(profile_id, topic, sub_topic, content, confidence, mention_dates, updated_at) VALUES(?,?,?,?,1,?,?)'
    ).run(PROFILE_ID, topic, subTopic, content, JSON.stringify(opts.mentionDate ? [opts.mentionDate] : []), t);
    return { ok: true, action: 'append' };
  }

  const dates = safeJson(prev.mention_dates);
  if (opts.mentionDate && !dates.includes(opts.mentionDate)) dates.push(opts.mentionDate);
  const keepDates = JSON.stringify(dates.slice(-20));

  // abort 已在前面拦截（首次写入也挡掉），这里不再判断 merge
  if (opts.merge === 'replace' || opts.merge === 'update') {
    db.prepare(
      'UPDATE user_profile_section SET content = ?, confidence = 1, mention_dates = ?, updated_at = ? WHERE profile_id = ? AND topic = ? AND sub_topic = ?'
    ).run(content, keepDates, t, PROFILE_ID, topic, subTopic);
    return { ok: true, action: 'replace' };
  }

  // 默认：内容相同则只提升置信度；内容不同则追加（用「；」连接，≤5 句由调用方控制）
  if (prev.content === content) {
    db.prepare(
      'UPDATE user_profile_section SET confidence = confidence + 1, mention_dates = ?, updated_at = ? WHERE profile_id = ? AND topic = ? AND sub_topic = ?'
    ).run(keepDates, t, PROFILE_ID, topic, subTopic);
    return { ok: true, action: 'confirm', confidence: (Number(prev.confidence) || 1) + 1 };
  }
  const trimTail = (x) => String(x).replace(/[。；;，,、\s]+$/g, '');
  const merged = `${trimTail(prev.content)}；${trimTail(content)}`.slice(0, 1200);
  db.prepare(
    'UPDATE user_profile_section SET content = ?, confidence = confidence + 1, mention_dates = ?, updated_at = ? WHERE profile_id = ? AND topic = ? AND sub_topic = ?'
  ).run(merged, keepDates, t, PROFILE_ID, topic, subTopic);
  return { ok: true, action: 'merge' };
}

export function deleteSection(db, topic, subTopic = '') {
  ensureProfileTables(db);
  const r = db.prepare('DELETE FROM user_profile_section WHERE profile_id = ? AND topic = ? AND sub_topic = ?')
    .run(PROFILE_ID, topic, subTopic);
  return { ok: true, removed: Number(r.changes) || 0 };
}

/** 由分节拼出整段叙事（注入用）。空分节跳过。 */
export function buildNarrative(db) {
  const p = getProfile(db);
  const lines = [];
  for (const [topic, label] of TOPICS) {
    const items = p.sections
      .filter((s) => s.topic === topic)
      .sort((a, b) => orderOf(topic, a.subTopic) - orderOf(topic, b.subTopic));
    if (items.length === 0) continue;
    lines.push(`### ${label}`);
    for (const it of items) {
      const tag = it.confidence > 1 ? `（印证 ${it.confidence} 次）` : '';
      lines.push(`- ${it.content}${tag}`);
    }
  }
  return lines.join('\n');
}

/**
 * 精简版叙事：注入用。每个分节最多 take 条，优先 confidence 高的。
 * 完整版留在分节表里，需要时按 topic 查。
 */
export function buildBriefNarrative(db, { take = 2, maxChars = 900 } = {}) {
  const p = getProfile(db);
  const lines = [];
  for (const [topic, label] of TOPICS) {
    const items = p.sections
      .filter((s) => s.topic === topic)
      .sort((a, b) => {
        const d = orderOf(topic, a.subTopic) - orderOf(topic, b.subTopic);
        return d !== 0 ? d : b.confidence - a.confidence;
      })
      .slice(0, take);
    if (items.length === 0) continue;
    lines.push(`### ${label}`);
    for (const it of items) lines.push(`- ${it.content}`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) {
    const cut = text.lastIndexOf('\n', maxChars);
    text = `${text.slice(0, cut > 0 ? cut : maxChars)}\n…（其余分节按需查）`;
  }
  return text;
}

/** 重写 narrative 并 +1 版本 */
export function refreshNarrative(db) {
  const text = buildNarrative(db);
  const t = nowIso();
  ensureRow(db);
  db.prepare('UPDATE user_profile SET narrative = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .run(text, t, PROFILE_ID);
  return { ok: true, narrative: text, chars: text.length };
}

/** dream 游标：记录已提炼到哪条记忆，避免重复处理 */
export function getCursor(db) {
  ensureProfileTables(db);
  const r = db.prepare('SELECT last_memory_at, last_memory_id FROM user_profile_cursor WHERE id = ?').get('dream');
  return { lastMemoryAt: r?.last_memory_at ?? '', lastMemoryId: r?.last_memory_id ?? '' };
}

export function setCursor(db, { lastMemoryAt, lastMemoryId = '' }) {
  ensureProfileTables(db);
  db.prepare(
    'INSERT INTO user_profile_cursor(id, last_memory_at, last_memory_id, updated_at) VALUES(?,?,?,?) ' +
    'ON CONFLICT(id) DO UPDATE SET last_memory_at = excluded.last_memory_at, last_memory_id = excluded.last_memory_id, updated_at = excluded.updated_at'
  ).run('dream', String(lastMemoryAt), String(lastMemoryId), nowIso());
  return { ok: true };
}

/** 找出在该游标之后更新过的 user 层记忆（待提炼候选） */
export function pendingMemories(db, opts = {}) {
  const o = typeof opts === 'number' ? { limit: opts } : opts;
  const level = o.level ?? 'user';
  const limit = o.limit ?? 50;
  const cur = getCursor(db);
  const rows = db.prepare(
    `SELECT id, title, content, importance, updated_at FROM ${tableOf(level)}
     WHERE status = 'memory' AND updated_at > ?
     ORDER BY updated_at ASC LIMIT ?`
  ).all(cur.lastMemoryAt || '0000', limit);
  return { cursor: cur, items: rows };
}

/**
 * 冲突扫描：找出同 topic 内内容互相矛盾的条目。
 * 判据刻意保守——只认「明确对立词」与「数字冲突」，宁可漏报不可乱报。
 */
const OPPOSE = [
  ['要', '不要'], ['应该', '不应该'], ['喜欢', '不喜欢'], ['用', '不用'],
  ['保留', '删除'], ['全升', '保守'], ['独立文件', '只在对话'],
  ['先做', '先问'], ['自动', '手动']
];

export function findConflicts(db) {
  const p = getProfile(db);
  const out = [];
  for (const [topic, label] of TOPICS) {
    const items = p.sections.filter((s) => s.topic === topic);
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        for (const [x, y] of OPPOSE) {
          const aHas = a.content.includes(x) && !a.content.includes(y);
          const bHas = b.content.includes(y) && !b.content.includes(x);
          if (aHas && bHas) {
            out.push({
              topic, label,
              a: { subTopic: a.subTopic, content: a.content },
              b: { subTopic: b.subTopic, content: b.content },
              reason: `「${x}」与「${y}」对立（词面判据，可能误报，需人工确认）`,
              suspected: true
            });
            break;
          }
        }
      }
    }
  }
  return { ok: true, total: out.length, suspected: out.length, note: '词面判据（OPPOSE 词对 + includes），全部结果需人工确认', conflicts: out };
}
