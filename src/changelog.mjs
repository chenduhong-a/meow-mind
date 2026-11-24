// 变更流水（版本升级日志）：属于记忆插件的一部分，但不进记忆层。
// 为什么单独一张表：事件史只在回溯时有用，混进记忆层会占检索面、拉低命中精度，
// 还会让「当前状态」与「历史事件」混在一起——升级三次后记忆里留着三份互相矛盾的版本号。
// 判据：这条写的是「某天升到了哪版」→ 记这里；「以后该怎么做」→ 记记忆层。
import { randomUUID } from 'node:crypto';

const pad = (n) => String(n).padStart(2, '0');

/** 本地日期（Asia/Shanghai 语义，与其它工具一致用本地时区）。 */
export function today(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ensureLogTable(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS change_log (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT,
  note TEXT,
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_day ON change_log(day DESC);
CREATE INDEX IF NOT EXISTS idx_change_subject ON change_log(subject);
`);
}

export function addLog(db, entry = {}) {
  ensureLogTable(db);
  const subject = String(entry.subject ?? '').trim();
  if (!subject) throw new Error('subject 必填（升的是哪个包/哪个东西）');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(entry.day ?? '')) ? String(entry.day) : today();
  const from = entry.from ? String(entry.from).trim() : null;
  const to = entry.to ? String(entry.to).trim() : null;
  const note = entry.note ? String(entry.note).trim() : null;
  const source = entry.source ? String(entry.source).trim() : null;
  const id = nextLogId(db);
  db.prepare('INSERT INTO change_log (id, day, subject, from_version, to_version, note, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, day, subject, from, to, note, source, Date.now());
  return { ok: true, id, day, subject, from, to, note, source };
}

function nextLogId(db) {
  // 与记忆层同风格：时间戳前缀 + uuid，排序即时间序
  return `cl-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function listLog(db, opts = {}) {
  ensureLogTable(db);
  const where = [];
  const params = [];
  if (opts.since) { where.push('day >= ?'); params.push(String(opts.since)); }
  if (opts.until) { where.push('day <= ?'); params.push(String(opts.until)); }
  if (opts.subject) { where.push('subject LIKE ?'); params.push(`%${String(opts.subject)}%`); }
  if (opts.query) {
    where.push('(subject LIKE ? OR note LIKE ? OR from_version LIKE ? OR to_version LIKE ?)');
    const q = `%${String(opts.query)}%`;
    params.push(q, q, q, q);
  }
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 30));
  const sql = `SELECT * FROM change_log${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY day DESC, created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit);
  return { ok: true, total: rows.length, items: rows.map(formatRow) };
}

export function removeLog(db, id) {
  ensureLogTable(db);
  const r = db.prepare('DELETE FROM change_log WHERE id = ?').run(String(id ?? ''));
  return { ok: true, removed: Number(r.changes) || 0 };
}

export function logStats(db) {
  ensureLogTable(db);
  const n = db.prepare('SELECT COUNT(*) n FROM change_log').get()?.n ?? 0;
  const first = db.prepare('SELECT MIN(day) d FROM change_log').get()?.d ?? null;
  const last = db.prepare('SELECT MAX(day) d FROM change_log').get()?.d ?? null;
  return { entries: n, since: first, until: last };
}

export function formatRow(r) {
  const ver = r.from_version && r.to_version && r.from_version !== r.to_version
    ? `${r.from_version} → ${r.to_version}`
    : (r.to_version || r.from_version || '');
  return {
    id: r.id,
    day: r.day,
    subject: r.subject,
    version: ver,
    note: r.note ?? '',
    source: r.source ?? ''
  };
}

/** 纯文本渲染，给斜杠指令与工具 render 用。 */
export function renderLog(list) {
  if (!list.length) return '还没有记录。';
  const out = [];
  let day = '';
  for (const it of list) {
    if (it.day !== day) { day = it.day; out.push(`\n${day}`); }
    const tail = it.note ? ` · ${it.note}` : '';
    out.push(`  ${it.subject}${it.version ? ' ' + it.version : ''}${tail}`);
  }
  return out.join('\n').trim();
}
