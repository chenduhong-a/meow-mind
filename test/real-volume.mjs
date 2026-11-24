// 用真实记忆库（431 条）验证 meow-mind 的注入体积
import fs from 'node:fs';
import { openDb } from '../src/db.mjs';
import { insertMemory } from '../src/store.mjs';
import { buildFirstTurnBlock, buildHitBlock, estimateTokens } from '../src/inject.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

const REAL = 'C:/deepseek/work/meow-mind/_real';
fs.mkdirSync(REAL, { recursive: true });
for (const f of ['memory.db', 'memory.db-wal', 'memory.db-shm']) {
  try { fs.unlinkSync(`${REAL}/${f}`); } catch {}
}

const { db } = openDb(`${REAL}/memory.db`);
const arr = JSON.parse(fs.readFileSync(new URL('fixtures-memories.json', new URL('./', import.meta.url)), 'utf8'))
  .filter((m) => (m.status ?? 'memory') === 'memory');

let n = 0;
for (const m of arr) {
  const ts = m.updated_at ?? undefined;
  insertMemory(db, m.level, {
    id: m.id,
    title: '',
    content: m.text,
    importance: m.importance ?? 1,
    keywords: String(m.keywords ?? '').split(/\s+/).filter(Boolean),
    subcategory: m.subcategory ?? undefined,
    hit_count: m.hit_count ?? 0,
    created_at: ts,
    updated_at: ts,
  });
  n += 1;
}

const cfg = { ...DEFAULT_CONFIG };
const first = buildFirstTurnBlock(db, cfg);
console.log(`[import] ${n} 条`);
console.log(`[first-turn] ${first.tokens} tokens / ${first.text.length} 字符`);
console.log('---');

// 每消息命中块：用几句真实问法量一下（对照阶段 0 里 BM25 失败的几条）
const queries = [
  '以前装过某个东西之后工具全没了怎么修',
  '怎么让技能换台机器也能用',
  '记忆插件重写要注意什么',
  'BOM 报错是什么原因',
  '帮我挑东西的时候应该注意什么',
];
for (const q of queries) {
  const hit = await buildHitBlock(db, cfg, q, new Set());
  if (!hit) { console.log(`[hit] null · ${q}`); continue; }
  const top = hit.ids.slice(0, 3).join(' ');
  console.log(`[hit] ${hit.tokens} tokens · ${q}\n        ${top}`);
}
