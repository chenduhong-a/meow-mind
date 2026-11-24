// L0/L1/L2 渐进披露：同一条记忆的三种读法。
//   L0 一句话（首轮块，每条 40–60 字）——只求「这条讲什么」
//   L1 首句 + 要点（每消息命中块，120–200 字）——够判断要不要深挖
//   L2 原文（memory_read 按需取）
// 全部是规则实现，不调模型：摘要质量靠「先剥噪音、再按句子边界切」，不靠生成。

const CODE_BLOCK = /```[\s\S]*?```/g;
// 行内代码只脱掉反引号、保留内容：里面常是文件名 / 工具名 / 参数名，删了句子就没主语了。
const INLINE_CODE = /`([^`\n]*)`/g;
const MD_BOLD = /\*\*([^*]+)\*\*/g;
const MD_HEAD = /^#{1,6}\s+/gm;
// URL 只保留主机名，且遇到中文标点就收尾：\s+ 会把「，读免认证…」一起吞掉，首轮块里就成了「在 在 C:\…」（2026-11-21 实测）
const URL = /https?:\/\/[^\s，。；、！？（）【】「」《》"'<>]+/g;
const BRACKET_NOTE = /（[^（）]{0,40}）/g;

/** 剥掉代码块、行内代码、markdown 标记、URL；可选去掉短括号补充。 */
export function stripNoise(text, { dropBrackets = false } = {}) {
  let s = String(text ?? '');
  s = s.replace(CODE_BLOCK, ' ').replace(INLINE_CODE, '$1');
  s = s.replace(MD_BOLD, '$1').replace(MD_HEAD, '');
  s = s.replace(URL, (u) => { const m = /^https?:\/\/([^/?#]+)/.exec(u); return m ? m[1] : ''; });
  if (dropBrackets) s = s.replace(BRACKET_NOTE, '');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 按句切，保留分隔符。中英文句读都认。
 * 关键：英文句点 `0.2.2-rc.5`、`e.g.`、`v1.2` 里的点不是句末——只有后面跟空白/结尾才算；
 * 数字之间的点（小数点、版本号）一律不算，否则一条记忆会被切成 `内核 0.` `1.` `5-rc.`。
 */
export function sentences(text) {
  const out = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    let cut = false;
    if ('。；！？'.includes(ch)) {
      cut = true;
    } else if (ch === ';' || ch === '!' || ch === '?') {
      cut = true;
    } else if (ch === '.') {
      const next = text[i + 1];
      const prev = text[i - 1] ?? '';
      const atEnd = next === undefined || /[\s\n]/.test(next);
      const betweenDigits = /[0-9]/.test(prev) && next !== undefined && /[0-9]/.test(next);
      cut = atEnd && !betweenDigits;
    }
    if (cut) {
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** 在 max 附近找合适的断点（优先中文标点，其次空格）。 */
function cutSmart(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf(' '));
  return (stop > max * 0.5 ? cut.slice(0, stop) : cut).trim() + '…';
}

/** L0：一句话主旨。优先第一个完整句，整句会截时再按标点剪。 */
export function l0(content, max = 60) {
  const s = stripNoise(content, { dropBrackets: true });
  if (s.length <= max) return s;
  const first = sentences(s)[0] ?? s;
  return cutSmart(first, max);
}

/**
 * L1：首句 + 后续要点分句，用「；」连接，放不下就截断并标「…」。
 * 比 L0 多的是「第二条要点」——命中块里够判断值不值得 read。
 */
export function l1(content, max = 200) {
  const s = stripNoise(content);
  if (s.length <= max) return s;
  const parts = sentences(s);
  if (parts.length <= 1) return cutSmart(s, max);
  let out = parts[0];
  for (const p of parts.slice(1)) {
    const next = `${out}；${p}`;
    if (next.length > max) break;
    out = next;
  }
  return out.length < s.length ? `${out}…` : out;
}

/** L2：原文，不做任何处理。 */
export function l2(content) {
  return String(content ?? '');
}
