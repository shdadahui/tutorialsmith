/**
 * metrics.js — 量化指标计算器（纯本地，零 LLM 调用）
 *
 * 为什么需要它？
 *   "质量"不能只靠 reviewer 的主观打分。这里用可枚举、可复现的规则
 *   计算 4 个客观维度 + 1 个来自 reviewer 的主观维度 + 1 个来自 verifier
 *   的运行维度，最后加权合成 0-100 的 QualityScore。
 *
 * 维度（权重在 config.json 的 defaults.metricsWeights 中配置）：
 *   structure  结构完整度：大纲要求的每章小节是否都覆盖了
 *   format     格式规范度：标题层级/代码块/表格/加粗等 lint
 *   factual    事实一致性：教程引用的文件路径是否真实存在于项目
 *   density    信息密度   ：章节字数与代码占比是否合理（防注水/空洞）
 *   code       代码可运行率：来自 verifier.js 的真实执行结果（未开启时为 null）
 *   review     LLM 评审分  ：来自 reviewer.js 的 6 维均分（跳过审查时为 null）
 */

/** 分词：把中文小节标题拆成可匹配的关键词（2 字以上的连续片段） */
function keywords(text) {
  const t = text
    .replace(/^[\d.]+/, "")        // 去掉 "1.1" 编号
    .replace(/[\[\]【】]/g, " ")    // 占位符括号变空格
    .replace(/[：:，,。.、()（）]/g, " ");
  // 提取 2+ 字片段（中文按 2 字滑窗 + 连续英文词）
  const parts = t.split(/\s+/).filter(Boolean);
  const kws = new Set();
  for (const p of parts) {
    if (/^[a-zA-Z0-9_./-]+$/.test(p) && p.length >= 3) {
      kws.add(p.toLowerCase()); // 英文/路径关键词
    } else {
      // 中文：2-4 字滑窗
      for (let i = 0; i + 1 < p.length; i++) {
        kws.add(p.slice(i, i + 2));
      }
    }
  }
  return [...kws];
}

/** 1. 结构完整度：每章小节是否覆盖（取关键词任意命中 ≥1 个即算覆盖） */
function calcStructure(chapters, chapterContents) {
  const byChapter = {};
  let matched = 0, total = 0;
  for (const ch of chapters) {
    const content = chapterContents[ch.index] || "";
    const missing = [];
    for (const section of ch.sections) {
      total++;
      const kws = keywords(section);
      const hit = kws.length === 0 || kws.some((k) => content.toLowerCase().includes(k));
      if (hit) matched++;
      else missing.push(section);
    }
    if (missing.length > 0) {
      byChapter[ch.index] = (byChapter[ch.index] || []).concat(
        missing.map((s) => `结构缺失小节：${s}`)
      );
    }
  }
  return {
    score: total === 0 ? 100 : Math.round((matched / total) * 1000) / 10,
    matched,
    total,
    byChapter,
  };
}

