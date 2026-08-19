/**
 * examplecode.test.js — 配套示例代码生成器单元测试
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExampleJson, buildExampleUser, buildExampleSys } from "../src/examplecode.js";

test("parseExampleJson：解析合法结构", () => {
  const r = parseExampleJson(JSON.stringify({
    files: [
      { path: "04-practice/mini-notes-cli.js", content: "console.log(1)", run: "node mini-notes-cli.js" },
      { path: "06-advanced/plugin.js", content: "// x" },
    ],
  }));
  assert.equal(r.files.length, 2);
  assert.equal(r.files[0].path, "04-practice/mini-notes-cli.js");
  assert.equal(r.files[1].run, "");
});

test("parseExampleJson：容忍 ```json 围栏", () => {
  const r = parseExampleJson("```json\n{\"files\":[{\"path\":\"a.js\",\"content\":\"x\"}]}\n```");
  assert.ok(r && r.files.length === 1);
});

test("parseExampleJson：拒绝目录穿越与绝对路径", () => {
  const r = parseExampleJson(JSON.stringify({
    files: [
      { path: "../evil.js", content: "x" },
      { path: "/etc/passwd", content: "x" },
      { path: "ok.js", content: "y" },
    ],
  }));
  assert.ok(r);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].path, "ok.js");
});

test("parseExampleJson：无 files 返回 null", () => {
  assert.equal(parseExampleJson("{\"foo\":1}"), null);
  assert.equal(parseExampleJson("不是 JSON"), null);
});

test("buildExampleUser：包含命令白名单与失败清单", () => {
  const u = buildExampleUser({
    projectSummary: { project_name: "demo" },
    reproduction: { okCommands: ["node src/index.js list"], failed: [{ cmd: "npm test" }] },
    chapterFiles: [{ index: 1, content: "# 第 1 章\n内容" }],
  });
  assert.ok(u.includes("node src/index.js list"));
  assert.ok(u.includes("npm test"));
  assert.ok(u.includes("第 1 章"));
});

test("buildExampleSys：包含真实性约束", () => {
  const s = buildExampleSys();
  assert.ok(s.includes("禁止编造"));
  assert.ok(s.includes("example-code"));
});
