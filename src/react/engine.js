/**
 * react/engine.js — ReAct 循环引擎（v2）
 *
 * ReAct = Reason + Act：模型每步输出一个 JSON 动作 {"action", "args"}，
 * 引擎执行工具并返回 Observation，模型据此决定下一步——执行顺序由模型自主决策，
 * 与 v1 确定性流水线形成架构对比。
 *
 * 约束（保证可控性）：
 *   - maxSteps 步数上限（默认 20），耗尽后强制收尾
 *   - 动作必须是注册工具之一，非法动作返回错误 Observation 继续
 *   - 对话历史以单轮文本拼接模拟多轮（chat() 是单轮接口）
 */
import { chat, chatMessages } from "../llm.js";
import { parseJsonLoose } from "../outliner.js";
import { resolveRole } from "../config.js";
import { resetUsage, getUsageSummary } from "../usage.js";
import { createTools, dispatchTool, TOOL_SCHEMA, toOpenAITools } from "./tools.js";

/** 系统提示词：角色 + 工具 schema + 协议 */
export function buildReactSys(config) {
  const toolsDesc = TOOL_SCHEMA.map((t) => `- ${t.name}(${t.args}) — ${t.desc}`).join("\n");
  return `你是"教程匠"教程生成 Agent。任务：给定一个项目目录，产出一份约 7 章的技术教程（Markdown，每章至少 3 个小节，覆盖基础概念/底层原理/环境搭建/分步实战/调试排错/进阶/总结）。

你通过工具与环境交互。每次回复只输出一个 JSON 对象（不要输出其他文字、不要用 markdown 围栏），格式：
{"action": "<工具名>", "args": {<参数>}}

可用工具：
${toolsDesc}

协作协议：
1. 先 scan_project()（必要时先 list_files()）了解项目，再 generate_outline() 定结构
2. 逐章 write_chapter(index)；可 review_chapter(index) 自查，发现问题用 write_chapter 重写该章
3. 用 compute_metrics() 检查质量（目标总分 ≥ ${config.defaults.qualityThreshold}）；若低于目标，定位问题章节并修复
4. 章节齐备且质量达标后调用 finalize() 收尾（调用后任务结束）
5. 每章内容要真实、可运行：命令与文件路径必须基于项目实际情况，严禁编造不存在的 API/路径

注意：Observation 会截断显示，章节全文以磁盘文件为准。`
    ;
}

/** 从模型回复中解析动作 JSON（容忍 ```json 围栏与前后杂字） */
export function parseAction(text) {
  if (typeof text !== "string") return null;
  const parsed = parseJsonLoose(text);
  if (parsed && typeof parsed.action === "string") {
    return { action: parsed.action, args: parsed.args && typeof parsed.args === "object" ? parsed.args : {} };
  }
  return null;
}

/**
 * 通用 Agent 循环（v5：原生 function calling，文本 JSON 回退）。
 * 模型通过原生 tool_calls 调用工具（OpenAI 兼容）；无 tool_calls 时回退到文本 JSON 解析。
 * 被 v2 教程生成（finalize 收尾）与复现阶段（finish 收尾）共用。
 */
