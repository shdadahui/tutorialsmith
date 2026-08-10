/**
 * web.js — Web 界面（零依赖：node:http + 原生前端）
 *
 * 提供：
 *   GET  /                      前端页面（web/index.html）
 *   GET  /api/projects          可选的样例项目列表
 *   POST /api/generate          提交生成任务（表单参数 → 子进程跑流水线）
 *   GET  /api/jobs              任务列表
 *   GET  /api/jobs/:id          任务状态 + 累计日志（前端轮询）
 *   GET  /api/files/:id         任务输出目录的文件列表
 *   GET  /api/file/:id?path=x   读取输出文件内容
 *   POST /api/preview/:id       在输出目录拉起 mdbrowse 网页预览，返回 URL
 *
 * 用法：node src/web.js [--port 8787]   （npm run web）
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, readdir, stat, mkdir } from "node:fs/promises";import { join, dirname, extname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_HTML = join(__dirname, "..", "web", "index.html");
const OUT_ROOT = join(__dirname, "..", "web", "out");
const SAMPLES_DIR = join(__dirname, "..", "benchmarks", "samples");

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || process.env.PORT || 8787);

/** 任务表：id -> { status, log[], outDir, createdAt, exitCode } */
const jobs = new Map();
const newJobId = () => `job-${Date.now()}`;

/** 启动一个生成任务（子进程跑 cli.js，日志流式收集） */
function startJob({ projectPath, options }) {
  const id = newJobId();
  const outDir = join(OUT_ROOT, id);
  const job = { id, status: "running", log: [], outDir, createdAt: new Date().toISOString(), exitCode: null };
  jobs.set(id, job);

  const args = ["src/cli.js", "--project", projectPath, "--output", outDir];
  if (options.verify) args.push("--verify");
  if (options.skipReview) args.push("--skip-review");
  if (options.resume) args.push("--resume");
  if (options.noFix) args.push("--no-fix");
  if (options.threshold) args.push("--threshold", String(options.threshold));
  if (options.audience) args.push("--audience", options.audience);
  if (options.focus) args.push("--focus", options.focus);
  if (options.intro) args.push("--intro", options.intro);
  if (options.template) args.push("--template", options.template);

  const push = (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
    job.log.push(...lines);
    if (job.log.length > 500) job.log = job.log.slice(-500); // 只保留最近 500 行
  };
  const child = spawn(process.execPath, args, { cwd: ROOT });
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("error", (err) => {
    job.status = "failed";
    job.log.push(`✗ 启动失败: ${err.message}`);
  });
  child.on("close", (code) => {
    job.status = "done";
    job.exitCode = code;
    job.log.push(code === 0 ? "✅ 任务完成" : `❌ 任务失败（退出码 ${code}）`);
  });
  return id;
}

/** JSON 响应 */
function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/** 读取请求体（JSON） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

/** 列目录（顶层文件 + 目录） */
async function listDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.isFile()) files.push({ name: e.name, size: (await stat(join(dir, e.name))).size });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

const MIME = {
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/** 路由分发 */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname;

  try {
    // ── 页面 ──
    if (path === "/" || path === "/index.html") {
      const html = await readFile(WEB_HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    // ── API：样例项目列表 ──
    if (path === "/api/projects") {
      const names = (await readdir(SAMPLES_DIR, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      return sendJson(res, 200, { samples: names, demo: "demo" });
    }

    // ── API：提交生成任务 ──
    if (path === "/api/generate" && req.method === "POST") {
      const body = await readBody(req);
      const projectPath = body.projectPath;
      if (!projectPath) return sendJson(res, 400, { error: "缺少 projectPath" });
      // 样例快捷路径：b01-hello-cli / hello-cli 等 → 自动映射到 benchmarks/samples/<name>
      let finalPath = projectPath;
      if (!isAbsolute(projectPath) && !projectPath.includes("/") && !projectPath.includes("\\")) {
        // 精确匹配
        const exact = join(SAMPLES_DIR, projectPath);
        try { await stat(exact); finalPath = exact; }
        catch {
          // 短名模糊匹配：hello-cli → b01-hello-cli
          try {
            const dirs = await readdir(SAMPLES_DIR, { withFileTypes: true });
            const hit = dirs.find((d) => d.isDirectory() && d.name.includes(projectPath));
            if (hit) finalPath = join(SAMPLES_DIR, hit.name);
          } catch { /* 保持原样 */ }
        }
      }
      const id = startJob({ projectPath: resolve(finalPath), options: body });
      return sendJson(res, 200, { id, status: "running" });
    }

    // ── API：任务列表 ──
    if (path === "/api/jobs") {
      const list = [...jobs.values()].map((j) => ({ id: j.id, status: j.status, exitCode: j.exitCode, createdAt: j.createdAt }));
      return sendJson(res, 200, { jobs: list });
    }

    // ── API：任务详情（状态 + 日志） ──
    const jobMatch = path.match(/^\/api\/jobs\/([\w-]+)$/);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return sendJson(res, 404, { error: "任务不存在" });
      return sendJson(res, 200, { id: job.id, status: job.status, exitCode: job.exitCode, log: job.log, outDir: job.outDir });
    }

    // ── API：输出文件列表 ──
    const filesMatch = path.match(/^\/api\/files\/([\w-]+)$/);
    if (filesMatch) {
      const job = jobs.get(filesMatch[1]);
      if (!job) return sendJson(res, 404, { error: "任务不存在" });
      try {
        const files = await listDir(job.outDir);
        return sendJson(res, 200, { files });
      } catch {
        return sendJson(res, 200, { files: [] });
      }
    }

    // ── API：读取输出文件 ──
    const fileMatch = path.match(/^\/api\/file\/([\w-]+)$/);
    if (fileMatch) {
      const job = jobs.get(fileMatch[1]);
      const fileName = url.searchParams.get("path") || "index.md";
      if (!job) return sendJson(res, 404, { error: "任务不存在" });
      // 防目录穿越：只允许输出目录内的文件
      const target = resolve(join(job.outDir, fileName));
      if (!target.startsWith(resolve(job.outDir))) return sendJson(res, 403, { error: "非法路径" });
      try {
        const content = await readFile(target, "utf8");
        const mime = MIME[extname(fileName).toLowerCase()] || "text/plain; charset=utf-8";
        res.writeHead(200, { "Content-Type": mime });
        return res.end(content);
      } catch {
        return sendJson(res, 404, { error: `文件不存在: ${fileName}` });
      }
    }

    // ── API：mdbrowse 网页预览 ──
    if (path.match(/^\/api\/preview\/[\w-]+$/) && req.method === "POST") {
      const job = jobs.get(path.split("/").pop());
      if (!job) return sendJson(res, 404, { error: "任务不存在" });
      const { openBrowse } = await import("./browse.js");
      const previewPort = 5000 + (Math.floor(Math.random() * 900)); // 5000-5900
      const child = spawn(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["--yes", "mdbrowse-cli", job.outDir, "--read-only", "-p", String(previewPort), "--host", "127.0.0.1"],
        { stdio: "ignore", shell: process.platform === "win32" }
      );
      job.previewUrl = `http://127.0.0.1:${previewPort}/`;
      return sendJson(res, 200, { url: job.previewUrl });
    }

    return sendJson(res, 404, { error: `未知路由: ${path}` });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

await mkdir(OUT_ROOT, { recursive: true });
server.listen(port, () => {
  console.log(`\n📚 tutorial-agent Web 界面`);
  console.log(`  → http://localhost:${port}`);
  console.log(`  按 Ctrl+C 退出\n`);
});
