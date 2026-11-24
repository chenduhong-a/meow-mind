// 插件入口：name / inject / config / apply。
// 注入走 agent/pre-step（改写待发 messages），与 meow-memory 同一机制。
import { openGlobal, openDb, dbPathFor, LEVELS } from './db.mjs';
import { DEFAULT_CONFIG, config } from './config.mjs';
import { registerTools } from './tools.mjs';
import { buildFirstTurnBlock, buildHitBlock } from './inject.mjs';
import { recordEvent, listMemories, findDuplicates, mergeMemory, splitLongMemory, slimMemory, rebuildRelations, findSinkCandidates, saveVector } from './store.mjs';
import { findPluginGaps } from './plugins.mjs';
import { cleanForCapture, shouldCapture, fingerprint } from './capture.mjs';
import { listForReview, markForReview, reviewStats, applyMarks, listReviewDbs } from './review.mjs';
import { getProfile, findConflicts, pendingMemories, refreshNarrative } from './profile.mjs';
import { ensureLogTable, listLog, logStats, renderLog } from './changelog.mjs';
import { mailboxStats, listLetters, renderLetters } from './mailbox.mjs';
import { sessionCode } from './code.mjs';

export { config };
export const name = 'meow-mind';
export const inject = ['tools'];

const GUIDE = [
  '记忆是本机跨会话的长期事实，不是用户本轮原话。',
  '要更多细节用 memory_search / memory_read；要写入用 memory_remember（给 project 与 8-13 个关键词）。',
  '被截断的条数写在块尾，用 memory_search 查。'
].join(' ');

function mergeConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  for (const k of ['embedding', 'injection', 'retrieval', 'governance']) {
    c[k] = { ...DEFAULT_CONFIG[k], ...(raw?.[k] ?? {}) };
    if (k === 'retrieval') c[k].weights = { ...DEFAULT_CONFIG.retrieval.weights, ...(raw?.retrieval?.weights ?? {}) };
  }
  return c;
}

