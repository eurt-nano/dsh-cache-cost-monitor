/**
 * dsh-cache-cost-monitor 浏览器端（web2 client bundle，经 tsdown 构建为
 * window.__ModuleLoader__.load({id, factory}) 惰性 CJS 产物，由
 * dsh-client-modules 宿主侧解析 exports["./client"] 后经 /plugins 提供）。
 *
 * 功能一：在 `conversation.chat.turnTail` 链式 Slot 注册页脚组件——
 * 每一段（已结束的轮次）助手消息末尾低调渲染该轮消耗的 tokens 与人民币费用，
 * 形如 `本轮 12.3K tokens · ¥0.0123`。
 *
 * 功能二：在 `conversation.composer.dock` list Slot 注册常驻统计条——
 * 输入框下方实时显示 `⌀ 1.2M tokens · ¥2.01 · 命中 68% ▂▅▇█`。
 *
 * 数据源（双保险，保证页脚/统计条在任意情况下至少显示 tokens）：
 * - 首选：宿主 `cacheCost` 投影（含每轮费用与汇率，经 useProjection 读取）；
 * - 兜底①：会话快照 `useSession`——引擎把每条助手消息的原始 usage
 *   （TokenUsage：cacheReadTokens/inputTokens/outputTokens）直接带进
 *   AssistantMessageNode，无需任何投影即可算出该轮 tokens；
 * - 兜底②（统计条）：官方 `tokenUsage` 投影（@deepseek-ai/dsh-token-meter
 *   由 dsh-base 组合层保证注册，官方 StatsLine 同款通路）。
 *
 * 与官方 `ui-deliverables`（同样注册在 turnTail）的共存策略：
 * - turnTail 是 chain 槽位，同一时刻只渲染第一个 select 非空 的条目；
 * - 本页脚用 priority: -1 在链上最先被尝试（原版设计：确保不被既有条目抢占）；
 *   当某轮产出了文件（deliverables 数据存在）时主动让位给 "Produced" 行。
 *
 * 样式约束（用户要求：不显眼）：小号字、次级文字色
 * （--dsw-alias-label-secondary，随明暗主题自动适配）、低透明度，纯文本。
 */

import React from 'react'
import type { Context, Plugin } from '@deepseek-ai/cordis'

// ============================================================================
// 投影视图类型（与宿主 lib 的 CacheCostProjectionView 保持一致；客户端
// 不跨包导入值，类型就地声明即可）
// ============================================================================

interface TurnCostView {
  hit: number
  miss: number
  output: number
  costUsd: number
  costCny: number
  hitRate: number
  model: string
}

interface CacheCostProjectionView {
  turns: Record<string, TurnCostView>
  /** 人民币展示汇率（随宿主配置，缺省 6.8） */
  usdCnyRate?: number
}

/** 官方 tokenUsage 投影（@deepseek-ai/dsh-token-meter，dsh-base 保证注册）。 */
interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    cacheCost: CacheCostProjectionView
    tokenUsage: TokenUsageProjection
  }
}

// ============================================================================
// 格式化与通用工具
// ============================================================================

/** 紧凑 token 数：1.2M / 45.2K / 987。 */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(Math.round(n))
}

/** 人民币金额：小于 1 元保留 4 位，否则 2 位。 */
function formatCny(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '¥0'
  return n < 1 ? `¥${n.toFixed(4)}` : `¥${n.toFixed(2)}`
}

/** 火花线字符（8 级亮度，用于命中率趋势可视化）。 */
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

/** 把 0~1 的命中率映射为火花线字符（固定刻度，右端为最新）。 */
function sparkOf(rate: number): string {
  const index = Math.min(SPARK_CHARS.length - 1, Math.max(0, Math.floor(rate * SPARK_CHARS.length)))
  return SPARK_CHARS[index] ?? SPARK_CHARS[0]
}

