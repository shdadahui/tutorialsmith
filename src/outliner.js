/**
 * outliner.js — 阶段 2：生成 7 章教程大纲（输出 JSON）
 *
 * 为什么先有大纲？
 *   - 让"写什么"先被单独决策，writer 逐章执行时只关注"怎么写"
 *   - 大纲是 JSON，程序可以校验结构、失败重试，可靠性远高于直接生成全文
 */
import { chat } from "./llm.js";
import { buildOutlinerSys, buildOutlinerUser, TUTORIAL_STRUCTURE } from "./prompts.js";

/**
 * 宽松的 JSON 解析：容忍模型输出里混入 ```json 代码块围栏或前后杂字。
 */
export function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.trim();
  // 去掉 ```json ... ``` 围栏
  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) t = fenceMatch[1].trim();
  // 去掉前后多余的说明文字：找到第一个 { 和最后一个 }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** 校验大纲结构是否合法 */
function isValidOutline(o) {
  if (!o || typeof o !== "object" || !Array.isArray(o.chapters)) return false;
  if (o.chapters.length < 7) return false;
  return o.chapters.every(
    (c) =>
      c &&
      typeof c.index === "number" &&
      typeof c.title === "string" &&
      Array.isArray(c.sections) &&
      c.sections.length > 0
  );
}

/** 校验用户自定义模板结构是否合法 */
export function isValidTemplate(t) {
  return !!(
    t &&
    typeof t === "object" &&
    Array.isArray(t.chapters) &&
    t.chapters.length > 0 &&
    t.chapters.every(
      (c) =>
        c &&
        typeof c.index === "number" &&
        typeof c.title === "string" &&
        Array.isArray(c.sections) &&
        c.sections.length > 0
    )
  );
}

/** 兜底大纲：模型多次失败时，用模板（或标准 7 章）生成可用大纲 */
function fallbackOutline(projectName, template) {
  const name = projectName || "该项目";
  const source = template || { chapters: TUTORIAL_STRUCTURE };
  return {
    project_name: name,
    audience_note: "基于模板生成，小节标题未做项目定制，建议人工微调。",
    chapters: source.chapters.map((c) => ({
      index: c.index,
      title: c.title,
      sections: c.sections.map((s) =>
        s.replaceAll("[项目/技术主题]", name).replaceAll("[项目名]", name)
      ),
    })),
  };
}

/**
 * 生成教程大纲。
 * @param {object} deps { roleConfig: 已解析的 outliner 角色配置, template?: 自定义模板 }
 * @param {object} projectSummary scanner 阶段输出的项目概况 JSON
 * @param {object} userOptions { intro, audience, focus }
 * @returns {Promise<object>} 大纲 JSON
 */
export async function generateOutline({ roleConfig, projectSummary, userOptions, template = null }) {
  const user = buildOutlinerUser(projectSummary, userOptions);
  const sys = buildOutlinerSys(template);
  let outline = null;
  let lastRaw = "";

  // 最多尝试 3 次（首次 + 2 次重试）
  for (let attempt = 1; attempt <= 3 && !outline; attempt++) {
    const raw = await chat({ roleConfig, system: sys, user });
    lastRaw = raw;
    outline = parseJsonLoose(raw);
    if (!isValidOutline(outline)) {
      outline = null;
      console.warn(`  ⚠ 大纲 JSON 校验未通过（第 ${attempt} 次尝试），重试中...`);
    }
  }

  if (!outline) {
    console.warn("  ⚠ 大纲生成多次失败，改用模板兜底（建议后续人工微调小节标题）。");
    outline = fallbackOutline(projectSummary?.project_name, template);
  }

  console.log(`  ✓ 大纲已生成：${outline.chapters.length} 章`);
  return outline;
}
