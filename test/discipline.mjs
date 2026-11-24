// 三条纪律与自动捕获的回归测试：
// ① 用户消息自动落 events（幂等、过滤噪音、剥自己的注入块）；
// ② 派生材料不能当「支持」类证据；
// ③ 反馈只淘汰不提升（useful 不改状态、wrong 降 review）。
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as mod from '../src/index.mjs';
import { insertMemory, addEvidence, getMemoryAnyLevel } from '../src/store.mjs';
import { cleanForCapture } from '../src/capture.mjs';

const DIR = 'C:/deepseek/work/_disc';
rmSync(DIR, { recursive: true, force: true });

const tools = [];
const handlers = {};
const logs = [];
const ctx = {
  logger: {
    info: (m) => logs.push(`INFO ${m}`),
    warn: (m) => logs.push(`WARN ${m}`),
    error: (m) => logs.push(`ERR ${m}`)
  },
  tools: {
    register(t) {
      tools.push(t);
      return () => {};
    }
  },
  get: (n) => (n === 'systemPrompt' ? { section: () => () => {} } : undefined),
  on(e, h) {
    handlers[e] = h;
    return () => {};
  },
  effect() {}
};

await mod.apply(ctx, {
  enabled: true,
  projectDir: `${DIR}/.dsh-mind`,
  embedding: { enabled: false },
  injection: { enabled: true }
});

const preStep = handlers['agent/pre-step'];
const userText = '请帮我看一下这个插件目录里到底有哪些文件，顺便统计一下体积';
const mkDecision = (text) => ({ kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }] });
const runStep = (sid, decision) =>
  preStep({ agent: { session: { id: sid, header: { cwd: DIR } } }, messages: decision.messages }, async () => decision);

await runStep('sess-1', mkDecision(userText));
if (logs.length) console.log(`[logs] ${logs.join(' | ')}`);
const db = new DatabaseSync(`${DIR}/.dsh-mind/memory.db`);

const evs = db.prepare("SELECT kind, payload FROM events WHERE kind = 'observe'").all();
const captured = evs.filter((e) => JSON.parse(e.payload).auto === true);
console.log(`[capture] observe=${evs.length} auto=${captured.length} -> ${captured.length === 1 ? 'OK' : 'FAIL'}`);
if (captured[0]) console.log(`  payload: ${JSON.parse(captured[0].payload).content.slice(0, 42)}...`);

await runStep('sess-1', mkDecision(userText));
const again = db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'observe'").get().n;
console.log(`[idempotent] observe=${again} -> ${again === evs.length ? 'OK（同一消息只写一次）' : 'FAIL'}`);

await runStep('sess-2', mkDecision('嗯嗯'));
const noise = db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-2'").get().n;
console.log(`[noise] sess-2 observe=${noise} -> ${noise === 0 ? 'OK（噪音不捕获）' : 'FAIL'}`);

const m = insertMemory(db, 'fact', { title: '纪律测试', content: '派生材料不能当证据', importance: 2, keywords: ['测试'] });
const bad = addEvidence(db, { memoryId: m.id, sourceKind: 'agent_inference' });
const good = addEvidence(db, { memoryId: m.id, sourceKind: 'user_statement' });
console.log(`[evidence] 派生=${bad === null ? 'null(拒绝)' : bad} 真实=${good ? '写入' : 'null'} -> ${bad === null && good ? 'OK' : 'FAIL'}`);

const feedbackTool = tools.find((t) => t.name === 'memory_feedback');
await feedbackTool.execute({ id: m.id, kind: 'useful' });
const afterUseful = getMemoryAnyLevel(db, m.id).memory.status;
await feedbackTool.execute({ id: m.id, kind: 'wrong' });
const afterWrong = getMemoryAnyLevel(db, m.id).memory.status;
console.log(`[feedback] useful->${afterUseful} wrong->${afterWrong} -> ${afterUseful === 'memory' && afterWrong === 'review' ? 'OK' : 'FAIL'}`);

const echo = '正文<meow-mind-hit>\n- [fact] 旧记忆\n</meow-mind-hit>结束';
const cleaned = cleanForCapture(echo);
console.log(`[strip] "${cleaned}" -> ${cleaned.includes('旧记忆') ? 'FAIL' : 'OK（回声防护）'}`);

// 只验「没掉」，不锁死具体个数——加工具不该让这条挂掉（2026-11-23 加三个时间线工具时踩过）
console.log(`[tools] ${tools.length} 个 -> ${tools.length >= 18 ? 'OK' : 'FAIL'}`);
db.close();
try {
  rmSync(DIR, { recursive: true, force: true });
} catch {
  /* Windows 上 WAL 句柄可能还没释放，留给下次覆盖 */
}
