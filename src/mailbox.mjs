// 跨会话信箱：共享库 mailbox\ 下的文件收发（不是数据库表，人来读也看得懂）。
//
// 为什么放文件不放表：信件是「过程性交流」，不是「结论性记忆」；用户用编辑器也能直接翻。
// 位置跟全局库走（cfg.globalDir）：globalDir 为空 = 关掉全局库，信箱也一并停用，行为退回单库。
//
// 目录结构：
//   <globalDir>\mailbox\inbox.md          未归档的信（按追加顺序）  ← scope='global'（默认）
//   <cwd>\.dsh-mind\mailbox\inbox.md     同上，但只属于这个工作区      ← scope='local'
//   <globalDir>\mailbox\archive\<YYYY-MM>.md  归档后的信（状态改「收档」）
//   <globalDir>\mailbox\README.md         格式说明（首次自动生成）
import fs from 'node:fs';
import path from 'node:path';

export const MAIL_DIRNAME = 'mailbox';
const INBOX = 'inbox.md';
const STATUSES = ['待办', '已办', '阅知', '收档'];

const README = `# 跨会话信箱

一封信 = 一段以 \`## \` 开头的块。字段用「- 名称：值」写在前三行，正文在空行之后：

    ## 2026-11-21 18:20 · LD-BA49BC34-894F → 全体
    - 编号：Lm9x2k
    - 状态：待办
    - 主题：待办层上线的回执
    （空行）
    正文，可以多段。

- **状态**：\`待办\` 要对方行动 / \`已办\` 处理完回帖 / \`阅知\` 只是告知 / \`收档\` 双方结束（归档进 archive/）。
- **写给谁**：\`to\` 填会话码或「全体」；不是私密频道，谁都能读，靠主题与状态说清谁该动。
- **只追加**：不删别人的信；结束用 \`memory_mail archive\`，别手工删行。
- **工具**：\`memory_mail\`（post / list / read / archive / stats），斜杠 \`/mail\` 看未办。
- **和记忆的分工**：信箱＝「这件事我要告诉另一个会话」；全局库＝「这条知识对谁都成立」。两者不合并。
`;

/**
 * 信箱目录。
 * scope='global'（默认）→ <globalDir>\mailbox，跨工作区共享；
 * scope='local'        → <cwd>\.dsh-mind\mailbox，只属于这个工作区（2026-11-23 加）。
 * 返回 null 表示「这个 scope 不可用」，调用方据此报错。
 */
export function mailboxDir(cfg, opts = {}) {
  const scope = String(opts.scope ?? 'global');
  if (scope === 'local') {
    const dir = String(opts.cwd ?? '').trim();
    if (!dir) return null;
    return path.join(dir, '.dsh-mind', MAIL_DIRNAME);
  }
  const root = String(cfg?.globalDir ?? '').trim();
  if (!root) return null;
  return path.join(root, MAIL_DIRNAME);
}

/** 统一的「信箱不可用」文案：说清是哪个 scope 缺什么，别让人猜。 */
const dirError = (opts = {}) =>
  String(opts.scope ?? 'global') === 'local'
    ? '工作区信箱不可用（拿不到当前会话的工作目录）'
    : '全局信箱未启用（globalDir 为空）';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function inboxPath(dir) {
  return path.join(dir, INBOX);
}

function archivePath(dir, ym) {
  return path.join(dir, 'archive', `${ym}.md`);
}

