# TutorialSmith（教程匠）— 基于项目自动生成技术教程的 Agent

[![CI](https://github.com/shdadahui/tutorialsmith/actions/workflows/ci.yml/badge.svg)](https://github.com/shdadahui/tutorialsmith/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/shdadahui/tutorialsmith)](https://github.com/shdadahui/tutorialsmith/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D18-blue)](package.json)
[![npm](https://img.shields.io/npm/v/tutorialsmith)](https://www.npmjs.com/package/tutorialsmith)

一个 **Node.js 命令行工具**：给定一个项目目录，自动产出一份体系完整的技术教程（Markdown，7 章结构），覆盖基础概念、底层原理、环境搭建、分步开发、调试排错、最佳实践与进阶延伸。

核心能力：

- **多阶段流水线**：扫描项目 → 生成大纲 → 逐章撰写 → 质量审查，四阶段各司其职
- **多 LLM 分工**：一个 `config.json` 就能让不同阶段用不同模型（默认统一 DeepSeek）
- **零第三方依赖**：只用 Node 内置模块（fetch / fs / path / util），整个工程 8 个源码文件，极易读懂、复现
- **工程化细节**：断点续写（`--resume`）、指数退避重试、敏感文件过滤、JSON 输出校验与兜底

---

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                       config.json                            │
│   providers: deepseek / openai / kimi / qwen (可扩展)        │
│   roles:     scanner → outliner → writer → reviewer          │
└──────────────────────────┬──────────────────────────────────┘
                           │ 每个角色可指向不同 provider + model
┌──────────────────────────▼──────────────────────────────────┐
│                     cli.js（入口）                            │
│        解析命令行参数 → 加载 .env → 加载 config → 跑流水线     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│     阶段1  scanner.js   项目扫描（感知工具）                   │
│     遍历目录 → 过滤噪音/敏感文件 → 精选素材 → LLM 提炼概况      │
│     （可选：视觉模型提取架构图/截图信息）                       │
├─────────────────────────────────────────────────────────────┤
│     阶段2  outliner.js  大纲生成                              │
│     项目概况 → LLM 生成大纲（JSON，校验+重试+兜底）             │
│     （支持 --template 自定义章节模板，默认 7 章）               │
├─────────────────────────────────────────────────────────────┤
│     阶段3  writer.js    逐章撰写（执行工具）                   │
│     每章一次 LLM 调用 → chapter-01..07.md（支持断点续写）       │
├─────────────────────────────────────────────────────────────┤
│     阶段4  reviewer.js  质量审查（校验工具）                   │
│     质量清单打分 → revise 章节带意见重写一轮                    │
├─────────────────────────────────────────────────────────────┤
│     阶段5  metrics/verifier 量化评估（零/低 LLM）              │
│     结构/格式/事实/密度本地评分 + --verify 真实执行教程命令      │
│     → 总分 < 阈值时，本地问题清单回灌 writer 自动修复（N 轮）    │
│     → 输出 index.md + report.md + metrics.json               │
└─────────────────────────────────────────────────────────────┘
```

数据流（每一跳都是"上一阶段的输出 = 下一阶段的输入"）：

```
项目目录 ──▶ projectSummary(JSON) ──▶ outline(JSON) ──▶ chapter-*.md
   ──▶ 审查修正 ──▶ 量化评分 ──▶ (低于阈值 → 本地问题回灌重写，循环)
   ──▶ index.md + report.md + metrics.json
```

**为什么这样分层？** 与"感知 / 执行 / 校验 / 协作"的工具分类思想一致——扫描器管"看"，writer 管"写"，reviewer 管"查"，互不越界，每个模块都可以单独替换或升级。

---

## 二、快速开始

### 0. 免克隆直接使用（已发布到 npm）

```bash
# 方式一：全局安装
npm i -g tutorialsmith
tutorialsmith --project ./你的项目 --output ./docs

# 方式二：免安装（npx 自动下载）
npx tutorialsmith --project ./你的项目 --output ./docs
```

> 从源码跑：`git clone` 后 `node src/cli.js --project <目录> --output ./output/xxx`

### 1. 准备环境

- Node.js ≥ 18（本工具在 Node 22 下开发测试）
- 一个 DeepSeek API Key（[platform.deepseek.com](https://platform.deepseek.com) 申请）

### 2. 配置 API Key

```bash
# 方式一（推荐）：复制 .env.example 为 .env 并填入
cp .env.example .env
# 然后编辑 .env，把 DEEPSEEK_API_KEY 换成你的 key

# 方式二：直接设置系统环境变量
export DEEPSEEK_API_KEY=sk-xxxx          # macOS / Linux
setx DEEPSEEK_API_KEY sk-xxxx            # Windows
```

### 3. 生成教程

```bash
node src/cli.js --project ./demo --output ./output/demo-tutorial
```

可选参数：

| 参数 | 说明 |
| --- | --- |
| `--audience "有 Node.js 基础的开发者"` | 指定目标受众 |
| `--focus "偏代码实战"` | 指定教程侧重 |
| `--intro "..."` | 补充项目简介 |
| `--resume` | 断点续写：跳过已生成的章节 |
| `--skip-review` | 跳过质量审查（更快、更省 token） |
| `--verify` | 真实验证：执行教程中的命令，统计可运行率（默认关闭） |
| `--template ./templates/lean.json` | 自定义章节模板（默认内置 7 章结构） |
| `--threshold 85` | 质量分阈值（默认读 config），低于则自动修复教程 |
| `--baseline metrics.json` | 黄金样本指标，报告中做对比 |
| `--no-fix` | 关闭"分数低于阈值自动修复" |
| `--browse [--port 4000]` | 生成完成后用 mdbrowse-cli 打开网页版文档预览 |

### 4b. 网页版文档预览（--browse）

教程输出是纯 Markdown，配合 [mdbrowse-cli](https://www.npmjs.com/package/mdbrowse-cli)（零安装，`npx` 直接拉取）即可变成一个**网页版文档站**：文件树侧栏、GFM 渲染、Shiki 语法高亮、全文搜索（Ctrl+K）、Mermaid 图、数学公式、实时刷新，自动打开浏览器。

```bash
# 生成后直接预览（阻塞直到 Ctrl+C）
node src/cli.js --project ./demo --output ./output/xxx --browse --port 4000

# 已有教程，跳过生成直接打开（resume 只耗 2 次 LLM 调用）
node src/cli.js --project ./demo --output ./output/xxx --resume --skip-review --browse

# 不经过流水线，手动预览任意 Markdown 目录
npx --yes mdbrowse-cli ./output/xxx --read-only
```

> 提示：`--browse` 默认 `--read-only`（只读，防误改教程）；想编辑可去掉该参数。需要公网分享可加 `--tunnel`（Cloudflare，需 cloudflared）。

### 5. 查看量化质量报告

每次运行都会产出三件套：

```
output/xxx/
├── index.md        # 总索引（含质量报告入口）
├── report.md       # 质量报告：总分/等级/六维评分/待改进问题/验证结果
├── metrics.json    # 机器可读的量化指标
└── chapter-01..07.md
```

**质量分怎么来的？——双指标体系**

报告同时给出两个 headline：

- **完整度**（Completeness）= 结构/格式/密度 加权 → "内容生成得全不全、规不规范"
- **可信度**（Reliability）= 事实/代码/评审 加权 → "内容是不是真的、能不能跑"

| 维度 | 权重 | 归属 | 计算方式 | 是否耗 LLM |
| --- | --- | --- | --- | --- |
| 结构完整度 | 25% | 完整度 | 大纲每章小节是否被覆盖（关键词匹配） | 否 |
| 事实一致性 | 25% | 可信度 | 教程引用的文件路径是否真实存在 | 否 |
| 格式规范度 | 15% | 完整度 | 标题跳级/代码块未闭合/表格列数/加粗配对 | 否 |
| 信息密度 | 10% | 完整度 | 章节字数与代码占比（防注水） | 否 |
| 代码可运行率 | 10% | 可信度 | `--verify` 真实执行**项目内命令**的通过率 | 否 |
| LLM 评审分 | 15% | 可信度 | reviewer 六维均分（默认跨模型评审，标注"参考"） | 是 |

**平台公平性**：`--verify` 会把命令分为两类——**项目内命令**（`node src/xxx`、`npm test` 等，失败 = 教程写错了，计入可运行率）与**系统/平台命令**（`nvm`、`brew`、`~` 路径、`npm publish` 等，目标环境可能与本机不同，记为"环境假设"不计分，单独展示适配度）。这样 Windows 上跑 macOS 教程不会被冤枉扣分。

**阈值修复闭环**：总分低于 `qualityThreshold`（默认 80）时，工具会把**本地可枚举的问题**（缺失小节、格式违规、引用不存在的路径、验证失败的命令）按章节回灌给 writer 重写，再重算分数，最多循环 `maxFixRounds`（默认 2）轮；**重写后分数不升反降则自动回滚**。整个闭环记录在 report.md 的「阈值修复记录」里。

**成本统计**：每次运行统计各模型 token 用量，按 `config.json` 的 `defaults.costs` 估算成本，写进 report.md 与 metrics.json。

### 4. 查看成果

`output/` 目录下会生成：

```
index.md                      ← 总索引（从这里开始读，含质量报告入口）
report.md                     ← 量化质量报告（双指标 + 六维评分 + 成本 + 修复记录）
metrics.json                  ← 机器可读的量化指标（含用量与成本）
meta.json                     ← 中间产物（项目概况+大纲，--resume 复用，省 2 次 LLM）
chapter-01.md  入门与概述
chapter-02.md  核心概念与底层原理
chapter-03.md  环境搭建与准备
chapter-04.md  分步开发实战
chapter-05.md  调试、排错与最佳实践
chapter-06.md  进阶与延伸
chapter-07.md  总结与思考题
```

### 5b. 基准测试套件（benchmarks/）

对多个样例项目以**标准评测模式**（审查 + 验证全开、固定权重）跑完整流水线，产出可复现的性能报告：

```bash
node benchmarks/run.js                # 跑全部样例项目（每个 8-15 分钟）
node benchmarks/run.js --projects hello-cli,http-server
```

输出 `benchmarks/out/run-<时间戳>/`：每个项目的教程目录 + `results.json`（机器可读）+ `benchmark-report.md`（耗时 / 成本 / token / 完整度 / 可信度 / 质量分 + 平均值、中位数、P90 百分位）。每次运行独立目录，保留历史基准记录。这些数字可以直接写进简历。

### 5c. ReAct 范式（v2，--agent react）

默认是**确定性流水线**（执行顺序由代码定死）；v2 把决策权交给模型——**ReAct 自主循环**：模型每步输出一个 JSON 动作 `{"action": "...", "args": {...}}`，引擎执行工具并回传 Observation，模型据此决定下一步，直到调用 `finalize()` 收尾。

```bash
node src/cli.js --project ./demo --agent react --output ./output/react-demo
```

**工具集**（8 个，90% 复用 v1 模块）：`list_files` / `scan_project` / `generate_outline` / `write_chapter(index)` / `review_chapter(index)` / `verify_tutorial` / `compute_metrics` / `finalize`。模型可重复、可跳步、可自主决定是否审查/验证；引擎兜底**步数上限**（默认 20，耗尽强制收尾）。

**架构对比实验**（同项目、同底层模块，只换编排层）：

```bash
npm run compare-arch                 # v1 流水线 vs v2 ReAct
```

输出 `benchmarks/out/compare-arch-<时间戳>/compare-arch-report.md`：耗时 / 成本 / 质量分 / 步数对比 + 结论（质量最高 / 成本最低 / 性价比）+ 差异说明。这是简历上的深度话题：**ReAct 的灵活性 vs 流水线的可控性**，用数据说话。

### 5c. 单元测试 + CI

```bash
npm test        # 18 个单测用例（metrics/verifier/config/outliner/usage）
```

`.github/workflows/ci.yml`：Node 18/20/22 三版本矩阵，语法检查 + 单测 + CLI 冒烟测试。

---

## 三、配置文件详解（多 LLM 分工的开关）

`config.json` 是整个工具"多模型协作"的核心，分四块：

```jsonc
{
  "providers": {          // ① 服务商注册表：只要 OpenAI 兼容，都能注册
    "deepseek": {
      "baseURL": "https://api.deepseek.com",        // 注意：deepseek 不带 /v1
      "apiKeyEnv": "DEEPSEEK_API_KEY",              // 从哪个环境变量取 Key
      "defaultModel": "deepseek-chat"
    },
    "openai": {
      "baseURL": "https://api.openai.com/v1",       // openai 带 /v1
      "apiKeyEnv": "OPENAI_API_KEY",
      "defaultModel": "gpt-4o-mini"
    },
    "qwen-vl": {            // 视觉模型（架构图/截图提取，需自行配 DASHSCOPE_API_KEY）
      "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKeyEnv": "DASHSCOPE_API_KEY",
      "defaultModel": "qwen-vl-max"
    }
  },
  "roles": {              // ② 角色分工：每个阶段用哪个服务商 + 哪个模型
    "scanner":  { "provider": "deepseek", "model": "deepseek-chat" },
    "outliner": { "provider": "deepseek", "model": "deepseek-chat" },
    "writer":   { "provider": "deepseek", "model": "deepseek-chat" },
    "reviewer": { "provider": "deepseek", "model": "deepseek-reasoner" }  // 跨模型评审（writer 与 reviewer 不同模型）
  },
  "vision": {             // ③ 视觉模型开关（默认关闭；开启后 scanner 自动提取项目图片）
    "provider": "qwen-vl",
    "model": "qwen-vl-max",
    "enabled": false
  },
  "defaults": {           // ④ 通用参数
    "temperature": 0.7,   //   温度：写作偏低、创意可调高
    "maxTokens": 4096,    //   单次输出上限（writer 阶段会覆盖为 8192）
    "maxProjectBytes": 200000,  //   项目素材总量上限（控制成本）
    "qualityThreshold": 80,     //   质量分阈值：低于则自动修复教程
    "maxFixRounds": 2,          //   阈值修复最大轮数
    "concurrency": 3,           //   章节并发撰写数（加速，注意限流）
    "metricsWeights": {         //   六维评分权重（总和应为 1）
      "structure": 0.25, "factual": 0.25, "format": 0.15,
      "density": 0.1,   "code": 0.1,    "review": 0.15
    },
    "costs": {                  //   成本估算表（¥/百万 token，用于 report 成本统计）
      "deepseek-chat":     { "inputPerMillion": 2,  "outputPerMillion": 8,  "currency": "¥" },
      "deepseek-reasoner": { "inputPerMillion": 4,  "outputPerMillion": 16, "currency": "¥" }
    }
  }
}
```

**想换分工？** 比如"扫描用便宜的、写作用强的、审查用最严的"，只需改 `roles`：

```jsonc
"roles": {
  "scanner":  { "provider": "deepseek", "model": "deepseek-chat" },  // 便宜快速
  "outliner": { "provider": "kimi",     "model": "moonshot-v1-8k" }, // 规划能力强
  "writer":   { "provider": "deepseek", "model": "deepseek-chat" },  // 长文稳定
  "reviewer": { "provider": "openai",   "model": "gpt-4o" }          // 审查严格
}
```

> **注意**：换用某个 provider 前，请确认对应的 `apiKeyEnv` 环境变量已设置（如 `OPENAI_API_KEY`）。

---

## 四、源码逐文件讲解（教学主线）

整个工程只有 8 个源码文件，按"从依赖到被依赖"的顺序读：

### 1. `src/env.js` — 极简 .env 加载器（~40 行）

**解决什么问题**：Node 默认不读 `.env` 文件。我们要让 API Key 既能从系统环境变量读、也能从项目根目录的 `.env` 文件读。

**核心逻辑**：读文件 → 逐行解析 `KEY=value`（支持引号包裹、跳过 `#` 注释）→ 写入 `process.env`（已有值不覆盖）。

**教学要点**：
- `loadEnv._loaded` 标记实现**幂等**，防止重复加载覆盖运行中的修改
- 用 `import.meta.url` 推导项目根目录，而不是写死相对路径（在任何目录运行都正确）

### 2. `src/config.js` — 配置加载与角色解析（~80 行）

**解决什么问题**：把 `config.json` 变成程序能用的对象，并且按角色查表，得到"这个角色该调哪个 URL、哪个模型、哪个 Key"。

**两个关键函数**：
- `loadConfig()`：读 JSON → 校验（`providers`/`roles` 必须存在、角色引用的 provider 必须已注册）→ 返回规范化配置
- `resolveRole(config, role)`：`roles[role] → providers[provider]` 两步查表，拼出 `{ baseURL, model, apiKey, temperature }`；Key 缺失时给出**明确的报错提示**

**教学要点**：`resolveRole` 是"多 LLM 分工"落地的地方——流水线每个阶段只调用 `resolveRole(config, "xxx")`，就自动拿到了该阶段专属的模型配置。

### 3. `src/llm.js` — 统一的 LLM 客户端（~130 行）

**解决什么问题**：所有 LLM 调用统一收口，保证错误处理和重试逻辑只有一份。

**核心逻辑**：
- 公共的 `requestCompletion()`：拼 URL、注入 Key、错误分级、指数退避重试
- `chat()`：纯文本对话（流水线四个阶段都用它）
- `chatVision()`：多模态调用（文本 + base64 图片，供视觉模型提取架构图）
- 错误分级：**401**（Key 无效，重试无用，直接抛错）/ **429**（限流）/ **5xx**（服务端）/ 超时/网络错误 → 指数退避重试（2s→4s→8s→16s，封顶 30s）

**教学要点**：这就是"**通用执行器**"思想的体现——不管后面接 DeepSeek、GPT 还是通义千问，流水线其它模块一行都不用改。

### 4. `src/prompts.js` — 提示词集中管理（"灵魂"）

**解决什么问题**：把"什么是一篇好教程"的定义沉淀成可复用的提示词资产，四阶段共享同一套标准。

**关键导出**：
- `WRITING_STYLE`：完美教程写作规范（认知递进 / 讲清取舍 / 实践导向 / 严谨准确 / 体系完整）
- `TUTORIAL_STRUCTURE`：7 章固定框架（每章的小节要求）
- `buildOutlinerSys(template)`：大纲系统提示词（支持自定义模板）
- `SCANNER_SYS` / `REVIEWER_SYS`：概况提取 / 质量审查的系统提示词
- 消息构建函数：`buildWriterUser()` 等

**教学要点**：对应 Agent 设计中的 **Skill 思想**——写作规范不散落在每次调用的 prompt 里，而是集中维护、按需注入。想调整教程风格，只改这一个文件。

### 5. `src/scanner.js` — 项目扫描（感知工具）

**解决什么问题**：把"一个项目目录"变成"一份喂给 LLM 的紧凑素材"，模拟人类的阅读顺序：README → 依赖清单 → 入口 → 源码。

**三个层次的设计**：
- **过滤**：`IGNORED_DIRS`（node_modules/.git/dist 等）、`IGNORED_EXTS`（二进制/锁文件）、`SENSITIVE_NAMES`（.env/密钥/证书）——对应"工具安全护栏"
- **排序**：`filePriority()` 按"README > 依赖清单 > 入口文件 > 越靠近根目录越优先"排序
- **限流**：最多 60 个文件、单文件截断 8000 字符、总素材上限 `maxProjectBytes`——控制 token 成本

### 6. `src/outliner.js` — 大纲生成

**核心逻辑**：项目概况 → LLM 生成 7 章大纲 JSON → `parseJsonLoose()` 宽松解析（容忍 ```json 围栏和前后杂字）→ `isValidOutline()` 结构校验 → 失败重试 3 次 → 仍失败则用 `TUTORIAL_STRUCTURE` 模板兜底。

**教学要点**：**先大纲后正文**是长文生成的黄金实践——"写什么"和"怎么写"分开决策，还让程序能校验 LLM 输出、失败可重试。

### 7. `src/writer.js` — 逐章撰写

**核心逻辑**：
- **每章一次独立调用**：上下文不超限，单章失败不影响其它章
- **断点续写**：`--resume` 时跳过已存在的章节文件（中断后接着写）
- **审查反馈循环**：收到 reviewer 的 `issues` 时，把意见注入提示词重写该章

**教学要点**：`fileExists()` 判断 + 跳过逻辑只有十几行，却让"跑一半断了"从灾难变成小事——这就是工程化的价值。

### 8. `src/reviewer.js` 与 `src/pipeline.js`

- `reviewer.js`：按质量清单（认知递进/概念清晰/实践可复现/取舍明确/结构完整/格式规范）让 LLM 打分，输出 JSON `{verdict, avg, issues}`；审查失败时**宁可放行也不阻塞**（审查失败 ≠ 内容错误）。每章得分会传给 metrics 作为「LLM 评审分」维度
- `pipeline.js`：把五个阶段串成产线。每阶段打印清晰日志；scanner 失败有兜底概况；最后本地拼 `index.md`（不消耗 LLM）

### 9. `src/metrics.js` — 量化指标计算器（纯本地、零 LLM）

把"质量"变成可复现的数字：结构完整度（大纲小节覆盖率）、格式规范度（标题跳级/代码块未闭合/表格列数/加粗配对 lint）、事实一致性（教程引用的文件路径与真实项目比对）、信息密度（章节字数与代码占比）。最后按权重合成 0-100 总分与 S/A/B/C 等级，并输出**按章节归类的可枚举问题清单**——这是阈值修复闭环的"弹药"。

**教学要点**：四个维度全部用正则/字符串规则实现，不消耗 token；reviewer 分和 verifier 分只是其中两个可选维度（未启用时自动归一化权重）。

### 10. `src/verifier.js` 与 `src/report.js`

- `verifier.js`（`--verify` 开启）：提取教程中的 bash/shell 代码块 → **危险命令过滤**（rm -rf/sudo/磁盘写入等）→ 环境设置命令跳过（export/cd）→ 在项目目录内真实执行（30s 超时）→ 统计可运行率。默认关闭，只有显式传 `--verify` 才执行
- `report.js`：把指标渲染成人类可读的 `report.md`（总分/等级/六维条形图/问题清单/验证结果/修复历史/与黄金样本对比）

### 11. 模板定制（`--template`）

`templates/lean.json` 是一个精简 4 章模板示例。模板 schema 与内置 7 章结构完全一致（`{chapters:[{index,title,sections}]}`），outliner 会严格按模板生成大纲，writer/reviewer/metrics 零改动即可适配。

---

## 五、从 0 复刻的实现顺序（8 步）

1. **骨架**：`package.json`（零依赖、`"type": "module"`）+ `.env.example`
2. **配置**：`env.js` → `config.js` → `config.json`
3. **发动机**：`llm.js`（先 curl 验证 API 连通，再写代码；视觉调用共用同一套重试逻辑）
4. **提示词与感知**：`prompts.js` → `scanner.js`（含图片收集，为视觉提取预留）
5. **规划**：`outliner.js`（含模板支持）
6. **生产与校验**：`writer.js` → `reviewer.js`
7. **量化闭环**：`metrics.js` → `verifier.js` → `report.js`（先单测：构造假章节验证扣分规则）
8. **编排**：`pipeline.js` → `cli.js` → 跑 demo 联调（`--verify`）→ 写文档

每步都可独立验证：`node --check src/xxx.js` 查语法，`node -e "import..."` 单测函数。

---

## 五b. Web 界面（src/web.js）

零依赖的本地 Web 界面（`node:http` + 原生前端）：提交生成任务 → 实时日志 → 结果文件查看 → mdbrowse 网页预览。

```bash
npm run web            # 或 node src/web.js [--port 8787]
# 浏览器打开 http://localhost:8787
```

- 左侧表单：项目目录（支持快捷选择 `benchmarks/samples` 样例）+ 受众/侧重/阈值 + 四个开关（验证/跳过审查/断点续写/关闭修复）
- 任务列表轮询状态；右侧实时日志滚动 + 结果文件（index/chapter/report/metrics）在线查看
- 「在浏览器中预览」按钮：在该任务输出目录拉起 mdbrowse，直接看渲染效果
- API：`POST /api/generate`、`GET /api/jobs/:id`、`GET /api/files/:id`、`GET /api/file/:id?path=xxx`、`POST /api/preview/:id`

> 实现要点：生成任务跑在**子进程**里（`spawn node src/cli.js`），stdout/stderr 流式收集进任务日志，前端 2s 轮询——零依赖、无需改流水线即可获得进度能力。

## 五c. 多模型对比（benchmarks/compare-models.js）

同一项目、同一流水线，换不同模型跑，量化「模型 → 质量 / 成本 / 耗时」权衡：

```bash
npm run compare                             # 默认 hello-cli + 3 种模型配置
node benchmarks/compare-models.js --project config-tool
node benchmarks/compare-models.js --models deepseek-chat,deepseek-reasoner
```

`benchmarks/models.json` 内置三种配置：`deepseek-chat`（标准）/ `deepseek-reasoner`（推理，慢贵）/ `chat+reasoner-review`（chat 写 + reasoner 评审的混合方案）。输出 `benchmarks/out/compare-<时间戳>/compare-report.md`：对比表 + 自动结论（质量最高 / 成本最低 / 性价比最高）。

**实测结果**（hello-cli，标准评测模式）：

| 模型配置 | 耗时 | 成本 | 完整度 | 可信度 | 质量分 |
| --- | --- | --- | --- | --- | --- |
| deepseek-chat | 5.8 min | ¥0.60 | 91.9 | 64.7 | 78.3 (B) |
| deepseek-reasoner | 20.5 min | ¥3.70 | 77.4 | **81.6** | 79.5 (B) |
| chat+reasoner-review | 20.1 min | ¥1.59 | **93.7** | 68.3 | **81.0 (A)** |

结论：reasoner 写内容更严谨（可信度最高）但慢且贵、完整度反而低；**reasoner 更适合当"裁判"（评审）而非"写手"**——混合方案用一半成本达到最高总分，这正支撑了工具默认的跨模型评审设计（writer=chat、reviewer=reasoner）。

---

## 六、进阶玩法

| 场景 | 做法 |
| --- | --- |
| 教程很长中途断了 | 重新运行加 `--resume`，已写好的章节自动跳过 |
| 想快速看效果 | `--skip-review` 跳过审查阶段，省一半调用 |
| 想让教程更贴合业务 | `--intro` / `--audience` / `--focus` 三个参数给足上下文 |
| 让教程命令真实可跑 | 加 `--verify`，失败的命令会进 report.md 待改进清单并触发修复 |
| 换成精简结构 | `--template ./templates/lean.json`（4 章） |
| 提高质量标准 | `--threshold 90`，低于 90 分自动修复 |
| 和"完美教程"对标 | 把参考教程的指标存成 metrics.json，用 `--baseline` 对比 |
| 接入新模型 | `providers` 加一条（baseURL + apiKeyEnv + defaultModel）即可 |
| 提取项目架构图 | `vision.enabled: true` 并配置 `DASHSCOPE_API_KEY`（DeepSeek 无视觉模型） |
| 网页版文档预览 | 加 `--browse [--port 4000]`，或手动 `npx --yes mdbrowse-cli <目录> --read-only` |
| 图形界面生成 | `npm run web` → http://localhost:8787（表单提交 + 实时日志 + 在线预览） |
| 选模型 | `npm run compare` 跑多模型对比（质量/成本/耗时权衡表） |
| 公网分享教程 | `npx --yes mdbrowse-cli <目录> --tunnel`（Cloudflare Tunnel） |
| 控制成本 | 调低 `maxProjectBytes`（扫描素材量）、用便宜的模型做 scanner/reviewer |
| 输出 PDF/HTML | 教程是标准 Markdown，用 pandoc / typora / mdbook 一键转换 |

---

## 七、常见问题（FAQ）

**Q：报错「找不到 DEEPSEEK_API_KEY 环境变量」？**
A：确认 `.env` 文件存在且格式为 `DEEPSEEK_API_KEY=sk-xxx`（无引号），或已在系统环境变量中设置。

**Q：某个阶段反复重试很慢？**
A：多为限流（429）。工具已做指数退避自动重试；仍失败可稍后再跑，用 `--resume` 接着来。

**Q：生成的教程章节风格不一致？**
A：`WRITING_STYLE` 会在每一章注入，且 reviewer 会兜底修正；想要更强的一致性，可以把 writer 全部章节放同一个模型并调低 temperature。

**Q：会读取到项目里的密钥吗？**
A：不会。`.env`、`.pem`、`id_rsa`、含 secret/credential/token 的文件名都会被过滤；且工具只读不写目标目录。

**Q：为什么 deepseek 的 baseURL 不带 /v1，openai 带？**
A：DeepSeek 官方兼容接口就是 `https://api.deepseek.com`（/chat/completions 直接在根路径）；OpenAI 则要求 `/v1/chat/completions`。按服务商文档填即可。

---

## 八、目录结构总览

```
tutorial-agent/
├── package.json          # 零依赖，Node ESM；npm test 跑单测
├── config.json           # providers + roles + vision + 阈值/权重/成本/并发
├── .env.example          # API Key 模板（复制为 .env 使用）
├── README.md             # 本文档（搭建讲解）
├── .github/workflows/ci.yml   # GitHub Actions：Node 18/20/22 矩阵测试
├── templates/
│   └── lean.json         # 精简 4 章模板示例（--template 使用）
├── benchmarks/
│   ├── projects.json     # 基准样例项目清单
│   ├── models.json       # 多模型对比的模型配置
│   ├── run.js            # 基准测试运行器（标准评测模式 + 百分位报告）
│   ├── compare-models.js # 多模型对比实验（质量/成本/耗时）
│   ├── compare-arch.js   # 架构对比实验（v1 流水线 vs v2 ReAct）
│   ├── samples/          # 3 个微型样例项目（hello-cli / http-server / config-tool）
│   └── out/              # 运行后生成 run-<ts>/ 与 compare-<ts>/ 报告
├── tests/                # 单元测试（node:test，18 个用例）
├── web/
│   └── index.html        # Web 界面前端（单文件，原生 JS）
├── output/               # 教程输出目录（运行后生成）
├── demo/                 # 示例项目（mini-notes，用于联调演示）
└── src/
    ├── cli.js            # 入口：参数解析 + 流水线编排
    ├── env.js            # 极简 .env 加载器
    ├── config.js         # 配置加载与角色/视觉解析
    ├── llm.js            # OpenAI 兼容 LLM 客户端（chat + chatVision + 用量记录）
    ├── prompts.js        # 完美教程写作规范 + 各阶段提示词（含模板支持）
    ├── scanner.js        # 阶段1：项目扫描、图片收集、视觉提取
    ├── outliner.js       # 阶段2：大纲生成（JSON 校验 + 模板 + 兜底）
    ├── writer.js         # 阶段3：逐章撰写（断点续写 + 并发）
    ├── reviewer.js       # 阶段4：质量审查（返回每章得分）
    ├── metrics.js        # 阶段5：双指标量化（完整度/可信度，零 LLM）
    ├── verifier.js       # 阶段5：真实验证（项目内命令计分 / 系统命令不计）
    ├── report.js         # 阶段5：渲染 report.md（含成本与验证明细）
    ├── usage.js          # token 用量与成本统计
    ├── browse.js         # 网页版文档预览（--browse，拉起 mdbrowse-cli）
    ├── web.js            # Web 界面服务器（任务队列 + 日志流 + 文件服务）
    ├── react/            # v2 ReAct 范式（--agent react）
    │   ├── engine.js     # 通用 Agent 循环：原生 function calling + 文本 JSON 回退
    │   └── tools.js      # 8 个工具（复用 v1 模块，Observation 截断防膨胀）
    ├── reproduce/        # v4 写作前复现（先把项目跑起来）
    │   ├── engine.js     # 复现 Agent（run_command 真实执行）
    │   └── tools.js      # 4 个工具（read_file/run_command 等）
    └── pipeline.js       # 五阶段流水线编排 + 阈值修复闭环 + meta.json 持久化
```

## 九、路线图（Roadmap）

> 已完成的版本演进：v1 确定性流水线 → v2 ReAct 自主循环 → v3 验证门控（踩坑回填）→ v4 写作前复现（命令白名单）→ v5 工程化（原生 function calling / 结构化输出 / 上下文缓存，实测可运行率 86.7%、质量 S 级、缓存命中 79.8%）。

### P1（下一个版本 v6，按序推进）

| # | 特性 | 目标 | 关键设计 | 验收标准 | 简历价值 |
| --- | --- | --- | --- | --- | --- |
| 1 | **代码沙箱**（--verify 隔离执行）✅ v6.1 | `--verify` 不再污染目标项目 | 复现+验证在临时副本执行（排除 node_modules/.git 等），跑完清理；清理失败仅告警不阻塞 | 验证后项目目录 `git status` 零改动，可运行率数据不变 | 工程安全硬实力 |
| 2 | **SSE 流式输出** | Web 界面实时看到章节逐字生成 | web.js 用 Server-Sent Events 推送 writer 进度 | 浏览器实时流式渲染，无轮询 | 现代 Web 技术栈 |
| 3 | **模型路由** | 同质量下成本再降 | scanner/outliner/复现用便宜模型；审查/难题失败自动升级 reasoner | 对比实测成本降幅 + 质量分不降 | 成本工程量化 |
| 4 | **RAG 素材检索** | 突破 200KB 素材上限，大项目可用 | 大项目启用 embedding 索引，writer 每章只检索相关片段 | 300KB+ 项目也能高质量生成 | 检索增强生成实战 |

### P2（按需）

- **跨章一致性检查**：修复第 3 章与第 6 章说法矛盾（一次 LLM pass，零 LLM 权重可复用 metrics）
- **教程配图生成**：架构图/流程图自动转 mermaid/SVG，提升可读性
- **Prompt Injection 防御**：项目 README 可能含恶意指令，素材中立化（5 分钟可加，安全红线）
- **参数级复现**：复现时把白名单命令的参数组合也实测一遍，消灭"list --search x"这类参数级错误

### 推进方式

- 每项独立成版本（v6.1 沙箱 → v6.2 SSE → ……），完成即推送 GitHub + 更新本表
- 每项都跑 demo 实测，用量化数据（可运行率/成本/缓存命中率）验收后收尾