export async function apply(ctx, rawConfig) {
  const cfg = mergeConfig(rawConfig);
  if (cfg.enabled === false) {
    ctx.logger?.info?.('meow-mind: 已禁用（config.enabled=false）');
    return;
  }

  const cache = new Map();
  let globalTried = false;
  let globalEntry = null;
  let lastCwd = process.cwd();

  const dbFor = (cwd) => {
    const dir = cwd ?? lastCwd;
    const file = dbPathFor(dir, cfg.projectDir);
    let entry = cache.get(file);
    if (entry === undefined) {
      const { db, path, created } = openDb(file);
      entry = { db, path };
      cache.set(file, entry);
      try {
        ensureLogTable(db); // 变更流水表：老库自动补建
      } catch {
        /* 建表失败不该挡住记忆本身 */
      }
      if (created) ctx.logger?.info?.(`meow-mind: 新建记忆库 ${path}`);
    }
    return entry.db;
  };

  // 全局库：懒加载 + 缓存。关闭（globalDir 空）或打不开时返回 null，全链路降级为单库。
  const globalFor = () => {
    if (globalTried) return globalEntry ? globalEntry.db : null;
    globalTried = true;
    try {
      const g = openGlobal(cfg);
      if (g === null) return null;
      globalEntry = { db: g.db, path: g.path };
      try {
        ensureLogTable(g.db);
      } catch {
        /* 全局库的表建不出来不影响记忆本身 */
      }
      ctx.logger?.info?.(`meow-mind: 全局库 ${g.path}${g.created ? '（新建）' : ''}`);
    } catch (e) {
      ctx.logger?.warn?.(`meow-mind: 全局库不可用，降级单库（${e instanceof Error ? e.message : String(e)}）`);
      globalEntry = null;
    }
    return globalEntry ? globalEntry.db : null;
  };

  const readCfg = () => cfg;

  // embedding：可选依赖，缺失或初始化失败一律降级为纯 BM25
  let embedder = null;
  let embedTried = false;
  const ensureEmbedder = async () => {
    if (embedTried) return embedder;
    embedTried = true;
    if (cfg.embedding.enabled === false) return null;
    try {
      const { createEmbedder } = await import('./embed.mjs');
      embedder = await createEmbedder(cfg, ctx.logger);
      ctx.logger?.info?.(`meow-mind: embedding 已启用（${cfg.embedding.model} ${cfg.embedding.dtype}；懒加载，首次检索才载模型）`);
    } catch (e) {
      ctx.logger?.warn?.(`meow-mind: embedding 不可用，降级纯 BM25（${e instanceof Error ? e.message : String(e)}）`);
      embedder = null;
    }
    return embedder;
  };

  const embed = async (text) => {
    const e = await ensureEmbedder();
    return e ? e.embed(text) : null;
  };

  // 后台预热 embedding：首次加载约 15 秒，不能阻塞第一步对话。
  // 预热完成前 pre-step 走纯 BM25；完成后自动切到混合检索。
  if (cfg.embedding.enabled) {
    setTimeout(() => {
      ensureEmbedder().catch(() => {});
    }, 2000);
  }

  const disposeTools = registerTools(ctx, {
    dbFor: () => dbFor(lastCwd),
    globalFor,
    readCfg,
    embed,
    getEmbedder: () => embedder,
    embeddingReady: () => embedder !== null && embedder.available?.() !== false,
    // 工作区信箱要 <cwd>/.dsh-mind/mailbox，cwd 由这里注入（2026-11-23）
    cwd: () => lastCwd
  });

  // 斜杠指令 /dream：把 dream 从「只能由模型调工具」变成用户直接可触发。
  // 契约取自 dsh-daily-flashcard 的 /study-spar 与 dsh-visual-card 的 /visual：
  // ctx.inject(['commands'], c => c.commands.register({ name, description, input, handler }))，
  // handler 收到 { agent, rawInput }，工作区从 agent.session.header.cwd 取，返回 { kind, text }。
  //
  // 不带参数只列清单（安全，不改库）；`/dream run` 才实际执行。
  // 清理动作不可逆，所以默认档必须是只读的。
  const registerDreamCommand = (c) => {
    const register = (definition) => {
      try {
        return c.commands.register(definition);
      } catch (e) {
        // bundle 与 patch 可能各加载一次；重复注册跳过，而不是让 web boot 失败。
        const msg = String(e?.message ?? e);
        if (msg.includes('duplicate') || msg.includes('already')) return () => {};
        throw e;
      }
    };

    const dispose = register({
      name: 'dream',
      description: '整理记忆库：查重合并、超长拆分、重建关系网',
      input: { hint: '[run] · 不带参数只列清单，/dream run 实际执行' },
      handler: async ({ agent, rawInput }) => {
        const cwd = agent?.session?.header?.cwd ?? lastCwd;
        const run = /\brun\b/i.test(String(rawInput ?? ''));
        let db;
        try {
          db = dbFor(cwd);
        } catch (e) {
          return { kind: 'error', text: `打不开记忆库：${e instanceof Error ? e.message : String(e)}` };
        }

        const maxChars = 800; // 与 memory_dream 的默认值一致
        const dupThreshold = Number(cfg.governance?.dupThreshold) || 0.92;

        const all = [];
        for (const lv of LEVELS) {
          try {
            for (const m of listMemories(db, lv, { limit: 100000 })) all.push({ ...m, level: lv });
          } catch {
            /* 单层读失败不影响其余 */
          }
        }
        const long = all.filter((m) => String(m.content ?? '').length > maxChars);
        let pairs = [];
        try {
          pairs = findDuplicates(db, dupThreshold);
        } catch {
          pairs = [];
        }

        if (!run) {
          const lines = [
            `记忆库：${all.length} 条`,
            `重复对：${pairs.length} 个（相似度 ≥ ${dupThreshold}）`,
            `超长：${long.length} 条（> ${maxChars} 字）`
          ];
          if (pairs.length > 0) {
            lines.push(`可合并：${pairs.slice(0, 5).map((p) => `${p.drop.id.slice(0, 8)} → ${p.keep.id.slice(0, 8)}（${p.sim}）`).join('、')}`);
          }
          if (long.length > 0) {
            lines.push(`可拆分：${long.slice(0, 3).map((m) => `${m.id.slice(0, 8)}（${String(m.content ?? '').length} 字）`).join('、')}`);
          }
          const sink = findSinkCandidates(db, 5, 1);
          if (sink.total > 0) {
            lines.push(`可沉淀：${sink.total} 条 lesson/rules 像方法、未标去向（${sink.items.map((x) => (x.hintSkill ? `→${x.hintSkill}` : '未匹配')).join('、')}）——只提醒，工具不改技能文件`);
          }
          try {
            const gap = findPluginGaps(db, 5, 7);
            if (gap.items && gap.items.length > 0) {
              lines.push(`插件缺口：${gap.total} 个符号在自建插件源码里找不到（${gap.items.map((x) => x.symbol).join('、')}）——可能是插件该补的能力`);
            } else {
              lines.push('插件缺口：无（近 7 天记忆提到的符号都在自建插件源码里）');
            }
          } catch { /* 读不到插件源码不影响其余 */ }
          try {
            // 画像描述的是「这个人」，跨工作区都成立 → 优先放/读全局库，旧库仍在工作区时退回本地。
            const pdb = globalFor() ?? db;
            const prof = getProfile(pdb);
            const conf = findConflicts(pdb);
            const pend = pendingMemories(pdb);
            lines.push(`用户画像：${prof.sections.length} 条分节 / ${prof.narrative.length} 字 / v${prof.version}｜未归纳 ${pend.items.length} 条 user 记忆`);
            if (pend.items.length > 0) {
              lines.push('→ 归纳得在会话里做：memory_profile 的 pending 列清单，逐节 upsert；插件自身调不到模型，不会自动归纳');
            }
            lines.push(conf.total > 0
              ? `画像冲突：${conf.total} 处（${conf.conflicts.slice(0, 3).map((x) => `${x.label}:${x.reason}`).join('；')}）——需要你确认保留哪条`
              : '画像冲突：无');
          } catch {
            lines.push('用户画像：未初始化（用 memory_profile 的 upsert 维护；归纳要在会话里做，插件不会自动归纳）');
          }
          lines.push('加 run 实际执行：/dream run');
          return { kind: 'success', text: lines.join('\n') };
        }

        const log = [];
        try {
          log.push(`关系网重建：${rebuildRelations(db)} 对`);
        } catch (e) {
          log.push(`关系网重建失败：${e instanceof Error ? e.message : String(e)}`);
        }
        // 瘦身：超过 200 字的活跃记忆压成「结论 + 判据」，原文挪进证据表
        let slimN = 0;
        try {
          for (const lv of LEVELS) {
            const rows = db.prepare(`SELECT id FROM ${lv} WHERE status = 'memory' AND length(content) > 200 LIMIT 60`).all();
            for (const r of rows) {
              const res = slimMemory(db, lv, r.id, { maxChars: 200 });
              if (res.ok && !res.skipped) slimN += 1;
            }
          }
          if (slimN > 0) db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
        } catch { /* 瘦身失败不影响其余步骤 */ }
        let merged = 0;
        for (const p of pairs.slice(0, 5)) {
          try {
            if (mergeMemory(db, p) !== null) merged += 1;
          } catch {
            /* 单对失败不影响其余 */
          }
        }
        log.push(`合并：${merged} 对`);
        log.push(`瘦身：${slimN} 条（原文进证据表）`);
        let split = 0;
        // 拆出来的新条要补向量，否则它只有词法通道、语义检索搜不到（2026-11-21 实测 9 条「（续）」全缺）
        const emSplit = await ensureEmbedder().catch(() => null);
        for (const m of long.slice(0, 3)) {
          try {
            const r = splitLongMemory(db, m.id, maxChars);
            if (r !== null) {
              split += 1;
              if (emSplit) {
                try {
                  const v = await emSplit.embed(String(r.tail).slice(0, 2000));
                  if (v) saveVector(db, r.newId, v, m.level);
                } catch {
                  /* 补向量失败不影响拆分本身 */
                }
              }
            }
          } catch {
            /* 同上 */
          }
        }
        log.push(`拆分：${split} 条`);
        try {
          const sink = findSinkCandidates(db, 5, 1);
          if (sink.total > 0) {
            log.push(`可沉淀：${sink.total} 条待看（前 ${sink.items.length} 条 ${sink.items.map((x) => (x.hintSkill ? `→${x.hintSkill}` : '未匹配')).join('、')}）`);
          }
        } catch {
          /* 沉淀提示失败不影响整理结果 */
        }
        try {
          recordEvent(db, {
            kind: 'dream',
            sessionId: agent?.session?.header?.id ?? null,
            payload: { via: 'command', merged, split }
          });
        } catch {
          /* 记账失败不影响整理结果 */
        }
        return { kind: 'success', text: log.join('\n') };
      }
    });
    if (typeof dispose === 'function') ctx.effect?.(() => dispose);
  };

  if (typeof ctx.inject === 'function') ctx.inject(['commands'], registerDreamCommand);

  // 斜杠指令 /log：查版本变更流水账（只读，不改库）。
  const registerLogCommand = (c) => {
    const register = (definition) => {
      try {
        return c.commands.register(definition);
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (msg.includes('duplicate') || msg.includes('already')) return () => {};
        throw e;
      }
    };
    const dispose = register({
      name: 'log',
      description: '查版本变更流水账（插件/内核升级记录，不进记忆层）',
      input: { hint: '[关键词] · 不带参数列最近 20 条' },
      handler: async ({ agent, rawInput }) => {
        const cwd = agent?.session?.header?.cwd ?? lastCwd;
        let db;
        try {
          db = dbFor(cwd);
        } catch (e) {
          return { kind: 'error', text: `打不开记忆库：${e instanceof Error ? e.message : String(e)}` };
        }
        const q = String(rawInput ?? '').trim();
        try {
          const st = logStats(db);
          const list = listLog(db, q ? { query: q, limit: 20 } : { limit: 20 });
          if (!list.items.length) {
            return { kind: 'success', text: q ? `没查到匹配「${q}」的记录。` : '还没有版本流水记录（用 memory_log 的 add 记）。' };
          }
          const head = `版本流水（共 ${st.entries} 条，${st.since} → ${st.until}）`;
          const more = q && st.entries > list.items.length ? `\n\n只看最近 ${list.items.length} 条；要更早用 memory_log 的 list 带 since。` : '';
          return { kind: 'success', text: `${head}\n\n${renderLog(list.items)}${more}` };
        } catch (e) {
          return { kind: 'error', text: `读流水失败：${e instanceof Error ? e.message : String(e)}` };
        }
      }
    });
    if (typeof dispose === 'function') ctx.effect?.(() => dispose);
  };

  if (typeof ctx.inject === 'function') ctx.inject(['commands'], registerLogCommand);
  // 斜杠指令 /mail：看信箱（只读；投递与归档走 memory_mail）。
  const registerMailCommand = (c) => {
    const register = (definition) => {
      try {
        return c.commands.register(definition);
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (msg.includes('duplicate') || msg.includes('already')) return () => {};
        throw e;
      }
    };
    const dispose = register({
      name: 'mail',
      description: '看跨会话信箱（未归档的信；投递与归档走 memory_mail）',
      input: { hint: '[all|关键词] · 不带参数列待办' },
      handler: async ({ rawInput }) => {
        try {
          const cfg = readCfg();
          const st = mailboxStats(cfg);
          if (!st.enabled) return { kind: 'success', text: '信箱未启用（globalDir 为空，全局库已关闭）。' };
          const q = String(rawInput ?? '').trim();
          const all = q === 'all';
          const list = listLetters(cfg, all ? { limit: 30 } : q ? { query: q, limit: 30 } : { status: '待办', limit: 30 });
          if (!list.items.length) {
            return { kind: 'success', text: all ? '信箱里没有未归档的信。' : q ? `没有匹配「${q}」的信。` : '没有待办的信。' };
          }
          const head = all ? `信箱（未归档 ${st.total} 封）` : q ? `信箱 · 匹配「${q}」（${list.total} 封）` : `信箱 · 待办 ${st.pending} 封`;
          return { kind: 'success', text: `${head}\n\n${renderLetters(list.items)}\n\n投递与归档用 memory_mail。` };
        } catch (e) {
          return { kind: 'error', text: `读信箱失败：${e instanceof Error ? e.message : String(e)}` };
        }
      }
    });
    if (typeof dispose === 'function') ctx.effect?.(() => dispose);
  };

  if (typeof ctx.inject === 'function') ctx.inject(['commands'], registerMailCommand);

  // 记忆审议 HTTP 路由（给侧边栏 client 半用）
  const reviewDbs = new Map();
  const registerReviewApi = (c) => {
    c.effect(() => c.webServer.register({
      kind: 'prefix',
      path: '/meow-mind/api',
      handler: async (req, res) => {
        const send = (code, obj) => {
          const body = Buffer.from(JSON.stringify(obj), 'utf8');
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
          res.end(body);
        };
        if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' });
        const pathname = new URL(req.url ?? '/', 'http://meow.local').pathname;
        const method = pathname.startsWith('/meow-mind/api/') ? pathname.slice(15) : '';
        if (!method || method.includes('/')) return send(404, { ok: false, error: 'unknown api method' });
        let payload = {};
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 2000000) return send(413, { ok: false, error: 'payload too large' });
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf8').trim();
          if (raw) payload = JSON.parse(raw);
        } catch {
          return send(400, { ok: false, error: 'invalid json body' });
        }
        try {
          if (method === 'dbs') {
            const dbs = listReviewDbs();
            const current = dbPathFor(lastCwd, cfg.projectDir);
            return send(200, { ok: true, dbs, current });
          }
          // 侧边栏可以指定要看哪个库：payload.db 为 listReviewDbs 给出的 id（global / ws:<工作区>）。
          // 只认枚举出来的路径，不接受任意路径。
          let db;
          let dbPath;
          const wantId = typeof payload.db === 'string' ? payload.db : '';
          const hit = wantId ? listReviewDbs().find((d) => d.id === wantId) : undefined;
          if (hit) {
            let entry = reviewDbs.get(hit.path);
            if (entry === undefined) {
              const opened = openDb(hit.path);
              entry = opened.db;
              reviewDbs.set(hit.path, entry);
            }
            db = entry;
            dbPath = hit.path;
          } else {
            db = dbFor(lastCwd);
            dbPath = dbPathFor(lastCwd, cfg.projectDir);
          }
          if (method === 'list') return send(200, Object.assign({ dbPath }, listForReview(db, payload)));
          if (method === 'mark') return send(200, markForReview(db, payload));
          if (method === 'stats') return send(200, Object.assign({ ok: true }, reviewStats(db)));
          if (method === 'apply') return send(200, applyMarks(db, payload));
          return send(404, { ok: false, error: 'unknown api method' });
        } catch (e) {
          ctx.logger?.warn?.('meow-mind: review api 失败: ' + (e instanceof Error ? e.message : String(e)));
          return send(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      },
    }), 'meow-mind: /meow-mind/api routes');
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerReviewApi);

  // systemPrompt 手册段（工具不受影响，注册失败只丢手册）
  const registerGuide = (attempt = 0) => {
    const svc = ctx.get?.('systemPrompt');
    if (svc === undefined || typeof svc.section !== 'function') {
      if (attempt < 20) setTimeout(() => registerGuide(attempt + 1), 1000);
      else ctx.logger?.warn?.('meow-mind: systemPrompt 服务 20s 未就绪，记忆手册未挂进 system prompt（工具不受影响）');
      return;
    }
    try {
      const d = svc.section({ name: 'meow-mind:guide', order: 130, text: GUIDE });
      if (typeof d === 'function') ctx.effect?.(() => d);
      ctx.logger?.info?.('meow-mind: guide section registered');
    } catch (e) {
      ctx.logger?.warn?.(`meow-mind: guide 注册失败（不影响工具）: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  registerGuide(0);

  // 每会话状态
  const firstDone = new Set();
  const seen = new Map();
  const seenOf = (sid) => {
    let s = seen.get(sid);
    if (s === undefined) {
      s = new Set();
      seen.set(sid, s);
    }
    return s;
  };

  let createUserMessage = null;
  try {
    const llm = await import('@deepseek-ai/dsh-llm');
    createUserMessage = llm.createUserMessage ?? null;
  } catch {
    createUserMessage = null;
  }

  const makeMsg = (text, form) => {
    if (createUserMessage === null) return null;
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: `plugin:${name}`, form, sections: [{ name: '长期记忆', text }] }
    });
  };

  const disposeHook = ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {    const decision = await next();
    try {
      if (decision === undefined || decision.kind !== 'enter') return decision;
      if (signal?.aborted) return decision;
      if (ensureConfigGuard()) return decision;
      const cwd = agent?.session?.header?.cwd;
      if (typeof cwd === 'string' && cwd.length > 0) lastCwd = cwd;
      const sid = agent?.session?.id ?? 'unknown';
      if (agent?.session?.header?.origin === 'subagent') return decision;
      const db = dbFor(lastCwd);
      const userMsgs = decision.messages.filter((m) => m.source?.kind === 'user');
      if (userMsgs.length === 0) return decision;
      const last = userMsgs[userMsgs.length - 1];
      const text = extractText(last);

      // 自动捕获：先落原始观察再做注入。宿主压缩会重写历史，不提前存就永久丢。
      // 幂等键含内容指纹，同一消息被重复 pre-step 也只写一条。
      if (cfg.governance?.autoCapture !== false) {
        try {
          const raw = cleanForCapture(text);
          if (shouldCapture(raw)) {
            recordEvent(db, {
              kind: 'observe',
              level: 'user',
              sessionId: sid,
              payload: { content: raw.slice(0, 8000), sourceKind: 'dialog', auto: true },
              idempotencyKey: `auto:${sid}:${fingerprint(raw)}`
            });
          }
        } catch {
          /* 捕获失败不阻断对话 */
        }
      }

      const rewritten = [...decision.messages];
      let injected = false;

      if (!firstDone.has(sid) && cfg.injection.enabled) {
        firstDone.add(sid);
        const block = buildFirstTurnBlock(db, cfg, globalFor(), sessionCode(sid) ?? '', sid);
        const msg = block ? makeMsg(block.text, 'snapshot') : null;
        if (msg) {
          rewritten.splice(rewritten.indexOf(userMsgs[0]), 0, msg);
          injected = true;
          ctx.logger?.info?.(`meow-mind: 首轮注入 ${block.tokens} tokens（${block.text.length} 字符）`);
        }
      }

      if (cfg.injection.enabled) {
        const hit = await buildHitBlock(db, cfg, text, seenOf(sid), embedder, globalFor(), sid);
        const msg = hit ? makeMsg(hit.text, 'recall') : null;
        if (msg) {
          rewritten.splice(rewritten.indexOf(last), 0, msg);
          injected = true;
        }
      }

      return injected ? { ...decision, messages: rewritten } : decision;
    } catch (e) {
      ctx.logger?.warn?.(`meow-mind: pre-step 注入失败（fail-open 放行原始消息）: ${e instanceof Error ? e.message : String(e)}`);
      return decision;
    }
  });

  const ensureConfigGuard = () => cfg.enabled === false;

  ctx.effect?.(() => () => {
    disposeTools?.();
    disposeHook?.();
    for (const { db } of cache.values()) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    cache.clear();
  });

  ctx.logger?.info?.(`meow-mind: 就绪（${disposeTools.count ?? 0} 个 memory_* 工具，注入预算 ${cfg.injection.firstTurnBudget}/${cfg.injection.perMessageBudget} tokens）`);
}

function extractText(message) {
  const parts = message?.content;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join(' ')
    .trim();
}

