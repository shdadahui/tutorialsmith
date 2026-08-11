/**
 * react/tools.js — ReAct 模式的工具集（v2）
 *
 * 与 v1 流水线的核心差异：执行顺序由模型自主决定（每步输出一个 JSON 动作），
 * 工具本体 90% 复用 v1 模块（scanner/writer/reviewer/metrics/verifier/report）。
 *
 * 工具列表（模型可见，见 engine.js 的 REACT_SYS）：
 *   list_files()              项目文件清单
 *   scan_project()            项目概况（scanner LLM 生成）
 *   generate_outline()        生成大纲（outliner LLM）
 *   write_chapter(index)      撰写第 index 章（writer LLM，写入磁盘）
 *   review_chapter(index)     审查第 index 章（reviewer LLM）
 *   verify_tutorial()         真实验证全部章节命令（--verify 等价物）
 *   compute_metrics()         计算双指标质量分
 *   finalize()                收尾：写 index.md / report.md / metrics.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scanProject } from "../scanner.js";
import { chat } from "../llm.js";
import { SCANNER_SYS, buildScannerUser } from "../prompts.js";
import { parseJsonLoose, generateOutline } from "../outliner.js";
import { writeChapter, CHAPTER_FILE, fileExists } from "../writer.js";
import { reviewChapter } from "../reviewer.js";
import { computeMetrics } from "../metrics.js";
import { verifyChapters } from "../verifier.js";
import { writeReport } from "../report.js";
import { writeIndex, isValidSummary, fallbackSummary } from "../pipeline.js";
import { getUsageSummary } from "../usage.js";
import { resolveRole } from "../config.js";

/** Observation 截断长度（防止对话历史膨胀，本身就是上下文管理） */
const OBS_LIMIT = 600;
const trunc = (s, n = OBS_LIMIT) => (s.length > n ? s.slice(0, n) + "…(已截断)" : s);

/** 从磁盘读取全部章节（供指标计算） */
async function readChapterFiles(outputDir, outline) {
  const files = [];
  for (const ch of outline.chapters) {
    const p = join(outputDir, CHAPTER_FILE(ch.index));
    try {
      files.push({ index: ch.index, content: await readFile(p, "utf8") });
    } catch {
      files.push({ index: ch.index, content: "" });
    }
  }
  return files;
}

/**
 * 创建工具集（闭包持有状态，Observation 全部为字符串）。
 * @param {object} deps { config, projectPath, outputDir, userOptions }
 */
