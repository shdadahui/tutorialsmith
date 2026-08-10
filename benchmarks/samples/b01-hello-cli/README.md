# hello-cli

一个演示命令行参数解析的极简 Node CLI，零依赖。支持 `greet`（打招呼）和 `calc`（四则运算）两个子命令。

```bash
node src/index.js greet 张三 --lang en
node src/index.js calc "1 + 2 * 3"
```

设计亮点：用 `node:util` 的 `parseArgs` 解析参数，`node:readline` 交互输入，错误统一捕获。
