# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。所有版本演进均来自真实开发历史（v1 → v6.1）。

## [Unreleased]

- 规划中：SSE 流式输出、模型路由、RAG 素材检索（见 README「路线图」）

## [1.0.0] - 2026-08-12

首个正式发布。收录 v1 → v6.1 的全部能力演进。

### 核心能力

- **五阶段确定性流水线**：扫描 → 大纲 → 撰写 → 跨模型审查 → 量化评估
- **双指标量化体系**：完整度（结构/格式/密度）+ 可信度（事实/代码/评审），阈值修复闭环（无改进自动回滚）
- **多 LLM 分工**：scanner/outliner/writer/reviewer/react/reproduce 角色可独立配置 provider（OpenAI 兼容）

### v6.1 · 代码沙箱（2026-08-12）

- 复现与验证在临时副本中执行（排除 node_modules/.git 等），目标项目零污染
- 沙箱清理失败仅告警，不阻塞流水线

### v5 · 工程化升级（2026-08-11）

- ReAct 引擎原生 function calling（tool_calls），文本 JSON 回退保留
- scanner/outliner 结构化输出（response_format json_object），消灭 JSON 重试
- DeepSeek 上下文缓存命中率统计（实测 79.8%），写入报告

### v4 · 写作前复现（2026-08-11）

- 撰写前模型先真实跑通项目（read_file/run_command），产出已验证命令清单
- 命令白名单注入 writer：教程命令只能来自清单，失败命令禁用
- 实测命令可运行率 76% → 83%

### v3 · 验证门控（2026-08-10）

- `--verify` 失败的项目内命令自动写入第 4 章「踩坑记录（真实验证实录）」
- 模板新增「实操演练」「踩坑记录」小节，写作规范强制命令真实性

### v2 · ReAct 自主循环（2026-08-10）

- `--agent react`：模型每步输出 JSON 动作自主决策，步数上限兜底
- v1 流水线 vs v2 ReAct 架构对比实验（质量 77.3 vs 76.6，ReAct 更快更便宜但会跳过验证）

### v1 · 初始版本（2026-08-07）

- 零依赖 Node CLI 骨架、五阶段流水线、双指标量化、Web 界面、基准/多模型对比实验
