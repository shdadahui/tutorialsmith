/**
 * examplecode.js — 教程配套「可运行示例代码」生成器（v7）
 *
 * 在教程正文之外，额外产出 example-code/ 文件夹：把教程中的核心代码
 * 整理成按章节组织的可运行示例文件，让读者"边看教程边动手"。
 *
 * 真实性保障：
 *   - 示例代码必须来自项目真实源码/教程正文（禁止编造 API/路径/URL）
 *   - 运行命令优先来自「已验证命令清单」（复现报告）
 *   - 每个文件头注释用途与运行方式
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chat } from "./llm.js";
import { parseJsonLoose } from "./outliner.js";
import { resolveRole } from "./config.js";

/** 系统提示词：示例代码工程师 */
export function buildExampleSys() {
  return `你是教程配套"示例代码工程师"。任务：基于给定的教程全文与项目概况，为教程制作「可运行的配套示例代码」，输出到 example-code 文件夹，让读者可以边看教程边动手运行。

要求：
1. 示例代码必须来自项目真实源码/真实 API（即教程正文或项目概况中出现的代码），禁止编造类名、函数、文件路径、URL
2. 每个文件顶部用注释写明：用途、运行方式（命令必须来自「已验证命令清单」；清单为空时写最通用写法并标注"需在对应环境验证"）
3. 文件按教程章节组织到子目录（如 04-practice/）；子目录加 index.md 说明该章示例
4. 选择 3-8 个最有代表性的示例，覆盖：启动/环境、核心功能使用、测试、进阶用法
5. 若项目是 CLI/库：至少给一个"完整最小可用示例"（尽量能独立运行；依赖项目文件时明确标注相对路径）
6. 输出必须是合法 JSON（不要输出 JSON 之外的任何文字）：
{
  "files": [
    { "path": "04-practice/mini-notes-cli.js", "content": "完整文件内容", "run": "运行命令" }
  ]
}`;
}

/** 用户消息：项目概况 + 已验证命令清单 + 教程全文 */
export function buildExampleUser({ projectSummary, reproduction, chapterFiles }) {
  const ok = reproduction?.okCommands || [];
  const failed = reproduction?.failed || [];
  const chapters = chapterFiles
    .map((c) => `===== 第 ${c.index} 章 =====\n${(c.content || "").slice(0, 8000)}`)
    .join("\n\n");
  return `## 项目概况
${JSON.stringify(projectSummary, null, 2)}

## 已验证命令清单（运行示例时优先使用）
${ok.length ? ok.map((c) => `- ${c}`).join("\n") : "（无）"}

## 复现中失败的命令（示例中禁止使用）
${failed.length ? failed.map((f) => `- ${f.cmd}`).join("\n") : "（无）"}

## 教程全文
${chapters}`;
}

/** 宽松解析示例 JSON：{ files: [{path, content, run}] }，校验结构 */
export function parseExampleJson(text) {
  const parsed = parseJsonLoose(text);
  if (!parsed || !Array.isArray(parsed.files)) return null;
  const files = parsed.files
    .filter((f) => f && typeof f.path === "string" && typeof f.content === "string")
    .map((f) => {
      const raw = f.path;
      return {
        raw, // 原始路径（用于安全校验，防规范化绕过后才暴露）
        path: raw.replace(/\\/g, "/").replace(/^\/+/, ""),
        content: f.content,
        run: typeof f.run === "string" ? f.run : "",
      };
    })
    // 防目录穿越：原始路径不得含 .. / 以 / 或 \ 开头
    .filter((f) => !f.raw.includes("..") && !f.raw.startsWith("/") && !f.raw.startsWith("\\"))
    .map(({ raw, ...rest }) => rest);
  return files.length ? { files } : null;
}

/**
 * 生成配套示例代码并写入 output/example-code/。
 * @param {object} deps { config, outputDir, projectSummary, chapterFiles, reproduction }
 * @returns {Promise<{count: number, paths: string[]}>} 生成的示例文件数（0 = 失败/跳过）
 */
export async function generateExampleCode({ config, outputDir, projectSummary, chapterFiles, reproduction }) {
  const role = resolveRole(config, "writer");
  const sys = buildExampleSys();
  const user = buildExampleUser({ projectSummary, reproduction, chapterFiles });

  let parsed = null;
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    try {
      const raw = await chat({ roleConfig: role, system: sys, user, maxTokens: 8192, jsonMode: true });
      parsed = parseExampleJson(raw);
    } catch (err) {
      console.warn(`  ⚠ 示例代码生成失败（第 ${attempt} 次）: ${err.message.slice(0, 120)}`);
      break;
    }
    if (!parsed && attempt < 2) console.warn("  ⚠ 示例代码 JSON 校验未通过，重试中...");
  }
  if (!parsed) return { count: 0, paths: [] };

  const root = join(outputDir, "example-code");
  const paths = [];
  // 汇总 index
  let indexMd = `# 配套示例代码（example-code）\n\n本目录由教程生成器自动产出，与教程章节配套，可独立运行。\n\n`;
  for (const f of parsed.files) {
    const dest = join(root, f.path);
    await mkdir(join(dest, ".."), { recursive: true });
    await writeFile(dest, f.content, "utf8");
    paths.push(`example-code/${f.path}`);
    indexMd += `- \`${f.path}\`${f.run ? ` — 运行: \`${f.run}\`` : ""}\n`;
  }
  await writeFile(join(root, "README.md"), indexMd, "utf8");
  paths.push("example-code/README.md");
  return { count: parsed.files.length, paths };
}
