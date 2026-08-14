/**
 * pipeline.js — 流水线编排：把各阶段串成一条完整产线
 *
 * 数据流：
 *   scanProject(项目目录) ──filesText(+视觉提取)──▶ scanner LLM ──projectSummary──▶
 *   outliner LLM ──outline(JSON)──▶ writer 逐章 ──chapter-*.md──▶
 *   reviewer 逐章审查 ──issues──▶ (revise 章节带意见重写)
 *   metrics 量化评分 ──QualityScore < 阈值──▶ 本地问题清单回灌 writer 修复（最多 N 轮）
 *   ──▶ index.md + report.md + metrics.json
 *
 * 每个阶段通过 config 里的 roles 映射到不同的 provider+model。
 */
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { scanProject, describeImages } from "./scanner.js";
import { chat } from "./llm.js";
import { SCANNER_SYS, buildScannerUser, PITFALL_SYS, buildPitfallUser } from "./prompts.js";
import { generateOutline, parseJsonLoose } from "./outliner.js";
import { writeAllChapters, writeChapter, CHAPTER_FILE } from "./writer.js";
import { reviewAllChapters } from "./reviewer.js";
import { computeMetrics } from "./metrics.js";
import { verifyChapters, createSandbox, cleanupSandbox } from "./verifier.js";
import { runReproduce } from "./reproduce/engine.js";
import { checkAllChaptersUrls } from "./urlcheck.js";
import { writeReport } from "./report.js";
import { resolveRole, resolveVision } from "./config.js";
import { resetUsage, getUsageSummary } from "./usage.js";

/** 校验 scanner 输出（项目概况）结构 */
export function isValidSummary(s) {
  return (
    s &&
    typeof s === "object" &&
    typeof s.project_name === "string" &&
    Array.isArray(s.tech_stack) &&
    Array.isArray(s.core_features)
  );
}

/** scanner 兜底：LLM 失败时，根据文件名拼一个最小概况，保证流水线不断 */
export function fallbackSummary(projectPath, filePaths) {
  const name = basename(projectPath);
  const keyFiles = filePaths.slice(0, 15).map((p) => ({ path: p, purpose: "" }));
  return {
    project_name: name,
    description: `项目 ${name}（自动扫描生成的最小概况，建议人工补充简介）`,
    tech_stack: [],
    architecture: "",
    entry_points: [],
    key_files: keyFiles,
    core_features: [],
    dependencies: [],
    notable_details: "",
  };
}

/** 生成总索引 index.md（本地拼接，不消耗 LLM） */
export async function writeIndex(outputDir, outline, chaptersWritten) {
  const lines = [
    `# ${outline.project_name} 技术教程`,
    "",
    `> 本教程由 tutorial-agent 自动生成${outline.audience_note ? `。\n> 面向读者：${outline.audience_note}` : ""}`,
    "",
    "## 目录",
    "",
  ];
  for (const ch of outline.chapters) {
    const filename = CHAPTER_FILE(ch.index);
    const exists = chaptersWritten.has(ch.index);
    let title = ch.title;
    if (exists) {
      // 章节文件标题自带"第N章"前缀，去掉以免重复
      const raw = await readFirstHeading(join(outputDir, filename));
      const cleaned = raw.replace(/^第\s*\d+\s*章\s*/, "").trim();
      if (cleaned) title = cleaned;
    }
    lines.push(`- [第 ${ch.index} 章 ${title}](${filename})`);
  }
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  lines.push("", "---", "", `*生成时间：${now}*`, "", "## 质量报告", "", "- [report.md](report.md) 教程量化质量报告（含维度评分与待改进问题）", "", "---", "", `*本教程由 tutorial-agent 生成*`);
  await writeFile(join(outputDir, "index.md"), lines.join("\n"), "utf8");
}

