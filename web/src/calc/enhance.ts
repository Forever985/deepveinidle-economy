import type { GameData, Options } from '../types.ts'
import type { PriceBook } from './price.ts'

/**
 * 强化计算。
 *
 * DVI 的强化数据（balance.enhance）：
 *   baseChanceFloor  0.2    成功率下限
 *   chanceDropPerTier 0.06  每阶递减
 *   maxTier          5      最高 5 阶
 *   shardsPerTier    3      每阶消耗碎片数
 *   goldTiers  [100,300,1000,3000,8000,20000]  各阶金币
 *   qualityMult [1,3,8,20,50]                 各阶品质倍率
 *
 * ⚠️⚠️ 以下公式是**从字段名与取值反推的合理形式**，不是从游戏代码读出的精确实现。
 * 与 burn/caught 同一处理原则：集中在 ASSUMPTIONS 里，改版或实测不符时只改这里。
 *
 * 已知的确切部分：
 *   · 最高 5 阶、每阶 3 碎片、金币 6 档、品质倍率 [1,3,8,20,50]
 *   · **+5 的价值是 +0 的 50 倍** —— 这是本模块存在的主要理由：
 *     强化很可能是 DVI 里最赚钱的玩法之一
 *
 * 未确证的部分（见 ASSUMPTIONS）：
 *   1. 成功率的递推方式
 *   2. 碎片是「每种物品各自的碎片」还是「通用碎片」
 *   3. 失败是否损失材料
 */

export const ASSUMPTIONS = [
  '成功率：第 n 阶（从 n-1 升到 n）= max(baseChanceFloor, 1 − n × chanceDropPerTier)',
  '碎片：按「每种物品对应一个碎片物品」处理，可在界面上手动指定碎片物品 id',
  '失败：消耗材料但不降阶（不惩罚），若实测会降阶请改这里',
] as const

export interface EnhanceBalance {
  baseChanceFloor: number
  chanceDropPerTier: number
  maxTier: number
  shardsPerTier: number
  goldTiers: number[]
  qualityMult: number[]
}

export function enhanceBalance(data: GameData): EnhanceBalance {
  const b = (data.balance as any).enhance
  return {
    baseChanceFloor: b?.baseChanceFloor ?? 0.2,
    chanceDropPerTier: b?.chanceDropPerTier ?? 0.06,
    maxTier: b?.maxTier ?? 5,
    shardsPerTier: b?.shardsPerTier ?? 3,
    goldTiers: b?.goldTiers ?? [100, 300, 1000, 3000, 8000, 20000],
    qualityMult: b?.qualityMult ?? [1, 3, 8, 20, 50],
  }
}

/** 从 (n-1) 升到第 n 阶的成功率 */
export function tierChance(b: EnhanceBalance, n: number): number {
  if (n < 1) return 1
  return Math.max(b.baseChanceFloor, 1 - n * b.chanceDropPerTier)
}

/** 从 0 阶一路升到 target 阶的总成功率（各阶独立相乘） */
export function pathChance(b: EnhanceBalance, target: number): number {
  let p = 1
  for (let n = 1; n <= target; n++) p *= tierChance(b, n)
  return p
}

export interface EnhanceInput {
  itemId: number
  targetTier: number
  /** 碎片物品 id；数据里没写死，界面上让玩家自己指定 */
  shardItemId: number
  /** 材料是否已自产（true 则碎片按 0 成本计） */
  shardsAreSelfMade?: boolean
}

export interface EnhanceStep {
  tier: number
  chance: number
  gold: number
  shards: number
  /** 该阶材料的名义成本 */
  cost: number
  /** 期望尝试次数 */
  attempts: number
  /** 期望成本（含失败重试） */
  expectedCost: number
  /** 该阶完成后的价值倍率 */
  mult: number
  /** 该阶完成后的价值 */
  valueAfter: number
}

