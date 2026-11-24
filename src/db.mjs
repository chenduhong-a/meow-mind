// 打开/建库/迁移。单文件 SQLite，WAL，零外部依赖（node:sqlite）。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'principle', 'topic', 'rules', 'todo'];
export const STATUSES = ['observation', 'evidence', 'candidate', 'memory', 'review'];

// 新四类不进 LEVELS：它们的表结构不同于九层，不参与上面那套建表循环，
// 但检索侧要认识它们（levelOf / loadRow 按名字查表），所以并列一个 KINDS 给 bm25 用。
export const EXTRA_KINDS = ['episode', 'phase', 'decision', 'persona'];
export const KINDS = [...LEVELS, ...EXTRA_KINDS];

// 参与「同主题边」与「找相似」的 kind：九层 + 时间线里带 keywords/content 的三类。
// personas 不在内——它只有 name/description，没有 keywords，也不该跟记忆建同主题边。
export const LINKABLE_KINDS = [...LEVELS, 'episode', 'phase', 'decision'];

// kind 与表名不同名：时间线三张表是复数。全目录唯一映射源——
// store / bm25 / review / profile 都从这里取，别再各写一份（2026-11-23 审计：原先散在三处）。
export const TABLE_OF = { episode: 'episodes', phase: 'phases', decision: 'decisions', persona: 'personas', 'persona-trait': 'persona_traits' };
export const tableOf = (kind) => TABLE_OF[kind] ?? kind;

const SCHEMA_VERSION = 5;

const LEVEL_DDL = (name, extra = '') => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'memory',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT
  ${extra}
);
CREATE INDEX IF NOT EXISTS idx_${name}_status ON ${name}(status);
CREATE INDEX IF NOT EXISTS idx_${name}_updated ON ${name}(updated_at);
`;

const COMMON_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  turn_id TEXT,
  kind TEXT NOT NULL,
  level TEXT,
  payload TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, created_at);

CREATE TABLE IF NOT EXISTS memory_evidence (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  event_id TEXT,
  stance TEXT NOT NULL DEFAULT 'supported',
  source_kind TEXT NOT NULL,
  quote TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_memory ON memory_evidence(memory_id);

CREATE TABLE IF NOT EXISTS memory_relations (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_relations_to ON memory_relations(to_id);

CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT,
  status TEXT,
  diff TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_versions ON memory_versions(memory_id, version);

CREATE TABLE IF NOT EXISTS memory_feedback (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  signal TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extract_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  adds INTEGER NOT NULL DEFAULT 0,
  updates INTEGER NOT NULL DEFAULT 0,
  deletes INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY,
  level TEXT NOT NULL DEFAULT '',
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// 时间线四表：事件（一段长期任务）→ 阶段（按环境变化切）→ 决定（一次选择），外加人格。
// 与八层的区别：八层每条是「一句结论」，这四类有层级与业务状态（state / archived_at / superseded_by）。
const TIMELINE_DDL = `
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  persona_id TEXT,
  title TEXT,
  content TEXT NOT NULL,
  goal TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  started_at TEXT,
  ended_at TEXT,
  keywords TEXT,
  status TEXT NOT NULL DEFAULT 'memory',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_episodes_persona ON episodes(persona_id, state);

