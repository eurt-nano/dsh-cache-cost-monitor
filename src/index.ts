/**
 * dsh-cache-cost-monitor
 *
 * DSH (DeepSeek Harness) v0.1.x Cordis 插件：自动监听每一轮 Agent 的模型 API 调用，
 * 从流式响应中提取缓存命中 / 未命中 / 输出 token 计数，实时统计单轮与累计
 * 缓存命中率、累计 token 数与按官方定价（含峰谷时段）预估的 API 费用；注册
 * `cache_report` 工具输出格式化统计报表（含命中率趋势、成本明细与 3 条针对性
 * 优化建议），并在命中率低于配置阈值时通过日志告警。浏览器端另见 src/client.ts
 * （在每条消息末尾低调显示本轮 tokens 与人民币消耗）。
 *
 * 实现要点（仅使用 DSH 公开扩展能力）：
 * - 通过 `llm/stream` 瀑布流事件包装每次模型调用（与官方插件相同的监听模式），
 *   从 `usage` chunk 读取 provider 中立的 TokenUsage：
 *     cacheReadTokens ← DeepSeek prompt_cache_hit_tokens
 *     inputTokens     ← prompt_cache_miss_tokens（适配器已剔除命中部分）
 *     outputTokens    ← completion_tokens
 *   （字段映射见 @deepseek-ai/dsh-llm-deepseek 的 mapUsage。）
 * - 通过 `tools` 服务注册模型可见工具 `cache_report`：参数为标准 JSON Schema，
 *   执行时使用官方 `validateJsonSchemaValue` 做参数校验。
 * - 通过 `sessionProjections` 能力缝注册轮末用量投影 `cacheCost`：纯折叠
 *   `assistant/message` 事件（其 usage 随模型输出一起落库），产出每轮
 *   tokens / 费用（USD 与 CNY）/ 命中率，供客户端轮末页脚读取。
 * - 插件配置用 StandardSchemaV1（Cordis 4 内核的配置校验标准）声明并归一化。
 *
 * 兼容性：@deepseek-ai/cordis ^4.0.1、@deepseek-ai/dsh-llm ^0.1.0、
 * @deepseek-ai/dsh-session-projection ^0.1.0、Node >= 18。产物为 ESM
 * （DSH loader 通过动态 import 加载插件包主入口）。
 */

// ============================================================================
// 依赖（类型导入在编译期擦除，不产生运行时依赖）
// ============================================================================

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { ContentBlock, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import { z } from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'

// ============================================================================
// 配置类型与默认值
// ============================================================================

/** 一组价格（美元 / 每百万 tokens）。 */
export interface PriceRates {
  /** 缓存命中输入单价 */
  cacheHit: number
  /** 未命中输入单价 */
  cacheMiss: number
  /** 输出单价 */
  output: number
}

/**
 * 单个模型的定价（美元 / 每百万 tokens）。
 * 基础字段为非高峰（默认）单价；提供 `peak` 后按 `timeBilling` 生效峰谷计价。
 */
export interface PriceEntry extends PriceRates {
  /** 高峰时段单价（可选；官方峰谷方案下通常为基础价 × 2） */
  peak?: PriceRates
}

/** 峰谷计价模式。 */
export type TimeBillingMode = 'auto' | 'peak' | 'off-peak'

/** 报表货币显示。 */
export type CurrencyMode = 'USD' | 'CNY' | 'both'

/** 缓存健康度评级（基于累计命中率）。 */
export interface HealthGrade {
  grade: 'S' | 'A' | 'B' | 'C' | 'D'
  emoji: '🟢' | '🟡' | '🟠' | '🔴'
}

/** 插件配置（经 StandardSchemaV1 校验与归一化后传入 apply）。 */
export interface CacheMonitorConfig {
  /** 单轮缓存命中率告警阈值（0~1），低于该值输出 warn 日志 */
  threshold: number
  /** 累计缓存命中率告警阈值（0~1），低于该值输出 warn 日志（状态翻转时提示一次） */
  cumulativeThreshold: number
  /** 命中率趋势窗口（保留最近 N 轮样本），最小为 2 */
  historySize: number
  /** 调用未携带 usage 数据时是否输出 debug 日志 */
  warnOnMissingUsage: boolean
  /** 峰谷计价：auto 按官方时段自动判定（高峰 UTC 00:30–16:30），peak/off-peak 强制按档计价 */
  timeBilling: TimeBillingMode
  /** 费用显示币种：USD / CNY / both（默认 both，美元 + 人民币） */
  currency: CurrencyMode
  /** 美元→人民币换算汇率（仅影响人民币显示，默认 6.8，可覆盖） */
  usdCnyRate: number
  /** 按模型 ID 的定价表；未配置的模型按 0 计费并在报表中标注 */
  pricing: Record<string, PriceEntry>
  /** 累计费用预算（USD，可选）：超出后输出 warn 告警并在报表中标注；缺省不设预算 */
  budgetUsd?: number
}

/**
 * DeepSeek 官方定价（USD / 1M tokens，来源：
 * https://api-docs.deepseek.com/quick_start/pricing/）。
 * - deepseek-chat / deepseek-reasoner：标准时段价格（峰谷自动优惠未建模）。
 * - deepseek-v4-flash / deepseek-v4-pro：官方峰谷定价，基础价 = 非高峰
 *   （OFF-PEAK），peak = 高峰（PEAK，为非高峰的 2 倍）；
 *   高峰时段为 UTC 00:30–16:30。
 * 价格会随官方调整变化，可在 cordis.patch.yml 的 config.pricing 中覆盖。
 */
const OFFICIAL_PRICING: Record<string, PriceEntry> = {
  'deepseek-chat': { cacheHit: 0.028, cacheMiss: 0.28, output: 0.42 },
  'deepseek-reasoner': { cacheHit: 0.14, cacheMiss: 0.55, output: 2.19 },
  'deepseek-v4-flash': {
    cacheHit: 0.007,
    cacheMiss: 0.22,
    output: 0.66,
    peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
  },
  'deepseek-v4-pro': {
    cacheHit: 0.022,
    cacheMiss: 0.66,
    output: 1.98,
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
  },
}

/** 配置默认值。 */
const DEFAULT_CONFIG: CacheMonitorConfig = {
  threshold: 0.3,
  cumulativeThreshold: 0.3,
  historySize: 20,
  warnOnMissingUsage: true,
  timeBilling: 'auto',
  currency: 'both',
  usdCnyRate: 6.8,
  pricing: OFFICIAL_PRICING,
}
// ============================================================================
// 通用工具函数
// ============================================================================

/** 判断一个值是否为普通 JSON 对象（非数组、非 null）。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取非负有限数；缺省/非法时回退到默认值并记录 issue。 */
function readCount(raw: unknown, fallback: number, path: readonly string[], issues: StandardSchemaV1.Issue[]): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    issues.push({ message: `应为有限数字，收到 ${JSON.stringify(raw)}`, path: [...path] })
    return fallback
  }
  return raw
}

