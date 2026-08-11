/**
 * report.js — 渲染 report.md 质量报告（纯本地，零 LLM）
 *
 * 报告包含：
 *   1. 总分 + 等级 + 与黄金样本（--baseline）的对比
 *   2. 各维度分数表（含可视化条形）
 *   3. 问题清单（按章节）
 *   4. 真实验证结果（--verify 开启时）
 *   5. 修复循环的历史记录（如触发过阈值修复）
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bar } from "./metrics.js";

const DIM_LABELS = {
  structure: "结构完整度",
  format: "格式规范度",
  factual: "事实一致性",
  density: "信息密度",
  code: "代码可运行率",
  review: "LLM 评审分",
};

/**
 * @param {object} deps
 * @param {object} deps.metrics      computeMetrics() 的结果
 * @param {string} deps.outputDir    输出目录
 * @param {object|null} deps.baseline 黄金样本 metrics（可选）
 * @param {object|null} deps.verify   verifier 结果（可选）
 * @param {Array} deps.fixHistory    修复轮次记录 [{round, threshold, scoreBefore, scoreAfter, chaptersFixed}]
 * @param {object|null} deps.usage    getUsageSummary() 的结果（可选）
 */
export async function writeReport({ metrics, outputDir, baseline = null, verify = null, fixHistory = [], usage = null }) {
  const lines = [];
  lines.push("# 教程质量报告", "");

  // 双 headline 指标
  const comp = metrics.completeness?.score;
  const reli = metrics.reliability?.score;
  lines.push(`**完整度：${comp ?? "未启用"} / 100（${metrics.completeness?.grade ?? "-"}）**（内容生成得全不全、规不规范）`);
  lines.push(`**可信度：${reli ?? "未启用"} / 100（${metrics.reliability?.grade ?? "-"}）**（内容是不是真的、能不能跑）`);
  lines.push(`**总分：${metrics.qualityScore} / 100（等级 ${metrics.grade}）**`);
  if (baseline) {
    const delta = Math.round((metrics.qualityScore - baseline.qualityScore) * 10) / 10;
    const sign = delta >= 0 ? "+" : "";
    lines.push(`**对比黄金样本：${metrics.qualityScore} vs ${baseline.qualityScore}（${sign}${delta}）**`);
  }
  lines.push("", "---", "", "## 各维度得分", "", "| 维度 | 得分 | 可视化 |", "| --- | --- | --- |");
  for (const [key, label] of Object.entries(DIM_LABELS)) {
    const v = metrics.details[key];
    const cell = v == null ? "未启用" : `${v} / 100`;
    const ref = key === "review" ? "（参考）" : "";
    lines.push(`| ${label}${ref} | ${cell} | \`${bar(v)}\` |`);
  }
  lines.push("");

  // 加权明细
  lines.push("> 完整度 = 结构/格式/密度 加权；可信度 = 事实/代码/评审 加权。未启用维度不参与计分。", "");

  // 成本统计
  if (usage) {
    lines.push("## 成本统计", "");
    lines.push(`累计调用 token：**${usage.totalTokens.toLocaleString()}**（输入 ${usage.totalInput.toLocaleString()} / 输出 ${usage.totalOutput.toLocaleString()}），估算成本 **${usage.totalCost}${usage.currency}**`, "");
    if (usage.cacheRate != null) {
      lines.push(`上下文缓存命中率：**${usage.cacheRate}%**（命中 ${usage.cacheHitTokens.toLocaleString()} / 未命中 ${usage.cacheMissTokens.toLocaleString()} token，DeepSeek 自动缓存）`, "");
    }
    lines.push("| 模型 | 输入 token | 输出 token | 估算成本 |", "| --- | --- | --- | --- |");
    for (const [model, m] of Object.entries(usage.byModel)) {
      lines.push(`| ${model} | ${m.promptTokens.toLocaleString()} | ${m.completionTokens.toLocaleString()} | ${m.cost}${usage.currency} |`);
    }
    lines.push("", "> 成本按 config.json 的 defaults.costs 估算，仅供参考。", "");
  }

  // 修复历史
  if (fixHistory.length > 0) {
    lines.push("## 阈值修复记录", "");
    lines.push("| 轮次 | 阈值 | 修复前 | 修复后 | 修复章节 |", "| --- | --- | --- | --- | --- |");
    fixHistory.forEach((f, i) => {
      lines.push(`| ${i + 1} | ${f.threshold} | ${f.scoreBefore} | ${f.scoreAfter} | ${f.chaptersFixed.join("、") || "—"} |`);
    });
    lines.push("");
  }

  // 问题清单
  const issues = Object.entries(metrics.issuesByChapter || {});
  if (issues.length > 0) {
    lines.push("## 待改进问题", "");
    for (const [idx, list] of issues) {
      lines.push(`### 第 ${idx} 章`);
      for (const item of list) lines.push(`- ${item}`);
      lines.push("");
    }
  } else {
    lines.push("## 待改进问题", "", "无（本地规则未发现问题，仍有 LLM 评审/人工复核空间）", "");
  }

  // 真实验证结果
  if (verify) {
    lines.push("## 真实验证结果（--verify）", "");
    lines.push(`项目内命令：执行 ${verify.total} 条，通过 ${verify.ok} 条 → 可运行率 **${verify.score ?? "N/A"}**`, "");
    lines.push(`系统/平台命令：${verify.systemTotal ?? 0} 条（环境假设，目标环境可能与本机不同，不参与评分）`, "");
    lines.push("| 章节 | 命令 | 类型 | 结果 | 输出摘要 |", "| --- | --- | --- | --- | --- |");
    for (const r of verify.results) {
      const state = r.skipped ? "⏭ 跳过" : r.ok ? "✅ 通过" : "❌ 失败";
      const kind = r.kind === "system" ? "环境假设" : r.skipped ? "过滤" : "项目内";
      const out = r.output.replace(/\n/g, " ").slice(0, 80);
      lines.push(`| 第${r.chapter}章 | \`${r.command.slice(0, 50)}\` | ${kind} | ${state} | ${out} |`);
    }
    lines.push("", "> **注意**：验证在项目目录内就地执行，可能产生副作用（如写入数据文件），建议人工复核敏感命令。", "");
  }

  // 生成时间
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  lines.push("---", "", `*报告生成时间：${now}*`, "");

  await writeFile(join(outputDir, "report.md"), lines.join("\n"), "utf8");
  return join(outputDir, "report.md");
}
