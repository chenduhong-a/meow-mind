// 插件侧沉淀候选：记忆里提到的代码符号在自建插件源码里找不到 → 可能该补的能力
//
// 为什么单独成模块：它只读文件系统、不碰数据库结构，跟 store.mjs 的职责（CRUD + 向量 + 关系 + 技能沉淀）
// 是两件事。放在一起时 store.mjs 到了 600 行、五个读者里只有一个需要它。
//
// 边界：**只读不改**。报出来的是「值得看一眼」，不是「必须改」——假阳率不低
// （源码注释里出现过的词也算已覆盖），真要动由人判断。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseStamp } from './store.mjs';

const PLUGIN_SKIP_SYMBOL = new Set(['i.e', 'e.g', 'etc', 'node.js', 'pnpm', 'npm']);

function sourceRoots() {
  const profile = process.env.MEOW_MIND_PROFILE || join(homedir(), '.dsh', 'profiles', 'desktop');
  const roots = [];
  try {
    const j = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    for (const [name, spec] of Object.entries(j.dependencies ?? {})) {
      const s = String(spec);
      if (!s.startsWith('file:') && !s.startsWith('link:')) continue;
      const p = s.replace(/^(file:|link:)/, '').replace(/\\/g, '/');
      if (/\.(tgz|tar\.gz|zip)$/i.test(p)) continue;   // 打包件不可改，跳过
      if (!existsSync(p)) continue;
      roots.push({ name, dir: p });
    }
  } catch { /* 读不到 package.json 就当没有可读源码的自建插件 */ }
  return roots;
}

function collectSourceText(root, maxBytes = 2_000_000) {
  const out = [];
  let total = 0;
  const walk = (dir, depth) => {
    if (depth > 4 || total > maxBytes) return;
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (total > maxBytes) return;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(mjs|cjs|js|ts|json|md)$/i.test(e.name)) continue;
      try { const t = readFileSync(p, 'utf8'); out.push(t); total += t.length; } catch { /* 单文件读失败跳过 */ }
    }
  };
  walk(root, 0);
  return out.join('\n');
}

let _pluginSources = null;
export function loadPluginSources() {
  if (_pluginSources) return _pluginSources;
  _pluginSources = [];
  for (const { name, dir } of sourceRoots()) {
    const text = collectSourceText(dir);
    if (text) _pluginSources.push({ name, text });
  }
  return _pluginSources;
}

// 只抓「像代码标识符」的词：小写开头的驼峰、全小写的下划线名、小写开头的点分名。
// 大写开头的（MEMORY.DMP、Userinit）与带文件扩展名的（userinit.exe）一律不算——
// 那是系统文件名，不是插件符号，第一版这样报出来全是误报。
const SYMBOL_RE = /\b(?:[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+|[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*)\b/g;
const FILE_EXT = /\.(exe|dll|sys|dmp|log|txt|json|md|mjs|cjs|js|ts|py|ps1|bat|cmd|zip|tgz|onnx|bin|asar|png|jpg|jpeg|gif)$/i;

export function findPluginGaps(db, limit = 5, sinceDays = 7) {
  const plugins = loadPluginSources();
  if (plugins.length === 0) return { total: 0, items: [], skipped: '没有可读源码的自建插件' };
  const since = Date.now() - sinceDays * 86400000;
  const all = plugins.map((p) => p.text).join('\n');
  const uniq = new Map();
  for (const lv of ['lesson', 'principle', 'rules', 'fact']) {
    let rows = [];
    try { rows = db.prepare(`SELECT id, title, content, status, created_at FROM ${lv} WHERE status = 'memory'`).all(); } catch { continue; }
    for (const r of rows) {
      const c = String(r.content ?? '');
      if (c.length < 40) continue;
      const ts = parseStamp(r.created_at);
      if (ts > 0 && ts < since) continue;
      const seen = new Set();
      for (const m of c.matchAll(SYMBOL_RE)) {
        const sym = m[0];
        if (sym.length < 6 || seen.has(sym) || PLUGIN_SKIP_SYMBOL.has(sym.toLowerCase()) || FILE_EXT.test(sym)) continue;
        seen.add(sym);
        if (all.includes(sym)) continue;
        if (!uniq.has(sym)) uniq.set(sym, { id: r.id, level: lv, title: r.title ?? '', chars: c.length, symbol: sym });
      }
    }
  }
  const items = [...uniq.values()].sort((a, b) => b.chars - a.chars).slice(0, limit);
  return { total: uniq.size, items, plugins: plugins.map((p) => p.name) };
}