/** 从原始 TokenUsage 中安全读取计数（非法值按 0，优雅降级）。 */
function tokenCount(value: unknown, key: string): number {
  if (value === null || typeof value !== 'object') return 0
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

/** 从原始 TokenUsage 提取 { hit, miss, output }；全为零返回 null。 */
function tokensFromUsage(usage: unknown): { hit: number; miss: number; output: number } | null {
  if (usage === null || typeof usage !== 'object') return null
  const hit = tokenCount(usage, 'cacheReadTokens')
  const miss = tokenCount(usage, 'inputTokens') + tokenCount(usage, 'cacheWriteTokens')
  const output = tokenCount(usage, 'outputTokens')
  if (hit + miss + output <= 0) return null
  return { hit, miss, output }
}

/**
 * 从 owner（或其 .turn 字段）提取轮次编号；无法识别时返回 null。
 * 引擎的 TurnLocation 对象为 { turn, start, end, status, steps, data }。
 */
function turnOf(owner: unknown): number | null {
  if (owner === null || typeof owner !== 'object') return null
  const raw = (owner as Record<string, unknown>).turn
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (raw !== null && typeof raw === 'object') {
    const nested = (raw as Record<string, unknown>).turn
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested
  }
  return null
}

/** 读取轮次状态；无法识别时返回 'unknown'。 */
function turnStatusOf(owner: unknown): string {
  if (owner === null || typeof owner !== 'object') return 'unknown'
  const raw = (owner as Record<string, unknown>).turn
  if (raw !== null && typeof raw === 'object') {
    const status = (raw as Record<string, unknown>).status
    if (typeof status === 'string') return status
  }
  return 'unknown'
}

/** 该轮是否由官方 ui-deliverables 发布了产出文件（其 turn data 键为 'deliverables'）。 */
function hasProducedFiles(owner: unknown): boolean {
  if (owner === null || typeof owner !== 'object') return false
  const raw = (owner as Record<string, unknown>).turn
  if (raw === null || typeof raw !== 'object') return false
  const data = (raw as Record<string, unknown>).data
  if (data === null || typeof data !== 'object' || typeof (data as { get?: unknown }).get !== 'function') return false
  const value = (data as { get(key: string): unknown }).get('deliverables')
  if (value === null || typeof value !== 'object') return false
  const produced = (value as Record<string, unknown>).produced
  return Array.isArray(produced) && produced.length > 0
}

/**
 * 链式 Slot 路由选择器：只认领“已结束、无产出文件、可识别轮次号”的轮次，
 * 返回 matched 共享 { turn }；其余（open 轮、文件轮、无法识别）返回 null 让位。
 * priority: -1 保证本条目在链上最先被尝试，避免被既有条目抢占。
 */
function selectTurn(owner: unknown): { turn: number } | null {
  if (turnStatusOf(owner) !== 'closed') return null
  if (hasProducedFiles(owner)) return null
  const turnNumber = turnOf(owner)
  return turnNumber === null ? null : { turn: turnNumber }
}

// ============================================================================
// 会话快照读取（兜底数据源：引擎自带每轮 usage）
// ============================================================================

/** 快照中极简的 chat 视图结构（与引擎类型匹配，只读所需字段）。 */
interface SnapshotChatLike {
  locations?: {
    getTurn(turn: number): readonly string[]
  }
  nodes?: {
    get(key: string): { data?: unknown } | undefined
  }
}

interface SnapshotLike {
  chat?: SnapshotChatLike
}

/**
 * 从会话快照取某轮「最后一条助手消息」的原始 usage。
 * 引擎把每条 assistant/message 的 TokenUsage 直接带进 AssistantMessageNode.usage，
 * 因此不依赖任何投影即可拿到该轮 tokens（命中/未命中/输出）。
 */
function usageOfTurn(snapshot: unknown, turnNumber: number): unknown {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const chat = (snapshot as SnapshotLike).chat
  if (chat === null || typeof chat !== 'object') return undefined
  const keys = chat.locations?.getTurn(turnNumber)
  if (keys === undefined || keys.length === 0) return undefined
  const lastKey = keys[keys.length - 1]
  const node = lastKey === undefined ? undefined : chat.nodes?.get(lastKey)
  const data = node?.data
  if (data === null || typeof data !== 'object') return undefined
  return (data as Record<string, unknown>).usage
}

// ============================================================================
// 页脚组件（conversation.chat.turnTail，chain 槽）
// ============================================================================

interface TurnTailProps {
  /** 宿主投影读面（标准 prop）：按 key 读取该会话的投影值。 */
  useProjection: <K extends string>(key: K) => unknown
  /** 会话快照读面（标准 prop）：useSession(selector)。 */
  useSession: <T>(selector: (snapshot: unknown) => T) => T
  /** 引擎轮次边界（owner prop，含 .turn 轮次号）。 */
  turn: unknown
  [key: string]: unknown
}

/**
 * 轮末页脚：`本轮 12.3K tokens · ¥0.0123`。
 * 数据双保险：优先 cacheCost 投影（含费用），否则直接读会话快照 usage
 * （仅 tokens）；两者皆无（插件安装前的历史轮 / 未携带 usage）时返回 null。
 */
function TurnCostFooter(props: TurnTailProps): React.ReactElement | null {
  const turnNumber = turnOf(props)
  if (turnNumber === null) return null

  // —— 首选：cacheCost 投影（每轮费用 + 汇率） ——
  const useProjection = typeof props.useProjection === 'function' ? props.useProjection : null
  const value = useProjection === null ? undefined : (useProjection('cacheCost') as CacheCostProjectionView | undefined)
  const bucket = value?.turns?.[String(turnNumber)]
  if (bucket !== undefined) {
    const totalTokens = bucket.hit + bucket.miss + bucket.output
    return React.createElement(
      'div',
      {
        'data-cache-cost-footer': 'true',
        title: `本轮 ${totalTokens} tokens（命中 ${bucket.hit} · 未命中 ${bucket.miss} · 输出 ${bucket.output}）· 命中率 ${(bucket.hitRate * 100).toFixed(1)}% · $${bucket.costUsd.toFixed(4)} · ${bucket.model}`,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '11px',
          lineHeight: '16px',
          color: 'var(--dsw-alias-label-secondary)',
          opacity: '0.75',
          padding: '2px 0 0 2px',
          userSelect: 'none',
        },
      },
      `本轮 ${formatTokens(totalTokens)} tokens · ${formatCny(bucket.costCny)}`,
    )
  }

  // —— 兜底：会话快照自带 usage（仅 tokens，无费用） ——
  const useSession = typeof props.useSession === 'function' ? props.useSession : null
  if (useSession === null) return null
  const snapshot = useSession((s) => s)
  const usage = usageOfTurn(snapshot, turnNumber)
  const tokens = tokensFromUsage(usage)
  if (tokens === null) return null
  const totalTokens = tokens.hit + tokens.miss + tokens.output
  return React.createElement(
    'div',
    {
      'data-cache-cost-footer': 'true',
      title: `本轮 ${totalTokens} tokens（命中 ${tokens.hit} · 未命中 ${tokens.miss} · 输出 ${tokens.output}）`,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        opacity: '0.75',
        padding: '2px 0 0 2px',
        userSelect: 'none',
      },
    },
    `本轮 ${formatTokens(totalTokens)} tokens`,
  )
}