export function createTools({ config, projectPath, outputDir, userOptions }) {
  // 跨工具共享状态
  const state = {
    scan: null,             // scanProject 原始结果
    projectSummary: null,   // scanner LLM 概况
    outline: null,          // 大纲
    chapterScores: {},      // review_chapter 收集的均分
    verified: null,         // verify_tutorial 结果
  };

  const role = (name) => resolveRole(config, name);

  /** 惰性扫描：list_files / scan_project 共用 */
  async function getScan() {
    if (!state.scan) {
      state.scan = await scanProject(projectPath, { maxProjectBytes: config.defaults.maxProjectBytes });
    }
    return state.scan;
  }

  return {
    state, // 暴露共享状态（供引擎读取 metrics 等）
    async list_files() {
      const s = await getScan();
      return `项目文件（共 ${s.fileCount} 个，${(s.totalBytes / 1024).toFixed(1)} KB）：\n${s.filePaths.slice(0, 40).join("\n")}`;
    },

    async scan_project() {
      const s = await getScan();
      let summary = null;
      for (let attempt = 1; attempt <= 2 && !summary; attempt++) {
        const raw = await chat({ roleConfig: role("scanner"), system: SCANNER_SYS, user: buildScannerUser(s.filesText) });
        const parsed = parseJsonLoose(raw);
        if (isValidSummary(parsed)) summary = parsed;
      }
      state.projectSummary = summary || fallbackSummary(projectPath, s.filePaths);
      return trunc(
        `项目概况已生成：\n` +
        `- project_name: ${state.projectSummary.project_name}\n` +
        `- description: ${state.projectSummary.description || ""}\n` +
        `- tech_stack: ${(state.projectSummary.tech_stack || []).join(", ") || "未知"}\n` +
        `- entry_points: ${(state.projectSummary.entry_points || []).join(", ") || "无"}\n` +
        `- key_files: ${(state.projectSummary.key_files || []).map((k) => k.path).slice(0, 10).join(", ")}\n` +
        `- core_features: ${(state.projectSummary.core_features || []).slice(0, 8).join("；") || "无"}`
      );
    },

    async generate_outline() {
      if (!state.projectSummary) return "错误：请先调用 scan_project() 获取项目概况";
      const outline = await generateOutline({
        roleConfig: role("outliner"),
        projectSummary: state.projectSummary,
        userOptions,
      });
      state.outline = outline;
      const list = outline.chapters.map((c) => `第${c.index}章 ${c.title}（小节：${c.sections.join(" / ")}）`).join("\n");
      return trunc(`大纲已生成（${outline.chapters.length} 章）：\n${list}`);
    },

    async write_chapter(args) {
      const idx = Number(args?.index);
      if (!state.outline) return "错误：请先调用 generate_outline() 生成大纲";
      const chapter = state.outline.chapters.find((c) => c.index === idx);
      if (!chapter) return `错误：章节 index=${idx} 不存在。可用大纲见 generate_outline 的返回`;
      await mkdir(outputDir, { recursive: true });
      const { content } = await writeChapter({
        roleConfig: role("writer"),
        projectSummary: state.projectSummary,
        chapter,
        chapterIndex: idx,
      });
      const filepath = join(outputDir, CHAPTER_FILE(idx));
      await writeFile(filepath, content, "utf8");
      return trunc(
        `已写入 ${CHAPTER_FILE(idx)}（${content.length} 字符）。开头：\n` +
        content.split("\n").slice(0, 12).join("\n")
      );
    },

    async review_chapter(args) {
      const idx = Number(args?.index);
      const filepath = join(outputDir, CHAPTER_FILE(idx));
      if (!(await fileExists(filepath))) return `错误：第 ${idx} 章尚未撰写，请先 write_chapter(${idx})`;
      const chapter = state.outline?.chapters.find((c) => c.index === idx);
      if (!chapter) return `错误：章节 index=${idx} 不在大纲中`;
      const content = await readFile(filepath, "utf8");
      const review = await reviewChapter({
        roleConfig: role("reviewer"),
        chapter,
        chapterIndex: idx,
        chapterContent: content,
      });
      if (review.avg != null) state.chapterScores[idx] = review.avg;
      return trunc(
        `第 ${idx} 章审查结果：verdict=${review.verdict}，均分=${review.avg ?? "N/A"}（0-10）\n` +
        `问题（${review.issues.length} 条）：\n` + review.issues.slice(0, 5).map((i) => `- ${i}`).join("\n") +
        `\n表扬：${review.praise || ""}`
      );
    },

    async verify_tutorial() {
      const chapterFiles = state.outline ? await readChapterFiles(outputDir, state.outline) : [];
      if (!chapterFiles.length) return "错误：还没有已撰写的章节";
      state.verified = await verifyChapters({ chapterFiles, projectPath });
      const v = state.verified;
      return `真实验证完成：执行 ${v.total} 条项目内命令，通过 ${v.ok} 条 → 可运行率 ${v.score ?? "N/A"}；系统命令 ${v.systemTotal ?? 0} 条记为环境假设。`;
    },

    async compute_metrics() {
      if (!state.outline) return "错误：请先 generate_outline() 并至少写一章";
      const chapterFiles = await readChapterFiles(outputDir, state.outline);
      const scores = Object.values(state.chapterScores).filter((v) => v != null);
      const reviewScore = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) : null;
      const metrics = computeMetrics({
        outline: state.outline,
        chapterFiles,
        projectFilePaths: (await getScan()).filePaths,
        reviewScore,
        codeScore: state.verified?.score ?? null,
        weights: config.defaults.metricsWeights,
      });
      state.metrics = metrics;
      const issues = Object.values(metrics.issuesByChapter).flat().length;
      return (
        `当前质量：完整度=${metrics.completeness?.score ?? "N/A"}（${metrics.completeness?.grade ?? "-"}） | ` +
        `可信度=${metrics.reliability?.score ?? "N/A"}（${metrics.reliability?.grade ?? "-"}） | ` +
        `总分=${metrics.qualityScore}（${metrics.grade}），阈值 ${config.defaults.qualityThreshold}\n` +
        `待改进问题 ${issues} 条` +
        (issues ? `，如：${metrics.allIssues.slice(0, 4).join("；")}` : "") +
        `\n提示：若总分 < ${config.defaults.qualityThreshold}，可 review_chapter 相关章节后重写（write_chapter 会覆盖）。`
      );
    },

    async finalize() {
      if (!state.metrics) {
        // 没算过指标也要能收尾：补算一次
        await this.compute_metrics();
      }
      const outline = state.outline;
      const chaptersWritten = new Set(outline.chapters.map((c) => c.index));
      await writeIndex(outputDir, outline, chaptersWritten);
      const usage = getUsageSummary(config.defaults.costs);
      await writeReport({ metrics: state.metrics, outputDir, verify: state.verified, usage });
      await writeFile(
        join(outputDir, "metrics.json"),
        JSON.stringify({
          qualityScore: state.metrics.qualityScore,
          grade: state.metrics.grade,
          completeness: state.metrics.completeness,
          reliability: state.metrics.reliability,
          details: state.metrics.details,
          issuesCount: Object.values(state.metrics.issuesByChapter).flat().length,
          usage: { totalTokens: usage.totalTokens, totalCost: usage.totalCost, currency: usage.currency },
          agent: "react",
        }, null, 2),
        "utf8"
      );
      return (
        `✅ 教程已完成并收尾：index.md / report.md / metrics.json 已生成。\n` +
        `最终质量：完整度=${state.metrics.completeness?.score} | 可信度=${state.metrics.reliability?.score} | 总分=${state.metrics.qualityScore}（${state.metrics.grade}）\n` +
        `输出目录：${outputDir}`
      );
    },
  };
}

