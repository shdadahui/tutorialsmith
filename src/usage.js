/**
 * usage.js — token 用量与成本统计
 *
 * llm.js 每次成功调用后调用 recordUsage()，pipeline 结束时用 getUsageSummary()
 * 汇总每个模型的 token 消耗与估算成本，写进 report.md 和基准报告——
 * 让"生成一份教程花多少钱"变成可量化指标。
 */
let records = [];

/** 记录一次调用的用量（含 DeepSeek 上下文缓存命中统计） */
export function recordUsage({ model, promptTokens, completionTokens, cacheHitTokens = 0, cacheMissTokens = 0 }) {
  records.push({
    model,
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    cacheHitTokens: cacheHitTokens ?? 0,
    cacheMissTokens: cacheMissTokens ?? 0,
  });
}

/** 清空（基准测试每个项目跑前调用，保证独立统计） */
export function resetUsage() {
  records = [];
}

/**
 * 汇总用量与成本。
 * @param {object} costs 成本表：{ modelName: { inputPerMillion, outputPerMillion, currency } }
 * @returns {{ byModel: object, totalTokens, totalInput, totalOutput, totalCost, currency }}
 */
export function getUsageSummary(costs = {}) {
  const byModel = {};
  let totalTokens = 0, totalInput = 0, totalOutput = 0, totalCost = 0;
  let cacheHitTokens = 0, cacheMissTokens = 0;
  let currency = "¥";

  for (const r of records) {
    const m = byModel[r.model] || (byModel[r.model] = { promptTokens: 0, completionTokens: 0, cost: 0 });
    m.promptTokens += r.promptTokens;
    m.completionTokens += r.completionTokens;
    totalInput += r.promptTokens;
    totalOutput += r.completionTokens;
    cacheHitTokens += r.cacheHitTokens;
    cacheMissTokens += r.cacheMissTokens;

    const costCfg = costs[r.model];
    if (costCfg) {
      currency = costCfg.currency || currency;
      const cost = (r.promptTokens / 1_000_000) * (costCfg.inputPerMillion ?? 0) +
                   (r.completionTokens / 1_000_000) * (costCfg.outputPerMillion ?? 0);
      m.cost += cost;
      totalCost += cost;
    }
  }
  totalTokens = totalInput + totalOutput;
  const promptTotal = cacheHitTokens + cacheMissTokens;
  const cacheRate = promptTotal > 0 ? Math.round((cacheHitTokens / promptTotal) * 1000) / 10 : null;

  for (const m of Object.values(byModel)) m.cost = Math.round(m.cost * 10000) / 10000;
  totalCost = Math.round(totalCost * 10000) / 10000;

  return { byModel, totalTokens, totalInput, totalOutput, totalCost, currency, cacheHitTokens, cacheMissTokens, cacheRate };
}
