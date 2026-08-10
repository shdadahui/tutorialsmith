#!/usr/bin/env node
/**
 * benchmarks/compare-models.js — 多模型对比实验
 *
 * 同一个项目、同一套流水线，换不同模型跑，量化「模型 → 质量 / 成本 / 耗时」的权衡：
 *   deepseek-chat         标准模型
 *   deepseek-reasoner     推理模型
 *   chat+reasoner-review  chat 写 + reasoner 评审（混合）
 *
 * 输出：
 *   benchmarks/out/compare-<时间戳>/compare-report.md   对比表 + 结论
 *   benchmarks/out/compare-<时间戳>/results.json        机器可读
 *
 * 用法：
 *   node benchmarks/compare-models.js                          # 默认 hello-cli + 全部模型
 *   node benchmarks/compare-models.js --project config-tool
 *   node benchmarks/compare-models.js --models deepseek-chat,deepseek-reasoner
 */
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { runPipeline } from "../src/pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_ROOT = join(__dirname, "out");

function parseArgs(argv) {
  const out = { project: "b01-hello-cli", models: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--project") out.project = argv[++i];
    if (argv[i] === "--models") out.models = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

/** 解析样例项目目录：支持短名（hello-cli → b01-hello-cli）与全名 */
async function resolveSampleDir(name) {
  const samplesRoot = join(__dirname, "samples");
  const exact = join(samplesRoot, name);
  try {
    const st = await stat(exact);
    if (st.isDirectory()) return exact;
  } catch { /* 继续模糊匹配 */ }
  const dirs = await readdir(samplesRoot, { withFileTypes: true });
  const hit = dirs.find((d) => d.isDirectory() && d.name.includes(name));
  if (hit) return join(samplesRoot, hit.name);
  throw new Error(`样例项目不存在: ${name}（可用: ${dirs.filter((d) => d.isDirectory()).map((d) => d.name).join(" / ")}）`);
}

function fmtMinutes(ms) { return `${(ms / 60000).toFixed(1)} min`; }

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(join(ROOT, "config.json"));
  const models = JSON.parse(await readFile(join(__dirname, "models.json"), "utf8"));

  let modelNames = Object.keys(models);
  if (args.models) modelNames = modelNames.filter((n) => args.models.includes(n));

  const projectDir = await resolveSampleDir(args.project);
  const runDir = join(OUT_ROOT, `compare-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  await mkdir(runDir, { recursive: true });

  console.log(`多模型对比：项目 ${projectDir} × ${modelNames.length} 种模型配置\n`);
  const results = [];

  for (const name of modelNames) {
    const mc = models[name];
    // 深拷贝配置并覆盖角色模型
    const cfg = structuredClone(config);
    for (const role of ["scanner", "outliner", "writer"]) {
      cfg.roles[role] = { provider: mc.provider, model: mc.model };
    }
    cfg.roles.reviewer = { provider: mc.provider, model: mc.reviewerModel || mc.model };

    const outDir = join(runDir, name);
    await mkdir(outDir, { recursive: true });

    console.log(`\n════════ 模型配置: ${name}（${mc.note}）════════`);
    const t0 = Date.now();
    try {
      const { metrics, usage } = await runPipeline({
        config: cfg,
        projectPath: projectDir,
        outputDir: outDir,
        userOptions: { audience: "有 Node.js 基础的开发者", focus: "偏代码实战" },
        resume: false,
        skipReview: false,
        verify: true,
        noFix: false,
        threshold: null,
      });
      results.push({
        model: name, note: mc.note,
        durationMs: Date.now() - t0,
        cost: usage.totalCost, currency: usage.currency, tokens: usage.totalTokens,
        completeness: metrics.completeness?.score, reliability: metrics.reliability?.score,
        qualityScore: metrics.qualityScore, grade: metrics.grade,
        issues: Object.values(metrics.issuesByChapter).flat().length,
      });
      console.log(`  完成: ${fmtMinutes(Date.now() - t0)} | 成本 ${usage.totalCost}${usage.currency} | 质量 ${metrics.qualityScore}（${metrics.grade}）`);
    } catch (err) {
      console.error(`  ✗ ${name} 失败: ${err.message}`);
      results.push({ model: name, note: mc.note, error: err.message });
    }
  }

  // 报告
  const ok = results.filter((r) => !r.error);
  const report = [];
  report.push("# 多模型对比报告", "");
  report.push(`> 项目：${args.project} | 标准评测模式（审查+验证全开）| ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`, "");
  report.push("## 对比", "", "| 模型配置 | 说明 | 耗时 | 成本 | tokens | 完整度 | 可信度 | 质量分 | 等级 | 问题数 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    if (r.error) report.push(`| ${r.model} | ${r.note} | 失败: ${r.error} | | | | | | | |`);
    else report.push(`| ${r.model} | ${r.note} | ${fmtMinutes(r.durationMs)} | ${r.cost}${r.currency} | ${r.tokens.toLocaleString()} | ${r.completeness} | ${r.reliability} | ${r.qualityScore} | ${r.grade} | ${r.issues} |`);
  }

  // 结论
  if (ok.length >= 2) {
    report.push("", "## 结论", "");
    const best = [...ok].sort((a, b) => b.qualityScore - a.qualityScore)[0];
    const cheapest = [...ok].sort((a, b) => a.cost - b.cost)[0];
    const bestValue = [...ok].filter((r) => r.cost > 0).sort((a, b) => (b.qualityScore / b.cost) - (a.qualityScore / a.cost))[0];
    report.push(`- **质量最高**：${best.model}（${best.qualityScore} 分，等级 ${best.grade}，成本 ${best.cost}${best.currency}）`);
    report.push(`- **成本最低**：${cheapest.model}（${cheapest.cost}${cheapest.currency}）`);
    if (bestValue) report.push(`- **性价比最高**（质量分/成本）：${bestValue.model}（${(bestValue.qualityScore / bestValue.cost).toFixed(0)} 分/元）`);
  }
  report.push("", "---", "", "*报告由 benchmarks/compare-models.js 自动生成*", "");

  await writeFile(join(runDir, "compare-report.md"), report.join("\n"), "utf8");
  await writeFile(join(runDir, "results.json"), JSON.stringify(results, null, 2), "utf8");

  console.log(`\n════════ 对比完成 ════════`);
  console.log(`  报告: ${join(runDir, "compare-report.md")}`);
  console.log(`  数据: ${join(runDir, "results.json")}`);
}

main().catch((err) => {
  console.error(`✗ 对比实验失败: ${err.message}`);
  process.exit(1);
});
