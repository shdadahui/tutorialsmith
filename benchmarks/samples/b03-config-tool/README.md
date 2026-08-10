# config-tool

一个 JSON 配置文件校验 CLI，零依赖。定义字段规则（类型/必填/范围），对任意 JSON 文件做校验并输出友好报告。

```bash
node src/cli.js check ./examples/app.json --schema ./examples/schema.json
```

设计亮点：声明式 schema、逐字段错误收集（一次性报出全部问题）、支持嵌套对象与数组。