/** 读取整数；缺省/非法时回退到默认值并记录 issue。 */
function readInteger(raw: unknown, fallback: number, path: readonly string[], issues: StandardSchemaV1.Issue[]): number {
  const value = readCount(raw, fallback, path, issues)
  if (raw !== undefined && (typeof raw !== 'number' || !Number.isInteger(raw))) {
    issues.push({ message: `应为整数，收到 ${JSON.stringify(raw)}`, path: [...path] })
    return fallback
  }
  return value
}

/** 读取布尔值；缺省/非法时回退到默认值。 */
function readBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

/**
 * 配置校验器（StandardSchemaV1，Cordis 4 内核 `resolveConfig` 直接消费）。
 * 归一化 + 校验：类型错误记录 issue（插件行加载失败并给出清晰报错），
 * 合法输入输出完全归一化后的配置对象。
 */
const CONFIG_SCHEMA: StandardSchemaV1<unknown, CacheMonitorConfig> = {
  '~standard': {
    version: 1,
    vendor: 'dsh-cache-cost-monitor',
    validate(value: unknown): StandardSchemaV1.Result<CacheMonitorConfig> {
      const issues: StandardSchemaV1.Issue[] = []
      const raw = isPlainRecord(value) ? value : {}

      const threshold = readCount(raw.threshold, DEFAULT_CONFIG.threshold, ['threshold'], issues)
      const cumulativeThreshold = readCount(raw.cumulativeThreshold, DEFAULT_CONFIG.cumulativeThreshold, ['cumulativeThreshold'], issues)
      const historySize = readInteger(raw.historySize, DEFAULT_CONFIG.historySize, ['historySize'], issues)
      const warnOnMissingUsage = readBoolean(raw.warnOnMissingUsage, DEFAULT_CONFIG.warnOnMissingUsage)
      const usdCnyRate = readCount(raw.usdCnyRate, DEFAULT_CONFIG.usdCnyRate, ['usdCnyRate'], issues)

      // 峰谷计价模式与货币显示
      const timeBilling: TimeBillingMode = raw.timeBilling === 'peak' || raw.timeBilling === 'off-peak' || raw.timeBilling === 'auto'
        ? raw.timeBilling
        : raw.timeBilling === undefined
          ? DEFAULT_CONFIG.timeBilling
          : (() => { issues.push({ message: `timeBilling 应为 auto/peak/off-peak，收到 ${JSON.stringify(raw.timeBilling)}`, path: ['timeBilling'] }); return DEFAULT_CONFIG.timeBilling })()
      const currency: CurrencyMode = raw.currency === 'USD' || raw.currency === 'CNY' || raw.currency === 'both'
        ? raw.currency
        : raw.currency === undefined
          ? DEFAULT_CONFIG.currency
          : (() => { issues.push({ message: `currency 应为 USD/CNY/both，收到 ${JSON.stringify(raw.currency)}`, path: ['currency'] }); return DEFAULT_CONFIG.currency })()

      if (threshold < 0 || threshold > 1) issues.push({ message: 'threshold 必须在 0~1 之间', path: ['threshold'] })
      if (cumulativeThreshold < 0 || cumulativeThreshold > 1) {
        issues.push({ message: 'cumulativeThreshold 必须在 0~1 之间', path: ['cumulativeThreshold'] })
      }
      if (historySize < 2) issues.push({ message: 'historySize 必须 >= 2', path: ['historySize'] })
      if (usdCnyRate <= 0) issues.push({ message: 'usdCnyRate 必须 > 0', path: ['usdCnyRate'] })

      // 费用预算（可选）：缺省不设预算；提供时须为非负有限数字
      let budgetUsd: number | undefined
      if (raw.budgetUsd !== undefined) {
        if (typeof raw.budgetUsd !== 'number' || !Number.isFinite(raw.budgetUsd) || raw.budgetUsd < 0) {
          issues.push({ message: `budgetUsd 应为非负有限数字，收到 ${JSON.stringify(raw.budgetUsd)}`, path: ['budgetUsd'] })
        } else {
          budgetUsd = raw.budgetUsd
        }
      }

      // 定价表：合法条目保留；缺省时使用官方默认定价；整体非法时报错。
      const pricing: Record<string, PriceEntry> = {}
      if (raw.pricing === undefined) {
        Object.assign(pricing, DEFAULT_CONFIG.pricing)
      } else if (isPlainRecord(raw.pricing)) {
        for (const [model, entry] of Object.entries(raw.pricing)) {
          if (!isPlainRecord(entry)) {
            issues.push({ message: `pricing["${model}"] 应为 { cacheHit, cacheMiss, output, peak? } 对象`, path: ['pricing', model] })
            continue
          }
          const rates = readRates(entry, ['pricing', model], issues)
          if (rates === undefined) continue
          const parsed: PriceEntry = { ...rates }
          if (entry.peak !== undefined) {
            if (!isPlainRecord(entry.peak)) {
              issues.push({ message: `pricing["${model}"].peak 应为 { cacheHit, cacheMiss, output } 对象`, path: ['pricing', model, 'peak'] })
            } else {
              const peakRates = readRates(entry.peak, ['pricing', model, 'peak'], issues)
              if (peakRates !== undefined) parsed.peak = peakRates
            }
          }
          pricing[model] = parsed
        }
        if (Object.keys(pricing).length === 0) {
          issues.push({ message: 'pricing 没有任何合法条目', path: ['pricing'] })
        }
      } else {
        issues.push({ message: 'pricing 应为对象', path: ['pricing'] })
      }

      if (issues.length > 0) return { issues }
      return { value: { threshold, cumulativeThreshold, historySize, warnOnMissingUsage, timeBilling, currency, usdCnyRate, pricing, budgetUsd } }
    },
  },
}