// ============================================================================
// 常驻统计条（conversation.composer.dock，list 槽）
// ============================================================================

interface DockProps {
  /** 宿主投影读面（标准 prop）：按 key 读取该会话的投影值。 */
  useProjection: <K extends string>(key: K) => unknown
  [key: string]: unknown
}

/**
 * 输入框下方的常驻统计条：实时显示当前会话的累计消耗与命中率趋势，
 * 形如 `⌀ 1.2M tokens · ¥2.01 · 命中 68% ▂▅▇█`。
 * 数据双保险：优先 `cacheCost` 投影（含费用与火花线），否则回退官方
 * `tokenUsage` 投影（dsh-base 保证注册；仅 tokens 与命中率）。
 */
function SessionCostReadout(props: DockProps): React.ReactElement | null {
  const useProjection = typeof props.useProjection === 'function' ? props.useProjection : null
  if (useProjection === null) return null

  const costValue = useProjection('cacheCost') as CacheCostProjectionView | undefined
  const turns = costValue?.turns
  if (turns !== undefined && Object.keys(turns).length > 0) {
    // —— 首选：cacheCost 投影（累计 tokens / 费用 / 命中率 / 火花线） ——
    const entries = Object.entries(turns).sort((a, b) => Number(a[0]) - Number(b[0]))
    let hit = 0
    let miss = 0
    let output = 0
    let costUsd = 0
    const recent: number[] = []
    for (const [, t] of entries) {
      hit += t.hit
      miss += t.miss
      output += t.output
      costUsd += t.costUsd
      recent.push(t.hitRate)
    }
    const denominator = hit + miss
    const rate = denominator > 0 ? hit / denominator : 0
    const spark = recent.slice(-14).map(sparkOf).join('')
    const cnyRate = costValue?.usdCnyRate ?? 6.8
    return React.createElement(
      'div',
      {
        'data-cache-cost-dock': 'true',
        title: `累计 ${hit + miss + output} tokens（命中 ${hit} · 未命中 ${miss} · 输出 ${output}）· $${costUsd.toFixed(4)} · 最近 ${recent.length} 轮命中率趋势`,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '11px',
          lineHeight: '16px',
          color: 'var(--dsw-alias-label-secondary)',
          opacity: '0.7',
          padding: '0 2px',
          userSelect: 'none',
        },
      },
      `⌀ ${formatTokens(hit + miss + output)} tokens · ${formatCny(costUsd * cnyRate)} · 命中 ${(rate * 100).toFixed(0)}%`,
      ' ',
      React.createElement('span', { style: { letterSpacing: '1px' } }, spark),
    )
  }

  // —— 兜底：官方 tokenUsage 投影（累计 tokens + 命中率，无费用） ——
  const usage = useProjection('tokenUsage') as TokenUsageProjection | undefined
  if (usage === undefined || typeof usage !== 'object') return null
  const total = (usage.cacheReadTokens ?? 0) + (usage.uncachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0)
  const denom = (usage.cacheReadTokens ?? 0) + (usage.uncachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  if (total <= 0) return null
  const rate = denom > 0 ? (usage.cacheReadTokens ?? 0) / denom : 0
  return React.createElement(
    'div',
    {
      'data-cache-cost-dock': 'true',
      title: `累计 tokens（命中 ${usage.cacheReadTokens ?? 0} · 未命中 ${(usage.uncachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0)} · 输出 ${usage.outputTokens ?? 0}）`,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        opacity: '0.7',
        padding: '0 2px',
        userSelect: 'none',
      },
    },
    `⌀ ${formatTokens(total)} tokens · 命中 ${(rate * 100).toFixed(0)}%`,
  )
}

// ============================================================================
// 客户端插件
// ============================================================================

/** slots 服务的结构接口（值导入跨包被禁止，服务经 ctx 注入获得）。 */
interface SlotsLike {
  inject(name: string, callback: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): () => void
}

const plugin: Plugin.Object<never> = {
  name: 'cache-cost-monitor-client',
  inject: ['slots'],

  apply(ctx: Context): void {
    const slots = ctx.get('slots') as SlotsLike | undefined
    if (slots === undefined) return
    // 每段已结束的助手消息末尾：本轮 tokens · ¥费用（priority -1 最先尝试）
    slots.inject('conversation.chat.turnTail', () => slots.register({
      name: 'conversation.chat.turnTail',
      select: selectTurn,
      priority: -1,
    }, TurnCostFooter))
    // 输入框下方常驻统计条：累计 tokens · ¥费用 · 命中率 + 趋势火花线
    // （list 槽；官方 StatsLine order 0 在前，本条目 order 1 紧随）
    slots.inject('conversation.composer.dock', () => slots.register({
      name: 'conversation.composer.dock',
      id: 'cache-cost',
      order: 1,
    }, SessionCostReadout))
  },
}

export default plugin
