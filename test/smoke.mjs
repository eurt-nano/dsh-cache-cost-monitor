/**
 * dsh-cache-cost-monitor 端到端冒烟测试（不依赖真实 DSH 运行时）。
 *
 * 用最小假 ctx 驱动插件 apply()，模拟 llm/stream chunk 流，验证：
 * 1. usage 统计与单轮/累计命中率计算
 * 2. cache_report 工具注册与参数校验、报表内容
 * 3. 阈值告警日志
 * 4. usage 缺失时的优雅降级
 * 5. 峰谷计价（peak/off-peak 档）与人民币显示
 *
 * 运行：node test/smoke.mjs（先执行 npm run build）
 */

import plugin from '../lib/index.js'

/** 构造最小假 ctx。 */
function makeFakeCtx(extraServices = {}) {
  const listeners = {}
  const tools = []
  const warnLogs = []
  const debugLogs = []
  const errorLogs = []
  const logger = {
    info() {},
    warn(...args) { warnLogs.push(args) },
    error(...args) { errorLogs.push(args) },
    debug(...args) { debugLogs.push(args) },
  }
  return {
    listeners,
    tools,
    warnLogs,
    debugLogs,
    errorLogs,
    ctx: {
      logger: () => logger,
      get: (name) => extraServices[name],
      on(name, listener) { listeners[name] = listener; return () => {} },
      effect(callback) { const disposer = callback(); return () => { if (typeof disposer === 'function') disposer() } },
      get tools() { return { register(definition) { tools.push(definition); return () => {} } } },
    },
  }
}

/** 构造一次模型调用的 chunk 源。 */
async function* chunksOf(usage) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'ok' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

