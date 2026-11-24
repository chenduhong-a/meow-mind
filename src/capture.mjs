// 自动捕获：把用户消息在进模型前存一份原始观察，防止被压缩重写历史后永久丢失。
// 学 OpenViking 的两条：① 清洗掉自己注入的块（否则召回内容被写回库形成回声）；
// ② 过滤噪音（ACK / 纯标点 / 信号不足），别把「嗯」「好的」也存成记忆素材。

const INJECTED_BLOCK = /<(meow-mind|meow-mind-hit)>[\s\S]*?<\/\1>/g;
const NOISE_ONLY = /^(?:ok|okay|yes|no|嗯|哦|好|行|可以|谢谢|收到|对|是|不|啊|哈|嗯嗯|好嘞)[。！？!?.~～\s]*$/i;

/** 剥掉自己注入的记忆块，压缩空白。 */
export function cleanForCapture(text) {
  if (typeof text !== 'string') return '';
  return text.replace(INJECTED_BLOCK, ' ').replace(/\s+/g, ' ').trim();
}

/** 是否值得存成原始观察。阈值学 OpenViking 的 capture 过滤，按中文语料调过。 */
export function shouldCapture(text) {
  const t = cleanForCapture(text);
  if (t.length < 12 || t.length > 8000) return false;
  if (NOISE_ONLY.test(t)) return false;
  const cjk = (t.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const alnum = (t.match(/[A-Za-z0-9]/g) ?? []).length;
  return cjk >= 4 || alnum >= 6;
}

/** 内容指纹：同一条消息重复 pre-step 时靠它幂等。 */
export function fingerprint(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