/** 从配置对象解析一组 { cacheHit, cacheMiss, output }；非法时记录 issue 并返回 undefined。 */
function readRates(entry: Record<string, unknown>, path: readonly string[], issues: StandardSchemaV1.Issue[]): PriceRates | undefined {
  const values: Partial<PriceRates> = {}
  for (const field of ['cacheHit', 'cacheMiss', 'output'] as const) {
    const rawValue = entry[field]
    if (rawValue === undefined) {
      issues.push({ message: `${path.join('.')}.${field} 缺失`, path: [...path, field] })
    } else if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || rawValue < 0) {
      issues.push({ message: `${path.join('.')}.${field} 应为非负有限数字，收到 ${JSON.stringify(rawValue)}`, path: [...path, field] })
    } else {
      values[field] = rawValue
    }
  }
  if (values.cacheHit !== undefined && values.cacheMiss !== undefined && values.output !== undefined) {
    return { cacheHit: values.cacheHit, cacheMiss: values.cacheMiss, output: values.output }
  }
  return undefined
}

// ============================================================================
// 定价解析（模块级纯函数：cache_report 统计与轮末投影单元共用同一套计价）
// ============================================================================

/** 按模型解析定价：精确匹配 → 更具体的 v4 系列前缀 → 通用 v4 → reasoner → chat → 无。 */
function resolvePriceEntry(config: CacheMonitorConfig, model: string): PriceEntry | undefined {
  const exact = config.pricing[model]
  if (exact !== undefined) return exact
  if (model.startsWith('deepseek-v4-pro')) return config.pricing['deepseek-v4-pro']
  if (model.startsWith('deepseek-v4-flash')) return config.pricing['deepseek-v4-flash']
  if (model.startsWith('deepseek-v4')) return config.pricing['deepseek-v4-flash']
  if (model.startsWith('deepseek-reasoner')) return config.pricing['deepseek-reasoner']
  if (model.startsWith('deepseek-chat')) return config.pricing['deepseek-chat']
  return undefined
}

/** 按峰谷计价模式取某时间点生效的单价；无定价时返回 undefined。 */
function effectiveRatesOf(config: CacheMonitorConfig, model: string, ts: number): PriceRates | undefined {
  const entry = resolvePriceEntry(config, model)
  if (entry === undefined) return undefined
  if (entry.peak === undefined) return { cacheHit: entry.cacheHit, cacheMiss: entry.cacheMiss, output: entry.output }
  const usePeak = config.timeBilling === 'peak' || (config.timeBilling === 'auto' && isPeakHour(ts))
  return usePeak ? entry.peak : { cacheHit: entry.cacheHit, cacheMiss: entry.cacheMiss, output: entry.output }
}

/** 金额四舍五入到 6 位小数（消除浮点噪声）。 */
function roundMoney(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

// ============================================================================
// 轮末用量投影（官方 sessionProjections 能力缝：宿主纯折叠 → 客户端 useProjection）
// ============================================================================

/** 单个 turn 的聚合状态（投影单元内部状态，纯 JSON）。 */
interface TurnCostState {
  hit: number
  miss: number
  output: number
  costUsd: number
  model: string
  lastTs: number
}

/** 单轮页脚视图数据（wire JSON，客户端直接消费）。 */
export interface TurnCostView {
  hit: number
  miss: number
  output: number
  costUsd: number
  costCny: number
  hitRate: number
  model: string
}

/** cacheCost 投影的完整视图：turn 号（字符串键）→ 单轮统计 + 展示汇率。 */
export interface CacheCostProjectionView {
  turns: Record<string, TurnCostView>
  /** 人民币展示汇率（随配置 usdCnyRate，客户端据此换算） */
  usdCnyRate?: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    cacheCost: CacheCostProjectionView
  }
}

/**
 * 创建轮末用量投影单元：纯函数折叠 `assistant/message` 事件（其 usage 与
 * source.model 随模型输出一起落库），按事件时刻与定价配置计算费用，
 * 产出每轮 tokens / 费用（USD 与 CNY）/ 命中率，供客户端轮末页脚显示。
 * 注册随插件 fiber 卸载；值经 Zod schema 校验后进入客户端快照通道。
 */
function createCostProjection(config: CacheMonitorConfig): ProjectionDefinition<'cacheCost', Record<string, TurnCostState>> {
  const schema = z.object({
    turns: z.record(z.string(), z.object({
      hit: z.number(),
      miss: z.number(),
      output: z.number(),
      costUsd: z.number(),
      costCny: z.number(),
      hitRate: z.number(),
      model: z.string(),
    })),
    // 展示汇率：客户端常驻统计条据此换算人民币，与宿主配置保持一致
    usdCnyRate: z.number().optional(),
  })
  return {
    key: 'cacheCost',
    schema,
    stateVersion: 1,
    init: () => ({}),
    apply(state, event) {
      // 只关心带 usage 的 assistant/message 事件；其余事件原样返回（零下游工作）
      if (event.type !== 'assistant/message' || event.data.usage === undefined) return state
      const usage = event.data.usage
      const message = event.data.message
      const hit = sanitizeToken(usage.cacheReadTokens)
      const miss = sanitizeToken(usage.inputTokens) + sanitizeToken(usage.cacheWriteTokens)
      const output = sanitizeToken(usage.outputTokens)
      if (hit + miss + output <= 0) return state
      const turnKey = String(event.data.turn)
      const rates = effectiveRatesOf(config, message.source.model, event.time)
      const costUsd = rates === undefined
        ? 0
        : (hit / 1e6) * rates.cacheHit + (miss / 1e6) * rates.cacheMiss + (output / 1e6) * rates.output
      const prev = state[turnKey]
      return {
        ...state,
        [turnKey]: {
          hit: (prev?.hit ?? 0) + hit,
          miss: (prev?.miss ?? 0) + miss,
          output: (prev?.output ?? 0) + output,
          costUsd: roundMoney((prev?.costUsd ?? 0) + costUsd),
          model: message.source.model,
          lastTs: event.time,
        },
      }
    },
    view(state) {
      const turns: Record<string, TurnCostView> = {}
      for (const [turn, s] of Object.entries(state)) {
        const denominator = s.hit + s.miss
        turns[turn] = {
          hit: s.hit,
          miss: s.miss,
          output: s.output,
          costUsd: s.costUsd,
          costCny: roundMoney(s.costUsd * config.usdCnyRate),
          hitRate: denominator > 0 ? roundMoney(s.hit / denominator) : 0,
          model: s.model,
        }
      }
      return { turns, usdCnyRate: config.usdCnyRate }
    },
  }
}