export interface EnhanceResult {
  itemId: number
  itemName: string
  from: number
  to: number
  steps: EnhanceStep[]
  /** 总期望成本（0 → target） */
  totalExpectedCost: number
  /** 强化前价值（tier 0） */
  baseValue: number
  /** 强化后价值 */
  finalValue: number
  /** 价值增量 */
  valueGain: number
  /** 净收益 = 价值增量 − 总期望成本 */
  net: number
  /** 回本：价值增量 / 总成本。> 1 表示赚 */
  roi: number
  /** 全程一次成功的概率 */
  allOrNothing: number
  /** 平均每个 +1 阶的期望成本 */
  costPerTier: number
  warnings: string[]
}

/**
 * 算一次强化的完整账。
 *
 * 成本口径：材料按**买入价**算（你得先买到碎片）。
 * 若 shardsAreSelfMade 则碎片记 0 成本 —— 但那意味着你要自己刷，
 * 界面上会提示这不反映真实成本。
 */
export function analyseEnhance(
  data: GameData,
  book: PriceBook,
  input: EnhanceInput,
  _opts?: Options,     // 预留：将来可能按玩家配置调整强化成功率
): EnhanceResult | null {
  const b = enhanceBalance(data)
  const item = book.item(input.itemId)
  if (!item) return null

  const target = Math.max(0, Math.min(b.maxTier, Math.floor(input.targetTier)))
  const warnings: string[] = []

  // 碎片单价
  const shardPrice = input.shardsAreSelfMade ? 0 : book.cost(input.shardItemId).value
  if (!input.shardsAreSelfMade && shardPrice <= 0) {
    warnings.push('碎片物品没有有效价格（可能填错了物品 ID），成本按 0 计')
  }

  const steps: EnhanceStep[] = []
  for (let n = 1; n <= target; n++) {
    const chance = tierChance(b, n)
    const gold = b.goldTiers[Math.min(n, b.goldTiers.length - 1)]
    const shards = b.shardsPerTier
    const cost = gold + shards * shardPrice
    const attempts = 1 / Math.max(1e-9, chance)
    steps.push({
      tier: n,
      chance,
      gold,
      shards,
      cost,
      attempts,
      expectedCost: cost * attempts,
      mult: b.qualityMult[Math.min(n - 1, b.qualityMult.length - 1)],
      valueAfter: item.value * b.qualityMult[Math.min(n - 1, b.qualityMult.length - 1)],
    })
  }

  const totalExpectedCost = steps.reduce((s, x) => s + x.expectedCost, 0)
  const baseValue = item.value * (b.qualityMult[0] ?? 1)
  const finalMult = b.qualityMult[Math.min(target - 1, b.qualityMult.length - 1)] ?? 1
  const finalValue = item.value * (target > 0 ? finalMult : 1)
  const valueGain = finalValue - baseValue
  const net = valueGain - totalExpectedCost

  if (target === 0) warnings.push('目标阶数为 0，等于没强化')

  return {
    itemId: input.itemId,
    itemName: item.name,
    from: 0,
    to: target,
    steps,
    totalExpectedCost,
    baseValue,
    finalValue,
    valueGain,
    net,
    roi: totalExpectedCost > 0 ? valueGain / totalExpectedCost : Infinity,
    allOrNothing: pathChance(b, target),
    costPerTier: target > 0 ? totalExpectedCost / target : 0,
    warnings,
  }
}

/**
 * 批量：对所有物品算「强化到 +5 是否划算」。
 * 这是强化模块最有用的视图 —— 直接告诉玩家该强化什么。
 */
export interface EnhanceRow {
  itemId: number
  name: string
  baseValue: number
  valueAtMax: number
  totalCost: number
  net: number
  roi: number
  warnings: string[]
}

export function enhanceAll(
  data: GameData,
  book: PriceBook,
  shardItemId: number,
  opts?: Options,
  filter?: (itemId: number) => boolean,
): EnhanceRow[] {
  const b = enhanceBalance(data)
  const rows: EnhanceRow[] = []
  for (const it of data.items) {
    if (filter && !filter(it.id)) continue
    const r = analyseEnhance(data, book, { itemId: it.id, targetTier: b.maxTier, shardItemId }, opts)
    if (!r) continue
    rows.push({
      itemId: it.id,
      name: it.name,
      baseValue: r.baseValue,
      valueAtMax: r.finalValue,
      totalCost: r.totalExpectedCost,
      net: r.net,
      roi: r.roi,
      warnings: r.warnings,
    })
  }
  return rows
}
