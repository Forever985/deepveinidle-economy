/**
 * DVI 利润网 · 数据类型
 *
 * 全部对齐 dvi_probe 提取出来的真实字段名，不另造名字 ——
 * 改名会让「数据改了公式就悄悄算错」这类问题无从排查。
 */

/** 物品 */
export interface Item {
  id: number
  name: string
  stackable: boolean
  /** 基础价值。市场无成交时的兜底价 */
  value: number
  heals?: number
}

/** 配方里的一个投入或产出 */
export interface Slot {
  itemId: number
  qty: number
}

/** 炼金/烹饪的失败机制：失败会损失产物 */
export interface FailSpec {
  /** 达到需求等级时的失败概率 */
  chanceAtReq: number
  /** 到这个等级就完全不会失败 */
  safeAtLevel: number
  /** 被抓后晕眩的 tick 数（仅 thieving） */
  stunTicks?: number
}

/** 配方（游戏里叫「作业」） */
export interface Action {
  id: number
  name: string
  skill: string
  group: string
  levelReq: number
  /** 单次「动手」时间，单位 tick。注意：这不等于获得一件成品的总时间 */
  baseTicks: number
  xp: number
  inputs: Slot[]
  output?: Slot
  /** farming：生长时间（tick）。这一项常常才是时间瓶颈 */
  grow?: number
  /** 采集/偷窃的额外掉落 */
  bonus?: { itemId: number; chance: number }
  /** cooking：烧焦 */
  burn?: FailSpec
  /** thieving：被抓 */
  caught?: FailSpec
}

/** 站点（决定赶路，暂未纳入利润计算） */
export interface Site {
  id: number
  x: number
  y: number
  kind: string
  jobIds: number[]
}

/** 怪物（战斗收益是独立利润来源） */
export interface Monster {
  id: number
  name: string
  level: number
  hp: number
  maxHit: number
  attack: number
  defence: number
  speed: number
  xp: number
  /** 金币区间 [min, max]，计算时取期望 */
  gold: number[]
  /** 概率额外掉落 */
  bonus?: { itemId: number; chance: number }
  /** 固定掉落的物品 id */
  drop: number
}

export interface Balance {
  maxLevel: number
  baseXp: number
  xpGrowth: number
  beyondGrowth: number
  speedPerLevelAboveRequirement: number
  /** 市场税率，基点。200 = 2% */
  marketTaxBp: number
  [k: string]: unknown
}

export interface GameData {
  meta: { source?: string; version?: string; commit?: string; extractedAt?: string }
  balance: Balance
  extra: Record<string, unknown>
  items: Item[]
  actions: Action[]
  /** 站点数量（坐标数据网站用不上，不随包分发，需要时从 dvi_probe 现取） */
  siteCount: number
  monsters: Monster[]
}

/* ────────────────────── 价格 ────────────────────── */

/** 价格来源。UI 上必须把这个标出来，让人知道每个数字从哪来 */
export type PriceSource = 'market' | 'fallback' | 'manual'

/** 一个方向上的报价 */
export interface Quote {
  /** 挂单量。价差再大，量只有 1 也卖不掉 */
  qty: number
}

export interface MarketSnapshot {
  /** 你挂出去能拿到的价（卖方要价） */
  ask?: Quote & { price: number }
  /** 你直接卖给收购单能拿到的价 */
  bid?: Quote & { price: number }
}

export interface Price {
  value: number
  source: PriceSource
  /** 计价方向：ask=挂出能拿到的，bid=卖给收购单的 */
  side: 'ask' | 'bid'
  /** 挂单量（仅 market 来源有） */
  qty?: number
}

/* ────────────────────── 计算 ────────────────────── */

/** 计算口径。这些选择会显著改变排名，所以必须在 UI 上暴露出来 */
export interface Options {
  /**
   * farming 生长等待期是否计入工时。
   * true  = 并行：等待期去干别的，只算动手时间（放置游戏常态）
   * false = 单线程：种下去就干等，生长时间全额计入
   */
  parallelGrow: boolean
  /** 收益按 bid（保守）还是 ask（乐观） */
  revenueSide: 'bid' | 'ask'
  /** 税率，基点 */
  taxBp: number
  /** 玩家当前等级，用于过滤与失败率 */
  playerLevel?: number
  /** 同一个玩家可以同时照料几块地（并行口径下用） */
  parallelSlots?: number
}

export interface StepResult {
  action: Action
  /** 是否可做（等级够不够） */
  available: boolean
  /** 单次周期的期望产出 */
  expectedOut: number
  /** 期望投入（考虑失败导致的额外消耗） */
  expectedIn: Slot[]
  /** 单次周期的工时（tick）。并行口径下已剔除可并行的等待 */
  ticks: number
  seconds: number
  cost: number
  income: number
  net: number
  netPerHour: number
  xpPerHour: number
  /** 计入这个结果的修正项，用于在 UI 上说明「为什么」 */
  factors: Factor[]
}

export interface Factor {
  label: string
  detail: string
  /** 相对无修正时的乘数 */
  mult: number
}

/** 一条链：按生产顺序排列 */
export interface ChainStep {
  actionId: number
  /** 把上游产物设为 0 价内部流转；不填则用上一步的产出 */
  alignItemId?: number
}

export interface ChainResult {
  steps: StepResult[]
  /** 整链成本（只算真正需要买进来的第一批原料） */
  cost: number
  /** 整链收入（只算最后卖出去的成品） */
  income: number
  net: number
  netPerHour: number
  /** 瓶颈环节：耗时最长的那一步 */
  bottleneck: number | null
  warnings: string[]
}
