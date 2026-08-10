/**
 * src/index.js — hello-cli 入口
 * 子命令：greet（打招呼）/ calc（四则运算）
 */
import { parseArgs } from "node:util";

const COMMANDS = {
  greet: async ({ values, positionals }) => {
    const name = positionals[0] || "world";
    const greeting = values.lang === "zh" ? "你好" : "Hello";
    console.log(`${greeting}, ${name}!`);
  },
  calc: async ({ positionals }) => {
    const expr = positionals[0];
    if (!expr) throw new Error("缺少表达式，用法: calc \"1 + 2\"");
    // 安全起见只允许数字和运算符
    if (!/^[\d+\-*/().\s]+$/.test(expr)) throw new Error("表达式包含非法字符");
    // eslint-disable-next-line no-eval
    const result = Function(`"use strict"; return (${expr})`)();
    console.log(`${expr} = ${result}`);
  },
};

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { lang: { type: "string", short: "l" } },
    allowPositionals: true,
    strict: false,
  });
  const command = positionals.shift();
  if (!command || command === "help" || !COMMANDS[command]) {
    console.log("用法: node src/index.js <greet|calc> [参数]");
    return;
  }
  try {
    await COMMANDS[command]({ values, positionals });
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  }
}

main();
