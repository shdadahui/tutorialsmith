/**
 * urlcheck.test.js — URL 真实性静态检查单元测试
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUrls, checkAllChaptersUrls, FAKE_URL_PATTERNS } from "../src/urlcheck.js";

test("checkUrls：识别 example.com 子路径（编造 URL）", () => {
  const hits = checkUrls("打开 https://example.com/login 登录，再看 https://example.org/api/v1");
  assert.deepEqual(hits, ["https://example.com/login", "https://example.org/api/v1"]);
});

test("checkUrls：example.com 根路径不算编造", () => {
  const hits = checkUrls("访问 https://example.com 查看示例");
  assert.deepEqual(hits, []);
});

test("checkUrls：真实站点（httpbin.org 等）不算编造", () => {
  const hits = checkUrls("POST 请求 https://httpbin.org/post，页面 https://the-internet.herokuapp.com/login");
  assert.deepEqual(hits, []);
});

test("checkUrls：占位域 your-domain.com 被标记", () => {
  const hits = checkUrls("部署到 https://your-domain.com/app");
  assert.ok(hits.includes("https://your-domain.com/app"));
});

test("checkAllChaptersUrls：按章节分组", () => {
  const map = checkAllChaptersUrls([
    { index: 2, content: "见 https://example.com/guide" },
    { index: 4, content: "一切正常 https://example.com 与 https://httpbin.org/get" },
    { index: 5, content: "" },
  ]);
  assert.deepEqual(map, { 2: ["https://example.com/guide"] });
});

test("FAKE_URL_PATTERNS：example.com 子域名被标记", () => {
  assert.ok(FAKE_URL_PATTERNS.some((re) => re.test("https://mail.example.com")));
  assert.ok(FAKE_URL_PATTERNS.some((re) => re.test("https://foo.example/")));
});
