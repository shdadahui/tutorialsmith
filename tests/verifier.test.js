/**
 * verifier.test.js — 真实验证器单元测试
 * 运行：node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../src/verifier.js";

test("命令分类：项目内命令", () => {
  assert.equal(classifyCommand("node src/index.js add x"), "project");
  assert.equal(classifyCommand("node ./main.js"), "project");
  assert.equal(classifyCommand("npm test"), "project");
  assert.equal(classifyCommand("npm start -- add x"), "project");
  assert.equal(classifyCommand("npm install fuse.js"), "project");
  assert.equal(classifyCommand("node --test test/"), "project");
  assert.equal(classifyCommand("yarn build"), "project");
});

test("命令分类：系统/平台命令（环境假设）", () => {
  assert.equal(classifyCommand("nvm install 20"), "system");
  assert.equal(classifyCommand("brew install node"), "system");
  assert.equal(classifyCommand("apt-get update"), "system");
  assert.equal(classifyCommand("git clone https://github.com/x/y.git"), "system");
  assert.equal(classifyCommand("cat ~/.mini-notes.json"), "system"); // ~ 家目录
  assert.equal(classifyCommand("npm publish"), "system");
  assert.equal(classifyCommand("npm install -g mini-notes"), "system");
  assert.equal(classifyCommand("export NODE_ENV=prod"), "system");
  assert.equal(classifyCommand("mkdir src"), "system");
  assert.equal(classifyCommand("cat $MINI_NOTES_DB"), "system"); // 环境变量
});

test("命令分类：默认保守归为项目内命令", () => {
  assert.equal(classifyCommand("node src/index.js"), "project");
  assert.equal(classifyCommand("npm run dev"), "project");
});