function readInbox(dir) {
  const file = inboxPath(dir);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

/** 把 inbox.md 切成块：返回 [{ raw, header, id, status, subject, from, to, day, time, body }]。 */
export function parseInbox(dir) {
  // 归一化换行：外部会话可能用 PowerShell 往 inbox.md 追加（CRLF），
  // 而 `\r` 会让 header 正则的 `$` 匹配失败，整封信被静默丢弃。
  const text = readInbox(dir).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return [];
  // 只按「合法信头」切分。正文里可能有 `## 一、…` 这类小标题，
  // 早先按 /^## / 裸切会把正文截断在第一个小标题处，后半段被当成无信头段塞进 skipped，
  // 于是 memory_mail read 只回第一段（2026-11-26 LB 线实测踩到：inbox.md 里内容其实完整）。
  const parts = text.split(/^## (?=\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s·\s)/m).slice(1);
  const out = [];
  // 解析不了的段不能丢：归档会重写整份 inbox，丢了就永久消失（2026-11-22 审计发现）
  Object.defineProperty(out, 'skipped', { value: [], enumerable: false });
  for (const raw of parts) {
    const block = raw.replace(/\s+$/, '');
    const firstLine = block.split('\n', 1)[0] ?? '';
    // 发件码放宽为「非空片段」：码格式将来可能改（前缀改成三位、16 位长度），
    // 这里只负责切块，格式不对不该让整封信消失——校验交给 memory_mail 写入口。
    const hm = firstLine.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s·\s(\S+)\s→\s(.+)$/);
    if (!hm) { out.skipped.push(`## ${block}`); continue; }
    const raw_from = hm[3].trim();
    const from = /^[A-Z]{2,3}-[0-9A-F]{4,16}(-[0-9A-F]{4})?$/.test(raw_from) ? raw_from : raw_from || '未知';
    const id = (block.match(/^(?:-\s*)?编号：(.+)$/m) ?? [])[1]?.trim() ?? '';
    const status = (block.match(/^(?:-\s*)?状态：(.+)$/m) ?? [])[1]?.trim() ?? '待办';
    const bodyLines = block.split('\n').slice(1);
    const bodyStart = bodyLines.findIndex((l) => l.trim() === '');
    const body = (bodyStart >= 0 ? bodyLines.slice(bodyStart + 1) : bodyLines).join('\n').trim();
    // 主题缺失（外部手写信常见）时退到正文首行，别让列表里出现空白标题。
    const subjectRaw = (block.match(/^(?:-\s*)?主题：(.*)$/m) ?? [])[1]?.trim() ?? '';
    const subject = subjectRaw || body.split('\n')[0].replace(/^#+\s*/, '').slice(0, 40);
    out.push({ raw: `## ${block}`, day: hm[1], time: hm[2], from: hm[3], to: hm[4].trim(), id, status, subject, body });
  }
  return out;
}

function nextId() {
  return `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function blockOf({ id, day, time, from, to, status, subject, body }) {
  return `## ${day} ${time} · ${from} → ${to}\n- 编号：${id}\n- 状态：${status}\n- 主题：${subject}\n\n${String(body ?? '').trim()}\n\n`;
}

function nowParts(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    day: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    ym: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
  };
}

/** 投一封信。code 为空时用「未知」，to 缺省「全体」。 */
export function postLetter(cfg, { code, to, subject, body, status = '待办', now = new Date(), scope = 'global', cwd = '' } = {}) {
  const dir = mailboxDir(cfg, { scope, cwd });
  if (dir === null) return { ok: false, error: dirError({ scope }) };
  const text = String(body ?? '').trim();
  if (!text) return { ok: false, error: '正文不能为空' };
  const subj = String(subject ?? '').trim() || text.split('\n')[0].slice(0, 40);
  const st = STATUSES.includes(status) ? status : '待办';
  ensureDir(dir);
  ensureDir(path.join(dir, 'archive'));
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README, 'utf8');
  const { day, time } = nowParts(now);
  const id = nextId();
  const block = blockOf({ id, day, time, from: code || '未知', to: String(to ?? '').trim() || '全体', status: st, subject: subj, body: text });
  fs.appendFileSync(inboxPath(dir), block, 'utf8');
  return { ok: true, id, day, time, status: st, subject: subj, path: inboxPath(dir) };
}

export function listLetters(cfg, { status, to, query, limit = 20, scope = 'global', cwd = '' } = {}) {
  const dir = mailboxDir(cfg, { scope, cwd });
  if (dir === null) return { ok: false, error: dirError({ scope }), items: [] };
  let items = parseInbox(dir);
  if (status) items = items.filter((l) => l.status === status);
  if (to) items = items.filter((l) => l.to.includes(String(to)));
  if (query) {
    const q = String(query).toLowerCase();
    items = items.filter((l) => `${l.subject}\n${l.body}\n${l.from}`.toLowerCase().includes(q));
  }
  items.sort((a, b) => `${b.day} ${b.time}`.localeCompare(`${a.day} ${a.time}`));
  const total = items.length;
  const n = Math.max(1, Math.min(Number(limit) || 20, 200));
  return { ok: true, dir, total, items: items.slice(0, n).map(({ raw, ...l }) => l) };
}

