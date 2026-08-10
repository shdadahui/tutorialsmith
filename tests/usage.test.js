/**
 * usage.test.js — token/成本统计单元测试
 * 运行：node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordUsage, resetUsage, getUsageSummary } from "../src/usage.js";

test("usage：按模型累计 token 并估算成本", () => {
  resetUsage();
  recordUsage({ model: "deepseek-chat", promptTokens: 1000, completionTokens: 500 });
  recordUsage({ model: "deepseek-chat", promptTokens: 1000, completionTokens: 500 });
  recordUsage({ model: "deepseek-reasoner", promptTokens: 500, completionTokens: 250 });

  const costs = {
    "deepseek-chat": { inputPerMillion: 2, outputPerMillion: 8, currency: "¥" },
    "deepseek-reasoner": { inputPerMillion: 4, outputPerMillion: 16, currency: "¥" },
  };
  const s = getUsageSummary(costs);

  assert.equal(s.totalTokens, 3750);
  assert.equal(s.totalInput, 2500);
  assert.equal(s.totalOutput, 1250);
  // deepseek-chat: 2000/1e6*2 + 1000/1e6*8 = 0.004 + 0.008 = 0.012
  // reasoner: 500/1e6*4 + 250/1e6*16 = 0.002 + 0.004 = 0.006
  assert.ok(Math.abs(s.totalCost - 0.018) < 0.001);
  assert.equal(s.currency, "¥");
  assert.equal(s.byModel["deepseek-chat"].promptTokens, 2000);
});

test("usage：无成本表时不报错，成本为 0", () => {
  resetUsage();
  recordUsage({ model: "unknown-model", promptTokens: 10, completionTokens: 5 });
  const s = getUsageSummary();
  assert.equal(s.totalCost, 0);
  assert.equal(s.totalTokens, 15);
});
