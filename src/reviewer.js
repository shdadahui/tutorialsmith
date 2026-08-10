/**
 * reviewer.js — 阶段 4：质量审查（校验类工具）
 *
 * 让 LLM 按质量清单给每章打分，返回结构化 JSON（分数/结论/修改意见）。
 * pipeline 拿到意见后，会把「revise」章节连同审查意见交给 writer 重写一轮。
 * 这是"内容闭环"的关键：生成 → 自检 → 修正。
 */
import { chat } from "./llm.js";
import { REVIEWER_SYS, buildReviewerUser } from "./prompts.js";
import { parseJsonLoose } from "./outliner.js";

/** 校验 reviewer 输出结构 */
function isValidReview(r) {
  return (
    r &&
    typeof r === "object" &&
    (r.verdict === "pass" || r.verdict === "revise") &&
    Array.isArray(r.issues)
  );
}

/**
 * 审查一章。
 * @param {object} deps { roleConfig, chapter, chapterIndex, chapterContent }
 * @returns {Promise<{verdict: 'pass'|'revise', avg: number, issues: string[], praise: string}>}
 */
export async function reviewChapter({ roleConfig, chapter, chapterIndex, chapterContent }) {
  const chapterSpec = chapter.sections.map((s) => `- ${s}`).join("\n");
  const user = buildReviewerUser({ chapterIndex, chapterTitle: chapter.title, chapterContent, chapterSpec });

  let review = null;
  for (let attempt = 1; attempt <= 2 && !review; attempt++) {
    // 4096：reasoner 的思考 token 计入 max_tokens，2048 会把 JSON 截断
    const raw = await chat({ roleConfig, system: REVIEWER_SYS, user, maxTokens: 4096 });
    const parsed = parseJsonLoose(raw);
    if (isValidReview(parsed)) {
      review = parsed;
    } else if (attempt < 2) {
      console.warn(`  ⚠ 审查 JSON 校验未通过（第 ${attempt} 次），重试中...`);
    }
  }

  if (!review) {
    // 兜底：宁可放行也不阻塞流水线（审查失败 ≠ 内容错误）
    // 注意 avg 用 null 而非 0，避免"审查失败"被当成"0 分"污染可信度
    review = { verdict: "pass", avg: null, issues: [], praise: "（审查失败，自动放行）" };
  }
  return review;
}

/**
 * 审查全部章节，返回 { reviewMap: { chapterIndex: issues[] }, passCount, reviseCount }。
 */
export async function reviewAllChapters({ roleConfig, outline, files }) {
  const reviewMap = {}; // chapterIndex -> issues[]
  const chapterScores = {}; // chapterIndex -> avg 得分（供 metrics 使用）
  let passCount = 0;
  let reviseCount = 0;

  for (const chapter of outline.chapters) {
    const idx = chapter.index;
    const file = files.find((f) => f.path === `chapter-${String(idx).padStart(2, "0")}.md`);
    if (!file || !file.content) continue; // 断点续写跳过的章节不再审查

    console.log(`  🔍 审查中: chapter-${String(idx).padStart(2, "0")}.md`);
    const review = await reviewChapter({ roleConfig, chapter, chapterIndex: idx, chapterContent: file.content });
    if (review.avg != null) chapterScores[idx] = review.avg; // 审查失败的章节不参与评审分

    if (review.verdict === "revise") {
      reviewMap[idx] = review.issues;
      reviseCount++;
      console.log(`    → 需修订（均分 ${review.avg?.toFixed?.(1) ?? "?"}）：${review.issues.length} 条意见`);
    } else {
      passCount++;
      console.log(`    → 通过（均分 ${review.avg?.toFixed?.(1) ?? "?"}）`);
    }
  }

  return { reviewMap, chapterScores, passCount, reviseCount };
}