// ============================================================================
// 统计聚合
// ============================================================================

/** 一次模型调用的用量样本（全部为已归一化的非负整数）。 */
interface UsageSample {
  /** 记录时间（epoch ms） */
  ts: number
  /** 提供方路由（options.provider） */
  provider: string
  /** 模型 ID（options.model） */
  model: string
  /** 缓存命中输入 tokens（cacheReadTokens） */
  hit: number
  /** 未命中输入 tokens（inputTokens + cacheWriteTokens） */
  miss: number
  /** 输出 tokens（outputTokens） */
  output: number
  /** 单轮缓存命中率（hit / (hit + miss)，分母为 0 时取 0） */
  hitRate: number
  /** 本轮预估费用（USD，按配置定价与峰谷时段） */
  cost: number
  /** 是否有可用定价（false 表示按 0 计费） */
  priced: boolean
  /** 本轮实际采用的单价（USD/1M tokens；无定价时为 undefined） */
  unit: PriceRates | undefined
}

/** 单模型聚合桶。 */
interface ModelBucket {
  hit: number
  miss: number
  output: number
  cost: number
  calls: number
}

/**
 * 进程内统计聚合器：累计计数 + 环形趋势窗口 + 按模型分桶 + 告警状态。
 * 状态仅存活于本插件 fiber（随插件卸载自动释放），不做持久化。
 */
class CacheStats {
  /** 累计命中 tokens */
  totalHit = 0
  /** 累计未命中 tokens */
  totalMiss = 0
  /** 累计输出 tokens */
  totalOutput = 0
  /** 累计预估费用（USD） */
  totalCost = 0
  /** 累计调用次数 */
  totalCalls = 0
  /** 无可用定价的调用次数（用于报表标注） */
  unpricedCalls = 0

  /** 趋势窗口样本（环形，最多 historySize 条） */
  private readonly history: UsageSample[] = []
  /** 按模型聚合 */
  private readonly modelStats = new Map<string, ModelBucket>()
  /** 累计命中率告警是否已触发（避免日志刷屏，状态翻转时提示一次） */
  private cumulativeWarned = false
  /** 费用预算告警是否已触发（超预算只提示一次） */
  private budgetWarned = false

  constructor(private readonly config: CacheMonitorConfig) {}

  /** 记录一次模型调用的用量。 */
  record(options: GenerateOptions, usage: TokenUsage, logger: Logger): void {
    // —— 字段提取与优雅降级：任何字段缺失/非法都不得抛出 ——
    const hit = sanitizeToken(usage.cacheReadTokens)
    const miss = sanitizeToken(usage.inputTokens) + sanitizeToken(usage.cacheWriteTokens)
    const output = sanitizeToken(usage.outputTokens)

    const hasAnyUsage = hit > 0 || miss > 0 || output > 0
    if (!hasAnyUsage) {
      if (this.config.warnOnMissingUsage) {
        logger.debug('收到 usage 块但缺少可用计数字段（provider=%s model=%s），本轮不参与统计', options.provider, options.model)
      }
      return
    }

    const provider = String(options.provider ?? 'unknown')
    const model = String(options.model ?? 'unknown')
    const denominator = hit + miss
    const hitRate = denominator > 0 ? hit / denominator : 0
    const ts = Date.now()
    const { cost, priced, rates } = this.estimateCost(model, hit, miss, output, ts)

    // 更新累计值与模型分桶（数值防御：防御性四舍五入，避免浮点漂移）
    this.totalHit += hit
    this.totalMiss += miss
    this.totalOutput += output
    this.totalCost += cost
    this.totalCalls += 1
    if (!priced) this.unpricedCalls += 1

    const bucket = this.modelStats.get(model) ?? { hit: 0, miss: 0, output: 0, cost: 0, calls: 0 }
    bucket.hit += hit
    bucket.miss += miss
    bucket.output += output
    bucket.cost += cost
    bucket.calls += 1
    this.modelStats.set(model, bucket)

    // 趋势窗口（环形缓冲）
    if (this.history.length >= this.config.historySize) this.history.shift()
    this.history.push({ ts, provider, model, hit, miss, output, hitRate, cost, priced, unit: rates })

    // —— 单轮告警 ——
    if (hitRate < this.config.threshold) {
      logger.warn(
        '[cache-monitor] 单轮缓存命中率告警：本轮 %s < 阈值 %s（provider=%s model=%s，命中=%s 未命中=%s 输出=%s）',
        formatPct(hitRate), formatPct(this.config.threshold), provider, model,
        formatInt(hit), formatInt(miss), formatInt(output),
      )
    }

    // —— 累计告警（状态翻转时提示一次） ——
    const cumulativeRate = this.cumulativeRate()
    if (cumulativeRate < this.config.cumulativeThreshold) {
      if (!this.cumulativeWarned) {
        this.cumulativeWarned = true
        logger.warn(
          '[cache-monitor] 累计缓存命中率告警：累计 %s < 阈值 %s（累计调用 %d 次，命中=%s 未命中=%s）',
          formatPct(cumulativeRate), formatPct(this.config.cumulativeThreshold), this.totalCalls,
          formatInt(this.totalHit), formatInt(this.totalMiss),
        )
      }
    } else {
      this.cumulativeWarned = false
    }

