#!/usr/bin/env node
/**
 * benchmarks/compare-arch.js — 架构对比实验：v1 确定性流水线 vs v2 ReAct 自主循环
 *
 * 同一项目、同一套底层模块（scanner/writer/reviewer/metrics），只切换"编排层"：
 *   v1 pipeline：执行顺序由代码定死（五阶段 + 阈值修复闭环）
 *   v2 react：   执行顺序由模型自主决策（每步输出 JSON 动作，直到 finalize）
 *
 * 输出 benchmarks/out/compare-arch-<时间戳>/compare-arch-report.md
 *
 * 用法：
 *   node benchmarks/compare-arch.js                          # 默认 b01-hello-cli
 *   node benchmarks/compare-arch.js --project config-tool
 *   node benchmarks/compare-arch.js --skip-v1 / --skip-v2    # 只跑一边（省时间）
 */
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { runPipeline } from "../src/pipeline.js";
import { runReactAgent } from "../src/react/engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_ROOT = join(__dirname, "out");

function parseArgs(argv) {
  const out = { project: "b01-hello-cli", skipV1: false, skipV2: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--project") out.project = argv[++i];
    if (argv[i] === "--skip-v1") out.skipV1 = true;
    if (argv[i] === "--skip-v2") out.skipV2 = true;
  }
  return out;
}

async function resolveSampleDir(name) {
  const samplesRoot = join(__dirname, "samples");
  const exact = join(samplesRoot, name);
  try {
    if ((await stat(exact)).isDirectory()) return exact;
  } catch { /* 模糊匹配 */ }
  const dirs = await readdir(samplesRoot, { withFileTypes: true });
  const hit = dirs.find((d) => d.isDirectory() && d.name.includes(name));
  if (hit) return join(samplesRoot, hit.name);
  throw new Error(`样例项目不存在: ${name}`);
}

const fmt = (ms) => `${(ms / 60000).toFixed(1)} min`;

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(join(ROOT, "config.json"));
  const projectDir = await resolveSampleDir(args.project);
  const runDir = join(OUT_ROOT, `compare-arch-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  await mkdir(runDir, { recursive: true });

  console.log(`架构对比：${projectDir}\n`);
  const results = [];

  // ── v1 流水线 ──
  if (!args.skipV1) {
    const outDir = join(runDir, "v1-pipeline");
    await mkdir(outDir, { recursive: true });
    console.log("════════ v1 确定性流水线 ════════");
    const t0 = Date.now();
    try {
      const { metrics, usage } = await runPipeline({
        config, projectPath: projectDir, outputDir: outDir,
        userOptions: { audience: "有 Node.js 基础的开发者", focus: "偏代码实战" },
        resume: false, skipReview: false, verify: true, noFix: false,
      });
      results.push({
        arch: "v1-pipeline", durationMs: Date.now() - t0, cost: usage.totalCost,
        currency: usage.currency, tokens: usage.totalTokens,
        completeness: metrics.completeness?.score, reliability: metrics.reliability?.score,
        qualityScore: metrics.qualityScore, grade: metrics.grade,
        steps: "固定 5 阶段",
      });
    } catch (err) {
      results.push({ arch: "v1-pipeline", error: err.message });
    }
  }

  // ── v2 ReAct ──
  if (!args.skipV2) {
    const outDir = join(runDir, "v2-react");
    await mkdir(outDir, { recursive: true });
    console.log("\n════════ v2 ReAct 自主循环 ════════");
    const t0 = Date.now();
    try {
      const r = await runReactAgent({
        config, projectPath: projectDir, outputDir: outDir,
        userOptions: { audience: "有 Node.js 基础的开发者", focus: "偏代码实战" },
        maxSteps: 25,
      });
      results.push({
        arch: "v2-react", durationMs: Date.now() - t0, cost: r.usage.totalCost,
        currency: r.usage.currency, tokens: r.usage.totalTokens,
        completeness: r.metrics?.completeness?.score, reliability: r.metrics?.reliability?.score,
        qualityScore: r.metrics?.qualityScore, grade: r.metrics?.grade,
        steps: `${r.steps} 步${r.finished ? "" : "（强制收尾）"}`,
      });
    } catch (err) {
      results.push({ arch: "v2-react", error: err.message });
    }
  }

  // ── 报告 ──
  const report = [];
  report.push("# 架构对比报告：v1 流水线 vs v2 ReAct", "");
  report.push(`> 项目：${args.project} | 底层模块相同（scanner/writer/reviewer/metrics），仅编排层不同 | ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`, "");
  report.push("## 对比", "", "| 架构 | 编排方式 | 耗时 | 成本 | tokens | 完整度 | 可信度 | 质量分 | 等级 | 步数/阶段 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    if (r.error) report.push(`| ${r.arch} | — | 失败: ${r.error} | | | | | | | |`);
    else report.push(`| ${r.arch} | ${r.arch === "v1-pipeline" ? "代码定序" : "模型自主决策"} | ${fmt(r.durationMs)} | ${r.cost}${r.currency} | ${r.tokens.toLocaleString()} | ${r.completeness} | ${r.reliability} | ${r.qualityScore} | ${r.grade} | ${r.steps} |`);
  }
  report.push("", "## 结论", "");
  const ok = results.filter((r) => !r.error);
  if (ok.length >= 2) {
    const best = [...ok].sort((a, b) => b.qualityScore - a.qualityScore)[0];
    const cheapest = [...ok].sort((a, b) => a.cost - b.cost)[0];
    report.push(`- **质量最高**：${best.arch}（${best.qualityScore} 分，等级 ${best.grade}）`);
    report.push(`- **成本最低**：${cheapest.arch}（${cheapest.cost}${cheapest.currency}）`);
    const ratio = (a) => (a.cost > 0 ? a.qualityScore / a.cost : Infinity);
    report.push(`- **性价比**：${[...ok].sort((a, b) => ratio(b) - ratio(a))[0].arch}（${ratio([...ok].sort((a, b) => ratio(b) - ratio(a))[0]).toFixed(0)} 分/元）`);
  }
  report.push("", "### 差异说明", "");
  report.push("- **v1 流水线**：执行顺序由代码定死（扫描→大纲→撰写→审查→验证→评分→修复闭环），每阶段单一任务、输出可校验、成本可预期");
  report.push("- **v2 ReAct**：模型每步自主选择动作（scan/outline/write/review/verify/metrics/finalize），可重复、可跳步；灵活但依赖模型自律，步数有上限兜底");
  report.push("- **公平性提示**：v1 强制全量审查+验证（--verify），v2 是否审查/验证由模型自主决定，两者的资源投入本身不同", "");
  report.push("---", "", "*报告由 benchmarks/compare-arch.js 自动生成*", "");

  await writeFile(join(runDir, "compare-arch-report.md"), report.join("\n"), "utf8");
  await writeFile(join(runDir, "results.json"), JSON.stringify(results, null, 2), "utf8");
  console.log(`\n════════ 对比完成 ════════`);
  console.log(`  报告: ${join(runDir, "compare-arch-report.md")}`);
}

main().catch((err) => {
  console.error(`✗ 架构对比失败: ${err.message}`);
  process.exit(1);
});