/** 工具注册表（供系统提示词生成与动作分发共用） */
export const TOOL_SCHEMA = [
  { name: "list_files", args: "{}", desc: "列出项目文件清单", parameters: { type: "object", properties: {} } },
  { name: "scan_project", args: "{}", desc: "扫描项目并生成概况（先于 generate_outline 调用）", parameters: { type: "object", properties: {} } },
  { name: "generate_outline", args: "{}", desc: "生成教程大纲（先于 write_chapter 调用）", parameters: { type: "object", properties: {} } },
  { name: "write_chapter", args: '{"index": <数字>}', desc: "撰写/重写指定章节，如 write_chapter({\"index\":1})", parameters: { type: "object", properties: { index: { type: "number", description: "章节序号（1-7）" } }, required: ["index"] } },
  { name: "review_chapter", args: '{"index": <数字>}', desc: "审查指定章节，返回均分(0-10)与问题清单", parameters: { type: "object", properties: { index: { type: "number", description: "章节序号（1-7）" } }, required: ["index"] } },
  { name: "verify_tutorial", args: "{}", desc: "真实执行教程中的项目内命令，统计可运行率", parameters: { type: "object", properties: {} } },
  { name: "compute_metrics", args: "{}", desc: "计算完整度/可信度/总分，判断是否达标", parameters: { type: "object", properties: {} } },
  { name: "finalize", args: "{}", desc: "收尾：生成 index.md/report.md/metrics.json，调用后任务结束", parameters: { type: "object", properties: {} } },
];

/** 转 OpenAI tools 格式（原生 function calling） */
export function toOpenAITools(schema = TOOL_SCHEMA) {
  return schema.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.desc,
      parameters: t.parameters || { type: "object", properties: {} },
    },
  }));
}

/** 分发执行（统一截断、统一报错） */
export async function dispatchTool(tools, action) {
  const fn = tools[action.action];
  if (!fn) return `错误：未知动作 "${action.action}"。可用：${TOOL_SCHEMA.map((t) => t.name).join(", ")}`;
  try {
    const obs = await fn(action.args || {});
    return typeof obs === "string" ? obs : trunc(JSON.stringify(obs));
  } catch (err) {
    return `工具执行异常：${err.message.slice(0, 200)}`;
  }
}
