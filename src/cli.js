#!/usr/bin/env node
/**
 * cli.js — 命令行入口
 *
 * 用法：
 *   node src/cli.js --project ./xxx --output ./docs [options]
 *
 * 选项：
 *   --project <path>   目标项目目录（必填）
 *   --output <path>    教程输出目录（默认 ./output）
 *   --config <path>    配置文件路径（默认 ./config.json）
 *   --intro <text>     补充项目简介
 *   --audience <text>  目标受众（如"有 Python 基础的开发者"）
 *   --focus <text>     教程侧重（如"偏代码实战"）
 *   --resume           断点续写：跳过输出目录中已生成的章节
 *   --skip-review      跳过质量审查阶段（更快、更省 token）
 *   --verify           开启真实验证：执行教程中的命令并统计可运行率
 *   --template <path>  自定义章节模板（template.json，默认 7 章结构）
 *   --baseline <path>  黄金样本指标文件（metrics.json），报告中进行对比
 *   --threshold <num>  质量分阈值（默认读 config，低于则自动修复教程）
 *   --no-fix           关闭"分数低于阈值自动修复"（默认开启）
 *   --browse           生成完成后用 mdbrowse-cli 打开网页版文档预览
 *   --port <num>       网页预览端口（默认 3000，被占用自动换）
 *   --agent <pipeline|react> 生成范式：pipeline=确定性流水线（默认），react=ReAct 自主循环（v2）
 *   --help             查看帮助
 */
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { loadEnv } from "./env.js";
import { loadConfig } from "./config.js";
import { runPipeline } from "./pipeline.js";
import { runReactAgent } from "./react/engine.js";
import { isValidTemplate } from "./outliner.js";
import { openBrowse } from "./browse.js";

// 第一件事：加载 .env（放在解析参数之前，保证任何阶段都能读到 API Key）
loadEnv();

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    output: { type: "string" },
    config: { type: "string" },
    intro: { type: "string" },
    audience: { type: "string" },
    focus: { type: "string" },
    resume: { type: "boolean", default: false },
    "skip-review": { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    template: { type: "string" },
    baseline: { type: "string" },
    threshold: { type: "string" },
    "no-fix": { type: "boolean", default: false },
    "no-reproduce": { type: "boolean", default: false },
    browse: { type: "boolean", default: false },
    port: { type: "string" },
    agent: { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: false, // 容忍未知参数，便于扩展
});

if (values.help || !values.project) {
  console.log(`
教程生成 Agent — 基于项目自动生成技术教程

用法:
  node src/cli.js --project <项目目录> [选项]

必填:
  --project <path>    目标项目目录（相对或绝对路径）

可选:
  --output <path>     教程输出目录（默认 ./output）
  --config <path>     配置文件（默认 ./config.json，可配置多 LLM 分工）
  --intro <text>      补充项目简介（可选）
  --audience <text>   目标受众，如"有 Python 基础的开发者"（可选）
  --focus <text>      教程侧重，如"偏代码实战 / 偏原理讲解"（可选）
  --resume            断点续写：跳过输出目录中已生成的章节
  --skip-review       跳过质量审查阶段（更快更省 token）
  --verify            开启真实验证：执行教程中的命令并统计可运行率
  --template <path>   自定义章节模板 JSON（默认内置 7 章结构）
  --baseline <path>   黄金样本 metrics.json，报告中做质量对比
  --threshold <num>   质量分阈值（默认读 config），低于阈值自动修复教程
  --no-fix            关闭"分数低于阈值自动修复"（默认开启）
  --browse            生成完成后用 mdbrowse-cli 打开网页版文档预览
  --port <num>        网页预览端口（默认 3000，被占用自动换）
  --agent react       用 ReAct 范式（v2，模型自主决策动作顺序）替代默认流水线
  --help              显示此帮助

示例:
  node src/cli.js --project ../my-app --output ./docs
  node src/cli.js --project ./demo --audience "零基础" --focus "偏代码实战" --resume
  node src/cli.js --project ./demo --verify --threshold 85 --template my-template.json
  node src/cli.js --project ./demo --output ./docs --browse --port 4000
  node src/cli.js --project ./demo --agent react --output ./output/react-demo  # v2 ReAct
  node src/cli.js --project ./demo --resume --skip-review --browse   # 重新打开已有教程

配置文件 config.json 说明:
  每个阶段角色（scanner/outliner/writer/reviewer）可指定不同的
  provider + model，默认全部使用 deepseek。API Key 从环境变量读取，
  默认 DEEPSEEK_API_KEY，可在 .env 文件中设置。
  质量阈值与各维度权重在 defaults 段配置（qualityThreshold / metricsWeights）。
`);
  process.exit(values.help ? 0 : 1);
}

