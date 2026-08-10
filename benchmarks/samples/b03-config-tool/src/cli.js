/**
 * src/cli.js — config-tool 入口
 * 用法：node src/cli.js check <config.json> --schema <schema.json>
 */
import { readFile } from "node:fs/promises";
import { validate } from "./validate.js";

async function loadJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] !== "check" || argv.length < 2) {
    console.log("用法: node src/cli.js check <config.json> --schema <schema.json>");
    return;
  }
  const target = argv[1];
  const schemaIdx = argv.indexOf("--schema");
  const schemaPath = schemaIdx !== -1 ? argv[schemaIdx + 1] : null;
  if (!schemaPath) throw new Error("缺少 --schema 参数");

  const data = await loadJson(target);
  const schema = await loadJson(schemaPath);
  const errors = validate(data, schema);

  if (errors.length === 0) {
    console.log("✅ 校验通过");
  } else {
    console.log(`❌ 发现 ${errors.length} 个问题：`);
    for (const e of errors) console.log(`  - ${e}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
});
