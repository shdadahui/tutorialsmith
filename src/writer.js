/**
 * writer.js — 阶段 3：按大纲逐章撰写 Markdown
 *
 * 关键设计：
 *   1. 每章独立调用 LLM —— 单次请求上下文可控，不会因为教程太长爆 token 上限
 *   2. 断点续写（--resume）—— 输出目录里已有的章节文件直接跳过，中断后接着写
 *   3. 审查反馈循环 —— 若 reviewer 判定某章需修订，把审查意见注入本章重写
 */
import { writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chat } from "./llm.js";
import { buildWriterSys, buildWriterUser } from "./prompts.js";

export const CHAPTER_FILE = (i) => `chapter-${String(i).padStart(2, "0")}.md`;

/** 章节标题，用于生成目录里的一级标题 */
export function chapterHeading(index, title) {
  return `# 第 ${index} 章 ${title}`;
}

/**
 * 撰写单章。
 * @param {object} deps { roleConfig, projectSummary, chapter, chapterIndex, reviewerIssues? }
 * @returns {Promise<{content: string, path: string}>}
 */
export async function writeChapter({ roleConfig, projectSummary, chapter, chapterIndex, reviewerIssues }) {
  const user = buildWriterUser({ projectSummary, chapter, chapterIndex, reviewerIssues });
  const raw = await chat({ roleConfig, system: buildWriterSys(), user, maxTokens: 8192 });

  // 清洗：去掉模型可能误加的 ```markdown 围栏
  let content = raw.trim();
  const fence = content.match(/^```(?:markdown)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) content = fence[1].trim();

  // 确保以 "# 第 N 章" 开头（如果模型漏了标题就补上）
  if (!content.startsWith("#")) {
    content = `${chapterHeading(chapterIndex, chapter.title)}\n\n${content}`;
  }

  return { content, path: CHAPTER_FILE(chapterIndex) };
}

/**
 * 撰写全部章节（支持断点续写 + 并发）。
 * @param {object} deps
 * @param {string} outputDir 教程输出目录
 * @param {boolean} resume 是否跳过已存在的章节文件
 * @param {number} concurrency 并发上限（默认 3，规避限流）
 * @returns {Promise<{files: Array<{path, content}>, rewritten: number[]}>}
 */
export async function writeAllChapters({ roleConfig, projectSummary, outline, outputDir, resume = false, reviewMap = {}, concurrency = 3 }) {
  await mkdir(outputDir, { recursive: true });
  const files = [];
  const rewritten = [];

  // 先决定每个章节的任务（跳过/重写/新写）
  const tasks = [];
  for (const chapter of outline.chapters) {
    const idx = chapter.index;
    const filename = CHAPTER_FILE(idx);
    const filepath = join(outputDir, filename);

    // 断点续写：文件已存在且不要求重写 → 跳过
    const existing = await fileExists(filepath);
    if (existing && resume && !reviewMap[idx]) {
      console.log(`  ⏭ 跳过（已存在）: ${filename}`);
      files.push({ path: filename, content: null });
      continue;
    }

    const reviewerIssues = reviewMap[idx] || undefined;
    if (reviewerIssues) {
      console.log(`  ✏ 重写（含审查意见）: ${filename}`);
      rewritten.push(idx);
    } else {
      console.log(`  ✍ 撰写中: ${filename}`);
    }
    tasks.push({ chapter, idx, filename, filepath, reviewerIssues });
  }

  // 并发池：并发写章节（章节相互独立，可并行；限制并发避免限流）
  const limit = Math.max(1, Math.min(concurrency, tasks.length || 1));
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < tasks.length) {
      const t = tasks[cursor++];
      const { content } = await writeChapter({
        roleConfig, projectSummary, chapter: t.chapter, chapterIndex: t.idx, reviewerIssues: t.reviewerIssues,
      });
      await writeFile(t.filepath, content, "utf8");
      console.log(`  ✓ 已写入: ${t.filename}（${content.length} 字符）`);
      files.push({ path: t.filename, content });
    }
  });
  await Promise.all(workers);

  return { files, rewritten };
}

/** 判断文件是否存在（用于断点续写） */
export async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
