/**
 * verifier.js — 真实验证器（执行类工具，--verify 开启时启用）
 *
 * 解决什么问题？
 *   教程里的命令是否真的能跑？LLM 会编造命令。这里把教程里的 shell 代码块
 *   提取出来，在目标项目目录内真实执行，统计"可运行率"，作为量化指标之一；
 *   执行失败的命令及其真实报错会记入问题清单，供修复循环改进教程。
 *
 * 安全护栏（务必理解后再改动）：
 *   1. v6.1 起默认在「沙箱副本」中执行（createSandbox），目标项目零污染；
 *      过滤危险命令（rm -rf / sudo / 磁盘写入等）
 *   2. 每条命令超时 30s，防止死循环/挂起
 *   3. 环境设置类命令（export/cd 开头）跳过不执行，不计分
 *   4. 只有显式传 --verify 才会启用本模块
 *   5. 报告会注明执行产生副作用的可能（即使已沙箱化）
 */
import { exec } from "node:child_process";
import { mkdtemp, mkdir, readdir, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** 沙箱复制时排除的大目录（node_modules/.git/构建产物等） */
const SANDBOX_IGNORE = new Set([
  "node_modules", ".git", ".hg", ".svn", ".idea", ".vscode", ".cache",
  "output", "dist", "build", "coverage", ".next", ".nuxt", ".turbo",
]);

/**
 * 创建沙箱：把项目复制到系统临时目录（排除大目录），返回副本路径。
 * 复现/验证阶段在副本中执行命令，跑完 cleanupSandbox 丢弃 → 目标项目零污染。
 */
export async function createSandbox(projectPath) {
  const sandboxPath = await mkdtemp(join(tmpdir(), "tutorialsmith-sandbox-"));
  async function walk(from, to) {
    await mkdir(to, { recursive: true });
    const entries = await readdir(from, { withFileTypes: true });
    for (const e of entries) {
      if (SANDBOX_IGNORE.has(e.name)) continue;
      const s = join(from, e.name);
      const d = join(to, e.name);
      if (e.isDirectory()) await walk(s, d);
      else if (e.isFile()) await copyFile(s, d);
    }
  }
  await walk(projectPath, sandboxPath);
  return sandboxPath;
}

/** 清理沙箱（递归删除临时副本）。Windows 上文件被占用时 fs.rm 可能卡死 → 限重试 + 失败只告警不阻塞 */
export async function cleanupSandbox(sandboxPath) {
  try {
    await rm(sandboxPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    console.warn(`  ⚠ 沙箱清理未完全成功（残留临时目录无害，系统会自动回收）: ${err.message.slice(0, 120)}`);
  }
}

/** 危险命令特征：命中即跳过（不执行、不计分） */
export const DANGEROUS_PATTERNS = [
  /\brm\b/i, /\brmdir\b/i, /\bsudo\b/i, /\bmkfs/i, /\bdd\b/i, /\bformat/i,
  /\bchmod\b/i, /\bchown\b/i, /\bshutdown/i, /\breboot/i, /\bkill\b/i,
  /\bmv\s+\/\b/i, /\b>\/dev\/sd/i, /\bwget\b.*\|\s*(ba)?sh/i,
  /\bcurl\b.*\|\s*(ba)?sh/i, /\bmysql\b.*\bDROP\s+TABLE/i, /\bgit\s+push\s+--force/i,
  /:\(\)\s*\{/,
];

/** 环境设置类命令：跳过不执行（export/cd 开头的行，常出现在 bash 片段里） */
const SETUP_PATTERNS = [/^\s*(export|set\s|cd|source|\.\s)/i];

/** 报错输出/提示文本（代码块里粘贴的运行结果，不是命令）：跳过 */
const OUTPUT_PATTERNS = [
  /^(Error|SyntaxError|TypeError|ReferenceError|RangeError|AssertionError|at\s)/i,
  /^(✗|❌|✔|✅|⚠|error|warning|fail|pass|ok)\b/i,
  /^\[?(stdout|stderr)\b/i,
  /^\s*\.\S*/i, // .test-data/ 之类路径片段
  /^[│├└┌─┐┘┴┬┼]/, // 目录树示意图（├── node_modules/ 之类）
];

/** 控制流/脚本片段（多行脚本拆出来的行，单独执行无意义）：跳过 */
const CONTROL_FLOW_PATTERNS = [
  /^(for|while|until|if|else|elif|then|fi|done|esac|case|function)\b/i,
  /^\}\s*$/, /^\{\s*$/, /^[a-zA-Z_]+\(\)\s*\{\s*$/,
  /^(local|complete|alias|trap|readonly)\b/i, // bash 脚本内部语句，不是独立命令
];

/** JS/其他语言语句混入 bash 块（教程常把代码块写成 bash）：跳过 */
const CODE_LANG_PATTERNS = [
  /^(const|let|var|await|import|export|return|function|async)\b/i,
  /^(console|process|document|window|require)\b/i,
  /[;{},]\s*$/, // 以 ; { } , 结尾，几乎不可能是 shell 命令
  /^[`'"\s]+$/,
];

/** 占位符/示例 URL：跳过（git clone yourname 之类） */
const PLACEHOLDER_PATTERNS = [
  /github\.com\/(your|example|yourname|username)/i,
  /(example|your-|your\.|sample)\.(com|org|io|net)/i,
  /<[^>]+>/, // 尖括号占位符如 <ID> <path>
];

/** 环境变量前缀命令（VAR=value cmd，bash 写法，Windows 不可用）：跳过 */
const ENV_PREFIX_PATTERN = /^[A-Z_][A-Z0-9_]*=/;

/**
 * 命令分类：项目内命令（计入可运行率） vs 系统/平台命令（环境假设，不计分）。
 *
 * 原则（质量分公平性）：
 *   - 项目内命令失败 = "教程写错了"（硬错误）：node src/xxx、npm test/start/install（非 -g）、
 *     引用项目内路径（./、src/、test/）的命令
 *   - 系统/平台命令失败 = "教程的目标环境与本机不同"（环境假设，不扣分）：
 *     nvm/brew/apt 等系统工具、git clone、~ 家目录、$ 环境变量、npm publish/install -g 等
 */
export function classifyCommand(cmd) {
  // 明确的项目内命令
  if (/^(node|python|python3|deno|bun|ruby|php)\s+(\.\/|src\/|test\/|lib\/|bin\/|scripts?\/|dist\/)/i.test(cmd)) return "project";
  if (/^npm\s+(test|start|run|install|ci|exec|link)\b/i.test(cmd) && !/\s-g\b/.test(cmd)) return "project";
  if (/^(yarn|pnpm|bun)\s+/i.test(cmd) && !/\s-g\b/.test(cmd)) return "project";
  if (/\.\/|\bsrc\/|\btest\/|\blib\/|\bdist\//.test(cmd)) return "project";
  // 系统/平台工具（环境假设）
  const SYSTEM_TOOLS =
    /^(nvm|brew|apt|apt-get|yum|dnf|pacman|apk|source|export|cd\s|git\s+(clone|init|submodule|checkout)|curl|wget|ssh|scp|docker|docker-compose|kubectl|crontab|mysql|psql|redis-cli|open|xdg-open|explorer|start|code|touch|echo|mkdir|rm|rmdir|chmod|chown|mv|cp|pip|pip3|npm\s+(publish|login|logout|config)|go\s+(get|install|env)|cargo\s+(install|new|build)|python\s+-m\s+venv|npx\s+(create|install))(?:\s|$)/i;
  if (SYSTEM_TOOLS.test(cmd)) return "system";
  if (/\s-g\b/.test(cmd)) return "system"; // npm install -g / yarn global 等
  if (/~|\$[A-Za-z_]/.test(cmd)) return "system"; // 家目录/环境变量
  return "project"; // 默认按项目内命令处理（保守）
}

/** 单条命令执行（Promise 化，带超时）——复现阶段（src/reproduce/）也复用 */
export function runCommand(command, cwd, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error?.code ?? 0;
        const timedOut = error?.killed === true;
        resolve({
          ok: code === 0,
          code,
          timedOut,
          output: (stdout || "").slice(0, 600) + (stderr ? `\n[stderr] ${stderr.slice(0, 600)}` : ""),
        });
      });
  });
}

/**
 * 提取并执行教程中的 shell 代码块。
 * @param {Array<{index, content}>} chapterFiles
 * @param {string} projectPath 目标项目目录（绝对路径，作为执行 cwd）
 * @returns {Promise<{score, total, ok, skipped, systemTotal, systemSkipped, results}>}
 *   score: 项目内命令可运行率（0-100）；系统命令不计入 score，仅统计 systemTotal/systemSkipped
 */
export async function verifyChapters({ chapterFiles, projectPath }) {
  const results = []; // {chapter, command, ok, output, kind}
  let total = 0, ok = 0, skipped = 0;
  let systemTotal = 0, systemSkipped = 0;

  for (const ch of chapterFiles) {
    const content = ch.content || "";
    // 匹配 ```bash / ```sh / ```shell / ```powershell 等代码块
    const blocks = content.match(/```(bash|sh|shell|console|powershell|cmd)\s*\n([\s\S]*?)```/gi) || [];
    for (const block of blocks) {
      const body = block.replace(/^```\w*\s*\n?/, "").replace(/```\s*$/, "").trim();
      const lines = body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("$") && !l.startsWith(">"));
      for (const line of lines) {
        // 去掉行内注释
        const cmd = line.split(/\s+#\s/)[0].trim();
        if (!cmd) continue;
        // 跳过"非命令"：报错输出 / 控制流 / 占位符 / 环境变量前缀 / 他语言代码
        const nonCommand = [
          ...OUTPUT_PATTERNS, ...CONTROL_FLOW_PATTERNS,
          ...PLACEHOLDER_PATTERNS, ...CODE_LANG_PATTERNS,
        ].some((re) => re.test(cmd));
        if (nonCommand) {
          results.push({ chapter: ch.index, command: cmd, ok: null, skipped: true, kind: "other", output: "非命令文本（报错输出/控制流/占位符），已跳过" });
          skipped++;
          continue;
        }
        if (ENV_PREFIX_PATTERN.test(cmd)) {
          results.push({ chapter: ch.index, command: cmd, ok: null, skipped: true, kind: "other", output: "bash 环境变量前缀写法，已跳过" });
          skipped++;
          continue;
        }
        if (DANGEROUS_PATTERNS.some((re) => re.test(cmd))) {
          results.push({ chapter: ch.index, command: cmd, ok: null, skipped: true, kind: "other", output: "危险命令，已跳过" });
          skipped++;
          continue;
        }
        if (SETUP_PATTERNS.some((re) => re.test(cmd))) {
          results.push({ chapter: ch.index, command: cmd, ok: null, skipped: true, kind: "other", output: "环境设置命令，已跳过" });
          skipped++;
          continue;
        }

        // 命令分类：系统/平台命令 → 环境假设，不执行、不计分
        const kind = classifyCommand(cmd);
        if (kind === "system") {
          systemTotal++;
          systemSkipped++;
          results.push({ chapter: ch.index, command: cmd, ok: null, skipped: true, kind, output: "环境假设（系统/平台命令，目标环境可能与本机不同），不参与评分" });
          continue;
        }

        total++;
        const r = await runCommand(cmd, projectPath);
        if (r.ok) ok++;
        results.push({ chapter: ch.index, command: cmd, ok: r.ok, skipped: false, kind, output: r.output });
        if (!r.ok) {
          console.warn(`    ✗ 命令失败: ${cmd.slice(0, 60)}${r.timedOut ? "（超时）" : ""}`);
        }
      }
    }
  }

  const score = total === 0 ? null : Math.round((ok / total) * 1000) / 10;
  return { score, total, ok, skipped, systemTotal, systemSkipped, results };
}
