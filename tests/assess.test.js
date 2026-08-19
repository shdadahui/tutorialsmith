/**
 * assess.test.js — 能力评估前置单元测试
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIENCE_MAP, GOAL_MAP, FOCUS_MAP } from "../src/assess.js";

test("能力评估：三张映射表覆盖全部输入", () => {
  assert.deepEqual(Object.keys(AUDIENCE_MAP).sort(), ["有基础", "熟练", "零基础"]);
  assert.deepEqual(Object.keys(GOAL_MAP).sort(), ["快速上手", "源码魔改", "系统学习"]);
  assert.deepEqual(Object.keys(FOCUS_MAP).sort(), ["偏原理", "偏实战", "均衡"]);
});

test("能力评估：每类输入都有对应受众描述", () => {
  for (const v of Object.values(AUDIENCE_MAP)) assert.ok(v.length > 5);
  for (const v of Object.values(GOAL_MAP)) assert.ok(v.length > 5);
  for (const v of Object.values(FOCUS_MAP)) assert.ok(v.length > 0);
});
