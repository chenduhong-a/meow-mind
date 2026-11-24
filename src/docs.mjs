// 共享库样板（global_doc）：需要时才读的长文，进全局库，不散在文件里。
//
// 为什么单独一张表，不塞进 rules/lesson：
// - 样板是「流程与判据的完整版」，长度以 KB 计，进检索与注入只会挤掉结论；
// - 想要的读法是「我知道它存在，用的时候整篇取回」，与记忆的「命中片段」正相反。
// 判据一句话：这条内容要整套读完才有用 → 样板；只取一句就够 → 记忆。
import { openGlobal } from './db.mjs';
import { nowIso } from './db.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS global_doc (
  name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** 老库自动补表；全局库未启用时返回 null。 */
export function ensureDocTable(db) {
  if (!db) return null;
  db.exec(SCHEMA);
  return db;
}

function withDb(cfg) {
  const g = openGlobal(cfg);
  if (!g) return { db: null, error: '全局库未启用（globalDir 为空）' };
  ensureDocTable(g.db);
  return { db: g.db, error: null };
}

export function putDoc(cfg, { name, title, summary = '', body } = {}) {
  const { db, error } = withDb(cfg);
  if (error) return { ok: false, error };
  const key = String(name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(key)) return { ok: false, error: 'name 只能用小写字母、数字与连字符（2–40 位）' };
  const text = String(body ?? '').trim();
  if (!text) return { ok: false, error: 'body 不能为空' };
  const t = String(title ?? '').trim() || key;
  const s = String(summary ?? '').trim() || text.slice(0, 80).replace(/\s+/g, ' ');
  db.prepare('INSERT OR REPLACE INTO global_doc(name, title, summary, body, updated_at) VALUES (?,?,?,?,?)').run(key, t, s, text, nowIso());
  return { ok: true, name: key, title: t, chars: text.length, updated: true };
}

export function getDoc(cfg, name) {
  const { db, error } = withDb(cfg);
  if (error) return { ok: false, error };
  const row = db.prepare('SELECT name, title, summary, body, updated_at FROM global_doc WHERE name = ?').get(String(name ?? '').trim());
  if (!row) return { ok: false, error: `没有名为 ${name} 的样板（用 memory_doc list 看有哪些）` };
  return { ok: true, doc: row };
}

export function listDocs(cfg) {
  const { db, error } = withDb(cfg);
  if (error) return { ok: false, error, items: [] };
  const items = db.prepare('SELECT name, title, summary, length(body) AS chars, updated_at FROM global_doc ORDER BY name').all();
  return { ok: true, total: items.length, items };
}

export function delDoc(cfg, name) {
  const { db, error } = withDb(cfg);
  if (error) return { ok: false, error };
  const r = db.prepare('DELETE FROM global_doc WHERE name = ?').run(String(name ?? '').trim());
  return r.changes > 0 ? { ok: true, name, deleted: true } : { ok: false, error: `没有名为 ${name} 的样板` };
}

/** 给首轮注入用的一行提示（不列正文，只列名字）。 */
export function docIndexLine(cfg) {
  const list = listDocs(cfg);
  if (!list.ok || !list.items.length) return '';
  const names = list.items.map((d) => `${d.name}（${d.title}，${d.chars} 字）`).join('、');
  return `共享库样板 ${list.items.length} 份：${names}。要看全文用 memory_doc get(name)，不要凭印象回答。`;
}

export function renderDocs(items) {
  if (!items?.length) return '（共享库里还没有样板）';
  return items.map((d) => `- ${d.name} · ${d.title}（${d.chars} 字，改于 ${String(d.updated_at ?? '').slice(0, 16).replace('T', ' ')}）\n  ${d.summary}`).join('\n');
}
