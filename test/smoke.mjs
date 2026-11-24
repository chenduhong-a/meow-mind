// 离线冒烟：不依赖 DSH 宿主与 schemastery，直接测 db/store/bm25/inject 全链路。
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.mjs';
import { insertMemory, stats } from '../src/store.mjs';
import { fusedSearch, summarize } from '../src/bm25.mjs';
import { buildFirstTurnBlock, buildHitBlock, estimateTokens } from '../src/inject.mjs';

const DIR = '../_test';
rmSync(DIR, { recursive: true, force: true });

const cfg = {
  projectDir: '.dsh-mind',
  embedding: { enabled: false },
  injection: { enabled: true, firstTurnBudget: 3200, perMessageBudget: 800, summaryChars: 60, topK: 6, minQueryChars: 3 },
  retrieval: { hybridPool: 50, k1: 1.2, b: 0.75, weights: { lex: 0.45, recency: 0.2, status: 0.2, evidence: 0.15 } },
  governance: { dupThreshold: 0.92, similarThreshold: 0.8, candidateTtlDays: 7, staleDays: 90 }
};

const { db, path } = openDb(`${DIR}/memory.db`);
console.log(`[open] ${path}`);

const items = [
  { level: 'user', content: '用户偏好：回答一律用中文，代码注释也用中文；不喜欢被反问已经说清的事。', keywords: ['中文', '偏好', '回答风格', '代码注释', '反问'], importance: 3 },
  { level: 'rules', content: '改插件包必须同时升 package.json 的 version，否则作者重新发布会覆盖改动。', keywords: ['升版本号', 'package.json', '插件', '覆盖'], importance: 3 },
  { level: 'fact', content: '本机 node 实际路径是 C:\\Users\\ZQY\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe，PATH 里没有 node。', keywords: ['node 路径', 'PATH', '运行时', '绝对路径'], importance: 2 },
  { level: 'lesson', content: 'PowerShell 5.1 用 Set-Content -Encoding UTF8 会写 BOM，导致 JSON 解析报 Unexpected token。改用 node 的 fs.writeFileSync 或 UTF8Encoding(false)。', keywords: ['BOM', 'PowerShell', 'UTF8', 'JSON', 'writeFileSync'], importance: 2 },
  { level: 'topic', content: '记忆插件重写：参考 OpenViking 与 Mnemosyne，定名 meow-mind，目标是降 token、治理积累、提升召回。', keywords: ['meow-mind', '重写', 'OpenViking', 'Mnemosyne', '召回'], importance: 2, goal: '把记忆插件重写成 meow-mind' }
];

for (const it of items) {
  const m = insertMemory(db, it.level, it);
  console.log(`  + [${it.level}] ${m.id} ${summarize(m.content, 30)}`);
}
console.log('[stats]', JSON.stringify(stats(db)));

const queries = ['回答用什么语言', 'node 在哪', 'BOM 报错', '插件改完要做什么', '记忆插件重写'];
for (const q of queries) {
  const hits = fusedSearch(db, q, cfg, { limit: 3, includeExplain: true });
  console.log(`\n[q] ${q}`);
  for (const h of hits) console.log(`   ${h.score.toFixed(3)} [${h.level}] ${h.id} ${summarize(h.content, 34)}  ${JSON.stringify(h.explain)}`);
  if (hits.length === 0) console.log('   （无命中）');
}

const first = buildFirstTurnBlock(db, cfg);
console.log(`\n[first-turn] ${first ? `${first.tokens} tokens / ${first.text.length} 字符` : 'null'}`);
if (first) console.log(first.text.split('\n').slice(0, 12).join('\n'));

const seen = new Set();
const hit = await buildHitBlock(db, cfg, '回答用什么语言比较好', seen);
console.log(`\n[hit] ${hit ? `${hit.tokens} tokens → ${hit.text}` : 'null'}`);
const hit2 = await buildHitBlock(db, cfg, '回答用什么语言比较好', seen);
console.log(`[hit-dedup] ${hit2 === null ? 'null（已注入过，正确）' : 'DUP!'}`);

const short = await buildHitBlock(db, cfg, '嗯', seen);
console.log(`[hit-short] ${short === null ? 'null（太短，正确）' : 'LEAK!'}`);

console.log(`\n[token] 估 100 汉字 ≈ ${estimateTokens('汉'.repeat(100))}`);
db.close();
console.log('[done]');
