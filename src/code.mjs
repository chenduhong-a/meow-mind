import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { homedir } from 'node:os';

/**
 * 会话识别码：写记忆时自动附在正文末尾。
 *
 * 来源优先级：
 *   1. `~/.dsh/CODES.md` 码表里登记的现行码（用户手工定过用途前缀，最准）
 *   2. 没登记就按 `<前缀>-<SHA1(sessionID) 前 8 位>-<后 4 位>` 现算，前缀缺省 MT
 *
 * 这样同一会话在任何机器上都得到同一个码；换会话必然换码。
 *
 * 码表按 `mtime+size` 版本戳缓存：文件一改，下一次 `sessionCode()` 就重读。
 * 2026-11-23 修：原先用模块级 `_map !== null` 永久缓存，用户在一个会话中途
 * 把新码登记进码表后，该会话直到重启插件都读不到自己的码。
 */

const CODES_FILE = path.join(homedir(), '.dsh', 'CODES.md');
const DEFAULT_PREFIX = process.env.DSH_CODE_PREFIX || 'MT';

let _map = null;
let _stamp = null;

/** 码表文件的版本戳（mtime + size）；文件不存在返回 `missing`。 */
function codesStamp() {
  try {
    const st = fs.statSync(CODES_FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

function loadCodes() {
  // 按版本戳失效，不做进程内永久缓存：会话跑到一半登记的新码必须立刻可见
  const stamp = codesStamp();
  if (_map !== null && stamp === _stamp) return _map;
  _stamp = stamp;
  _map = new Map();
  try {
    const text = fs.readFileSync(CODES_FILE, 'utf8');
    // 表格行形如：| `LD-BA49BC34-894F` | 说明 | `session-56430bca-...` | 2026-11-21 | 现行 |
    const re = /\|\s*`([A-Z]{2}-[0-9A-F]{8}-[0-9A-F]{4})`\s*\|[^|\n]*\|\s*`(session-[^`\s]+)`/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const code = m[1];
      const sid = m[2];
      if (!_map.has(sid)) _map.set(sid, code);
    }
  } catch {
    // 没有码表、读不到 —— 退化成纯哈希，不阻断写入
  }
  return _map;
}

/** 从会话 id 得到识别码；拿不到会话 id 返回 null（调用方就不加码）。 */
export function sessionCode(sessionId) {
  const sid = String(sessionId ?? '').trim();
  if (!sid) return null;
  const known = loadCodes().get(sid);
  if (known) return known;
  const h = crypto.createHash('sha1').update(sid).digest('hex').toUpperCase().slice(0, 12);
  return `${DEFAULT_PREFIX}-${h.slice(0, 8)}-${h.slice(8, 12)}`;
}

/** 从工具的第二个参数 `exec` 里取会话 id（exec.agent.session.header.id）。 */
export function sessionIdFrom(exec) {
  const s = exec?.agent?.session;
  return s?.header?.id ?? s?.id ?? null;
}

const CODE_TAIL = /[（(]\s*码\s*[:：]\s*[A-Z]{2}-[0-9A-F]{8}-[0-9A-F]{4}\s*[）)]\s*$/;

/** 给正文补码；已经带码（末尾有「（码：XX-XXXXXXXX-XXXX）」）就不重复加。 */
export function withCode(content, code) {
  const s = String(content ?? '');
  if (!code || CODE_TAIL.test(s)) return s;
  return `${s}\n\n（码：${code}）`;
}

/** 组合用：从 exec 直接拿码并补进正文。 */
export function decorate(content, exec) {
  return withCode(content, sessionCode(sessionIdFrom(exec)));
}

