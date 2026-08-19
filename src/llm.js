/**
 * llm.js — 统一的 LLM 客户端（OpenAI 兼容协议）
 *
 * 这是整条流水线的"发动机"：无论你用 DeepSeek、OpenAI、Kimi 还是通义千问，
 * 只要它是 OpenAI 兼容的 /chat/completions 接口，都走这一个函数。
 *
 * 职责：
 *   1. 拼接请求 URL（baseURL + /chat/completions）
 *   2. 注入 API Key（从配置指定的环境变量读取）
 *   3. 处理常见错误：401（Key 无效）、429（限流）、5xx（服务端）、超时
 *   4. 指数退避重试（第一次失败等 2s，第二次 4s，第三次 8s……上限 30s）
 *   5. 返回干净的文本内容
 */

/** 在超时后中止请求（Node 18+ 原生 AbortController） */
function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 发送一次 /chat/completions 请求，含重试与错误处理（chat 与 chatVision 共用） */
async function requestCompletion({ roleConfig, body, maxRetries = 3 }) {
  const { baseURL, apiKey } = roleConfig;
  const url = `${baseURL}/chat/completions`;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      }, 120_000); // 单次请求 120s 超时（长文本生成需要）

      if (res.ok) {
        const data = await res.json();
        const message = data?.choices?.[0]?.message || {};
        const content = message.content ?? null;
        // 原生 function calling：解析 tool_calls
        const toolCalls = Array.isArray(message.tool_calls)
          ? message.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function?.name,
              arguments: tc.function?.arguments, // 字符串形式的 JSON
            }))
          : [];
        if (content == null && !toolCalls.length) {
          const hint = message.reasoning
            ? "（模型输出了 reasoning 但 content 为空：这是思考型模型，reasoning 消耗了全部 max_tokens 预算，请为该角色增大 maxTokens，如 config.json 中设为 4096+）"
            : "";
          throw new Error(`响应缺少 content 或 tool_calls${hint}: ${JSON.stringify(data).slice(0, 200)}`);
        }
        // 记录 token 用量（成本统计 + DeepSeek 上下文缓存命中统计）
        const usage = data?.usage;
        if (usage) {
          const { recordUsage } = await import("./usage.js");
          recordUsage({
            model: body.model,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            cacheHitTokens: usage.prompt_cache_hit_tokens,
            cacheMissTokens: usage.prompt_cache_miss_tokens,
          });
        }
        return { content, toolCalls, message };
      }

      // 非 2xx：构造带上下文的错误信息
      let detail = "";
      try {
        const errBody = await res.json();
        detail = errBody?.error?.message || JSON.stringify(errBody).slice(0, 300);
      } catch {
        detail = (await res.text()).slice(0, 300);
      }

      if (res.status === 401) {
        // Key 无效：重试也没用，直接抛错终止
        throw new Error(`[401] API Key 无效或已过期（${body.model}）: ${detail}`);
      }
      if (res.status === 429) {
        lastError = new Error(`[429] 触发限流，等待后重试（${body.model}）: ${detail}`);
      } else if (res.status >= 500) {
        lastError = new Error(`[${res.status}] 服务端错误，等待后重试（${body.model}）: ${detail}`);
      } else {
        throw new Error(`[${res.status}] 请求失败（${body.model}）: ${detail}`);
      }
    } catch (err) {
      // 超时 / 网络错误
      if (err.name === "AbortError") {
        lastError = new Error(`请求超时（120s），等待后重试（${body.model}）`);
      } else if (err instanceof TypeError) {
        lastError = new Error(`网络错误（${body.model}）: ${err.message}`);
      } else {
        throw err; // 上面明确 throw 的错误（401、4xx 等）直接上抛
      }
    }

    // 指数退避：2s → 4s → 8s → 16s（封顶 30s）
    const delay = Math.min(2 ** (attempt + 1), 30) * 1000;
    console.warn(`  ⚠ ${lastError.message}（第 ${attempt + 1}/${maxRetries} 次重试，等待 ${delay / 1000}s）`);
    await sleep(delay);
  }

  throw lastError || new Error("未知 LLM 调用错误");
}

/**
 * 高级对话：多轮 messages + 原生 function calling + 结构化输出。
 * 供 v2/v4 的 ReAct 引擎（原生工具调用）与各阶段 JSON 输出使用。
 *
 * @param {object} opts
 * @param {object} opts.roleConfig  resolveRole() 的输出
 * @param {Array}  opts.messages    OpenAI messages 数组（system/user/assistant/tool）
 * @param {Array}  [opts.tools]     OpenAI tools 格式（[{type:"function",function:{name,description,parameters}}]）
 * @param {string} [opts.toolChoice] "auto" | "none" | {type:"function",function:{name}}
 * @param {boolean}[opts.jsonMode]  强制 JSON 输出（response_format: json_object）
 * @param {number} [opts.maxTokens] 覆盖最大输出 token
 * @param {number} [opts.maxRetries] 重试次数，默认 3
 * @returns {Promise<{content: string|null, toolCalls: Array<{id,name,arguments}>, message: object}>}
 */
export async function chatMessages({ roleConfig, messages, tools, toolChoice = "auto", jsonMode = false, maxTokens, maxRetries = 3 }) {
  const body = {
    model: roleConfig.model,
    messages,
    temperature: roleConfig.temperature,
    max_tokens: maxTokens ?? roleConfig.maxTokens,
    stream: false,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  if (jsonMode) body.response_format = { type: "json_object" };
  return requestCompletion({ roleConfig, body, maxRetries });
}

/**
 * 调用一次 LLM 对话（返回文本内容）。
 *
 * @param {object} opts
 * @param {object} opts.roleConfig  resolveRole() 的输出：{baseURL, model, apiKey, temperature, maxTokens}
 * @param {string} opts.system      系统提示词（角色设定/写作规范）
 * @param {string} opts.user        用户消息（任务内容）
 * @param {number} [opts.maxTokens] 覆盖该次调用的最大输出 token
 * @param {number} [opts.maxRetries] 最大重试次数，默认 3
 * @param {boolean}[opts.jsonMode]  强制 JSON 输出（response_format: json_object）
 * @returns {Promise<string>} 模型返回的文本内容
 */
export async function chat({ roleConfig, system, user, maxTokens, maxRetries = 3, jsonMode = false }) {
  const r = await chatMessages({
    roleConfig,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
    jsonMode,
    maxTokens,
    maxRetries,
  });
  return r.content;
}

/**
 * 多模态视觉调用：文本 + 一张图片（OpenAI 兼容 content 数组格式）。
 * 用于 scanner 阶段提取架构图/截图中的信息。
 *
 * @param {object} opts
 * @param {object} opts.roleConfig  resolveVision() 的输出（视觉模型配置）
 * @param {string} opts.system      系统提示词
 * @param {string} opts.text        对图片的提问文本
 * @param {string} opts.imageBase64 图片 base64（不含 data: 前缀）
 * @param {string} [opts.mimeType]  图片 MIME，默认 image/png
 * @returns {Promise<string>} 模型返回的描述文本
 */
export async function chatVision({ roleConfig, system, text, imageBase64, mimeType = "image/png" }) {
  const body = {
    model: roleConfig.model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      },
    ],
    temperature: roleConfig.temperature ?? 0.3,
    max_tokens: roleConfig.maxTokens ?? 2048,
    stream: false,
  };
  const r = await requestCompletion({ roleConfig, body, maxRetries: 2 });
  return r.content;
}
