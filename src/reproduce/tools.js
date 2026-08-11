/**
 * reproduce/tools.js — 复现阶段工具集（写作前自主复现）
 *
 * 目标：在撰写教程之前，让模型亲自把项目跑起来，产出「已验证可运行的命令清单」，
 * 后续 writer 只能使用这些命令——从源头杜绝编造命令（如 python3 实际不可用）。
 *
 * 工具：
 *   list_files()               项目文件清单
 *   read_file(path)            读取文件内容（相对路径、防穿越、限大小、截断）
 *   run_command(cmd)           在项目目录真实执行（危险过滤 + 30s 超时）
 *   finish()                   提交复现报告（已验证命令清单 + 失败记录 + 遇到的问题）
 */
import { readFile } from "node:fs/promises";
import { join, normalize, isAbsolute } from "node:path";
import { scanProject } from "../scanner.js";
import { runCommand, DANGEROUS_PATTERNS } from "../verifier.js";

const OBS_LIMIT = 900;
const trunc = (s, n = OBS_LIMIT) => (s.length > n ? s.slice(0, n) + "…(已截断)" : s);
const MAX_READ = 200 * 1024; // read_file 大小上限

export function createReproduceTools({ config, projectPath }) {
  const state = {
    scan: null,
    commands: [],   // {cmd, ok, output, timedOut, skipped}
    failed: [],     // 失败命令及原因
    notes: [],      // 模型通过 finish args.notes 补充的说明
  };

  async function getScan() {
    if (!state.scan) {
      state.scan = await scanProject(projectPath, { maxProjectBytes: config.defaults.maxProjectBytes });
    }
    return state.scan;
  }

  return {
    state,
    async list_files() {
      const s = await getScan();
      return `项目文件（共 ${s.fileCount} 个，${(s.totalBytes / 1024).toFixed(1)} KB）：\n${s.filePaths.slice(0, 50).join("\n")}`;
    },

    async read_file(args) {
      const p = args?.path;
      if (!p || typeof p !== "string") return "错误：需要参数 {\"path\": \"相对路径\"}";
      // 防目录穿越：必须解析后仍在项目目录内
      const target = join(projectPath, p);
      if (!target.startsWith(projectPath) || isAbsolute(p)) {
        return `错误：path 必须是项目内相对路径（拒绝: ${p}）`;
      }
      try {
        const buf = await readFile(target);
        if (buf.length > MAX_READ) return `文件过大（${(buf.length / 1024).toFixed(0)} KB），已拒绝读取（上限 200KB）。可改用 list_files 查看结构。`;
        const text = buf.toString("utf8");
        return trunc(`## ${p}（${text.length} 字符）\n${text}`, 2500);
      } catch (err) {
        return `错误：无法读取 ${p}: ${err.message.slice(0, 120)}`;
      }
    },

    async run_command(args) {
      const cmd = (args?.cmd || "").trim();
      if (!cmd) return "错误：需要参数 {\"cmd\": \"要执行的命令\"}";
      if (DANGEROUS_PATTERNS.some((re) => re.test(cmd))) {
        state.commands.push({ cmd, ok: false, skipped: true, output: "危险命令，已过滤" });
        return "已拒绝：该命令匹配危险模式（rm/sudo/kill/重定向到设备等），不会执行。请改用安全的等价命令。";
      }
      const r = await runCommand(cmd, projectPath, 30_000);
      state.commands.push({ cmd, ok: r.ok, timedOut: r.timedOut, output: r.output });
      if (!r.ok) {
        state.failed.push({ cmd, error: r.output.slice(0, 300), timedOut: r.timedOut });
      }
      const status = r.timedOut ? "超时(30s)" : r.ok ? "成功" : "失败";
      return `命令「${cmd}」执行${status}${r.ok ? "" : "（注意：此命令不可用，请在复现报告中记录替代方案）"}。\n${trunc(r.output, 900)}`;
    },

    async finish(args) {
      if (args?.notes) state.notes.push(String(args.notes).slice(0, 500));
      const okCmds = state.commands.filter((c) => c.ok && !c.skipped).map((c) => c.cmd);
      return trunc(
        `✅ 复现报告已生成：\n` +
        `- 已验证可用命令（${okCmds.length} 条）:\n${okCmds.map((c) => `  - ${c}`).join("\n") || "  （无）"}\n` +
        `- 执行失败命令（${state.failed.length} 条）:${state.failed.length ? "" : " 无"}\n` +
        state.failed.map((f) => `  - ${f.cmd}（${(f.error || "未知错误").split("\n")[0].slice(0, 150)}）`).join("\n") +
        `\n- 补充说明: ${state.notes.join("；") || "无"}`
      );
    },
  };
}

export const REPRODUCE_TOOLS_SCHEMA = [
  { name: "list_files", args: "{}", desc: "列出项目文件清单" },
  { name: "read_file", args: '{"path": "相对路径"}', desc: "读取项目内文件内容（防穿越，上限 200KB）" },
  { name: "run_command", args: '{"cmd": "命令"}', desc: "在项目目录真实执行命令（危险命令自动过滤，30 秒超时）" },
  { name: "finish", args: '{"notes": "可选：补充你发现的注意事项"}', desc: "提交复现报告（已验证命令清单+失败记录），调用后复现结束" },
];

/** 分发执行 */
export async function dispatchReproduceTool(tools, action) {
  const fn = tools[action.action];
  if (!fn) return `错误：未知动作 "${action.action}"。可用：${REPRODUCE_TOOLS_SCHEMA.map((t) => t.name).join(", ")}`;
  try {
    const obs = await fn(action.args || {});
    return typeof obs === "string" ? obs : trunc(JSON.stringify(obs));
  } catch (err) {
    return `工具执行异常：${err.message.slice(0, 200)}`;
  }
}
