// 白盒测试：mock ctx 调 apply，验证工具注册、guide 注册、pre-step 注入。
import { rmSync } from 'node:fs';
import * as mod from '../src/index.mjs';

const DIR = '../_wbtest';
rmSync(DIR, { recursive: true, force: true });

const tools = [];
const handlers = {};
const effects = [];
const logs = [];
let sectionCalls = 0;

const ctx = {
  logger: {
    info: (m) => logs.push(`INFO ${m}`),
    warn: (m) => logs.push(`WARN ${m}`),
    error: (m) => logs.push(`ERR  ${m}`)
  },
  tools: {
    register(tool) {
      tools.push(tool);
      return () => {};
    }
  },
  get(name) {
    if (name === 'systemPrompt') {
      return {
        section(opts) {
          sectionCalls++;
          return () => {};
        }
      };
    }
    return undefined;
  },
  on(event, handler) {
    handlers[event] = handler;
    return () => {};
  },
  effect(fn) {
    effects.push(fn);
  }
};

console.log(`[mod] name=${mod.name} inject=${JSON.stringify(mod.inject)} config=${typeof mod.config}`);

// 先在目标库写几条，才能验证注入
const { openDb } = await import('../src/db.mjs');
const { insertMemory } = await import('../src/store.mjs');
const projDir = './_wbtest/wr/.dsh-mind';
const seedDb = openDb(`${projDir}/memory.db`).db;
for (const it of [
  { level: 'user', content: '用户偏好：回答用中文，代码注释也用中文。', keywords: ['中文', '偏好', '回答'], importance: 3 },
  { level: 'rules', content: '改插件包必须同时升 package.json 的 version。', keywords: ['升版本号', 'package.json', '插件'], importance: 3 },
  { level: 'fact', content: '本机 node 在 dsh-runtimes 下，PATH 里没有。', keywords: ['node', 'PATH', '运行时'], importance: 2 }
]) {
  insertMemory(seedDb, it.level, it);
}
seedDb.close();

await mod.apply(ctx, { projectDir: '.dsh-mind' });

console.log(`[tools] ${tools.length} 个：${tools.map((t) => t.name).join(', ')}`);
console.log(`[guide] section 调用 ${sectionCalls} 次`);
console.log(`[events] ${Object.keys(handlers).join(', ')}`);

// 校验工具契约
const bad = tools.filter((t) => !t.name || typeof t.execute !== 'function' || !t.parameters || !t.output?.schema || typeof t.output.render !== 'function');
console.log(`[contract] 缺字段的工具：${bad.length === 0 ? '无' : bad.map((t) => t.name).join(',')}`);

// 触发 pre-step
const sid = 'sess-test-1';
const userMsg = { source: { kind: 'user' }, content: [{ type: 'text', text: '用户偏好和回答语言是什么' }] };
const decision = { kind: 'enter', messages: [{ source: { kind: 'system' }, content: [{ type: 'text', text: 'sys' }] }, userMsg] };

const pre = handlers['agent/pre-step'];
if (!pre) {
  console.log('[pre-step] 未注册！');
} else {
  const out = await pre({ agent: { session: { id: sid, header: { cwd: 'C:/deepseek/work/meow-mind/_wbtest/wr', origin: 'main' } } }, messages: decision.messages, signal: { aborted: false } }, async () => decision);
  console.log(`[pre-step] kind=${out.kind} messages=${out.messages.length}（原 ${decision.messages.length}）`);
  for (const m of out.messages) {
    const kind = m.source?.kind ?? '?';
    const form = m.source?.form ?? '-';
    const text = (m.content ?? []).map((p) => p.text ?? '').join('').slice(0, 40);
    console.log(`   - [${kind}/${form}] ${text}`);
  }
  const inj = out.messages.filter((m) => String(m.source?.kind ?? '').startsWith('plugin:'));
  console.log(`[pre-step] 注入消息 ${inj.length} 条；kind=${inj[0]?.source?.kind}`);

  // 第二轮：同会话再跑一次，应只注入命中块（不再有首轮块）
  const out2 = await pre({ agent: { session: { id: sid, header: { cwd: 'C:/deepseek/work/meow-mind/_wbtest/wr', origin: 'main' } } }, messages: [], signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [userMsg] }));
  const inj2 = out2.messages.filter((m) => String(m.source?.kind ?? '').startsWith('plugin:'));
  console.log(`[pre-step-2] 注入 ${inj2.length} 条：${inj2.map((m) => m.source.form).join(',')}`);
}

// 子代理会话不应注入
const out3 = await handlers['agent/pre-step']({ agent: { session: { id: 'sub', header: { cwd: 'C:/x', origin: 'subagent' } } }, messages: [], signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [userMsg] }));
console.log(`[subagent] 注入 ${out3.messages.filter((m) => String(m.source?.kind ?? '').startsWith('plugin:')).length} 条（应为 0）`);

console.log(`\n[logs]`);
for (const l of logs) console.log('  ' + l);

// 收尾 effect
for (const fn of effects) {
  try {
    const d = fn();
    if (typeof d === 'function') d();
  } catch (e) {
    console.log(`[effect] ${e.message}`);
  }
}
console.log('[done]');