export function readLetter(cfg, id, opts = {}) {
  const dir = mailboxDir(cfg, opts);
  if (dir === null) return { ok: false, error: dirError(opts) };
  const found = parseInbox(dir).find((l) => l.id === id);
  if (!found) return { ok: false, error: `没有编号为 ${id} 的信` };
  const { raw, ...rest } = found;
  return { ok: true, ...rest };
}

/** 归档：从 inbox.md 摘掉这一段，追加到 archive/<YYYY-MM>.md，状态改「收档」。 */
export function archiveLetter(cfg, ref, now = new Date(), opts = {}) {
  const dir = mailboxDir(cfg, opts);
  if (dir === null) return { ok: false, error: dirError(opts) };
  const all = parseInbox(dir);
  const want = typeof ref === 'string' ? { id: ref } : (ref ?? {});
  let target = want.id ? all.find((l) => l.id === want.id) : undefined;
  if (!target && (want.time || want.subject)) {
    // 手工投的信（对方直接写文件）编号栏可能不是真 id，退化为「时间 + 主题」定位
    const cands = all.filter(
      (l) =>
        (!want.time || l.time === String(want.time)) &&
        (!want.subject || String(l.subject ?? '').includes(String(want.subject))) &&
        (!want.from || l.from === want.from)
    );
    if (cands.length === 1) target = cands[0];
    else if (cands.length > 1) return { ok: false, error: `匹配到 ${cands.length} 封，请再加 time 或更长一点的 subject` };
  }
  if (!target) return { ok: false, error: want.id ? `没有编号为 ${want.id} 的信` : '没有匹配的信（给 id，或 time + subject）' };
  // 按对象身份摘除，不能按 id：手工信可能共用占位编号，按 id 会误删同编号的其它封
  const rest = all.filter((l) => l !== target);
  const skipped = all.skipped ?? [];
  const head = '# 跨会话信箱（未归档）\n\n> 由 meow-mind 的 memory_mail 维护；每段以「## 」开头。\n\n';
  fs.mkdirSync(dir, { recursive: true });
  const blocks = rest.map((l) => l.raw.replace(/\n+$/, ''));
  const tail = skipped.length ? '\n\n' + skipped.map((s) => s.replace(/\n+$/, '')).join('\n\n') : '';
  fs.writeFileSync(inboxPath(dir), blocks.length || skipped.length ? head + blocks.join('\n\n') + tail + '\n' : head, 'utf8');
  const { ym, day, time } = nowParts(now);
  const file = archivePath(dir, ym);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# 信箱归档 ${ym}\n\n`, 'utf8');
  fs.appendFileSync(file, `## ${target.day} ${target.time} · ${target.from} → ${target.to}\n- 编号：${target.id}\n- 状态：收档\n- 主题：${target.subject}\n- 归档：${day} ${time}\n\n${target.body}\n\n`, 'utf8');
  return { ok: true, id: target.id, subject: target.subject, from: target.from, archivedTo: file };
}

export function mailboxStats(cfg, opts = {}) {
  const dir = mailboxDir(cfg, opts);
  if (dir === null) return { enabled: false, scope: String(opts.scope ?? 'global') };
  const items = parseInbox(dir);
  const by = {};
  for (const s of STATUSES) by[s] = 0;
  for (const l of items) by[l.status] = (by[l.status] ?? 0) + 1;
  return { enabled: true, scope: String(opts.scope ?? 'global'), dir, total: items.length, pending: by['待办'] ?? 0, by };
}

/** 纯文本渲染（斜杠指令与工具回执共用）。 */
export function renderLetters(items) {
  if (!items.length) return '（没有信）';
  return items
    .map((l) => `- [${l.status}] ${l.id} · ${l.day} ${l.time} · ${l.from} → ${l.to}\n  ${l.subject}`)
    .join('\n');
}
