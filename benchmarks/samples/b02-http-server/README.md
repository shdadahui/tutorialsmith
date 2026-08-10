# http-server

一个用 Node 原生 `node:http` 实现的极简 HTTP 服务器，零依赖。支持静态文件服务与一个 JSON API 端点。

```bash
node src/server.js --port 8080
curl http://localhost:8080/api/health
```

设计亮点：路由表驱动分发、`Content-Type` 自动推断、请求日志中间件、优雅退出（SIGINT）。