    // —— 费用预算告警（超预算提示一次） ——
    if (this.config.budgetUsd !== undefined && this.totalCost > this.config.budgetUsd && !this.budgetWarned) {
      this.budgetWarned = true
      logger.warn(
        '[cache-monitor] 已超过费用预算：预算 %s，当前累计 %s（调用 %d 次）。可在报表中查看明细',
        formatUsd(this.config.budgetUsd), formatUsd(this.totalCost), this.totalCalls,
      )
    }
  }

  /** 累计命中率（无样本时为 0）。 */
  cumulativeRate(): number {
    const denominator = this.totalHit + this.totalMiss
    return denominator > 0 ? this.totalHit / denominator : 0
  }

  /** 是否已超过费用预算（未配置预算时恒为 false）。 */
  overBudget(): boolean {
    return this.config.budgetUsd !== undefined && this.totalCost > this.config.budgetUsd
  }

  /** 最近 N 条样本（倒序：最新在前）。 */
  recent(limit: number): UsageSample[] {
    return this.history.slice(-limit).reverse()
  }

  /** 按模型分桶快照（按费用降序）。 */
  modelBuckets(): Array<{ model: string; bucket: ModelBucket }> {
    return [...this.modelStats.entries()]
      .map(([model, bucket]) => ({ model, bucket }))
      .sort((a, b) => b.bucket.cost - a.bucket.cost)
  }

  /**
   * 趋势判断：把窗口样本分成“最近半段”与“之前半段”，比较平均命中率。
   * 返回 'rising' | 'stable' | 'declining'，样本不足 2 条时返回 'insufficient'。
   */
  trend(): { kind: 'rising' | 'stable' | 'declining' | 'insufficient'; recentAvg: number; earlierAvg: number; recent: number; earlier: number } {
    const n = this.history.length
    if (n < 2) return { kind: 'insufficient', recentAvg: 0, earlierAvg: 0, recent: n, earlier: 0 }
    const recentCount = Math.max(1, Math.floor(n / 2))
    const recent = this.history.slice(n - recentCount)
    const earlier = this.history.slice(0, n - recentCount)
    const recentAvg = averageRate(recent)
    const earlierAvg = earlier.length > 0 ? averageRate(earlier) : recentAvg
    const delta = recentAvg - earlierAvg
    if (delta > 0.1) return { kind: 'rising', recentAvg, earlierAvg, recent: recent.length, earlier: earlier.length }
    if (delta < -0.1) return { kind: 'declining', recentAvg, earlierAvg, recent: recent.length, earlier: earlier.length }
    return { kind: 'stable', recentAvg, earlierAvg, recent: recent.length, earlier: earlier.length }
  }

  /** 费用结构占比（hit/miss/output 占累计费用的比例，总费用为 0 时全为 0）。 */
  costShares(): { hit: number; miss: number; output: number } {
    if (this.totalCost <= 0) return { hit: 0, miss: 0, output: 0 }
    // 分别按定价口径重算三部分费用占比（逐样本按各自时段单价计算）
    let hitCost = 0
    let missCost = 0
    let outputCost = 0
    for (const sample of this.history) {
      const rates = this.effectiveRates(sample.model, sample.ts)
      if (rates === undefined) continue
      hitCost += (sample.hit / 1e6) * rates.cacheHit
      missCost += (sample.miss / 1e6) * rates.cacheMiss
      outputCost += (sample.output / 1e6) * rates.output
    }
    const total = hitCost + missCost + outputCost
    if (total <= 0) return { hit: 0, miss: 0, output: 0 }
    return { hit: hitCost / total, miss: missCost / total, output: outputCost / total }
  }

  /** 按模型解析定价（委托模块级函数，与轮末投影共用同一计价口径）。 */
  resolvePrice(model: string): PriceEntry | undefined {
    return resolvePriceEntry(this.config, model)
  }

  /** 按峰谷计价模式取某时间点生效的单价（委托模块级函数）。 */
  effectiveRates(model: string, ts: number): PriceRates | undefined {
    return effectiveRatesOf(this.config, model, ts)
  }

  /** 估算单次调用费用（含峰谷时段判定）。 */
  private estimateCost(model: string, hit: number, miss: number, output: number, ts: number): { cost: number; priced: boolean; rates: PriceRates | undefined } {
    const rates = this.effectiveRates(model, ts)
    if (rates === undefined) return { cost: 0, priced: false, rates: undefined }
    return {
      cost: (hit / 1e6) * rates.cacheHit + (miss / 1e6) * rates.cacheMiss + (output / 1e6) * rates.output,
      priced: true,
      rates,
    }
  }
}

/** 将 token 计数归一化为非负有限整数（非法值按 0 处理，优雅降级）。 */
function sanitizeToken(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

/** 样本平均命中率（空数组为 0）。 */
function averageRate(samples: UsageSample[]): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample.hitRate
  return sum / samples.length
}

/**
 * 是否为官方高峰时段：UTC 00:30–16:30 为高峰（PEAK），
 * UTC 16:30–00:30 为非高峰（OFF-PEAK，价格为高峰的一半）。
 */
function isPeakHour(ts: number): boolean {
  const date = new Date(ts)
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  return minutes >= 30 && minutes < 990
}

/** 峰谷档位标签（用于报表标注）：强制模式按配置，auto 模式按时间判定。 */
function billingTierOf(config: CacheMonitorConfig, ts: number): 'PEAK' | 'OFF-PEAK' {
  if (config.timeBilling === 'peak') return 'PEAK'
  if (config.timeBilling === 'off-peak') return 'OFF-PEAK'
  return isPeakHour(ts) ? 'PEAK' : 'OFF-PEAK'
}

// ============================================================================
// 格式化输出
// ============================================================================

/** 千分位整数。 */
function formatInt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 美元金额：小于 1 保留 4 位，否则保留 2 位。 */
function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '$0'
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

/** 人民币金额（按汇率换算，显示规则同美元）。 */
function formatCny(usd: number, rate: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '¥0'
  const cny = usd * rate
  return cny < 1 ? `¥${cny.toFixed(4)}` : `¥${cny.toFixed(2)}`
}

