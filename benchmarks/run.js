#!/usr/bin/env node
/**
 * benchmarks/run.js — 基准测试套件
 *
 * 以「标准评测模式」（review + verify 全开、固定权重）对多个样例项目跑完整流水线，
 * 收集每个项目的耗时 / token 成本 / 完整度 / 可信度 / 总分 / 验证统计，
 * 输出：
 *   benchmarks/out/results.json        机器可读
 *   benchmarks/out/benchmark-report.md 人类可读（含平均值与百分位排名）
 *
 * 用法：
 *   node benchmarks/run.js                 # 跑全部项目
 *   node benchmarks/run.js --projects hello-cli,http-server   # 跑指定项目
 *   node benchmarks/run.js --skip-fix      # 关闭阈值修复（更快的对比基线）
 *
 * 注意：需要 DEEPSEEK_API_KEY 环境变量；每个项目 8-15 分钟，建议后台运行。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { runPipeline } from "../src/pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_ROOT = join(__dirname, "out");

// 每次运行写入独立时间戳目录（保留历史基准记录，且避免删除操作触发安全拦截）
function newRunDir() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join(OUT_ROOT, `run-${ts}`);
}

function parseArgs(argv) {
  const out = { projects: null, skipFix: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--projects") out.projects = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (argv[i] === "--skip-fix") out.skipFix = true;
  }
  return out;
}

function fmtMinutes(ms) {
  return `${(ms / 60000).toFixed(1)} min`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(join(ROOT, "config.json"));
  const spec = JSON.parse(await readFile(join(__dirname, "projects.json"), "utf8"));
  let projects = spec.projects;
  if (args.projects) {
    const wanted = new Set(args.projects);
    projects = projects.filter((p) => wanted.has(p.name));
  }
  console.log(`基准测试：${projects.length} 个项目，标准评测模式（review + verify 全开）\n`);

  const OUT_DIR = newRunDir();
  await mkdir(OUT_DIR, { recursive: true });
  const results = [];

  for (const p of projects) {
    const projDir = resolve(join(__dirname, p.dir));
    const outDir = join(OUT_DIR, p.name);
    await mkdir(outDir, { recursive: true });

    console.log(`\n════════ 项目 ${p.name} ════════`);
    const t0 = Date.now();
    try {
      const { metrics, usage } = await runPipeline({
        config,
        projectPath: projDir,
        outputDir: outDir,
        userOptions: { intro: p.intro, audience: p.audience, focus: p.focus },
        resume: false,
        skipReview: false,
        verify: true,
        template: null,
        baseline: null,
        noFix: args.skipFix,
        threshold: null,
      });
      results.push({
        name: p.name,
        durationMs: Date.now() - t0,
        cost: usage.totalCost,
        currency: usage.currency,
        tokens: usage.totalTokens,
        completeness: metrics.completeness?.score,
        reliability: metrics.reliability?.score,
        qualityScore: metrics.qualityScore,
        grade: metrics.grade,
        issues: Object.values(metrics.issuesByChapter).flat().length,
        details: metrics.details,
      });
      console.log(`  完成: ${fmtMinutes(Date.now() - t0)} | 成本 ${usage.totalCost}${usage.currency} | 质量 ${metrics.qualityScore}（${metrics.grade}）`);
    } catch (err) {
      console.error(`  ✗ 项目 ${p.name} 失败: ${err.message}`);
      results.push({ name: p.name, error: err.message });
    }
  }

  // 汇总
  const ok = results.filter((r) => !r.error);
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);
  const byScore = ok.map((r) => r.qualityScore).sort((a, b) => a - b);

  const report = [];
  report.push("# 基准测试报告", "");
  report.push(`> 标准评测模式：审查 + 真实验证全开 | 样例项目 ${results.length} 个 | 生成时间 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`, "");
  report.push("## 汇总", "", "| 指标 | 平均值 | 中位数 | P90 |", "| --- | --- | --- | --- |");
  const durSorted = ok.map((r) => r.durationMs).sort((a, b) => a - b);
  const costSorted = ok.map((r) => r.cost).sort((a, b) => a - b);
  const compSorted = ok.map((r) => r.completeness).sort((a, b) => a - b);
  const reliSorted = ok.map((r) => r.reliability).sort((a, b) => a - b);
  report.push(`| 端到端耗时 | ${fmtMinutes(avg(durSorted) ?? 0)} | ${fmtMinutes(percentile(durSorted, 50) ?? 0)} | ${fmtMinutes(percentile(durSorted, 90) ?? 0)} |`);
  report.push(`| 单教程成本 | ${avg(costSorted)}${ok[0]?.currency ?? ""} | ${percentile(costSorted, 50)}${ok[0]?.currency ?? ""} | ${percentile(costSorted, 90)}${ok[0]?.currency ?? ""} |`);
  report.push(`| 质量分 | ${avg(byScore)} | ${percentile(byScore, 50)} | ${percentile(byScore, 90)} |`);
  report.push(`| 完整度 | ${avg(compSorted)} | ${percentile(compSorted, 50)} | — |`);
  report.push(`| 可信度 | ${avg(reliSorted)} | ${percentile(reliSorted, 50)} | — |`, "");
  report.push("## 分项目", "", "| 项目 | 耗时 | 成本 | tokens | 完整度 | 可信度 | 质量分 | 等级 | 问题数 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    if (r.error) {
      report.push(`| ${r.name} | 失败: ${r.error} | | | | | | | |`);
    } else {
      report.push(`| ${r.name} | ${fmtMinutes(r.durationMs)} | ${r.cost}${r.currency} | ${r.tokens.toLocaleString()} | ${r.completeness} | ${r.reliability} | ${r.qualityScore} | ${r.grade} | ${r.issues} |`);
    }
  }
  report.push("", "---", "", "*报告由 benchmarks/run.js 自动生成*", "");

  await writeFile(join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2), "utf8");
  await writeFile(join(OUT_DIR, "benchmark-report.md"), report.join("\n"), "utf8");

  console.log(`\n════════ 基准测试完成 ════════`);
  console.log(`  结果: ${join(OUT_DIR, "results.json")}`);
  console.log(`  报告: ${join(OUT_DIR, "benchmark-report.md")}`);
}

main().catch((err) => {
  console.error(`✗ 基准测试失败: ${err.message}`);
  process.exit(1);
});
