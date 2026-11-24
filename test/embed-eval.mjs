// 阶段 3 验证：真实 431 条记忆下，纯 BM25 vs 混合（BM25 + 语义重排）
import fs from 'node:fs';
import { rmSync, mkdirSync } from 'node:fs';
import { openDb } from '../src/db.mjs';
import { insertMemory, getVectors, saveVector } from '../src/store.mjs';
import { createEmbedder } from '../src/embed.mjs';
import { bm25Candidates, fusedSearch } from '../src/bm25.mjs';
import { semanticScores } from '../src/inject.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

const DIR = 'C:/deepseek/work/meow-mind/_embedtest';
const REUSE = process.argv.includes('--reuse') && fs.existsSync(`${DIR}/memory.db`);
if (!REUSE) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
}

const FIX = new URL('./', import.meta.url);
const arr = JSON.parse(fs.readFileSync(new URL('fixtures-memories.json', FIX), 'utf8'))
  .filter((m) => (m.status ?? 'memory') === 'memory');
const queries = JSON.parse(fs.readFileSync(new URL('fixtures-queries.json', FIX), 'utf8'));
const { db } = openDb(`${DIR}/memory.db`);

if (!REUSE) {
  for (const m of arr) {
    const ts = m.updated_at ?? undefined;
    insertMemory(db, m.level, {
      id: m.id,
      content: m.text,
      importance: m.importance ?? 1,
      keywords: String(m.keywords ?? '').split(/\s+/).filter(Boolean),
      subcategory: m.subcategory ?? undefined,
      hit_count: m.hit_count ?? 0,
      created_at: ts,
      updated_at: ts
    });
  }
  console.log(`[import] ${arr.length} 条 / ${queries.length} 条查询`);
} else {
  console.log(`[reuse] 复用已有库（${arr.length} 条基准数据）`);
}

const t0 = Date.now();
const embedder = await createEmbedder(DEFAULT_CONFIG, { info: (m) => console.log('  ' + m), warn: (m) => console.log('  WARN ' + m) });
console.log(`[embedder] 就绪 ${Date.now() - t0}ms`);

// 批量嵌入（复用库时跳过）
const t1 = Date.now();
if (!REUSE) {
  const rows = arr.map((m) => ({ id: m.id, level: m.level, text: m.text }));
  let done = 0;
  for (let i = 0; i < rows.length; i += 16) {
    const batch = rows.slice(i, i + 16);
    const vecs = await embedder.embedBatch(batch.map((r) => r.text));
    batch.forEach((r, j) => { if (vecs[j]) saveVector(db, r.id, vecs[j], r.level); });
    done += batch.length;
    if (i % 128 === 0) console.log(`  嵌入 ${done}/${rows.length}`);
  }
  const embedMs = Date.now() - t1;
  console.log(`[vectors] ${done} 条 / ${embedMs} ms / ${(embedMs / done).toFixed(1)} ms 一条`);
} else {
  const n = db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get().n;
  console.log(`[vectors] 复用已有 ${n} 条向量`);
}

const cfg = { ...DEFAULT_CONFIG };

async function evalSet(label, searchFn) {
  let h1 = 0, h5 = 0, mrr = 0;
  const fails = [];
  for (const item of queries) {
    const hits = await searchFn(item.q);
    const rank = hits.findIndex((h) => item.expect.some((e) => h.id.startsWith(e)));
    if (rank === 0) h1++;
    if (rank >= 0 && rank < 5) h5++;
    if (rank >= 0) mrr += 1 / (rank + 1);
    if (!(rank >= 0 && rank < 5)) fails.push({ q: item.q, type: item.type, top: hits.slice(0, 3).map((h) => h.id.slice(0, 10)) });
  }
  const n = queries.length;
  console.log(`\n[${label}] hit@1=${(h1 / n * 100).toFixed(1)}%  hit@5=${(h5 / n * 100).toFixed(1)}%  MRR=${(mrr / n).toFixed(3)}`);
  for (const f of fails) console.log(`   未命中 [${f.type}] ${f.q} → ${f.top.join(' ')}`);
  return { h1, h5, mrr };
}

const pure = await evalSet('纯 BM25', async (q) => fusedSearch(db, q, cfg, { limit: 10 }));

const t2 = Date.now();
const hybrid = await evalSet('混合', async (q) => {
  let semantic = null;
  try { semantic = await semanticScores(db, q, cfg, embedder); } catch {}
  return fusedSearch(db, q, cfg, { limit: 10, semantic });
});
const hybridMs = Date.now() - t2;
console.log(`\n[耗时] 混合检索 ${queries.length} 条共 ${hybridMs} ms（平均 ${(hybridMs / queries.length).toFixed(1)} ms/条，含 query 嵌入）`);

// 权重对照：四因子里 recency/status/evidence 是「先验」，对「找具体事实」可能过重
const W = [
  ['低先验权重 85/5/5/5', { lex: 0.85, recency: 0.05, status: 0.05, evidence: 0.05 }],
  ['中先验权重 65/15/10/10', { lex: 0.65, recency: 0.15, status: 0.1, evidence: 0.1 }]
];
for (const [label, weights] of W) {
  const c2 = { ...cfg, retrieval: { ...cfg.retrieval, weights } };
  await evalSet(label + '（纯 BM25）', async (q) => fusedSearch(db, q, c2, { limit: 10 }));
  await evalSet(label + '（混合）', async (q) => {
    let semantic = null;
    try { semantic = await semanticScores(db, q, c2, embedder); } catch {}
    return fusedSearch(db, q, c2, { limit: 10, semantic });
  });
}

const n = queries.length;
console.log(`\n=== 对比 ===`);
console.log(`hit@1  ${(pure.h1 / n * 100).toFixed(1)}% → ${(hybrid.h1 / n * 100).toFixed(1)}%`);
console.log(`hit@5  ${(pure.h5 / n * 100).toFixed(1)}% → ${(hybrid.h5 / n * 100).toFixed(1)}%`);
console.log(`MRR    ${(pure.mrr / n).toFixed(3)} → ${(hybrid.mrr / n).toFixed(3)}`);
db.close();