/** 按配置的货币模式格式化一笔费用（USD 单币 / CNY 单币 / both 双币）。 */
function formatCost(usd: number, config: CacheMonitorConfig): string {
  if (config.currency === 'CNY') return formatCny(usd, config.usdCnyRate)
  if (config.currency === 'both') return `${formatUsd(usd)}（${formatCny(usd, config.usdCnyRate)}）`
  return formatUsd(usd)
}

/** 百分比（0~1 → 百分数字符串）。 */
function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '0.0%'
  return `${(n * 100).toFixed(1)}%`
}

/** 火花线字符（8 级亮度，用于命中率趋势可视化）。 */
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

/**
 * 把一组 0~1 的命中率渲染成 ASCII 火花线（右端为最新样本）。
 * 使用固定刻度 [0,1]，如实反映命中率高低而不放大微小波动。
 */
function sparklineOf(samples: UsageSample[]): string {
  let out = ''
  for (const sample of samples) {
    const index = Math.min(SPARK_CHARS.length - 1, Math.max(0, Math.floor(sample.hitRate * SPARK_CHARS.length)))
    out += SPARK_CHARS[index] ?? SPARK_CHARS[0]
  }
  return out
}

/**
 * 缓存健康度评级：基于累计命中率给出等级与颜色。
 * S ≥ 85% · A ≥ 70% · B ≥ 50% · C ≥ 30% · D < 30%。
 */
function healthGradeOf(rate: number): HealthGrade {
  if (rate >= 0.85) return { grade: 'S', emoji: '🟢' }
  if (rate >= 0.7) return { grade: 'A', emoji: '🟢' }
  if (rate >= 0.5) return { grade: 'B', emoji: '🟡' }
  if (rate >= 0.3) return { grade: 'C', emoji: '🟠' }
  return { grade: 'D', emoji: '🔴' }
}

/** 生成完整统计报表文本。 */
function buildReport(config: CacheMonitorConfig, stats: CacheStats, detail: boolean, limit: number): string {
  const lines: string[] = []
  lines.push('# 缓存命中率与成本报告（cache_report）')
  lines.push('')

  // —— 一行摘要：命中率 · 费用 · 轮次 · 健康度（含预算状态），便于直接复制 ——
  const health = stats.totalCalls > 0 ? healthGradeOf(stats.cumulativeRate()) : null
  const budgetFlag = stats.overBudget() ? ' · ⚠️ 已超预算' : ''
  lines.push(
    `> 📊 **摘要**：命中率 ${formatPct(stats.cumulativeRate())} · 费用 ${formatCost(stats.totalCost, config)} · ${formatInt(stats.totalCalls)} 轮` +
    (health !== null ? ` · 健康度 ${health.grade} ${health.emoji}` : '') + budgetFlag,
  )
  lines.push('')

  lines.push('## 累计统计')
  lines.push(`- 模型调用次数：${formatInt(stats.totalCalls)}`)
  lines.push(`- 累计缓存命中率：${formatPct(stats.cumulativeRate())}`)
  lines.push(`- 累计命中 tokens：${formatInt(stats.totalHit)}`)
  lines.push(`- 累计未命中 tokens：${formatInt(stats.totalMiss)}`)
  lines.push(`- 累计输出 tokens：${formatInt(stats.totalOutput)}`)
  const unpricedNote = stats.unpricedCalls > 0 ? `（其中 ${formatInt(stats.unpricedCalls)} 次调用无对应定价，按 0 计）` : ''
  lines.push(`- 预估 API 总费用：${formatCost(stats.totalCost, config)}${unpricedNote}`)
  if (config.budgetUsd !== undefined) {
    lines.push(`- 费用预算：${formatUsd(config.budgetUsd)}（${stats.overBudget() ? '⚠️ 已超出' : '未超出'}）`)
  }
  if (config.currency === 'both' || config.currency === 'CNY') {
    lines.push(`- 汇率：1 USD = ${config.usdCnyRate} CNY（config.usdCnyRate 可覆盖）`)
  }
  lines.push('')

  const samples = stats.recent(limit)
  if (samples.length > 0) {
    lines.push(`## 命中率趋势（最近 ${samples.length} 轮，右为最新）`)
    lines.push(`> 火花线：${sparklineOf(samples)}`)
    lines.push('| 轮次 | 模型 | 命中 tokens | 未命中 tokens | 输出 tokens | 单轮命中率 | 单轮费用 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    samples.forEach((sample, index) => {
      lines.push(
        `| ${index + 1} | ${sample.model} | ${formatInt(sample.hit)} | ${formatInt(sample.miss)} | ${formatInt(sample.output)} | ${formatPct(sample.hitRate)} | ${formatCost(sample.cost, config)} |`,
      )
    })
    lines.push('')
  }

  if (detail) {
    lines.push('## 逐轮明细（含提供方、计价档位与时间戳）')
    lines.push('```')
    for (const sample of samples) {
      const time = new Date(sample.ts).toISOString()
      const tier = sample.unit !== undefined ? billingTierOf(config, sample.ts) : '-'
      const unit = sample.unit !== undefined
        ? ` unit(hit/miss/out)=${sample.unit.cacheHit}/${sample.unit.cacheMiss}/${sample.unit.output}`
        : ''
      lines.push(
        `[${time}] tier=${tier} provider=${sample.provider} model=${sample.model} hit=${formatInt(sample.hit)} miss=${formatInt(sample.miss)} output=${formatInt(sample.output)} rate=${formatPct(sample.hitRate)} cost=${formatCost(sample.cost, config)}${unit}`,
      )
    }
    lines.push('```')
    lines.push('')
  }

  const buckets = stats.modelBuckets()
  if (buckets.length > 0) {
    lines.push('## 成本明细（按模型）')
    lines.push('| 模型 | 调用次数 | 命中 tokens | 未命中 tokens | 输出 tokens | 命中率 | 预估费用 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const { model, bucket } of buckets) {
      const rate = bucket.hit + bucket.miss > 0 ? bucket.hit / (bucket.hit + bucket.miss) : 0
      lines.push(
        `| ${model} | ${formatInt(bucket.calls)} | ${formatInt(bucket.hit)} | ${formatInt(bucket.miss)} | ${formatInt(bucket.output)} | ${formatPct(rate)} | ${formatCost(bucket.cost, config)} |`,
      )
    }
    lines.push('')
  }

  const tierNote = stats.totalCalls > 0
    ? `；峰谷计价 ${config.timeBilling === 'peak' ? '强制按高峰(PEAK)' : config.timeBilling === 'off-peak' ? '强制按非高峰(OFF-PEAK)' : '自动按官方时段（高峰 UTC 00:30–16:30，非高峰为其半价）'}判定`
    : ''
  lines.push(`> 定价来源：config.pricing（默认 DeepSeek 官方定价，可在 cordis.patch.yml 中覆盖${tierNote}；人民币按 config.usdCnyRate 汇率换算）。`)
  lines.push('')

  lines.push('## 缓存优化建议')
  buildSuggestions(config, stats).forEach((suggestion, index) => {
    lines.push(`${index + 1}. ${suggestion}`)
  })

  return lines.join('\n')
}

