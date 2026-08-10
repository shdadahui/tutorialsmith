/**
 * src/validate.js — 声明式 JSON Schema 校验器
 * 规则：{ 字段名: { type: 'string'|'number'|'boolean'|'object'|'array', required?: bool, min?: number, max?: number } }
 * 逐字段收集全部错误（不是遇到第一个就停）
 */
export function validate(data, schema, path = "") {
  const errors = [];

  for (const [key, rule] of Object.entries(schema)) {
    const fullPath = path ? `${path}.${key}` : key;
    const value = data?.[key];

    if (value === undefined || value === null) {
      if (rule.required) errors.push(`[${fullPath}] 必填字段缺失`);
      continue;
    }
    if (rule.type && typeof value !== rule.type) {
      errors.push(`[${fullPath}] 类型错误：期望 ${rule.type}，实际 ${typeof value}`);
      continue;
    }
    if (typeof value === "number") {
      if (rule.min != null && value < rule.min) errors.push(`[${fullPath}] 小于最小值 ${rule.min}`);
      if (rule.max != null && value > rule.max) errors.push(`[${fullPath}] 大于最大值 ${rule.max}`);
    }
    if (rule.type === "object" && rule.properties) {
      errors.push(...validate(value, rule.properties, fullPath));
    }
    if (rule.type === "array" && rule.itemSchema) {
      value.forEach((item, i) => {
        if (rule.itemSchema.type && typeof item !== rule.itemSchema.type) {
          errors.push(`[${fullPath}[${i}]] 元素类型错误`);
        }
      });
    }
  }
  return errors;
}