/** 读取章节文件第一行标题 */
async function readFirstHeading(p) {
  try {
    await access(p);
    const text = await readFile(p, "utf8");
    const first = text.split("\n").find((l) => l.startsWith("# "));
    return first ? first.replace(/^#\s*/, "").trim() : "";
  } catch {
    return "";
  }
}

/** 从磁盘读取全部章节内容（供指标计算与修复循环使用） */
async function readChapterFiles(outputDir, outline) {
  const files = [];
  for (const ch of outline.chapters) {
    const p = join(outputDir, CHAPTER_FILE(ch.index));
    try {
      await access(p);
      files.push({ index: ch.index, content: await readFile(p, "utf8") });
    } catch {
      files.push({ index: ch.index, content: "" });
    }
  }
  return files;
}

/**
 * 踩坑回填（验证门控）：真实验证失败的项目内命令 → 调 writer 生成「踩坑记录」小节，
 * 追加到第 4 章末尾，保证"遇到的实际困难点"写进教程（而非只进报告）。
 * @returns {Promise<number>} 写入的失败命令条数（0 = 无失败或未开启验证）
 */
async function appendPitfallRecord({ config, outputDir, verifyResult, projectSummary, filePaths }) {
  if (!verifyResult) return 0;
  const failed = verifyResult.results.filter((r) => r.ok === false && !r.skipped);
  if (!failed.length) return 0;

  // 汇总失败命令（命令 + 错误摘要），按章节排序
  const failedList = failed
    .sort((a, b) => a.chapter - b.chapter)
    .map((r) => `第${r.chapter}章 命令: ${r.command}\n   报错: ${(r.output || "").split("\n").slice(0, 3).join(" | ").slice(0, 240)}`)
    .join("\n\n");

  const writerRole = resolveRole(config, "writer");
  let text = "";
  try {
    text = await chat({
      roleConfig: writerRole,
      system: PITFALL_SYS,
      user: buildPitfallUser({ projectSummary, failedList }),
      maxTokens: 2048,
    });
  } catch (err) {
    console.warn(`  ⚠ 踩坑回填失败: ${err.message}`);
    return 0;
  }
  if (!text.trim()) return 0;

  // 追加到第 4 章（章节缺失则跳过）
  const p04 = join(outputDir, CHAPTER_FILE(4));
  try {
    await access(p04);
  } catch {
    return 0;
  }
  const content = await readFile(p04, "utf8");
  const section = `\n\n## 4.6 踩坑记录（真实验证实录）\n\n> 本小节由教程生成器在真实执行教程命令后自动补充：以下问题均在实际验证中真实发生。\n\n${text.trim()}\n`;
  await writeFile(p04, content + section, "utf8");
  return failed.length;
}

/**
 * 运行完整流水线。
 * @param {object} args
 * @param {object} args.config      loadConfig() 的结果
 * @param {string} args.projectPath 目标项目目录（绝对路径）
 * @param {string} args.outputDir   教程输出目录
 * @param {object} args.userOptions { intro, audience, focus }
 * @param {boolean} args.resume     跳过已存在章节
 * @param {boolean} args.skipReview 跳过质量审查阶段
 * @param {boolean} args.verify     开启真实验证（执行教程中的命令）
 * @param {object|null} args.template 自定义章节模板（isValidTemplate 通过）
 * @param {object|null} args.baseline 黄金样本 metrics（用于报告对比）
 * @param {boolean} args.noFix      关闭"分数低于阈值自动修复"
 * @param {number|null} args.threshold 质量阈值（覆盖 config 默认值）
 */
export async function runPipeline({
  config, projectPath, outputDir, userOptions,
  resume = false, skipReview = false, verify = false,
  template = null, baseline = null, noFix = false, threshold = null, noReproduce = false,
}) {
  // 每个 run 独立统计 token/成本（基准测试逐项目调用时保证互不污染）
  resetUsage();
  const metaPath = join(outputDir, "meta.json");

  console.log(`\n════════ 阶段 1/4：扫描分析项目 ════════`);
  console.log(`  目标目录: ${projectPath}`);
  const scanResult = await scanProject(projectPath, {
    maxProjectBytes: config.defaults.maxProjectBytes,
  });
  let { filesText, fileCount, totalBytes, filePaths, imageFiles } = scanResult;

  // 视觉模型增强（可选）：项目里有架构图/截图且配置了 vision provider
  const visionConfig = resolveVision(config);
  if (imageFiles?.length && visionConfig) {
    console.log(`  发现 ${imageFiles.length} 张图片，正在用视觉模型提取信息...`);
    const visionText = await describeImages({ imageFiles, projectPath, visionConfig });
    if (visionText) filesText += `\n\n${visionText}`;
  } else if (imageFiles?.length) {
    console.log(`  （发现 ${imageFiles.length} 张图片，未配置视觉模型，已跳过）`);
  }
  console.log(`  已读取 ${fileCount} 个文件${imageFiles?.length ? ` + ${imageFiles.length} 张图片` : ""}，共 ${(totalBytes / 1024).toFixed(1)} KB 素材`);

  // meta.json 复用：resume 时跳过扫描/大纲两次 LLM 调用
  let projectSummary = null;
  let outline = null;
  let metaLoaded = false;
  if (resume) {
    try {
      await access(metaPath);
      const meta = JSON.parse(await readFile(metaPath, "utf8"));
      if (meta.projectSummary && meta.outline) {
        projectSummary = meta.projectSummary;
        outline = meta.outline;
        metaLoaded = true;
        console.log(`  ⏭ 复用上次的中间产物（meta.json）：项目概况 + 大纲（省 2 次 LLM 调用）`);
      }
    } catch { /* meta 不存在或损坏则正常走全流程 */ }
  }

  if (!projectSummary) {
    let summary = null;
    const scannerRole = resolveRole(config, "scanner");
    for (let attempt = 1; attempt <= 2 && !summary; attempt++) {
      const raw = await chat({ roleConfig: scannerRole, system: SCANNER_SYS, user: buildScannerUser(filesText), jsonMode: true });
      const parsed = parseJsonLoose(raw);
      if (isValidSummary(parsed)) {
        summary = parsed;
      } else if (attempt < 2) {
        console.warn("  ⚠ 项目概况 JSON 校验未通过，重试中...");
      }
    }
    if (!summary) {
      console.warn("  ⚠ 项目概况生成失败，使用最小兜底概况（教程质量可能下降）。");
      summary = fallbackSummary(projectPath, filePaths);
    }
    projectSummary = summary;
    console.log(`  ✓ 项目概况: ${projectSummary.project_name} | 技术栈: ${(projectSummary.tech_stack || []).join(", ") || "未知"}`);
  }

  if (!outline) {
    console.log(`\n════════ 阶段 2/4：生成教程大纲 ════════`);
    outline = await generateOutline({
      roleConfig: resolveRole(config, "outliner"),
      projectSummary,
      userOptions,
      template,
    });
  }

  // 写作前复现（v4）：先把项目真实跑起来，产出"已验证命令清单"注入 writer。
  // v6.1 沙箱：复现与验证都在临时副本中执行，目标项目零污染。
  let reproduction = null;
  let sandboxPath = null;
  if (resume && metaLoaded) {
    try {
      const m = JSON.parse(await readFile(metaPath, "utf8"));
      if (m.reproduction) reproduction = m.reproduction;
    } catch { /* meta 里没有复现记录 */ }
  }
  if (!reproduction && !noReproduce) {
    try {
      sandboxPath = await createSandbox(projectPath);
      console.log(`  🛡 沙箱模式：复现与验证在隔离副本中执行（目标项目零污染）`);
      reproduction = (await runReproduce({ config, projectPath: sandboxPath, maxSteps: config.defaults.reproduceMaxSteps ?? 12 })).reproduction;
    } catch (err) {
      console.warn(`  ⚠ 写作前复现失败（继续生成，但命令未经预验证）: ${err.message}`);
    }
  }

  // 持久化中间产物（断点续写 + 基准测试复用）
  await mkdir(outputDir, { recursive: true });
  await writeFile(metaPath, JSON.stringify({
    projectSummary,
    outline,
    reproduction,
    generatedAt: new Date().toISOString(),
  }, null, 2), "utf8");

  console.log(`\n════════ 阶段 3/4：逐章撰写（并发 ${config.defaults.concurrency}）════════`);
  const writerRole = resolveRole(config, "writer");
  const { files } = await writeAllChapters({
    roleConfig: writerRole,
    projectSummary,
    outline,
    outputDir,
    resume,
    reproduction,
    custom: userOptions?.custom,
    concurrency: config.defaults.concurrency,
  });

  // 阶段 4：质量审查 → 有问题的章节带意见重写一轮
  let chapterScores = {};
  if (!skipReview) {
    console.log(`\n════════ 阶段 4/4：质量审查 ════════`);
    const reviewerRole = resolveRole(config, "reviewer");
    const { reviewMap, chapterScores: scores, passCount, reviseCount } = await reviewAllChapters({
      roleConfig: reviewerRole,
      outline,
      files,
    });
    chapterScores = scores;

    if (reviseCount > 0) {
      console.log(`\n  ✏ 共 ${reviseCount} 章需修订，正在带审查意见重写...`);
      await writeAllChapters({
        roleConfig: writerRole,
        projectSummary,
        outline,
        outputDir,
        resume: false,
        reviewMap,
        reproduction,
        custom: userOptions?.custom,
        concurrency: config.defaults.concurrency,
      });
      console.log(`  ✓ 修订完成`);
    } else {
      console.log(`  ✓ 全部 ${passCount} 章通过审查`);
    }
  } else {
    console.log(`\n（已跳过质量审查阶段 --skip-review）`);
  }

  // ════════ 阶段 5：量化指标 + 真实验证 + 阈值修复闭环 ════════
  console.log(`\n════════ 阶段 5/5：量化评估 ${verify ? "+ 真实验证" : ""} ════════`);

  let chapterFiles = await readChapterFiles(outputDir, outline);
  const reviewScores = Object.values(chapterScores).filter((v) => v != null);
  // reviewer 均分是 0-10 制，换算成 0-100 参与加权合成
  const reviewScore = reviewScores.length
    ? Math.round((reviewScores.reduce((a, b) => a + b, 0) / reviewScores.length) * 100) / 10
    : null;

  // 真实验证（可选）——在沙箱副本中执行（v6.1）
  let verifyResult = null;
  if (verify) {
    console.log("  正在真实执行教程中的命令（危险命令已过滤，沙箱隔离）...");
    if (!sandboxPath) {
      sandboxPath = await createSandbox(projectPath);
      console.log(`  🛡 沙箱模式：验证在隔离副本中执行（目标项目零污染）`);
    }
    verifyResult = await verifyChapters({ chapterFiles, projectPath: sandboxPath });
    console.log(`  验证结果: 执行 ${verifyResult.total} 条，通过 ${verifyResult.ok} 条，跳过 ${verifyResult.skipped} 条 → 可运行率 ${verifyResult.score ?? "N/A"}`);
  }

  const weights = config.defaults.metricsWeights;
  let metrics = computeMetrics({
    outline, chapterFiles, projectFilePaths: filePaths,
    reviewScore, codeScore: verifyResult?.score ?? null, weights,
  });

  // 把验证失败的命令也并入问题清单（回灌 writer 时可修正命令写法）
  const addVerifyIssues = () => {
    if (!verifyResult) return;
    for (const r of verifyResult.results) {
      if (r.skipped || r.ok) continue;
      const idx = String(r.chapter);
      metrics.issuesByChapter[idx] = metrics.issuesByChapter[idx] || [];
      if (!metrics.issuesByChapter[idx].some((i) => i.includes(r.command))) {
        metrics.issuesByChapter[idx].push(`命令验证失败（请改为实际可运行的命令）: ${r.command}`);
      }
    }
    metrics.allIssues = Object.entries(metrics.issuesByChapter)
      .flatMap(([idx, issues]) => issues.map((i) => `第${idx}章：${i}`));
  };
  addVerifyIssues();

  // 阈值修复闭环：本地可枚举问题 → 回灌 writer → 重算，最多 maxFixRounds 轮。
  // 策略：只保留"有改进"的版本——若重写后分数不升反降，则回滚旧内容并停止。
  const qualityThreshold = threshold ?? config.defaults.qualityThreshold;
  const maxFixRounds = config.defaults.maxFixRounds;
  const fixHistory = [];
  let fixRound = 0;
  while (!noFix && metrics.qualityScore < qualityThreshold && fixRound < maxFixRounds) {
    const before = metrics.qualityScore;
    const entries = Object.entries(metrics.issuesByChapter)
      .map(([idx, issues]) => ({ idx: Number(idx), issues }))
      .filter((e) => e.issues.length > 0);
    if (entries.length === 0) break;

    // 快照旧内容，用于分数回退时还原
    const oldContents = new Map();
    for (const { idx } of entries) {
      try {
        await access(join(outputDir, CHAPTER_FILE(idx)));
        oldContents.set(idx, await readFile(join(outputDir, CHAPTER_FILE(idx)), "utf8"));
      } catch { /* 章节不存在则跳过还原 */ }
    }

    fixRound++;
    console.log(`\n  ⚠ 质量分 ${before} < 阈值 ${qualityThreshold}，第 ${fixRound}/${maxFixRounds} 轮修复（${entries.length} 章）...`);
    for (const { idx, issues } of entries) {
      const chapter = outline.chapters.find((c) => c.index === idx);
      if (!chapter) continue;
      console.log(`  ✏ 修复: ${CHAPTER_FILE(idx)}（${issues.length} 条问题）`);
      const { content } = await writeChapter({
        roleConfig: writerRole, projectSummary, chapter, chapterIndex: idx,
        reviewerIssues: issues.map((i) => `【本地量化问题】${i}`),
        reproduction,
        custom: userOptions?.custom,
      });
      await writeFile(join(outputDir, CHAPTER_FILE(idx)), content, "utf8");
    }

    chapterFiles = await readChapterFiles(outputDir, outline);
    metrics = computeMetrics({
      outline, chapterFiles, projectFilePaths: filePaths,
      reviewScore, codeScore: verifyResult?.score ?? null, weights,
    });
    addVerifyIssues(); // 重算后保留验证失败问题

    const after = metrics.qualityScore;
    fixHistory.push({
      threshold: qualityThreshold,
      scoreBefore: before,
      scoreAfter: after,
      chaptersFixed: entries.map((e) => e.idx),
    });

    if (after <= before) {
      // 没有改进：回滚到旧版本，避免教程被改差
      console.log(`  ⚠ 修复后分数未提升（${before} → ${after}），回滚本轮修改并停止。`);
      for (const [idx, oldContent] of oldContents) {
        await writeFile(join(outputDir, CHAPTER_FILE(idx)), oldContent, "utf8");
      }
      chapterFiles = await readChapterFiles(outputDir, outline);
      metrics = computeMetrics({
        outline, chapterFiles, projectFilePaths: filePaths,
        reviewScore, codeScore: verifyResult?.score ?? null, weights,
      });
      addVerifyIssues();
      fixHistory[fixHistory.length - 1].scoreAfter = metrics.qualityScore;
      fixHistory[fixHistory.length - 1].rolledBack = true;
      break;
    }
    console.log(`  ✓ 修复后质量分: ${before} → ${after}`);
  }

  // URL 真实性强制修复（不依赖质量阈值）：疑似编造 URL（如 example.com/login）的章节直接重写一轮
  const urlIssues = checkAllChaptersUrls(chapterFiles);
  const urlBadChapters = Object.keys(urlIssues).map(Number);
  if (urlBadChapters.length > 0) {
    console.log(`\n  🔗 发现 ${urlBadChapters.length} 章含疑似编造 URL（示例域子路径不存在），强制修复...`);
    for (const idx of urlBadChapters) {
      const chapter = outline.chapters.find((c) => c.index === idx);
      if (!chapter) continue;
      console.log(`  ✏ 重写（URL 真实性）: ${CHAPTER_FILE(idx)}`);
      const { content } = await writeChapter({
        roleConfig: writerRole, projectSummary, chapter, chapterIndex: idx,
        reviewerIssues: urlIssues[idx].map((u) => `【URL 真实性】示例 URL 疑似编造: ${u}（example.com 等示例域只有根路径可访问，子路径不存在）；请改为真实可达的测试站点 URL（如 httpbin.org），或改为 <your-domain>/... 占位并注明替换`),
        reproduction, custom: userOptions?.custom,
      });
      await writeFile(join(outputDir, CHAPTER_FILE(idx)), content, "utf8");
    }
    chapterFiles = await readChapterFiles(outputDir, outline);
    metrics = computeMetrics({
      outline, chapterFiles, projectFilePaths: filePaths,
      reviewScore, codeScore: verifyResult?.score ?? null, weights,
    });
    addVerifyIssues();
    console.log("  ✓ URL 问题章节已重写");
  }

  // 输出：index + 报告 + 机器可读指标 + 成本
  const chaptersWritten = new Set(files.map((f) => {
    const m = f.path.match(/chapter-(\d+)\.md/);
    return m ? Number(m[1]) : null;
  }).filter(Boolean));
  const usage = getUsageSummary(config.defaults.costs);

  // 踩坑回填（验证门控）：真实验证失败的命令 → 调 writer 生成踩坑记录，追加到第 4 章
  const pitfallsWritten = await appendPitfallRecord({ config, outputDir, verifyResult, projectSummary: outline, filePaths });
  if (pitfallsWritten > 0) {
    console.log(`  📌 已将 ${pitfallsWritten} 条验证失败命令写入第 4 章「踩坑记录」`);
    // 回填会改变第 4 章内容，需重读以便 index 标题正确
    const p04 = join(outputDir, CHAPTER_FILE(4));
    try { await access(p04); } catch { /* 章节缺失则忽略 */ }
  }

  await writeIndex(outputDir, outline, chaptersWritten);
  await writeReport({ metrics, outputDir, baseline, verify: verifyResult, fixHistory, usage });  await writeFile(join(outputDir, "metrics.json"), JSON.stringify({
    qualityScore: metrics.qualityScore,
    grade: metrics.grade,
    completeness: metrics.completeness,
    reliability: metrics.reliability,
    details: metrics.details,
    raw: metrics.raw,
    issuesCount: Object.values(metrics.issuesByChapter).flat().length,
    fixHistory,
    usage: {
      totalTokens: usage.totalTokens,
      totalCost: usage.totalCost,
      currency: usage.currency,
      cacheHitTokens: usage.cacheHitTokens,
      cacheMissTokens: usage.cacheMissTokens,
      cacheRate: usage.cacheRate,
      byModel: usage.byModel,
    },
  }, null, 2), "utf8");

  console.log(`\n════════ 完成 ════════`);
  console.log(`  教程输出目录: ${outputDir}`);
  console.log(`  章节文件: chapter-01.md ~ chapter-${String(outline.chapters.length).padStart(2, "0")}.md`);
  console.log(`  总索引: index.md | 质量报告: report.md | 量化指标: metrics.json`);
  console.log(`  完整度: ${metrics.completeness?.score ?? "—"}（${metrics.completeness?.grade ?? "-"}） | 可信度: ${metrics.reliability?.score ?? "—"}（${metrics.reliability?.grade ?? "-"}）`);
  console.log(`  质量分: ${metrics.qualityScore} / 100（等级 ${metrics.grade}）${qualityThreshold ? `，阈值 ${qualityThreshold}` : ""}`);
  if (usage.totalTokens > 0) console.log(`  用量: ${usage.totalTokens.toLocaleString()} tokens | 估算成本: ${usage.totalCost}${usage.currency}`);
  if (fixHistory.length) console.log(`  阈值修复: ${fixHistory.length} 轮（${fixHistory.map((f) => `${f.scoreBefore}→${f.scoreAfter}`).join("，")}）`);

  // 清理沙箱（临时副本），目标项目始终保持零污染
  if (sandboxPath) {
    await cleanupSandbox(sandboxPath);
    sandboxPath = null;
  }

  return { outline, outputDir, metrics, usage };
}
