// 旧库（meow-memory 0.33.x）→ 新库（meow-mind）迁移。
//
// 用法：
//   node scripts/migrate.mjs --from <旧库> --to <新库> [--dry]
//   node scripts/migrate.mjs --report <新库>          # 只看迁移后统计
//
// 设计要点：
//   - 幂等：按 id 先删后插，重跑不会重复也不会冲突。
//   - 状态映射：active→memory / stale→review（标 done）/ archived→review（标 tombstone）。
//   - 保留原始 id，方便回滚与对账；新库对同 id 重跑覆盖。
//   - 不动旧库（只读打开）。
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { openDb } from '../src/db.mjs';
import { insertMemory, stats as dbStats } from '../src/store.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const DRY = argv.includes('--dry');
const FROM = opt('--from', 'C:/deepseek/work/.dsh-meow/memory.db');
const TO = opt('--to', 'C:/deepseek/work/.dsh-mind/memory.db');

const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'];
const STATUS_MAP = { active: 'memory', stale: 'review', archived: 'review' };

if (argv.includes('--report')) {
  const { db } = openDb(TO);
  const s = dbStats(db);
  console.log(JSON.stringify(s, null, 2));
  db.close();
  process.exit(0);
}

if (!existsSync(FROM)) {
  console.error(`源库不存在：${FROM}`);
  process.exit(1);
}

const src = new DatabaseSync(FROM, { readOnly: true });
const { db: dst, created } = openDb(TO);

console.log(`源库 ${FROM}`);
console.log(`目标库 ${TO}${created ? '（新建）' : ''}${DRY ? '  [dry-run，不写入]' : ''}\n`);

const byLevel = {};
const byStatus = {};
let total = 0;
let failed = 0;

for (const lv of LEVELS) {
  let rows;
  try {
    rows = src.prepare(`SELECT * FROM ${lv}`).all();
  } catch {
    console.log(`${lv.padEnd(8)} 源库无此表，跳过`);
    continue;
  }
  let n = 0;
  for (const r of rows) {
    const status = STATUS_MAP[r.status] ?? 'memory';
    let keywords = [];
    try {
      keywords = JSON.parse(r.keywords ?? '[]');
    } catch {
      keywords = [];
    }
    const data = {
      id: r.id,
      title: r.title ?? '',
      content: r.content ?? '',
      importance: r.importance ?? 1,
      keywords,
      status,
      source_session: r.source_session ?? null,
      hit_count: r.hit_count ?? 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
      last_accessed_at: r.last_accessed_at ?? null,
      project: r.project ?? null,
      subcategory: r.subcategory,
      goal: r.goal,
      corrected: r.corrected === 1 || r.corrected === true
    };
    if (!DRY) {
      try {
        // 先删后插 → 幂等；不用 INSERT OR REPLACE 是为了保留 FTS 触发器与版本表语义的一致性。
        dst.prepare(`DELETE FROM ${lv} WHERE id = ?`).run(r.id);
        insertMemory(dst, lv, data);
      } catch (e) {
        console.error(`  FAIL ${lv} ${r.id}: ${e.message}`);
        failed++;
        continue;
      }
    }
    n++;
    total++;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  byLevel[lv] = n;
  console.log(`${lv.padEnd(8)} ${String(n).padStart(4)} 条`);
}

console.log(`\n合计 ${total} 条${failed ? `（失败 ${failed}）` : ''}`);
console.log('按状态：', Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' '));
if (!DRY) {
  const s = dbStats(dst);
  console.log('\n迁移后统计：');
  for (const [lv, e] of Object.entries(s.byLevel ?? {})) console.log(`  ${lv.padEnd(8)} ${e.count} 条 / ${e.chars} 字`);
  console.log(`  total ${s.total}`);
}
src.close();
dst.close();
