/**
 * src/server.js — 极简 HTTP 服务器
 * 路由表驱动：/api/health 返回 JSON；其余路径尝试静态文件
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const ROUTES = {
  "/api/health": async () => ({ status: 200, body: JSON.stringify({ ok: true, ts: Date.now() }) }),
};

function contentType(path) {
  return MIME[extname(path)] || "application/octet-stream";
}

async function serveStatic(reqUrl, root) {
  const filePath = join(root, reqUrl === "/" ? "index.html" : reqUrl);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    const body = await readFile(filePath);
    return { status: 200, body, headers: { "Content-Type": contentType(filePath) } };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const t0 = Date.now();

  let response = null;
  if (ROUTES[url.pathname]) {
    response = await ROUTES[url.pathname]();
  } else {
    response = await serveStatic(url.pathname, process.cwd());
  }

  if (!response) {
    response = { status: 404, body: "Not Found" };
  }
  res.writeHead(response.status, { "Content-Type": "text/plain; charset=utf-8", ...(response.headers || {}) });
  res.end(response.body);
  console.log(`[${req.method}] ${url.pathname} ${response.status} ${Date.now() - t0}ms`);
});

const port = Number(process.argv[2] === "--port" ? process.argv[3] : 3000);
server.listen(port, () => console.log(`http://localhost:${port}`));

// 优雅退出
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`收到 ${sig}，关闭服务器`);
    server.close(() => process.exit(0));
  });
}
