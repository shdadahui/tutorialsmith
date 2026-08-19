/**
 * learningpath.js — 学习清单生成器（借鉴 codojo 的"文件即进度"协议）
 *
 * 教程正文之外，额外产出 learning-path.md：每章的学习目标（checkpoint）、
 * 自测题（带参考答案位置提示）与打卡框，读者可以边学边打勾、跨 session 追踪进度。
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chat } from "./llm.js";
import { parseJsonLoose } from "./outliner.js";
import { resolveRole } from "./config.js";

const SYS = `你是教程配套"学习清单设计师"。任务：基于教程大纲与章节内容，为读者设计一份可打卡的学习清单（learning-path.md）。

要求：
1. 每章给出 2-3 条「理解目标」（checkpoint：学完本章应能解释/做到什么，用可验证的表述）
2. 每章给出 2-3 道「自测题」（客观可答，覆盖核心概念），每题附「答案提示」指向本章哪一节
3. 每章一个打卡框 [ ]（供读者打勾追踪进度）
4. 输出必须是合法 JSON（不要输出 JSON 之外的任何文字）：
{
  "intro": "整份清单的引导语（鼓励读者边学边勾选，2-3 句）",
  "chapters": [
    { "index": 1, "title": "章标题", "checkpoints": ["..."], "questions": [{ "q": "题目", "hint": "答案提示（指向章节位置）" }] }
  ]
}`;

/** 生成并写入 learning-path.md；返回 0=失败/跳过，1=成功 */
export async function generateLearningPath({ config, outputDir, outline, chapterFiles }) {
  const role = resolveRole(config, "writer");
  const chapters = chapterFiles
    .map((c) => `第${c.index}章 ${outline.chapters.find((o) => o.index === c.index)?.title || ""}：\n${(c.content || "").slice(0, 2500)}`)
    .join("\n\n");

  let parsed = null;
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    try {
      const raw = await chat({ roleConfig: role, system: SYS, user: `## 教程大纲\n${JSON.stringify(outline, null, 1)}\n\n## 章节内容\n${chapters}`, maxTokens: 4096, jsonMode: true });
      parsed = parseJsonLoose(raw);
    } catch (err) {
      console.warn(`  ⚠ 学习清单生成失败（第 ${attempt} 次）: ${err.message.slice(0, 120)}`);
      break;
    }
    if (!parsed && attempt < 2) console.warn("  ⚠ 学习清单 JSON 校验未通过，重试中...");
  }
  if (!parsed || !Array.isArray(parsed.chapters)) return 0;

  const lines = [
    "# 学习清单（Learning Path）",
    "",
    parsed.intro || "边学边勾选，追踪自己的学习进度。",
    "",
  ];
  for (const ch of parsed.chapters) {
    const chOutline = outline.chapters.find((o) => o.index === ch.index);
    lines.push(`## 第 ${ch.index} 章 ${ch.title || chOutline?.title || ""}`, "");
    lines.push(`- [ ] 本章学习打卡`, "");
    lines.push(`### 理解目标（学完应能...）`);
    for (const c of ch.checkpoints || []) lines.push(`- [ ] ${c}`);
    lines.push("", `### 自测题`);
    for (const q of ch.questions || []) {
      lines.push(`- **${q.q}**`);
      if (q.hint) lines.push(`  - 提示：${q.hint}`);
    }
    lines.push("");
  }
  lines.push("---", "> 由 TutorialSmith 自动生成。每章完成学习后打勾，跨 session 继续学习。", "");

  await writeFile(join(outputDir, "learning-path.md"), lines.join("\n"), "utf8");
  return 1;
}
