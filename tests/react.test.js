/**
 * react.test.js — ReAct 引擎单元测试
 * 运行：node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAction, buildReactSys } from "../src/react/engine.js";
import { TOOL_SCHEMA, toOpenAITools } from "../src/react/tools.js";

test("parseAction：纯 JSON 动作", () => {
  assert.deepEqual(parseAction('{"action":"write_chapter","args":{"index":1}}'), {
    action: "write_chapter", args: { index: 1 },
  });
});

test("parseAction：容忍 markdown 围栏与前后思考文本", () => {
  assert.deepEqual(parseAction('思考一下，下一步应该：\n```json\n{"action":"scan_project","args":{}}\n```\n结束'), {
    action: "scan_project", args: {},
  });
  assert.deepEqual(parseAction('好的，我先扫描项目 {"action":"list_files","args":{}} 完成'), {
    action: "list_files", args: {},
  });
});

test("parseAction：args 缺失时回退为空对象", () => {
  assert.deepEqual(parseAction('{"action":"finalize"}'), { action: "finalize", args: {} });
});

test("parseAction：非法输入返回 null", () => {
  assert.equal(parseAction("我想先看看项目"), null);
  assert.equal(parseAction('{"foo":"bar"}'), null); // 无 action 字段
  assert.equal(parseAction(null), null);
  assert.equal(parseAction(""), null);
});

test("buildReactSys：包含工具清单、JSON 协议与质量阈值", () => {
  const sys = buildReactSys({ defaults: { qualityThreshold: 80 } });
  for (const t of TOOL_SCHEMA) assert.ok(sys.includes(t.name), `缺少工具 ${t.name}`);
  assert.ok(sys.includes("finalize"));
  assert.ok(sys.includes("80"));
  assert.ok(sys.includes("action"));
});

test("工具注册表：8 个工具且 finalize 存在", () => {
  assert.equal(TOOL_SCHEMA.length, 8);
  assert.ok(TOOL_SCHEMA.some((t) => t.name === "finalize"));
  assert.ok(TOOL_SCHEMA.some((t) => t.name === "compute_metrics"));
});

test("toOpenAITools：生成原生 function calling 格式", () => {
  const tools = toOpenAITools();
  assert.equal(tools.length, 8);
  const write = tools.find((t) => t.function.name === "write_chapter");
  assert.equal(write.type, "function");
  assert.ok(write.function.parameters.properties.index);
  assert.deepEqual(write.function.parameters.required, ["index"]);
  const finalize = tools.find((t) => t.function.name === "finalize");
  assert.ok(finalize.function.parameters.properties, "空参工具也有 properties");
});
