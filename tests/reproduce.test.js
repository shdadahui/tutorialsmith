/**
 * reproduce.test.js — 写作前复现工具单元测试
 * 运行：node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReproduceTools, REPRODUCE_TOOLS_SCHEMA, dispatchReproduceTool } from "../src/reproduce/tools.js";
import { buildReproduceSys } from "../src/reproduce/engine.js";

const config = { defaults: { maxProjectBytes: 200000 } };
const tools = createReproduceTools({ config, projectPath: "G:/SuuuuuuuuuuuuuuuuuperCrypto/Aiagent/tutorialsmith" });

test("复现工具：危险命令被过滤且不执行", async () => {
  const obs = await tools.run_command({ cmd: "rm -rf /" });
  assert.match(obs, /已拒绝|危险/);
  assert.equal(tools.state.commands.length, 1);
  assert.equal(tools.state.commands[0].ok, false);
  assert.equal(tools.state.commands[0].skipped, true);
});

test("复现工具：read_file 防目录穿越", async () => {
  const obs = await tools.read_file({ path: "../../../../etc/passwd" });
  assert.match(obs, /拒绝|错误/);
});

test("复现工具：缺少参数给出明确错误", async () => {
  assert.match(await tools.run_command({}), /需要参数/);
  assert.match(await tools.read_file({}), /需要参数/);
});

test("复现工具：finish 汇总报告", async () => {
  const obs = await tools.finish({});
  assert.match(obs, /复现报告已生成/);
});

test("工具注册表：4 个工具且包含 finish", () => {
  assert.equal(REPRODUCE_TOOLS_SCHEMA.length, 4);
  assert.ok(REPRODUCE_TOOLS_SCHEMA.some((t) => t.name === "finish"));
  assert.ok(REPRODUCE_TOOLS_SCHEMA.some((t) => t.name === "run_command"));
});

test("buildReproduceSys：包含工具清单与硬性规则", () => {
  const sys = buildReproduceSys();
  for (const t of REPRODUCE_TOOLS_SCHEMA) assert.ok(sys.includes(t.name));
  assert.ok(sys.includes("finish"));
  assert.ok(sys.includes("严禁编造"));
});

test("dispatchReproduceTool：未知动作报错", async () => {
  assert.match(await dispatchReproduceTool(tools, { action: "nope" }), /未知动作/);
});
