import fs from 'node:fs';
import path from 'node:path';
import { sessionCode } from './code.mjs';
import { fmtStamp, parseStamp } from './store.mjs';
import { tableOf } from './db.mjs';

/**
 * 记忆审议（side review）：给侧边栏用的「逐条标记有用 / 无用」后端。
 *
 * 与 memory_feedback 的分工：那个是模型侧的自我降级（wrong → review），
 * 这个是**用户当面审议**，标记只写 marks 表，不动记忆状态——用户标记完
 * 再决定怎么处置（删 / 改 / 提升）。两者互不覆盖。
 */

const MARK_DDL = `
CREATE TABLE IF NOT EXISTS memory_marks (
  id        TEXT PRIMARY KEY,
  verdict   TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  note      TEXT
);
CREATE INDEX IF NOT EXISTS idx_marks_verdict ON memory_marks(verdict);
CREATE INDEX IF NOT EXISTS idx_marks_time    ON memory_marks(marked_at);
`;

/** 层的中文名与排序，与侧边栏展示一致。 */
export const REVIEW_LEVELS = [
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

export function ensureMarkTable(db) {
  db.exec(MARK_DDL);
  // 老库没有 note 列（2026-11-21 加），补一次；已存在时 SQLite 会抛错，忽略即可
  try {
    db.exec('ALTER TABLE memory_marks ADD COLUMN note TEXT');
  } catch {
    /* 列已存在 */
  }
}

/**
 * 按层取候选条目，带上已有标记。
 *
 * @param {object} db     DatabaseSync
 * @param {object} [opts]
 * @param {string} [opts.verdict]  '', 'useful', 'useless', 'unmarked'
 * @param {string} [opts.level]    限定某一层
 * @param {number} [opts.limit]    每层上限（默认 200）
 */
export function listForReview(db, opts = {}) {
  ensureMarkTable(db);
  const verdict = String(opts.verdict ?? 'all');
  const onlyLevel = String(opts.level ?? 'all');
  const per = Math.max(1, Math.min(500, Number(opts.limit) || 200));
  // 时间窗：0 = 不限。库里 created_at / updated_at 混着 ISO 与毫秒数字（还有个别微秒），
  // 不能直接拿 SQL 比大小，统一交给 parseStamp 折成毫秒再筛。
  const days = Math.max(0, Number(opts.days) || 0);
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  const marks = new Map();
  for (const row of db.prepare('SELECT id, verdict, marked_at, note FROM memory_marks').all()) {
    marks.set(String(row.id), { verdict: String(row.verdict), markedAt: String(row.marked_at), note: String(row.note ?? '') });
  }
  const groups = [];
  let total = 0;
  for (const [level, label] of REVIEW_LEVELS) {
    if (onlyLevel !== 'all' && level !== onlyLevel) continue;
    let rows = [];
    try {
      rows = db
        .prepare(
          `SELECT id, title, content, status, project, importance, created_at, updated_at, source_session FROM ${tableOf(level)} ` +
            "WHERE status = 'memory' ORDER BY updated_at DESC"
        )
        .all();
    } catch {
      continue;
    }
    const items = [];
    for (const row of rows) {
      const id = String(row.id);
      const mark = marks.get(id);
      const v = mark ? mark.verdict : '';
      if (verdict === 'unmarked' && v !== '') continue;
      if (verdict !== 'all' && verdict !== 'unmarked' && v !== verdict) continue;
      if (cutoff) {
        const stamp = parseStamp(row.updated_at) || parseStamp(row.created_at);
        if (!stamp || stamp < cutoff) continue;
      }
      const content = String(row.content ?? '');
      // 卡片上要显示「什么时候写的」：库里混着 ISO 与毫秒数字，交给 fmtStamp 统一
      const writtenAt = fmtStamp(row.created_at) || fmtStamp(row.updated_at) || '';
      const updatedText = fmtStamp(row.updated_at) || writtenAt;
      items.push({
        id,
        level,
        title: String(row.title ?? '') || content.slice(0, 40),
        writtenAt,
        updatedText,
        snippet: content.length > 320 ? `${content.slice(0, 320)}…` : content,
        chars: content.length,
        status: String(row.status ?? ''),
        project: String(row.project ?? ''),
        importance: Number(row.importance) || 0,
        updatedAt: String(row.updated_at ?? ''),
        author: sessionCode(row.source_session),
        authorSession: row.source_session ? String(row.source_session) : '',
        verdict: v,
        note: mark ? mark.note : '',
        markedAt: mark ? mark.markedAt : '',
      });
      if (items.length >= per) break;
    }
    total += items.length;
    groups.push({ level, label, count: items.length, items });
  }
  return { ok: true, total, groups, marks: marks.size, days };
}

/** 写或清除一条标记。verdict 传空串即撤销。 */
export function markForReview(db, { id, verdict, note }) {
  ensureMarkTable(db);
  const key = String(id ?? '').trim();
  if (!key) return { ok: false, error: 'id 不能为空' };
  const v = String(verdict ?? '').trim();
  const hasNote = note !== undefined && note !== null;
  const n = hasNote ? String(note).slice(0, 4000) : undefined;
  const touchedAt = new Date().toISOString();

  if (v === '') {
    // 撤销标记；但若同时带了评语，就只把 verdict 清空、评语留着
    if (hasNote && n.trim() !== '') {
      db.prepare(
        'INSERT INTO memory_marks (id, verdict, marked_at, note) VALUES (?, ?, ?, ?) ' +
          "ON CONFLICT(id) DO UPDATE SET verdict = '', marked_at = excluded.marked_at, note = excluded.note"
      ).run(key, '', touchedAt, n);
      return { ok: true, id: key, verdict: '', note: n };
    }
    db.prepare('DELETE FROM memory_marks WHERE id = ?').run(key);
    return { ok: true, id: key, verdict: '', note: '' };
  }
  if (v !== 'useful' && v !== 'useless') return { ok: false, error: `未知 verdict: ${v}` };

  if (hasNote) {
    db.prepare(
      'INSERT INTO memory_marks (id, verdict, marked_at, note) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET verdict = excluded.verdict, marked_at = excluded.marked_at, note = excluded.note'
    ).run(key, v, touchedAt, n);
    return { ok: true, id: key, verdict: v, note: n };
  }
  db.prepare(
    'INSERT INTO memory_marks (id, verdict, marked_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET verdict = excluded.verdict, marked_at = excluded.marked_at'
  ).run(key, v, touchedAt);
  return { ok: true, id: key, verdict: v };
}

/** 汇总：各标记的数量，给侧边栏顶部条用。 */
export function reviewStats(db) {
  ensureMarkTable(db);
  const counts = { useful: 0, useless: 0, total: 0, archived: 0 };
  const alive = new Set();
  for (const [level] of REVIEW_LEVELS) {
    try {
        for (const row of db.prepare(`SELECT id FROM ${tableOf(level)} WHERE status = 'memory'`).all()) {
        alive.add(String(row.id));
      }
    } catch {
      /* 该层不存在 */
    }
  }
  for (const row of db.prepare('SELECT id, verdict FROM memory_marks').all()) {
    if (!alive.has(String(row.id))) {
      counts.archived += 1;
      continue;
    }
    const v = String(row.verdict);
    if (v in counts) counts[v] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * 按标记处置：把「无用」的条目标成 review（不删，等用户二次确认），
 * 「有用」的提升 importance +1（封顶 4）。返回处理条数。
 */
export function applyMarks(db, { verdict, dryRun = true } = {}) {
  ensureMarkTable(db);
  const v = String(verdict ?? '').trim();
  if (v !== 'useful' && v !== 'useless') return { ok: false, error: 'verdict 只能是 useful / useless' };
  const ids = db.prepare('SELECT id FROM memory_marks WHERE verdict = ?').all(v).map((r) => String(r.id));
  const out = { ok: true, verdict: v, dryRun, touched: 0, skipped: 0 };
  for (const id of ids) {
    let found = false;
    for (const [level] of REVIEW_LEVELS) {
      let row;
      try {
        row = db.prepare(`SELECT id, importance, status FROM ${tableOf(level)} WHERE id = ?`).get(id);
      } catch {
        continue;
      }
      if (!row) continue;
      found = true;
      if (row.status !== 'memory') {
        // 已归档（review）的条目不再参与处置：审议页也看不到它
        break;
      }
      if (dryRun) break;
      const now = new Date().toISOString();
      if (v === 'useless') {
        db.prepare(`UPDATE ${tableOf(level)} SET status = 'review', updated_at = ? WHERE id = ?`).run(now, id);
      } else {
        const next = Math.min(4, (Number(row.importance) || 0) + 1);
        db.prepare(`UPDATE ${tableOf(level)} SET importance = ?, updated_at = ? WHERE id = ?`).run(next, now, id);
      }
      break;
    }
    if (found) out.touched += 1;
    else out.skipped += 1;
  }
  return out;
}

export function listReviewDbs(root = 'C:/deepseek') {
  const out = [];
  const stat = (p) => {
    try {
      const s = fs.statSync(p);
      return { size: s.size, mtime: s.mtime.toISOString() };
    } catch {
      return { size: 0, mtime: null };
    }
  };
  const push = (id, label, p, global) => {
    const { size, mtime } = stat(p);
    out.push({ id, label, path: p, global, size, mtime });
  };
  const g = path.join(root, '.dsh-mind-global', 'memory.db');
  if (fs.existsSync(g)) push('global', '全局库', g, true);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const p = path.join(root, name, '.dsh-mind', 'memory.db');
    if (fs.existsSync(p)) push(`ws:${name}`, name, p, false);
  }
  return out;
}
