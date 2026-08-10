/**
 * metrics.test.js — 量化指标计算器单元测试
 * 运行：node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, bar } from "../src/metrics.js";

const W = { structure: 0.25, factual: 0.25, format: 0.15, density: 0.1, code: 0.1, review: 0.15 };

const outline = {
  chapters: [
    { index: 1, title: "入门与概述", sections: ["1.1 什么是 mini-notes", "1.2 核心价值与方案对比", "1.3 整体架构与核心组成"] },
    { index: 2, title: "核心概念", sections: ["2.1 原子写入", "2.2 底层工作原理"] },
  ],
};

test("结构完整度：缺失小节被识别并扣分", () => {
  // 用独特关键词的小节，避免关键词碰撞导致误命中
  const outline2 = {
    chapters: [
      { index: 1, title: "入门与概述", sections: ["1.1 什么是 mini-notes", "1.2 性能基准测试", "1.3 安全审计流程"] },
    ],
  };
  const chapterFiles = [
    { index: 1, content: "# 第1章\n\n## 1.1 什么是 mini-notes\n\n正文内容足够长，用来通过密度检查。\n\n引用 src/index.js 文件路径。" },
  ];
  const m = computeMetrics({ outline: outline2, chapterFiles, projectFilePaths: ["src/index.js"], weights: W });
  // 只有 1.1 命中 → 1/3
  assert.equal(m.raw.structure.score, Math.round((1 / 3) * 1000) / 10);
  assert.ok(m.issuesByChapter["1"].some((i) => i.includes("1.2")));
  assert.ok(m.issuesByChapter["1"].some((i) => i.includes("1.3")));
});

test("格式规范度：四级标题/未闭合代码块/表格列数/加粗扣分", () => {
  const chapterFiles = [
    { index: 1, content: "# 第1章\n\n#### 四级标题违规\n\n```js\n未闭合\n\n| a | b |\n|---|\n| 1 | 2 | 3 |\n\n**未配对加粗" },
  ];
  const m = computeMetrics({ outline, chapterFiles, projectFilePaths: [], weights: W });
  assert.ok(m.raw.format.score < 100);
  assert.ok(m.issuesByChapter["1"].some((i) => i.includes("四级")));
  assert.ok(m.issuesByChapter["1"].some((i) => i.includes("未闭合")));
  assert.ok(m.issuesByChapter["1"].some((i) => i.includes("列数不一致")));
  assert.ok(m.issuesByChapter["1"].some((i) => i.includes("未配对")));
});

test("事实一致性：教程引用的文件路径与项目文件树比对", () => {
  const chapterFiles = [
    { index: 1, content: "# 第1章\n\n引用 src/index.js 和 src/ghost.js\n\n正文内容足够长用来通过密度检查，补充一些文字。" },
  ];
  const m = computeMetrics({ outline, chapterFiles, projectFilePaths: ["src/index.js"], weights: W });
  assert.equal(m.raw.factual.score, 50); // 2 个引用命中 1 个
  assert.ok(m.issuesByChapter["1"].some((i) => i.includes("src/ghost.js")));
});

test("双指标：完整度与可信度分开计算", () => {
  const chapterFiles = [
    { index: 1, content: "# 第1章\n\n## 1.1 什么是 mini-notes\n\n## 1.2 核心价值与方案对比\n\n## 1.3 整体架构与核心组成\n\n正文内容足够长，包含代码示例。\n\n```js\nconsole.log(1)\n```\n\n引用 src/index.js。" },
    { index: 2, content: "# 第2章\n\n## 2.1 原子写入\n\n## 2.2 底层工作原理\n\n正文内容足够长，包含代码示例。\n\n```js\nconsole.log(2)\n```\n\n引用 src/notes.js。" },
  ];
  const m = computeMetrics({ outline, chapterFiles, projectFilePaths: ["src/index.js", "src/notes.js"], reviewScore: 90, codeScore: 100, weights: W });
  assert.ok(m.completeness.score > 80); // 结构/格式/密度都很好
  assert.ok(m.reliability.score > 90);  // 事实/代码/评审都很好
  assert.equal(m.review, 90);
  assert.equal(m.code, 100);
});

test("未启用的维度不参与加权（权重归一化）", () => {
  const chapterFiles = [
    { index: 1, content: "# 第1章\n\n## 1.1 什么是 mini-notes\n\n## 1.2 核心价值与方案对比\n\n## 1.3 整体架构与核心组成\n\n正文内容足够长，包含代码示例。\n\n```js\nconsole.log(1)\n```\n\n引用 src/index.js。" },
    { index: 2, content: "# 第2章\n\n## 2.1 原子写入\n\n## 2.2 底层工作原理\n\n正文内容足够长，包含代码示例。\n\n```js\nconsole.log(2)\n```\n\n引用 src/notes.js。" },
  ];
  // review 和 code 都 null（未审查/未验证）
  const m = computeMetrics({ outline, chapterFiles, projectFilePaths: ["src/index.js", "src/notes.js"], reviewScore: null, codeScore: null, weights: W });
  assert.equal(m.details.review, null);
  assert.equal(m.details.code, null);
  assert.equal(m.reliability.score, m.raw.factual.score); // 可信度只剩事实维度
  assert.ok(m.qualityScore > 0);
});

test("bar 可视化：null 显示占位，分数映射长度", () => {
  assert.equal(bar(null), "—".repeat(20));
  assert.equal(bar(100).length, 20);
  assert.ok(bar(50).includes("█"));
  assert.ok(bar(50).includes("░"));
});