export async function runAgentLoop({ system, roleConfig, tools, maxSteps = 20, finishActionName = "finalize", banner = "", openAITools = null }) {
  if (banner) console.log(banner);
  const messages = [{ role: "system", content: system }];
  let finished = false;
  let step = 0;
  let textMode = false; // 降级为文本模式后保持（两种模式的消息结构不同，混用会出错）

  for (step = 1; step <= maxSteps; step++) {
    let r;
    try {
      r = await chatMessages({
        roleConfig,
        messages,
        tools: openAITools && !textMode ? openAITools : undefined,
        toolChoice: openAITools && !textMode ? "auto" : undefined,
        maxTokens: 1024,
      });
    } catch (err) {
      console.error(`  ✗ 第 ${step} 步调用失败: ${err.message}`);
      break;
    }

    // ── 原生 tool_calls ──
    if (r.toolCalls?.length) {
      messages.push(r.message); // assistant 消息（含 tool_calls）
      for (const tc of r.toolCalls) {
        let action = null;
        try {
          action = { action: tc.name, args: JSON.parse(tc.arguments || "{}") };
        } catch { /* 参数 JSON 解析失败走下方 tool 错误消息 */ }
        if (!action) {
          messages.push({ role: "tool", tool_call_id: tc.id, content: "参数 JSON 解析失败，请重新调用" });
          continue;
        }
        console.log(`  [${step}] ${action.action}(${JSON.stringify(action.args || {})})`);
        const obs = await dispatchTool(tools, action);
        messages.push({ role: "tool", tool_call_id: tc.id, content: truncate(obs, 700) });
        if (action.action === finishActionName) {
          console.log(`      → ${truncate(obs, 200)}`);
          finished = true;
          break;
        }
      }
      if (finished) break;
      continue;
    }

    // ── 文本回退（parseAction）──
    textMode = true;
    const content = r.content ?? "";
    messages.push({ role: "assistant", content });
    const action = parseAction(content);
    if (!action) {
      messages.push({ role: "user", content: "无法解析动作：请只输出 {\"action\":\"...\",\"args\":{...}} 格式的 JSON，不要加任何其他文字。" });
      console.log(`  [${step}] 非法动作，重试`);
      continue;
    }
    console.log(`  [${step}] ${action.action}(${JSON.stringify(action.args || {})})`);
    const obs = await dispatchTool(tools, action);
    messages.push({ role: "user", content: truncate(`Observation: ${obs}`, 700) });
    if (action.action === finishActionName) {
      console.log(`      → ${truncate(obs, 200)}`);
      finished = true;
      break;
    }
  }

  if (!finished) {
    console.log(`\n  ⚠ 达到步数上限（${maxSteps}），强制收尾...`);
    const obs = await dispatchTool(tools, { action: finishActionName, args: {} });
    console.log(`      → ${truncate(obs, 200)}`);
  }

  return { steps: step, finished };
}

/**
 * 运行 ReAct 教程生成（v2）。
 * @param {object} deps { config, projectPath, outputDir, userOptions, maxSteps }
 * @returns {Promise<{agent: "react", steps, finished, metrics, usage, outputDir}>}
 */
export async function runReactAgent({ config, projectPath, outputDir, userOptions = {}, maxSteps = 20 }) {
  resetUsage();
  const reactRole = resolveRole(config, "react");
  const system = buildReactSys(config);
  const tools = createTools({ config, projectPath, outputDir, userOptions });

  console.log(`\n════════ ReAct 教程生成（v2，模型自主决策）════════`);
  console.log(`  决策模型: ${reactRole.model} | 步数上限: ${maxSteps}`);

  const { steps, finished } = await runAgentLoop({
    system,
    roleConfig: reactRole,
    tools,
    maxSteps,
    finishActionName: "finalize",
    openAITools: toOpenAITools(),
  });

  const usage = getUsageSummary(config.defaults.costs);
  // 优先取工具状态里的 metrics；若引擎没拿到，则从磁盘 metrics.json 兜底
  let metrics = tools.state?.metrics ?? null;
  if (!metrics) {
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const raw = JSON.parse(await readFile(join(outputDir, "metrics.json"), "utf8"));
      metrics = {
        qualityScore: raw.qualityScore,
        grade: raw.grade,
        completeness: raw.completeness,
        reliability: raw.reliability,
      };
    } catch { /* 无兜底文件 */ }
  }

  console.log(`\n════════ ReAct 完成 ════════`);
  console.log(`  步数: ${step}${finished ? "" : "（达上限强制收尾）"} | 成本: ${usage.totalCost}${usage.currency} | tokens: ${usage.totalTokens.toLocaleString()}`);
  if (metrics) console.log(`  质量: 完整度 ${metrics.completeness?.score} | 可信度 ${metrics.reliability?.score} | 总分 ${metrics.qualityScore}（${metrics.grade}）`);
  console.log(`  输出目录: ${outputDir}`);

  return { agent: "react", steps: step, finished, metrics, usage, outputDir };
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
