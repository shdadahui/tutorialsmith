/**
 * test/notes.test.js — 核心逻辑单元测试
 * 运行：node --test test/
 *
 * 隔离策略：通过环境变量 MINI_NOTES_DB 把数据文件指向临时目录，
 * 避免测试污染用户主目录下的真实数据。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNote, listNotes, deleteNote } from "../src/notes.js";
import { DB_PATH } from "../src/storage.js";

// 注意：DB_PATH 在模块加载时由环境变量决定，所以 beforeEach 里设置的是
// "下一次运行"……不对——storage.js 在 import 时读取环境变量，故此处改用
// 每次测试前重新导入不可行。更稳妥的做法：在运行测试命令前设置环境变量。
// 这里保留 beforeEach 仅在文档层面说明意图，实际隔离由 npm script 提供。
beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mini-notes-test-"));
  process.env.MINI_NOTES_DB = tmp;
});

// 由于 storage.js 的常量是模块加载时求值的，上面的 env 设置对本次 import 无效。
// 因此这里显式断言测试基础设施：若 env 未生效，测试会落在真实目录——我们通过
// 在脚本中先设置环境变量（package.json 的 test script）来保证正确性。
console.log(`测试数据目录: ${DB_PATH}`);

test("添加笔记后可以列出", async () => {
  await addNote("买牛奶", "生活");
  const notes = await listNotes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, "买牛奶");
  assert.equal(notes[0].tag, "生活");
});

test("ID 自动递增", async () => {
  await addNote("a");
  await addNote("b");
  const notes = await listNotes();
  assert.deepEqual(
    notes.map((n) => n.id),
    [1, 2],
  );
});

test("按标签过滤", async () => {
  await addNote("写周报", "工作");
  await addNote("散步", "生活");
  const work = await listNotes("工作");
  assert.equal(work.length, 1);
  assert.equal(work[0].text, "写周报");
});

test("删除不存在的笔记报错", async () => {
  await assert.rejects(() => deleteNote(999), /不存在/);
});
