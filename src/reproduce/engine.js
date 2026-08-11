/**
 * reproduce/engine.js — 写作前自主复现（v4 特性）
 *
 * 在撰写教程之前，让模型以 ReAct 方式亲自把项目跑起来：
 *   读 README/依赖/入口 → 安装依赖 → 执行启动/测试/常用命令 → 记录成功与失败
 * 产出「复现报告」：已验证可运行的命令清单 + 失败命令与原因。
 * 该报告注入 writer 提示词——教程中的命令只能来自此清单，从源头杜绝编造命令。
 *
 * 与 v2 ReAct 的区别：目标不是写教程，而是"把项目跑通"；工具更动手（run_command）。
 */
import { chat } from "../llm.js";
import { resolveRole } from "../config.js";
import { runAgentLoop, parseAction } from "../react/engine.js";
import { createReproduceTools, REPRODUCE_TOOLS_SCHEMA, dispatchReproduceTool } from "./tools.js";

export function buildReproduceSys() {
  const toolsDesc = REPRODUCE_TOOLS_SCHEMA.map((t) => `- ${t.name}(${t.args}) — ${t.desc}`).join("\n");
  return `你是"教程匠"的复现工程师。任务：把给定的项目【真实跑起来】，产出"已验证可运行的命令清单"，供后续教程作者使用（教程中的命令只能来自你的清单）。

你通过工具与环境交互。每次回复只输出一个 JSON 对象（不要输出其他文字、不要用 markdown 围栏）：
{"action": "<工具名>", "args": {<参数>}}

可用工具：
${toolsDesc}

复现流程建议：
1. list_files() 了解项目结构；read_file() 看 README、package.json / requirements.txt / go.mod、入口文件
2. run_command() 实际执行，覆盖至少五类：环境检查（node/python 版本）、安装依赖、启动/运行、测试、核心操作（如 CLI 的增删改查）
3. 每条命令如实记录结果：成功 → 进入"可用清单"；失败 → 分析原因并尝试替代方案（例如 python3 不可用就试 python；路径不对就修正）
4. 无法解决的环境依赖（如需要 GPU/付费 API）在 finish 的 notes 里说明
5. 完成（覆盖足够多操作）后调用 finish() 提交复现报告（调用后任务结束）

硬性规则：
- 只有真实执行成功的命令才能进入"可用清单"；严禁编造
- 危险命令会被自动过滤（rm/sudo/kill 等），遇到时改用安全等价命令
- 安装类命令（npm install 等）允许执行，但注意 30 秒超时
- 不要修改项目文件（复现是只读探索 + 执行命令，不写代码）`;
}

/**
 * 运行写作前复现。
 * @param {object} deps { config, projectPath, maxSteps }
 * @returns {Promise<{reproduction, steps, finished}>}
 *   reproduction: { commands: [{cmd, ok, output, timedOut, skipped}], failed: [...], notes: [] }
 */
export async function runReproduce({ config, projectPath, maxSteps = 12 }) {
  const role = resolveRole(config, "reproduce") || resolveRole(config, "writer");
  const system = buildReproduceSys();
  const tools = createReproduceTools({ config, projectPath });

  const { steps, finished } = await runAgentLoop({
    system,
    roleConfig: role,
    tools,
    maxSteps,
    finishActionName: "finish",
    banner: `\n════════ 写作前复现（v4：先把项目跑起来）════════\n  决策模型: ${role.model} | 步数上限: ${maxSteps}`,
  });

  const reproduction = {
    commands: tools.state.commands,
    failed: tools.state.failed,
    notes: tools.state.notes,
    okCommands: tools.state.commands.filter((c) => c.ok && !c.skipped).map((c) => c.cmd),
  };
  console.log(`════════ 复现完成 ════════`);
  console.log(`  已验证可用命令: ${reproduction.okCommands.length} 条 | 失败: ${reproduction.failed.length} 条 | 步数: ${steps}`);
  return { reproduction, steps, finished };
}