/** 生成 3 条针对性优化建议（始终恰好 3 条）。 */
function buildSuggestions(config: CacheMonitorConfig, stats: CacheStats): string[] {
  const suggestions: string[] = []
  const cumulativeRate = stats.cumulativeRate()

  // —— 建议 1：累计命中率水平 ——
  if (stats.totalCalls === 0) {
    suggestions.push('暂无模型调用数据：请先让 Agent 完成至少一轮对话，插件会自动从 API 响应中提取 usage 并累计统计。')
  } else if (cumulativeRate < config.cumulativeThreshold) {
    suggestions.push(
      `累计命中率 ${formatPct(cumulativeRate)} 低于阈值 ${formatPct(config.cumulativeThreshold)}：尽量在同一会话内连续推进任务、避免频繁新建会话，让系统提示词与历史前缀稳定命中缓存；同时避免过早触发上下文压缩（compaction 会重写历史并清空前缀缓存）。`,
    )
  } else if (cumulativeRate < 0.6) {
    suggestions.push('累计命中率处于中等水平：检查是否每轮注入大量动态内容（时间上下文、工具结果、附件摘要），动态内容会截断前缀缓存；可将易变内容尽量后置到消息尾部。')
  } else {
    suggestions.push(`累计命中率 ${formatPct(cumulativeRate)} 表现良好：继续保持会话连续性与提示词稳定性即可。`)
  }

  // —— 建议 2：命中率趋势 ——
  const trend = stats.trend()
  if (trend.kind === 'insufficient') {
    suggestions.push('数据不足：累计 2 轮以上才会生成趋势判断，继续对话即可。')
  } else if (trend.kind === 'declining') {
    suggestions.push(
      `命中率呈下降趋势（近 ${trend.recent} 轮均值 ${formatPct(trend.recentAvg)} vs 此前 ${trend.earlier} 轮均值 ${formatPct(trend.earlierAvg)}）：近期可能修改了系统提示词/工具列表，或注入了时间等动态内容；保持请求前缀稳定可恢复命中率。`,
    )
  } else {
    suggestions.push('命中率趋势稳定/上升：当前会话结构健康，继续维持即可。')
  }

  // —— 建议 3：成本结构 ——
  if (stats.totalCalls === 0) {
    suggestions.push('暂无费用数据：DeepSeek 官方模型已内置官方定价；若使用自定义或网关模型名，请在 config.pricing 中补充单价，费用估算才会生效。')
  } else if (stats.unpricedCalls > 0 && stats.totalCost <= 0) {
    suggestions.push('当前调用均无对应定价：请在 config.pricing 中补充这些模型的单价（cacheHit/cacheMiss/output，USD/1M tokens；官方峰谷模型可再提供 peak 档），否则费用按 0 估算。')
  } else {
    const shares = stats.costShares()
    if (shares.output >= 0.5) {
      suggestions.push(
        `输出 token 占预估费用 ${formatPct(shares.output)}，是主要成本来源：可降低 max_tokens、要求更简洁的回答；reasoner 输出单价较高，非推理场景建议使用 deepseek-chat。`,
      )
    } else if (shares.miss >= 0.5) {
      suggestions.push(
        `未命中输入占预估费用 ${formatPct(shares.miss)}，是主要成本来源：单轮上下文较长或缓存频繁失效；维持会话连续性、减少大段动态注入可显著降本。`,
      )
    } else {
      suggestions.push(`缓存命中输入已占成本主导（${formatPct(shares.hit)}）：成本结构健康，继续保持前缀缓存命中即可。`)
    }
  }

  return suggestions
}

/** 从工具返回的规范 JSON 值中安全提取 text 叶子字段。 */
function readText(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  const text = (value as Record<string, unknown>).text
  return typeof text === 'string' ? text : ''
}

// ============================================================================
// llm/stream 流包装（核心监听逻辑）
// ============================================================================

/**
 * 包装一次模型调用的 chunk 流：透传全部 chunk，从 `usage` chunk 中提取
 * TokenUsage 并交给统计器。任何统计异常都被捕获并记录，绝不中断调用流。
 */
async function* captureUsage(
  source: AsyncIterable<StreamChunk>,
  options: GenerateOptions,
  stats: CacheStats,
  logger: Logger,
): AsyncIterable<StreamChunk> {
  let usageSeen = false
  for await (const chunk of source) {
    if (chunk.type === 'usage' && !usageSeen) {
      usageSeen = true
      try {
        stats.record(options, chunk.usage, logger)
      } catch (error) {
        // 优雅降级：统计失败仅记日志，不影响下游消费 chunk
        logger.error('记录 usage 失败（已忽略，不影响模型调用流）：%s', error instanceof Error ? error.message : String(error))
      }
    }
    yield chunk
  }
}

// ============================================================================
// cache_report 工具
// ============================================================================