CREATE TABLE IF NOT EXISTS phases (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  persona_id TEXT,
  title TEXT,
  content TEXT NOT NULL,
  env TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  archived_at TEXT,
  keywords TEXT,
  status TEXT NOT NULL DEFAULT 'memory',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_phases_episode ON phases(episode_id, seq);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  phase_id TEXT,
  episode_id TEXT,
  persona_id TEXT,
  title TEXT,
  content TEXT NOT NULL,
  chosen TEXT,
  rejected TEXT,
  occurred_at TEXT,
  superseded_by TEXT,
  keywords TEXT,
  status TEXT NOT NULL DEFAULT 'memory',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_phase ON decisions(phase_id, occurred_at);

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  session_ids TEXT,
  merged_into TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_traits (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source_session TEXT,
  status TEXT NOT NULL DEFAULT 'memory',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traits_persona ON persona_traits(persona_id, sort_order);
`;
// 工具问题表：插件自己捕获的工具执行错误，供维护会话定位维修。
// 只记「哪个工具 + 错误原文 + 参数名列表」，不记参数值（值里可能是用户原话）。
const TOOL_ISSUES_DDL = `
CREATE TABLE IF NOT EXISTS tool_issues (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  signature TEXT NOT NULL,
  error TEXT NOT NULL,
  param_names TEXT,
  session_code TEXT,
  source_session TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issues_sig ON tool_issues(signature, updated_at);
CREATE INDEX IF NOT EXISTS idx_issues_status ON tool_issues(status, updated_at);
`;

const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  level UNINDEXED,
  body
);
`;

function nowIso() {
  return new Date().toISOString();
}

export function dbPathFor(cwd, projectDir) {
  const dir = projectDir || '.dsh-mind';
  return join(isAbsolute(dir) ? dir : join(cwd, dir), 'memory.db');
}

/** 打开库并确保 schema 就绪；返回 { db, path, created }。 */
/** 全局库路径：cfg.globalDir 或环境变量；空字符串 = 关闭（返回 null）。 */
// 未配置时也要能落回默认共享目录：DEFAULT_CONFIG 是手写对象，不含 schema 默认值，
// 只认 cfg.globalDir 会让两库路由在「配置没显式给 globalDir」时静默失效。
const DEFAULT_GLOBAL_DIR = 'C:/deepseek/.dsh-mind-global';

export function globalPath(cfg) {
  const raw = cfg?.globalDir;
  const dir = (raw === undefined || raw === null ? DEFAULT_GLOBAL_DIR : String(raw)).trim();
  if (dir === '') return null;
  return join(dir, 'memory.db');
}

/** 打开全局库；关闭或失败返回 null（降级为单库）。 */
export function openGlobal(cfg) {
  const file = globalPath(cfg);
  if (file === null) return null;
  try {
    return openDb(file);
  } catch {
    return null;
  }
}

export function openDb(file) {
  const created = !existsSync(file);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');
  db.exec('PRAGMA busy_timeout=5000;');
  initSchema(db);
  return { db, path: file, created };
}

export function initSchema(db) {
  db.exec('BEGIN');
  try {
    for (const level of LEVELS) {
      const extra =
        level === 'project' ? ", subcategory TEXT NOT NULL DEFAULT 'overview'" : level === 'topic' ? ', goal TEXT' : level === 'lesson' ? ', corrected INTEGER NOT NULL DEFAULT 0' : '';
      db.exec(LEVEL_DDL(level, `${extra}, project TEXT`));
      // 旧库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，迁移后老库还得能用。
      try {
        db.exec(`ALTER TABLE ${level} ADD COLUMN project TEXT`);
      } catch {
        /* 列已存在 */
      }
    }
    db.exec(COMMON_DDL);
    db.exec(TIMELINE_DDL);
    db.exec(TOOL_ISSUES_DDL);
    db.exec(FTS_DDL);
    // schema_version 必须跟进：原来用 INSERT OR IGNORE，老库的值永远停在首次建库那一刻（2026-11-23 发现停在 1，代码已是 4）。
    db.prepare(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('schema_version', String(SCHEMA_VERSION));
    db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('created_at', nowIso());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 迁移前体检：integrity_check + 旧库识别。 */
export function preflight(db) {
  const row = db.prepare('PRAGMA integrity_check').get();
  const ok = row !== undefined && String(Object.values(row)[0]).toLowerCase() === 'ok';
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return { ok, schemaVersion: version ? Number(version.value) : 0 };
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function nextId() {
  // ULID 风格：10 位 base32 时间（毫秒）+ 16 位随机 = 26 字符，按时间字典序有序
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[Math.floor(Math.random() * 32)];
  return time + rand;
}

export { nowIso };
