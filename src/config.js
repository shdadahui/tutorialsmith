/**
 * config.js — 加载并校验 config.json 配置文件
 *
 * config.json 是「多 LLM 分工」的开关：每个流水线角色（scanner/outliner/writer/reviewer）
 * 都可以指向不同的 provider + model。默认全部指向 deepseek，后续只需改这一个文件，
 * 就能让"大纲生成"用 Kimi、"章节撰写"用 DeepSeek、"审查"用 GPT 等。
 *
 * 配置结构：
 *   providers: { 名字: { baseURL, apiKeyEnv, defaultModel } }   —— LLM 服务商注册表
 *   roles:     { 角色: { provider, model } }                     —— 每个阶段用哪个服务商/模型
 *   defaults:  { temperature, maxTokens, maxProjectBytes }       —— 通用参数
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(__dirname, "..", "config.json");

/** 所有必须存在的流水线角色 */
export const ROLES = ["scanner", "outliner", "writer", "reviewer"];

/** 读取 config.json，做基本校验，返回规范化后的配置对象 */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (!existsSync(configPath)) {
    throw new Error(`配置文件不存在: ${configPath}`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`配置文件不是合法 JSON: ${configPath} (${err.message})`);
  }

  if (!raw.providers || typeof raw.providers !== "object") {
    throw new Error("config.json 缺少 providers 字段（LLM 服务商注册表）");
  }
  if (!raw.roles || typeof raw.roles !== "object") {
    throw new Error("config.json 缺少 roles 字段（角色→模型映射）");
  }

  // 校验每个角色必须引用存在的 provider
  for (const role of ROLES) {
    const roleCfg = raw.roles[role];
    if (!roleCfg) throw new Error(`roles 中缺少 "${role}" 角色配置`);
    if (!raw.providers[roleCfg.provider]) {
      throw new Error(`角色 "${role}" 引用了未注册的 provider: "${roleCfg.provider}"`);
    }
    if (!roleCfg.model) throw new Error(`角色 "${role}" 缺少 model 字段`);
  }

  return {
    providers: raw.providers,
    roles: raw.roles,
    vision: raw.vision && raw.providers[raw.vision.provider] ? raw.vision : null,
    defaults: {
      temperature: raw.defaults?.temperature ?? 0.7,
      maxTokens: raw.defaults?.maxTokens ?? 4096,
      maxProjectBytes: raw.defaults?.maxProjectBytes ?? 200_000,
      qualityThreshold: raw.defaults?.qualityThreshold ?? 80,
      maxFixRounds: raw.defaults?.maxFixRounds ?? 2,
      concurrency: raw.defaults?.concurrency ?? 3,
      costs: raw.defaults?.costs ?? {},
      metricsWeights: {
        structure: 0.25,
        factual: 0.25,
        format: 0.15,
        density: 0.1,
        code: 0.1,
        review: 0.15,
        ...(raw.defaults?.metricsWeights || {}),
      },
      ...(raw.defaults || {}),
    },
  };
}

/** 解析某个角色的最终调用配置：{ baseURL, model, apiKey, temperature, maxTokens } */
export function resolveRole(config, role) {
  const roleCfg = config.roles[role];
  const provider = config.providers[roleCfg.provider];
  if (!provider) throw new Error(`未注册的 provider: ${roleCfg.provider}`);

  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `找不到 ${provider.apiKeyEnv} 环境变量（角色 ${role} 使用 provider "${roleCfg.provider}"）。` +
        `请在 .env 文件或系统环境变量中设置，例如：${provider.apiKeyEnv}=sk-xxx`
    );
  }

  return {
    baseURL: (provider.baseURL || "").replace(/\/+$/, ""), // 统一去掉末尾斜杠
    model: roleCfg.model,
    apiKey,
    temperature: roleCfg.temperature ?? config.defaults.temperature,
    maxTokens: roleCfg.maxTokens ?? config.defaults.maxTokens,
  };
}

/**
 * 解析视觉模型配置（供 scanner 的多模态提取使用）。
 * 未配置 vision 或对应环境变量缺失时返回 null（调用方自动跳过视觉提取）。
 */
export function resolveVision(config) {
  if (!config.vision) return null;
  const provider = config.providers[config.vision.provider];
  if (!provider) return null;
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) return null;
  return {
    baseURL: (provider.baseURL || "").replace(/\/+$/, ""),
    model: config.vision.model || provider.defaultModel,
    apiKey,
    temperature: config.vision.temperature ?? 0.3,
    maxTokens: config.vision.maxTokens ?? 2048,
  };
}