/** 工具参数：标准 JSON Schema（受 DSH 强制子集约束，注册时由 registry 校验）。 */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    detail: {
      type: 'boolean',
      description: '是否输出逐轮明细（含提供方与时间戳），默认 false。',
    },
    limit: {
      type: 'integer',
      description: '趋势明细保留轮数，默认 10，最大为配置的 historySize。',
    },
  },
  additionalProperties: false,
} as const satisfies Record<string, unknown>

/** 工具返回值的规范 JSON Schema（registry 会对 execute 返回值做强制校验）。 */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否成功生成报表。' },
    text: { type: 'string', description: '格式化的统计报表文本（Markdown）。' },
  },
  required: ['ok', 'text'],
} as const satisfies JsonSchemaNode

/** 创建 cache_report 工具定义（闭包持有统计器与配置）。 */
function createReportTool(config: CacheMonitorConfig, stats: CacheStats, logger: Logger): ToolDefinition {
  return {
    name: 'cache_report',
    description:
      '输出缓存命中率与成本统计报表：一行摘要（命中率/费用/轮次/健康度 S-D 评级 + 🟢🟡🟠🔴）、累计/单轮缓存命中率、命中/未命中/输出 token 数、按官方定价（含峰谷时段）预估的 API 费用（美元与人民币）、命中率趋势（含 ASCII 火花线）、成本明细与 3 条缓存优化建议；若配置了 budgetUsd 且已超预算会在报表中标注。',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (args, value): ContentBlock[] => [{ type: 'text', text: readText(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown): Promise<{ ok: boolean; text: string }> {
      try {
        // —— 参数校验：官方 validateJsonSchemaValue（标准 JSON Schema 语义） ——
        // 模型可能不传任何参数，统一按空对象处理后再校验
        const parsed = args === undefined || args === null ? {} : args
        const violations = validateJsonSchemaValue(TOOL_PARAMETERS, parsed, '$')
        if (violations.length > 0) {
          return { ok: false, text: `cache_report 参数校验失败：\n${violations.map((v) => `- ${v}`).join('\n')}` }
        }

        const input = parsed as Record<string, unknown>
        const detail = typeof input.detail === 'boolean' ? input.detail : false
        const rawLimit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 10
        const limit = Math.min(Math.max(Math.floor(rawLimit), 1), config.historySize)

        return { ok: true, text: buildReport(config, stats, detail, limit) }
      } catch (error) {
        // 兜底：任何意外异常都降级为可读的错误结果，绝不让工具执行崩溃
        logger.error('cache_report 执行失败：%s', error instanceof Error ? error.stack ?? error.message : String(error))
        return { ok: false, text: `cache_report 内部错误：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

// ============================================================================
// 插件定义（DSH loader 加载本模块后取 default 导出）
// ============================================================================

/** 命名日志器类型（Cordis Context 核心能力，无需额外服务）。 */
type Logger = ReturnType<Context['logger']>

const plugin: Plugin.Object<CacheMonitorConfig> = {
  name: 'cache-cost-monitor',
  Config: CONFIG_SCHEMA,
  // `tools` 是硬依赖：dsh-base 组合包必然提供，插件会等到其可用才激活
  inject: ['tools'],

  apply(ctx: Context, config: CacheMonitorConfig): void {
    const logger = ctx.logger('cache-cost-monitor')
    // —— 启动 banner（吸引眼球，一眼看清插件状态） ——
    logger.info(
      [
        '╔══════════════════════════════════════════════════════════╗',
        '║   dsh-cache-cost-monitor  v0.3.0                         ║',
        '║   缓存命中率 · 费用预估 · 峰谷计价 · 健康度评级          ║',
        '╚══════════════════════════════════════════════════════════╝',
        '  cache_report 工具已就绪 · 消息末尾页脚 · 常驻统计条',
      ].join('\n'),
    )
    logger.info(
      '已启动：threshold=%s cumulativeThreshold=%s historySize=%d 峰谷计价=%s 币种=%s(汇率 %s) 定价模型=%d 个%s',
      formatPct(config.threshold), formatPct(config.cumulativeThreshold), config.historySize,
      config.timeBilling, config.currency, String(config.usdCnyRate), Object.keys(config.pricing).length,
      config.budgetUsd !== undefined ? ` 预算=${formatUsd(config.budgetUsd)}` : ' 预算=未设置',
    )

    const stats = new CacheStats(config)

    // —— 轮末用量投影（每轮 tokens/费用 → 客户端 turnTail 页脚） ——
    const projections = ctx.get('sessionProjections') as SessionProjectionRegistry | undefined
    if (projections !== undefined) {
      try {
        ctx.effect(() => projections.register(createCostProjection(config)))
        logger.info('已注册会话投影 cacheCost（轮末用量/费用页脚数据源）')
      } catch (error) {
        // 优雅降级：投影不可用只影响页脚，cache_report 与告警不受影响
        logger.error('注册会话投影 cacheCost 失败（轮末页脚不可用）：%s', error instanceof Error ? error.message : String(error))
      }
    } else {
      logger.warn('sessionProjections 服务不可用：轮末用量页脚不可用（cache_report 与告警不受影响）')
    }

    // —— 注册 cache_report 工具（disposer 交给 fiber effect，随插件卸载自动回收） ——
    try {
      ctx.effect(() => ctx.tools.register(createReportTool(config, stats, logger)))
      logger.info('已注册模型工具 cache_report')
    } catch (error) {
      // 优雅降级：工具注册失败不影响 llm/stream 监听
      logger.error('注册 cache_report 失败（llm/stream 监听仍将工作）：%s', error instanceof Error ? error.message : String(error))
    }

    // —— 监听每一轮模型调用（官方 llm/stream 瀑布流包装模式） ——
    ctx.on(
      'llm/stream',
      (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
        let source: AsyncIterable<StreamChunk>
        try {
          source = next()
        } catch (error) {
          // 与不包装时行为一致：向下游重新抛出，但先记录以便排查
          logger.error('llm/stream next() 失败：%s', error instanceof Error ? error.message : String(error))
          throw error
        }
        return captureUsage(source, options, stats, logger)
      },
      { global: true },
    )
    logger.info('已挂载 llm/stream 监听：每轮模型调用的缓存/费用统计已生效')
  },
}

export default plugin
