# dsh-cache-cost-monitor

DSH（DeepSeek Harness）v0.1.x 的 Cordis 插件：**自动监听每一轮 Agent 的模型 API 调用**，从流式响应中提取 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `completion_tokens`（经 DSH 适配器归一化为 provider 中立的 TokenUsage），实时统计：

- 单轮 / 累计缓存命中率
- 累计命中 / 未命中 / 输出 token 数
- 按官方定价（含峰谷时段）预估的 API 费用（美元 + 人民币）

并注册模型工具 **`cache_report`** 输出格式化统计报表（命中率趋势、成本明细、3 条针对性缓存优化建议）；命中率低于阈值时通过日志告警。浏览器端还在**每条助手消息末尾低调显示该轮 tokens 与人民币消耗**（如 `12.3K tokens · ¥0.0123`）。

基于 [Cordis](https://github.com/cordiverse/cordis) 插件内核（`@deepseek-ai/cordis` ^4.0.1），仅使用 DSH 公开的插件扩展能力（`llm/stream` 瀑布流、`tools` 服务、`sessionProjections` 能力缝、`conversation.chat.turnTail` 链式槽位）。

---

## 特性

| 能力 | 说明 |
| --- | --- |
| 自动监听 | 包装每一次 `llm/stream` 调用，从 `usage` chunk 提取 token 计数，透传全部 chunk，统计异常只记日志、绝不中断调用流 |
| 实时统计 | 单轮/累计命中率、累计 hit/miss/output tokens、按模型分桶、环形趋势窗口 |
| `cache_report` 工具 | 参数为标准 JSON Schema（`detail` / `limit`），官方 `validateJsonSchemaValue` 校验；输出 Markdown 报表（累计统计、趋势表、逐轮明细、按模型成本、3 条优化建议） |
| 阈值告警 | 单轮命中率低于 `threshold` 输出 warn；累计命中率低于 `cumulativeThreshold` 在状态翻转时提示一次（防刷屏） |
| 消息末尾页脚 | 每段已结束的助手消息下方低调显示 `tokens · ¥费用`，hover 可见命中/未命中/输出明细与命中率；无数据时渲染 null |
| 优雅降级 | API 字段缺失、无定价、投影/工具注册失败均不崩溃主程序 |

---

## 项目结构

```
dsh-cache-cost-monitor/
├── package.json          # 包清单：dsh.bundle.patch + dsh.client（规范要求的 bundle 声明）
├── cordis.patch.yml      # bundle 补丁：注入宿主插件行 + 配置（定价/阈值/币种）
├── src/
│   ├── index.ts          # 宿主插件：监听/统计/cache_report/投影/告警（ESM）
│   └── client.ts         # 浏览器端：turnTail 页脚（经 tsdown 构建为 web2 client bundle）
├── test/smoke.mjs        # 端到端冒烟测试（假 ctx 驱动，不依赖真实 DSH）
├── scripts/
│   ├── install-profile.ps1   # 一键安装脚本（构建+测试+安装+校验）
│   └── deploy-live.ps1       # （已弃用）旧版热部署脚本，见文件内说明
├── tsconfig.json         # 宿主构建（tsc → lib/index.js + d.ts）
└── tsdown.config.ts      # 客户端构建（tsdown → lib/client.js）
```

---

## 安装

### 前置要求

- Node.js >= 18（推荐 20+）
- pnpm（DSH 的 `dsh plugin` 命令转发给 pnpm；可用 `corepack enable` 或 `npm i -g pnpm` 安装）
- DSH v0.1.x（本版本针对 `0.1.0-rc.6` 开发验证，见[兼容性](#兼容性)）

### 步骤

```powershell
# 1. 在插件目录安装依赖、构建、跑冒烟测试
cd F:\dsh_project\github_about\2026.8.16\dsh-cache-cost-monitor
npm install
npm run build
npm test                    # 全部 PASS

# 2. 安装进 profile（web 即你正在使用的浏览器 profile），
#    必须传绝对路径；DSH 会 pnpm add 该目录并把包加入 dsh.profile.bundles 层栈
#    （Windows 请保留 --config.node-linker=isolated，见下方“Windows 说明”）
dsh plugin --profile web add F:\dsh_project\github_about\2026.8.16\dsh-cache-cost-monitor --config.node-linker=isolated

# 3. 校验组合树已包含插件行
dsh --profile web --dump-config | findstr cache-cost-monitor

# 4. 重启 DSH 生效
dsh web
```

也可以直接跑一键脚本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-profile.ps1
```

> 说明：`dsh plugin add` 通过 pnpm 把插件以 `file:` 依赖安装进
> `%DSH_HOME%\profiles\<name>\node_modules` 并 reconcile 到 bundles 列表；
> 插件在 `package.json` 中声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": {...} }`，
> 因此 profile 组合器会把它作为一层插入组合树，同时客户端模块扫描器会加载 `./client` 页脚。
> 每次修改代码后重新 `npm run build` 即可（file: 链接指向真实目录，无需重装），重启 DSH 生效。

> **Windows 说明**：pnpm 在 workspace 模式下对“盘符绝对路径”创建 junction 存在 bug
> （会把 `F:/...` 当相对路径拼到 profile 目录下，导致链接失效、启动校验报
> `declares no dsh.bundle`）。安装 / 移除时请始终附带
> `--config.node-linker=isolated`，pnpm 会改用 isolated linker 正确创建链接；
> 其他平台该参数无副作用。

### 卸载

```powershell
dsh plugin --profile web remove dsh-cache-cost-monitor --config.node-linker=isolated
# 可选：清理 profile 依赖
dsh plugin --profile web install --config.node-linker=isolated
```

---

## 使用

### 1. `cache_report` 工具

安装重启后，Agent 的工具列表会自动出现 `cache_report`。直接对它说"调用 cache_report"即可，报表形如：

```markdown
# 缓存命中率与成本报告（cache_report）

## 累计统计
- 模型调用次数：12
- 累计缓存命中率：68.4%
- 累计命中 tokens：86,120
- 累计未命中 tokens：39,760
- 累计输出 tokens：23,410
- 预估 API 总费用：$0.0312（¥0.2122）

## 命中率趋势（最近 5 轮）
| 轮次 | 模型 | 命中 tokens | 未命中 tokens | 输出 tokens | 单轮命中率 | 单轮费用 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | deepseek-v4-flash | 18,200 | 3,100 | 2,010 | 85.4% | $0.0019（¥0.0129） |
...

## 成本明细（按模型）
| 模型 | 调用次数 | 命中 tokens | 未命中 tokens | 输出 tokens | 命中率 | 预估费用 |
...

## 缓存优化建议
1. ...
2. ...
3. ...
```

可选参数：`{ "detail": true, "limit": 10 }` 输出逐轮明细（含提供方、计价档位 PEAK/OFF-PEAK、时间戳、实际单价）。

### 2. 消息末尾页脚

每条已结束的助手消息下方会显示一行小字（次级色、低透明度，hover 可看明细）：

```
本轮 12.3K tokens · ¥0.0123
```

- 只统计**插件安装之后**、且 API 响应携带 usage 的轮次；
- 某轮产出了文件时（官方 "Produced" 行占位），本页脚自动让位，不叠加显示。

### 3. 日志告警

命中率低于阈值时在 DSH 日志中输出：

```
[cache-monitor] 单轮缓存命中率告警：本轮 10.0% < 阈值 30.0%（provider=deepseek model=deepseek-reasoner，命中=1,000 未命中=9,000 输出=1,200）
[cache-monitor] 累计缓存命中率告警：累计 20.1% < 阈值 30.0%（累计调用 8 次，命中=16,000 未命中=63,600）
```

---

## 配置参考（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `threshold` | `0.3` | 单轮缓存命中率告警阈值（0~1） |
| `cumulativeThreshold` | `0.3` | 累计缓存命中率告警阈值（0~1），状态翻转时提示一次 |
| `historySize` | `20` | 趋势窗口轮数（>= 2） |
| `warnOnMissingUsage` | `true` | 响应缺 usage 字段时是否输出 debug 日志 |
| `timeBilling` | `auto` | 峰谷计价：`auto`（高峰 UTC 00:30–16:30，非高峰为其半价）/ `peak` / `off-peak` |
| `currency` | `both` | 费用显示：`USD` / `CNY` / `both` |
| `usdCnyRate` | `6.8` | 美元→人民币汇率 |
| `pricing` | 见下 | 按模型 ID 的定价表（USD / 每百万 tokens） |

内置定价（`cacheHit` / `cacheMiss` / `output`，USD / 1M tokens）：

| 模型 | OFF-PEAK 非高峰 | PEAK 高峰 |
| --- | --- | --- |
| deepseek-v4-flash | 0.007 / 0.22 / 0.66 | 0.014 / 0.44 / 1.32 |
| deepseek-v4-pro | 0.022 / 0.66 / 1.98 | 0.044 / 1.32 / 3.96 |
| deepseek-chat | 0.028 / 0.28 / 0.42 | — |
| deepseek-reasoner | 0.14 / 0.55 / 2.19 | — |

未配置的模型按 0 计费并在报表中标注；`deepseek-v4-*` 变体按前缀回退到对应系列定价。官方调价后直接在 `cordis.patch.yml` 的 `config.pricing` 覆盖即可（补丁按层合并、后写胜出）。

---

## 兼容性

| 项 | 版本 |
| --- | --- |
| DSH | `0.1.x`（针对 `0.1.0-rc.6` 验证） |
| Cordis | `@deepseek-ai/cordis` ^4.0.1 |
| 运行时依赖 | `@deepseek-ai/dsh-tools` ^0.1.0-rc.6、`zod` ^4 |
| 宿主 API | `llm/stream` 瀑布流、`ctx.tools.register`、`ctx.sessionProjections.register`（`assistant/message` + `usage`） |
| 客户端 API | `dsh.client` 声明、`exports["./client"]`、`conversation.chat.turnTail` 链式槽位、标准 prop `useProjection` |
| Node | >= 18（ESM 产物，DSH loader 动态 import） |

**bundle 声明（v0.2.0 修复重点）**：`package.json` 必须同时声明
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": [...], "platform": "web" } }`。
缺少 `dsh.bundle` 字段的第三方插件会在新版 DSH 启动校验时被拒绝（
`profile bundle <name> declares no dsh.bundle in its package.json`）。
本包已按该规范构建，可通过 `dsh plugin add` 正常安装。

---

## 已知限制

1. **进程内统计**：`cache_report` 的累计数据只存活于当前 DSH 进程（插件 fiber），重启后归零；消息页脚数据来自会话投影（随会话落库，重启后仍可回放）。
2. **页脚与 Produced 行共存**：`turnTail` 是单胜出链式槽位，官方 `ui-deliverables` 先注册；产出了文件的轮次由 "Produced" 行占位，该轮页脚不显示。
3. **费用为估算**：按配置定价 × 实际 token 数计算，不含折扣、错误重试、上游网关加价；未配置定价的模型按 0 计。
4. **峰谷时段**：`auto` 模式按官方高峰时段（UTC 00:30–16:30）判定，以**调用发生时刻**（usage chunk 到达时间）为准；如需强制某档可设 `timeBilling: peak|off-peak`。
5. **页脚不回溯**：插件安装前的历史轮次没有 usage 投影数据，不显示页脚。
6. **仅统计携带 usage 的调用**：上游未返回 usage 的响应（如某些错误/重试路径）不计入统计，`warnOnMissingUsage` 可控制调试日志。

---

## 开发

```powershell
npm run build     # tsc 构建宿主（lib/index.js + d.ts）+ tsdown 构建客户端（lib/client.js）
npm test          # 冒烟测试（node test/smoke.mjs，需先 build）
```

- 宿主逻辑为纯 ESM，可脱离 DSH 用 `test/smoke.mjs` 的假 ctx 驱动验证；
- 客户端组件使用 `React.createElement`，平台模块（react / cordis / slots 等）由 shell 模块表提供，其余依赖全部内联；
- 修改后重新 `npm run build`，重启 DSH 生效。

## License

MIT
