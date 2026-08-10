/**
 * outliner.test.js — 大纲生成器单元测试
 * 运行：node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonLoose, isValidTemplate } from "../src/outliner.js";
import { buildOutlinerSys } from "../src/prompts.js";

test("parseJsonLoose：容忍 ```json 围栏与前后杂字", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('好的，结果如下：{"a":1} 完毕'), { a: 1 });
  assert.deepEqual(parseJsonLoose('{"a":{"b":[1,2]}}'), { a: { b: [1, 2] } });
  assert.equal(parseJsonLoose("不是 JSON"), null);
  assert.equal(parseJsonLoose(null), null);
});

test("isValidTemplate：合法模板通过，非法拒绝", () => {
  const good = {
    chapters: [
      { index: 1, title: "快速上手", sections: ["1.1 是什么", "1.2 跑起来"] },
      { index: 2, title: "进阶", sections: ["2.1 高级特性"] },
    ],
  };
  assert.equal(isValidTemplate(good), true);
  assert.equal(isValidTemplate(null), false);
  assert.equal(isValidTemplate({ chapters: [] }), false);
  assert.equal(isValidTemplate({ chapters: [{ index: 1, title: "x" }] }), false); // 缺 sections
  assert.equal(isValidTemplate({ chapters: [{ index: 1, title: "x", sections: [] }] }), false);
});

test("buildOutlinerSys：自定义模板注入 vs 默认 7 章", () => {
  const withTemplate = buildOutlinerSys({
    chapters: [{ index: 1, title: "快速上手", sections: ["1.1 是什么"] }],
  });
  assert.ok(withTemplate.includes("快速上手"));
  assert.ok(withTemplate.includes("必须严格遵循"));

  const withoutTemplate = buildOutlinerSys(null);
  assert.ok(withoutTemplate.includes("第1章 入门与概述"));
  assert.ok(withoutTemplate.includes("7 章结构"));
});
