/**
 * urlcheck.js — 教程 URL 真实性静态检查
 *
 * 问题：LLM 会编造"看起来合理但不存在"的 URL，例如 example.com/login
 * （example.com 是 IANA 保留示例域，只有根路径可访问）。
 * 本模块在量化阶段扫描教程全部章节中的 http(s) URL，命中"疑似编造"模式
 * 即记入问题清单，强制触发修复闭环改写。
 */
export const FAKE_URL_PATTERNS = [
  // 示例域的子路径：example.com/xxx、example.org/api、www.example.net/login 等
  /https?:\/\/(?:www\.)?example\.(?:com|org|net)\/[^\s"'<>)\]]+/i,
  // example.com 的子域名（mail.example.com 等）
  /https?:\/\/[a-z0-9-]+\.example\.(?:com|org|net)/i,
  // 占位域：your-domain.com / your-site.io / my-website 等
  /https?:\/\/(?:your|my|demo)-(?:domain|website|site|app)\.(?:com|io|org|app|dev)/i,
  // 示例保留域：foo.example / bar.example
  /https?:\/\/[a-z0-9-]+\.example(?:\/|$)/i,
];

/** 常见测试/真实站点（这些根路径与常见子路径是允许的，不算编造） */
const SAFE_HOSTS = new Set([
  "httpbin.org", "example.com", "example.org", "example.net", "localhost",
  "127.0.0.1", "the-internet.herokuapp.com", "reqres.in", "jsonplaceholder.typicode.com",
  "httpstat.us", "postman-echo.com",
]);

/**
 * 扫描文本中的 http(s) URL，返回疑似编造的列表。
 * @param {string} text 章节内容
 * @returns {string[]} 疑似编造的 URL（去重）
 */
export function checkUrls(text) {
  if (!text) return [];
  const found = [];
  const urlRe = /https?:\/\/[^\s"'<>())\]},，。；、]+/g;
  for (const m of text.matchAll(urlRe)) {
    let url = m[0];
    // 去掉行尾标点
    url = url.replace(/[.,;:!?]+$/, "");
    if (!url) continue;
    // 允许明确的占位符（<your-domain> 等尖括号形式在正则中已被排除）
    if (FAKE_URL_PATTERNS.some((re) => re.test(url)) && !found.includes(url)) {
      found.push(url);
    }
  }
  return found;
}

/**
 * 扫描全部章节，返回按章节索引分组的疑似编造 URL。
 * @param {Array<{index:number, content:string}>} chapterFiles
 * @returns {Record<number, string[]>} { 章节index: [url, ...] }
 */
export function checkAllChaptersUrls(chapterFiles) {
  const map = {};
  for (const ch of chapterFiles) {
    if (!ch.content) continue;
    const hits = checkUrls(ch.content);
    if (hits.length) map[ch.index] = hits;
  }
  return map;
}