let failures = 0
function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${label}`)
  }
}

// —— 组装插件实例 ——
const fake = makeFakeCtx()
const defaultConfig = plugin.Config['~standard'].validate(undefined).value
assert(defaultConfig.usdCnyRate === 6.8, '默认汇率为 6.8（随官方汇率更新）')
assert(defaultConfig.pricing['deepseek-v4-pro'] !== undefined, '默认定价包含 deepseek-v4-pro')
assert(defaultConfig.pricing['deepseek-v4-flash']?.peak !== undefined, '默认定价包含 v4-flash 峰谷档')
const config = plugin.Config['~standard'].validate({
  threshold: 0.5,          // 单轮告警阈值调高，便于触发
  cumulativeThreshold: 0.4,
  historySize: 10,
  pricing: {
    'deepseek-chat': { cacheHit: 0.028, cacheMiss: 0.28, output: 0.42 },
    'deepseek-reasoner': { cacheHit: 0.14, cacheMiss: 0.55, output: 2.19 },
  },
}).value

plugin.apply(fake.ctx, config)
const listener = fake.listeners['llm/stream']
const tool = fake.tools[0]

// —— 1. 模拟 3 轮调用：两轮高命中、一轮低命中 ——
const rounds = [
  { provider: 'deepseek', model: 'deepseek-chat', usage: { inputTokens: 3000, cacheReadTokens: 7000, outputTokens: 500 } },   // 70%
  { provider: 'deepseek', model: 'deepseek-chat', usage: { inputTokens: 2000, cacheReadTokens: 8000, outputTokens: 400 } },   // 80%
  { provider: 'deepseek', model: 'deepseek-reasoner', usage: { inputTokens: 9000, cacheReadTokens: 1000, outputTokens: 1200 } }, // 10% → 单轮告警
]

for (const round of rounds) {
  const stream = listener({ provider: round.provider, model: round.model }, () => chunksOf(round.usage))
  let chunks = 0
  for await (const chunk of stream) chunks += 1
  assert(chunks === 5, `chunk 透传完整（${round.model}: ${chunks} 个 chunk）`)
}
assert(fake.errorLogs.length === 0, '统计过程无错误日志')

// —— 2. 工具调用：无参数 ——
const result = await tool.execute({})
assert(result.ok === true, 'cache_report 无参调用成功')
const report = result.text
assert(report.includes('累计缓存命中率：53.3%'), `累计命中率正确（实际: ${report.match(/累计缓存命中率：[^ ]+/)?.[0] ?? '未找到'}`)
assert(report.includes('累计命中 tokens：16,000'), '累计命中 tokens 正确')
assert(report.includes('累计未命中 tokens：14,000'), '累计未命中 tokens 正确')
assert(report.includes('累计输出 tokens：2,100'), '累计输出 tokens 正确')
assert(report.includes('deepseek-chat') && report.includes('deepseek-reasoner'), '成本明细包含两个模型')
assert(report.includes('缓存优化建议') && (report.match(/^[123]\./gm)?.length ?? 0) >= 3, '报表包含 3 条优化建议')
assert(report.includes('单轮命中率'), '趋势表存在')

// —— 3. 参数校验 ——
const bad = await tool.execute({ limit: 'abc' })
assert(bad.ok === false && bad.text.includes('参数校验失败'), '非法参数被拒绝')
const limited = await tool.execute({ limit: 2, detail: true })
assert(limited.ok === true && limited.text.includes('逐轮明细'), 'detail/limit 参数生效')

// —— 4. 告警 ——
const roundWarn = fake.warnLogs.some(([msg]) => String(msg).includes('单轮缓存命中率告警'))
assert(roundWarn, '低命中率轮触发单轮告警（10% < 50%）')
const cumWarn = fake.warnLogs.some(([msg]) => String(msg).includes('累计缓存命中率告警'))
assert(!cumWarn, '累计命中率 53.3% 未低于阈值 40%，不应触发累计告警')

// —— 5. 优雅降级：usage 块存在但无可用计数字段 ——
const beforeDebug = fake.debugLogs.length
const silent = listener({ provider: 'deepseek', model: 'deepseek-chat' }, () => chunksOf({}))
for await (const _ of silent) { /* 消费完 */ }
assert(fake.debugLogs.length === beforeDebug + 1, '缺失 usage 字段时输出 debug 日志')
const r2 = await tool.execute({})
assert(r2.ok === true && r2.text.includes('模型调用次数：3'), '无 usage 字段的轮不计入统计（仍为 3 次）')

// —— 6. 峰谷计价与双币种 ——
const V4 = {
  'deepseek-v4-flash': {
    cacheHit: 0.007, cacheMiss: 0.22, output: 0.66,
    peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
  },
  'deepseek-v4-pro': {
    cacheHit: 0.022, cacheMiss: 0.66, output: 1.98,
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
  },
}
/** 模拟一次 v4-flash 调用（1M 未命中输入，其余为 0 → 费用 = 未命中单价）。 */
async function runV4(cfg, model = 'deepseek-v4-flash') {
  const instance = makeFakeCtx()
  const resolved = plugin.Config['~standard'].validate(cfg).value
  plugin.apply(instance.ctx, resolved)
  const listenerFn = instance.listeners['llm/stream']
  const stream = listenerFn({ provider: 'deepseek', model }, () => chunksOf({ inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }))
  for await (const _ of stream) { /* 消费完 */ }
  return { instance, report: (await instance.tools[0].execute({})).text }
}

// 6a. 强制非高峰：1M 未命中 → 0.22 USD
const offPeak = await runV4({ pricing: V4, timeBilling: 'off-peak', currency: 'both', usdCnyRate: 7.2 })
assert(offPeak.report.includes('$0.2200'), `非高峰价 0.22 USD 生效（实际含: ${offPeak.report.match(/预估 API 总费用：[^\n]+/)?.[0] ?? '未找到'}`)
assert(offPeak.report.includes('¥1.58'), '双币种显示人民币（0.22 × 7.2 = 1.584 → ¥1.58）')

// 6b. 强制高峰：1M 未命中 → 0.44 USD
const peak = await runV4({ pricing: V4, timeBilling: 'peak', currency: 'USD' })
assert(peak.report.includes('$0.4400'), '高峰价 0.44 USD 生效')
assert(!peak.report.includes('¥'), '单币种 USD 模式不显示人民币')

// 6c. 仅人民币模式
const cny = await runV4({ pricing: V4, timeBilling: 'off-peak', currency: 'CNY', usdCnyRate: 7.0 })
assert(cny.report.includes('¥1.54'), '仅人民币模式显示 ¥（0.22 × 7.0 = 1.54）')
assert(!cny.report.includes('$'), '仅人民币模式不显示美元符号')

// 6d. 逐轮明细含计价档位与单价
const detailReport = await offPeak.instance.tools[0].execute({ detail: true, limit: 5 })
assert(detailReport.text.includes('tier=OFF-PEAK'), '明细含计价档位 OFF-PEAK')
assert(detailReport.text.includes('unit(hit/miss/out)=0.007/0.22/0.66'), '明细含实际单价')

// 6e. auto 模式档位判定（由 Date.now() 决定档位；强制档位语义由 6a/6b 覆盖）
const autoCfg = plugin.Config['~standard'].validate({ pricing: V4, timeBilling: 'auto' }).value
{
  const instance = makeFakeCtx()
  plugin.apply(instance.ctx, autoCfg)
  const listenerFn = instance.listeners['llm/stream']
  const stream = listenerFn({ provider: 'deepseek', model: 'deepseek-v4-flash' }, () => chunksOf({ inputTokens: 1_000_000 }))
  for await (const _ of stream) { /* 消费完 */ }
  const text = (await instance.tools[0].execute({ detail: true })).text
  const tier = text.match(/tier=([A-Z-]+)/)?.[1]
  assert(tier === 'PEAK' || tier === 'OFF-PEAK', `auto 模式输出合法档位（实际: ${tier}）`)
}

// —— 7. deepseek-v4-pro 定价与前缀回退 ——
// 7a. v4-pro 非高峰：1M 未命中 → 0.66 USD
const proOff = await runV4({ pricing: V4, timeBilling: 'off-peak', currency: 'USD' }, 'deepseek-v4-pro')
assert(proOff.report.includes('$0.6600'), `v4-pro 非高峰价 0.66 USD 生效（实际含: ${proOff.report.match(/预估 API 总费用：[^\n]+/)?.[0] ?? '未找到'}`)

// 7b. v4-pro 高峰：1M 未命中 → 1.32 USD（>= 1 时保留 2 位小数）
const proPeak = await runV4({ pricing: V4, timeBilling: 'peak', currency: 'USD' }, 'deepseek-v4-pro')
assert(proPeak.report.includes('$1.32'), 'v4-pro 高峰价 1.32 USD 生效')

// 7c. v4-pro 变体前缀回退（deepseek-v4-pro-0731 → v4-pro 定价，而非 v4-flash）
const proVariant = await runV4({ pricing: V4, timeBilling: 'off-peak', currency: 'USD' }, 'deepseek-v4-pro-0731')
assert(proVariant.report.includes('$0.6600'), 'deepseek-v4-pro-* 前缀回退到 v4-pro 定价（0.66 而非 0.22）')

// 7d. v4-flash 变体前缀回退仍正确（deepseek-v4-flash-20260423 → v4-flash 定价）
const flashVariant = await runV4({ pricing: V4, timeBilling: 'off-peak', currency: 'USD' }, 'deepseek-v4-flash-20260423')
assert(flashVariant.report.includes('$0.2200'), 'deepseek-v4-flash-* 前缀回退到 v4-flash 定价（0.22）')

// —— 8. 轮末用量投影单元（sessionProjections 能力缝） ——
let projectionDef
const projFake = makeFakeCtx({
  sessionProjections: {
    register: (def) => { projectionDef = def; return () => {} },
  },
})
const projConfig = plugin.Config['~standard'].validate({
  pricing: V4, timeBilling: 'off-peak', currency: 'both', usdCnyRate: 7.2,
}).value
plugin.apply(projFake.ctx, projConfig)
assert(projectionDef !== undefined && projectionDef.key === 'cacheCost', '注册 cacheCost 投影单元')

// 8a. 纯折叠：多个 assistant/message 事件按 turn 聚合
const assistantEvent = (turn, hit, miss, out, model = 'deepseek-v4-flash', time = 0) => ({
  type: 'assistant/message', time,
  data: {
    turn, step: 0,
    message: { role: 'assistant', id: 'm', content: [], source: { kind: 'model', provider: 'deepseek', model } },
    usage: { inputTokens: miss, cacheReadTokens: hit, outputTokens: out },
  },
})
let projState = projectionDef.init()
projState = projectionDef.apply(projState, assistantEvent(1, 1000, 500, 200))
projState = projectionDef.apply(projState, assistantEvent(1, 2000, 300, 100))
projState = projectionDef.apply(projState, assistantEvent(2, 0, 1_000_000, 0))
const view = projectionDef.view(projState)
assert(view.turns['1'].hit === 3000 && view.turns['1'].miss === 800 && view.turns['1'].output === 300, 'turn 1 聚合正确（hit=3000 miss=800 out=300）')
assert(Math.abs(view.turns['1'].hitRate - 3000 / 3800) < 1e-6, 'turn 1 命中率正确')
// 非高峰 flash 计价：3000×0.007 + 800×0.22 + 300×0.66（/1e6）
assert(Math.abs(view.turns['1'].costUsd - (3000 * 0.007 + 800 * 0.22 + 300 * 0.66) / 1e6) < 1e-9, 'turn 1 美元费用正确')
assert(Math.abs(view.turns['1'].costCny - (3000 * 0.007 + 800 * 0.22 + 300 * 0.66) / 1e6 * 7.2) < 1e-9, 'turn 1 人民币费用正确')
assert(Math.abs(view.turns['2'].costUsd - 0.22) < 1e-9, 'turn 2 费用正确（1M 未命中 × 0.22）')

// 8b. 无关事件返回同一状态引用（零下游工作）
const untouched = {}
assert(projectionDef.apply(untouched, { type: 'user/message', time: 0, data: {} }) === untouched, '无关事件返回原状态引用')

// 8c. 无 usage 的 assistant/message 不产生状态
const noUsage = projectionDef.apply({}, { type: 'assistant/message', time: 0, data: { turn: 1, step: 0, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } } } })
assert(Object.keys(noUsage).length === 0, '无 usage 事件不产生状态')

// 8d. 视图通过 Zod schema（wire 校验）
const parsed = projectionDef.schema.safeParse(view)
assert(parsed.success === true, '投影视图通过 Zod schema 校验')

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
process.exit(failures === 0 ? 0 : 1)
