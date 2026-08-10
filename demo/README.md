# mini-notes

一个极简的本地笔记命令行工具，用 Node.js 实现，零第三方依赖。

## 功能

- `add`：添加一条笔记（支持标签）
- `list`：列出所有笔记（支持按标签过滤）
- `delete`：按 ID 删除笔记
- 数据以 JSON 文件持久化在用户主目录下

## 快速开始

```bash
node src/index.js add "买牛奶" --tag 生活
node src/index.js list
node src/index.js delete 1
```

## 设计亮点

- **原子写入**：写入笔记库时先写临时文件再 rename，避免中途崩溃损坏数据
- **零依赖**：只用 Node 内置模块（node:fs、node:path、util.parseArgs）
