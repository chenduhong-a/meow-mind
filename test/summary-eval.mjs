// L0/L1/L2 三级摘要的体量对比：确认「分级」真的省字，而不是换个说法。
// 用法：node test/summary-eval.mjs
import { openDb } from '../src/db.mjs';
import { listMemories } from '../src/store.mjs';
import { l0, l1, l2 } from '../src/summary.mjs';
import { estimateTokens } from '../src/inject.mjs';

const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'];
const DB = process.env.MIND_DB ?? 'C:/deepseek/work/.dsh-meow/memory.db';

const { db } = openDb(DB);
const rows = [];
for (const lv of LEVELS) {
  for (const m of listMemories(db, lv, { limit: 1000 })) rows.push({ level: lv, ...m });
}

let c0 = 0, c1 = 0, c2 = 0;
const byLevel = new Map();
for (const m of rows) {
  const a = l0(m.content, 60), b = l1(m.content, 200), c = l2(m.content);
  c0 += a.length; c1 += b.length; c2 += c.length;
  const e = byLevel.get(m.level) ?? { n: 0, l0: 0, l1: 0, l2: 0 };
  e.n++; e.l0 += a.length; e.l1 += b.length; e.l2 += c.length;
  byLevel.set(m.level, e);
}

console.log(`样本 ${rows.length} 条 / ${c2} 字`);
console.log(`L0 ${c0} 字（${((c0 / c2) * 100).toFixed(1)}%，≈${estimateTokens('汉'.repeat(c0))} tokens）`);
console.log(`L1 ${c1} 字（${((c1 / c2) * 100).toFixed(1)}%，≈${estimateTokens('汉'.repeat(c1))} tokens）`);
console.log(`L2 ${c2} 字（100%）\n`);

console.log('按层：');
for (const [lv, e] of byLevel) {
  console.log(`  ${lv.padEnd(8)} ${String(e.n).padStart(4)} 条  L0 ${String(Math.round(e.l0 / e.n)).padStart(4)} 字/条  L1 ${String(Math.round(e.l1 / e.n)).padStart(4)} 字/条  原文 ${String(Math.round(e.l2 / e.n)).padStart(5)} 字/条`);
}

console.log('\n示例（取最长 3 条）：');
for (const m of [...rows].sort((a, b) => b.content.length - a.content.length).slice(0, 3)) {
  console.log(`\n[${m.level}] 原文 ${m.content.length} 字`);
  console.log(`  L0: ${l0(m.content, 60)}`);
  console.log(`  L1: ${l1(m.content, 200)}`);
}
db.close();
