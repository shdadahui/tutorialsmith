/**
 * src/index.js — mini-notes 命令行入口
 *
 * 使用 Node 内置的 parseArgs 解析命令，把子命令分发到对应的处理器。
 */
import { parseArgs } from "node:util";
import { addNote, listNotes, deleteNote } from "./notes.js";
import { DB_PATH } from "./storage.js";

// 定义子命令 → 处理函数 的映射表
const COMMANDS = {
  add: { args: ["text"], flags: { tag: { type: "string" } } },
  list: { args: [], flags: { tag: { type: "string" } } },
  delete: { args: ["id"], flags: {} },
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || !COMMANDS[command]) {
    console.log(`mini-notes v1.0.0 — 极简本地笔记工具

用法:
  node src/index.js add "内容" [--tag 标签]
  node src/index.js list [--tag 标签]
  node src/index.js delete <id>

数据文件: ${DB_PATH()}`);
    process.exit(command === "--help" ? 0 : 1);
  }

  const spec = COMMANDS[command];
  const { values, positionals } = parseArgs({
    args: rest,
    options: spec.flags,
    strict: true,
    allowPositionals: true,
  });

  if (command === "add") {
    const text = positionals.join(" "); // 支持带空格的多词内容
    if (!text) throw new Error("add 命令需要内容参数");
    const note = await addNote(text, values.tag);
    console.log(`已添加笔记 #${note.id}: ${note.text}`);
  } else if (command === "list") {
    const notes = await listNotes(values.tag);
    if (notes.length === 0) {
      console.log("（暂无笔记）");
    } else {
      for (const n of notes) {
        console.log(
          `#${n.id} [${n.tag || "未分类"}] ${n.text}（${new Date(n.createdAt).toLocaleString("zh-CN")}）`,
        );
      }
    }
  } else if (command === "delete") {
    const id = Number(positionals[0]);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error("delete 命令需要正整数 ID");
    await deleteNote(id);
    console.log(`已删除笔记 #${id}`);
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
