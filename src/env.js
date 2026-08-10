/**
 * env.js — 极简 .env 文件加载器（零依赖）
 *
 * 为什么需要它？
 *   Node 本身不会自动读取 .env 文件。我们希望 API Key 既可以通过系统环境变量设置，
 *   也可以放在项目根目录的 .env 文件里（更方便，且不会污染系统环境）。
 *
 * 加载优先级：.env 文件中的值 > 系统环境变量中已存在的值
 * （也就是说，如果系统里已有 DEEPSEEK_API_KEY，.env 可以覆盖它，反之亦然）
 *
 * 用法：在程序入口（cli.js）第一行调用 loadEnv()，之后 process.env.XXX 即可读到。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// .env 位于项目根目录（src/ 的上一级）
const DEFAULT_ENV_PATH = join(__dirname, "..", ".env");

/**
 * 解析一行 .env 内容，返回 [key, value] 或 null（跳过空行/注释）
 * 支持的格式：
 *   KEY=value
 *   KEY="value with spaces"   （去掉双引号）
 *   KEY='value'               （去掉单引号）
 *   # 注释
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null; // 没有 = 的行忽略
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  // 去掉包裹的引号
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

/** 加载 .env 文件（不存在则静默跳过）。仅在第一次调用时生效。 */
export function loadEnv(envPath = DEFAULT_ENV_PATH) {
  if (loadEnv._loaded) return; // 幂等：防止重复加载覆盖用户运行中的修改
  loadEnv._loaded = true;
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
