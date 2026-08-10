/**
 * config.test.js — 配置加载与角色解析单元测试
 * 运行：node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, resolveRole, resolveVision } from "../src/config.js";

// 测试用最小配置（不依赖磁盘上的 config.json）
const FAKE_CONFIG = {
  providers: {
    deepseek: { baseURL: "https://api.deepseek.com/", apiKeyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" },
    qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "DASHSCOPE_API_KEY", defaultModel: "qwen-plus" },
  },
  roles: {
    scanner: { provider: "deepseek", model: "deepseek-chat" },
    outliner: { provider: "deepseek", model: "deepseek-chat" },
    writer: { provider: "deepseek", model: "deepseek-chat" },
    reviewer: { provider: "deepseek", model: "deepseek-reasoner" },
  },
  vision: { provider: "qwen", model: "qwen-plus", enabled: false },
  defaults: {
    qualityThreshold: 85,
    concurrency: 5,
    costs: { "deepseek-chat": { inputPerMillion: 2, outputPerMillion: 8 } },
  },
};

test("defaults 缺省值填充", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ providers: FAKE_CONFIG.providers, roles: FAKE_CONFIG.roles }));
  const cfg = loadConfig(p);
  assert.equal(cfg.defaults.temperature, 0.7); // 缺省
  assert.equal(cfg.defaults.qualityThreshold, 80); // 缺省
  assert.equal(cfg.defaults.concurrency, 3); // 缺省
  assert.ok(cfg.defaults.metricsWeights.structure > 0);
});

test("defaults 自定义值生效", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(FAKE_CONFIG));
  const cfg = loadConfig(p);
  assert.equal(cfg.defaults.qualityThreshold, 85);
  assert.equal(cfg.defaults.concurrency, 5);
  assert.ok(cfg.defaults.costs["deepseek-chat"]);
});

test("resolveRole：baseURL 去尾斜杠 + 环境变量缺失报错", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(FAKE_CONFIG));
  const cfg = loadConfig(p);

  // 未设置 key 时报错
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  assert.throws(() => resolveRole(cfg, "scanner"), /DEEPSEEK_API_KEY/);
  if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;

  // 设置 key 后正常，且 baseURL 无尾斜杠
  process.env.DEEPSEEK_API_KEY = "sk-test";
  const r = resolveRole(cfg, "scanner");
  assert.equal(r.baseURL, "https://api.deepseek.com");
  assert.equal(r.model, "deepseek-chat");
  assert.equal(r.apiKey, "sk-test");
  delete process.env.DEEPSEEK_API_KEY;
});

test("resolveVision：无 key 时返回 null（静默跳过）", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(FAKE_CONFIG));
  const cfg = loadConfig(p);
  delete process.env.DASHSCOPE_API_KEY;
  assert.equal(resolveVision(cfg), null);
});
