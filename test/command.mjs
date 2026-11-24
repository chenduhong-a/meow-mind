// /dream 斜杠指令的契约测试。
// 不依赖宿主：mock 一个带 inject/commands 的 ctx，验证注册与 handler 的两种模式。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../src/index.mjs';

const DIR = path.join(process.cwd(), '_cmdtest');
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* WAL 句柄可能未释放 */ }

const commands = [];
const logs = [];
const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) },
  effect: (fn) => { try { fn(); } catch { /* disposer 失败不影响测试 */ } },
  on: () => () => {},
  get: () => undefined,
  provide: () => {},
  tools: { register: () => () => {} },
  systemPrompt: undefined,
  inject: (services, fn) => {
    if (services.includes('commands')) {
      fn({ commands: { register: (d) => { commands.push(d); return () => {}; } } });
    }
  }
};

const ok = (label, cond, extra) => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${extra === undefined ? '' : ' -> ' + extra}`);
  if (!cond) process.exitCode = 1;
};

await apply(ctx, {
  projectDir: path.join(DIR, '.dsh-mind'),
  embedding: { enabled: false },
  injection: { enabled: false } // 只测指令，不测注入
});

ok('注册了 3 条指令（dream + log + mail）', commands.length === 3, commands.length);
const cmd = commands.find((c) => c.name === 'dream');
const logCmd = commands.find((c) => c.name === 'log');
ok('指令名是 dream', cmd?.name === 'dream', cmd?.name);
ok('有 description', typeof cmd?.description === 'string' && cmd.description.length > 0, cmd?.description);
ok('有 input.hint', typeof cmd?.input?.hint === 'string', cmd?.input?.hint);
ok('有 handler', typeof cmd?.handler === 'function');

// 先建库：handler 里 dbFor 会惰性开库，但空目录第一次由 openDb 建
const dbFile = path.join(DIR, '.dsh-mind', 'memory.db');

// ① 不带参数：只读清单，不改库
const agent = { session: { header: { cwd: DIR, id: 'cmd-sess' } } };
const dry = await cmd.handler({ agent, rawInput: '' });
ok('dry 返回 success', dry?.kind === 'success', dry?.kind);
ok('dry 文本含「记忆库」', String(dry?.text).includes('记忆库'), String(dry?.text).replace(/\n/g, ' | '));
ok('dry 文本含「/dream run」', String(dry?.text).includes('/dream run'));

// ② 带 run：实际整理（空库时各计数为 0）
const run = await cmd.handler({ agent, rawInput: 'run' });
ok('run 返回 success', run?.kind === 'success', run?.kind);
ok('run 文本含「关系网重建」', String(run?.text).includes('关系网重建'), String(run?.text).replace(/\n/g, ' | '));

// ③ 无 cwd 的容错：回落到 lastCwd（进程 cwd），不抛错
const noCwd = await cmd.handler({ agent: { session: { header: {} } }, rawInput: '' });
ok('无 cwd 不抛错', typeof noCwd?.text === 'string', noCwd?.kind);

ok('库文件已建', fs.existsSync(dbFile), dbFile);

// ④ /log：空库只读、写入后能查到（流水账不进记忆层）
ok('注册了 /log', !!logCmd, logCmd?.name);
const logEmpty = await logCmd.handler({ agent, rawInput: '' });
ok('/log 空库返回 success', logEmpty?.kind === 'success', logEmpty?.kind);
{
  const { DatabaseSync } = await import('node:sqlite');
  const db2 = new DatabaseSync(dbFile);
  const { addLog } = await import('../src/changelog.mjs');
  addLog(db2, { day: '2026-11-21', subject: 'test-pkg', from: '1.0.0', to: '1.1.0', note: '单测' });
  db2.close();
}
const logHit = await logCmd.handler({ agent, rawInput: 'test-pkg' });
ok('/log 能查到刚写的记录', String(logHit?.text).includes('test-pkg'), String(logHit?.text).replace(/\n/g, ' | '));
const logMiss = await logCmd.handler({ agent, rawInput: '不存在的包名' });
ok('/log 查不到时给明确答复', String(logMiss?.text).includes('没查到'), String(logMiss?.text));

try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* 句柄延迟释放 */ }
console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