// 路径统一转绝对路径
const projectPath = resolve(values.project);
const outputDir = resolve(values.output || "./output");
const configPath = resolve(values.config || "./config.json");

// 基本校验
try {
  const { statSync } = await import("node:fs");
  if (!statSync(projectPath).isDirectory()) {
    throw new Error("不是目录");
  }
} catch {
  console.error(`✗ 项目目录不存在: ${projectPath}`);
  process.exit(1);
}

try {
  const config = loadConfig(configPath);
  console.log(`配置已加载: ${configPath}`);
  console.log(`角色分工 → scanner:${config.roles.scanner.model} | outliner:${config.roles.outliner.model} | writer:${config.roles.writer.model} | reviewer:${config.roles.reviewer.model}`);

  // 自定义模板（可选）
  let template = null;
  if (values.template) {
    const templatePath = resolve(values.template);
    const { readFileSync, existsSync: templateExists } = await import("node:fs");
    if (!templateExists(templatePath)) {
      throw new Error(`模板文件不存在: ${templatePath}`);
    }
    template = JSON.parse(readFileSync(templatePath, "utf8"));
    if (!isValidTemplate(template)) {
      throw new Error("模板格式不合法：需要 { chapters: [{ index, title, sections: [...] }] }");
    }
    console.log(`自定义模板: ${templatePath}（${template.chapters.length} 章）`);
  }

  // 黄金样本基线（可选）
  let baseline = null;
  if (values.baseline) {
    const baselinePath = resolve(values.baseline);
    const { readFileSync } = await import("node:fs");
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    console.log(`黄金样本基线: ${baselinePath}（总分 ${baseline?.qualityScore ?? "?"}）`);
  }

  // 质量阈值（可选覆盖）
  let threshold = null;
  if (values.threshold) {
    threshold = Number(values.threshold);
    if (!Number.isFinite(threshold)) throw new Error(`--threshold 必须是数字，收到: ${values.threshold}`);
    console.log(`质量阈值覆盖: ${threshold}`);
  }

  // ReAct 范式（v2）：模型自主决策工具调用顺序
  if (values.agent === "react") {
    await runReactAgent({
      config,
      projectPath,
      outputDir,
      userOptions: { intro: values.intro, audience: values.audience, focus: values.focus },
    });
  } else {
    await runPipeline({
      config,
      projectPath,
      outputDir,
      userOptions: { intro: values.intro, audience: values.audience, focus: values.focus },
      resume: values.resume,
      skipReview: values["skip-review"],
      verify: values.verify,
      template,
      baseline,
      threshold,
      noFix: values["no-fix"],
      noReproduce: values["no-reproduce"],
    });
  }

  // 网页版文档预览（可选）
  if (values.browse) {
    let port = null;
    if (values.port) {
      port = Number(values.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`--port 必须是 1-65535 的整数，收到: ${values.port}`);
      }
    }
    await openBrowse(outputDir, { port, readOnly: true });
  }
} catch (err) {
  console.error(`\n✗ 运行失败: ${err.message}`);
  process.exit(1);
}