/** 2. 格式规范度：从 100 起，发现违规扣分 */
function calcFormat(chapterContents, chapterFiles) {
  const byChapter = {};
  let penalty = 0;
  for (const ch of chapterFiles) {
    const content = ch.content || "";
    const issues = [];
    // a. 四级标题（#### 以上不该出现，教程最多 ###）
    const h4 = (content.match(/^#{4,}\s/gm) || []).length;
    if (h4 > 0) issues.push(`出现 ${h4} 处四级及以上标题（建议最多用到 ###）`);
    // b. 代码块未闭合（``` 数量为奇数）
    const fences = (content.match(/^```/gm) || []).length;
    if (fences % 2 === 1) issues.push("代码块 ``` 数量为奇数，存在未闭合代码块");
    // c. 加粗未配对
    const bolds = (content.match(/\*\*/g) || []).length;
    if (bolds % 2 === 1) issues.push("加粗 ** 数量为奇数，存在未配对加粗");
    // d. 表格列数不一致（同一表格内 | 数量不同）
    const rows = content.match(/^\|.*\|$/gm) || [];
    if (rows.length >= 3) {
      const cols = new Set(rows.map((r) => r.split("|").length));
      if (cols.size > 1) issues.push("存在列数不一致的 Markdown 表格");
    }
    // e. 连续 5 行以上没有空行分隔（大段文字）——不判罚，仅提示
    const para = /[^\n]{400,}/.test(content);
    if (para) issues.push("存在超过 400 字符的长段落，建议分段");
    if (issues.length > 0) byChapter[ch.index] = issues;
    penalty += issues.length * 3;
  }
  const score = Math.max(0, Math.round((100 - penalty) * 10) / 10);
  return { score, byChapter };
}

/** 3. 事实一致性：教程引用的相对路径是否真实存在于项目文件树 */
function calcFactual(chapterContents, filePaths) {
  const fileSet = new Set(filePaths.map((p) => p.replace(/\\/g, "/")));
  const extRe = /\b(?:src|lib|test|tests|docs?|scripts?|config|public)\/[\w./-]+\.\w{1,6}\b/g;
  const byChapter = {};
  let referenced = 0, hit = 0;
  for (const [idx, content] of Object.entries(chapterContents)) {
    const refs = [...new Set(content.match(extRe) || [])];
    const missing = [];
    for (const ref of refs) {
      referenced++;
      if (fileSet.has(ref)) hit++;
      else missing.push(ref);
    }
    if (missing.length > 0) {
      byChapter[idx] = (byChapter[idx] || []).concat(
        missing.map((p) => `引用了不存在的文件路径：${p}`)
      );
    }
  }
  return {
    score: referenced === 0 ? 100 : Math.round((hit / referenced) * 1000) / 10,
    referenced,
    hit,
    byChapter,
  };
}

/** 4. 信息密度：章节字数与代码占比在合理区间 */
function calcDensity(chapterContents, chapterFiles) {
  const byChapter = {};
  let penalty = 0;
  for (const ch of chapterFiles) {
    const content = ch.content || "";
    const issues = [];
    const textLen = content.replace(/```[\s\S]*?```/g, "").replace(/[#\s|*`>-]/g, "").length;
    const codeLen = (content.match(/```[\s\S]*?```/g) || []).join("").length;
    const totalLen = Math.max(1, content.length);
    const codeRatio = codeLen / totalLen;
    if (textLen < 600) issues.push(`有效文字仅 ${textLen} 字符，章节偏空洞`);
    if (codeRatio < 0.02 && codeLen === 0) issues.push("章节没有任何代码块（开发类章节建议含示例代码）");
    if (codeRatio > 0.7) issues.push(`代码占比 ${(codeRatio * 100).toFixed(0)}%，讲解偏少`);
    if (issues.length > 0) byChapter[ch.index] = issues;
    penalty += issues.length * 5;
  }
  const score = Math.max(0, Math.round((100 - penalty) * 10) / 10);
  return { score, byChapter };
}

/** 把各维度按章节合并成问题清单（供阈值修复循环回灌 writer） */
function mergeIssuesByChapter(dims) {
  const map = {};
  for (const dim of dims) {
    for (const [idx, issues] of Object.entries(dim.byChapter || {})) {
      map[idx] = (map[idx] || []).concat(issues);
    }
  }
  return map;
}

/** 合成总分：未启用的维度（null）不参与加权，其余权重归一化 */
function compose(metrics, weights) {
  const dims = ["structure", "format", "factual", "density", "code", "review"];
  let sumW = 0, sum = 0;
  const details = {};
  for (const d of dims) {
    const v = metrics[d];
    if (v == null) { details[d] = null; continue; }
    details[d] = v;
    sumW += weights[d] ?? 0;
    sum += (weights[d] ?? 0) * v;
  }
  const qualityScore = sumW === 0 ? 0 : Math.round((sum / sumW) * 10) / 10;
  const grade = qualityScore >= 90 ? "S" : qualityScore >= 80 ? "A" : qualityScore >= 65 ? "B" : "C";
  return { qualityScore, grade, details, usedWeights: sumW };
}

/** 子指标合成（完整度/可信度）：给定维度子集内权重归一化 */
function composeSubset(metrics, weights, subset) {
  const dims = subset.filter((d) => metrics[d] != null);
  if (dims.length === 0) return { score: null, grade: null };
  const sumW = dims.reduce((a, d) => a + (weights[d] ?? 0), 0);
  if (sumW === 0) return { score: null, grade: null };
  const sum = dims.reduce((a, d) => a + (weights[d] ?? 0) * metrics[d], 0);
  const score = Math.round((sum / sumW) * 10) / 10;
  const grade = score >= 90 ? "S" : score >= 80 ? "A" : score >= 65 ? "B" : "C";
  return { score, grade };
}

/**
 * 计算全部指标。
 * @param {object} deps
 * @param {object} deps.outline          大纲（chapters）
 * @param {Array<{index, content}>} deps.chapterFiles 已生成的章节文件内容
 * @param {string[]} deps.projectFilePaths 项目真实文件路径列表（相对路径，/ 分隔）
 * @param {number|null} deps.reviewScore   reviewer 均分（null = 未审查）
 * @param {number|null} deps.codeScore     verifier 可运行率（null = 未验证）
 * @param {object} deps.weights            权重表
 */
export function computeMetrics({ outline, chapterFiles, projectFilePaths, reviewScore = null, codeScore = null, weights = {} }) {
  const chapterContents = {};
  for (const f of chapterFiles) chapterContents[f.index] = f.content || "";

  const structure = calcStructure(outline.chapters, chapterContents);
  const format = calcFormat(chapterContents, chapterFiles);
  const factual = calcFactual(chapterContents, projectFilePaths);
  const density = calcDensity(chapterContents, chapterFiles);

  const metrics = {
    structure: structure.score,
    format: format.score,
    factual: factual.score,
    density: density.score,
    code: codeScore,
    review: reviewScore,
    raw: {
      structure: { ...structure },
      format: { ...format },
      factual: { ...factual },
      density: { ...density },
      review: reviewScore,
      code: codeScore,
    },
  };

  const composed = compose(metrics, weights);
  metrics.qualityScore = composed.qualityScore;
  metrics.grade = composed.grade;
  metrics.details = composed.details;

  // 双 headline 指标：
  //   完整度 Completeness = 结构/格式/密度（内容生成得全不全、规不规范）
  //   可信度 Reliability = 事实/代码/评审（内容是不是真的、能不能跑）
  const completeness = composeSubset(metrics, weights, ["structure", "format", "density"]);
  const reliability = composeSubset(metrics, weights, ["factual", "code", "review"]);
  metrics.completeness = completeness; // { score, grade }
  metrics.reliability = reliability;

  // 汇总问题清单（本地可枚举的部分），按章节归类
  metrics.issuesByChapter = mergeIssuesByChapter([
    structure, format, factual, density,
  ]);

  // 全部问题（平铺）
  metrics.allIssues = Object.entries(metrics.issuesByChapter)
    .flatMap(([idx, issues]) => issues.map((i) => `第${idx}章：${i}`));

  return metrics;
}

/** 供 report.js 使用：把分数映射成简洁的可视化条 */
export function bar(score, max = 100, width = 20) {
  if (score == null) return "—".repeat(width);
  const filled = Math.round((score / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
