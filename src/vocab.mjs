// 分词：中文按字符 bigram，英文/数字按词，全角标点丢弃。
// 写入时预切词存进 FTS.body，检索时用同一函数保证一致。

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const WORD = /[A-Za-z0-9_.+\-/#@]/;
const MAX_GRAMS = 400;

export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  const lower = text.toLowerCase();
  let word = '';
  const flush = () => {
    if (word.length > 0) {
      out.push(word);
      word = '';
    }
  };
  let prevCjk = '';
  for (const ch of lower) {
    if (CJK.test(ch)) {
      flush();
      if (prevCjk !== '') out.push(prevCjk + ch);
      prevCjk = ch;
    } else if (WORD.test(ch)) {
      prevCjk = '';
      word += ch;
    } else {
      flush();
      prevCjk = '';
    }
  }
  flush();
  return out.length > MAX_GRAMS ? out.slice(0, MAX_GRAMS) : out;
}

/** 供 FTS.body 用：把标题、正文、关键词拼起来预切词。关键词加权靠重复一次。 */
export function buildBody(title, content, keywords) {
  const kw = Array.isArray(keywords) ? keywords.join(' ') : typeof keywords === 'string' ? keywords : '';
  const raw = [title ?? '', content ?? '', kw, kw].join(' \n ');
  return tokenize(raw).join(' ');
}

/** 查询词去重，避免 bigram 重复放大。 */
export function queryTerms(text) {
  return [...new Set(tokenize(text))];
}
