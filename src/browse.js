/**
 * browse.js — 网页版文档预览（适配 mdbrowse-cli）
 *
 * mdbrowse-cli 是一个零安装的 Markdown 浏览工具：本地起一个 Web UI，
 * 提供文件树、GFM 渲染、语法高亮（Shiki）、搜索、Mermaid/数学公式、
 * 实时刷新，自动打开浏览器。教程输出目录正好是 Markdown 集合，
 * 用它即可把教程变成网页版文档站。
 *
 * 用法（CLI 集成）：
 *   node src/cli.js --project ./demo --output ./output/xxx --browse [--port 4000]
 *
 * 直接使用：
 *   npx --yes mdbrowse-cli <教程输出目录> --read-only [-p <端口>]
 *
 * 本模块负责跨平台拉起该命令并保持前台运行（Ctrl+C 退出）。
 */
import { spawn } from "node:child_process";

/**
 * 在教程输出目录上启动 mdbrowse 网页服务（阻塞直到用户 Ctrl+C）。
 * @param {string} outputDir 教程输出目录（绝对路径）
 * @param {object} opts { port?, readOnly?, tunnel? }
 * @returns {Promise<void>} 服务退出时 resolve
 */
export async function openBrowse(outputDir, { port, readOnly = true, tunnel = false } = {}) {
  const args = ["--yes", "mdbrowse-cli", outputDir];
  if (port) args.push("-p", String(port));
  if (readOnly) args.push("--read-only");
  if (tunnel) args.push("--tunnel");

  console.log(`\n📖 正在启动网页版文档预览...`);
  console.log(`  命令: npx ${args.join(" ")}`);
  console.log(`  提示: 服务会自动打开浏览器；按 Ctrl+C 退出预览\n`);

  // Windows 上 npx 是 npx.cmd，必须走 shell 才能解析
  const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: false,
  });

  return new Promise((resolve) => {
    child.on("exit", (code) => {
      console.log(`\n网页预览已退出（code=${code}）`);
      resolve();
    });
    child.on("error", (err) => {
      console.error(`✗ 启动 mdbrowse-cli 失败: ${err.message}`);
      console.error("  可手动尝试: npx --yes mdbrowse-cli <目录> --read-only");
      resolve();
    });
  });
}
