/**
 * assess.js — 能力评估前置（--assess，借鉴 codojo 的 dojo-assess）
 *
 * 生成教程前，用 3 个结构化问题评估读者水平，自动产出 audience + focus，
 * 注入 outliner/writer——替代手动传 --audience/--focus（显式参数优先）。
 *
 * 问题（一问一答，读 stdin）：
 *   1. 读者的编程基础？（零基础 / 有基础 / 熟练）
 *   2. 学习目标？（快速上手 / 系统学习原理 / 深入源码魔改）
 *   3. 内容侧重？（偏实战 / 偏原理 / 均衡）
 */
import { createInterface } from "node:readline";

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

export const AUDIENCE_MAP = {
  "零基础": "零基础入门者（从概念讲起，避免术语轰炸）",
  "有基础": "有编程基础、想系统学习该项目/技术的开发者",
  "熟练": "对该领域较熟练的开发者（聚焦深度与最佳实践）",
};

export const GOAL_MAP = {
  "快速上手": "快速上手：最短路径跑通项目并完成一个实例",
  "系统学习": "系统学习：完整理解核心概念、架构与底层原理",
  "源码魔改": "深入源码：能读懂关键实现并具备独立修改能力",
};

export const FOCUS_MAP = {
  "偏实战": "偏代码实战",
  "偏原理": "偏原理讲解",
  "均衡": "实战与原理并重",
};

/** 交互式评估：返回 { audience, focus }（用户取消返回 null） */
export async function assessUser({ projectSummary }) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n📋 能力评估（面向项目：${projectSummary?.project_name || "未知"}，Ctrl+C 可跳过）\n`);
  try {
    const base = await ask(rl, "1) 目标读者的编程基础？（输入：零基础 / 有基础 / 熟练，默认有基础）");
    const goal = await ask(rl, "2) 学习目标？（输入：快速上手 / 系统学习 / 源码魔改，默认系统学习）");
    const focus = await ask(rl, "3) 内容侧重？（输入：偏实战 / 偏原理 / 均衡，默认均衡）");
    const audienceKey = (AUDIENCE_MAP[base] ? base : "有基础");
    const goalKey = (GOAL_MAP[goal] ? goal : "系统学习");
    const focusKey = (FOCUS_MAP[focus] ? focus : "均衡");
    const audience = `${AUDIENCE_MAP[audienceKey]}；学习目标：${GOAL_MAP[goalKey]}`;
    return { audience, focus: FOCUS_MAP[focusKey] };
  } catch {
    return null; // Ctrl+C / 非交互环境
  } finally {
    rl.close();
  }
}
