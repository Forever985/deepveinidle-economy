import type { GameData, Monster, Options } from '../types.ts'
import type { PriceBook } from './price.ts'
import { combatMult, type PlayerState } from './player.ts'

/**
 * 战斗（打野）收益。
 *
 * 怪物字段：level / hp / maxHit / attack / defence / speed / xp
 *          gold:[min,max] / drop:itemId / bonus:{itemId,chance}
 *
 * ✅ 能精确算的（每只怪的收益）：
 *   金币（区间，取期望）、掉落物品、概率额外掉落、经验
 *
 * ⚠️ **算不了的是「每小时打多少只」** ——
 *   那需要玩家自己的攻击力 / 战斗属性，而静态页拿不到存档。
 *   所以这里让玩家直接填「每小时击杀数」或「每只耗时」，
 *   就像 milkonomy 那类工具的做法：把算不出来的作为输入，而不是假装能算。
 *
 * 这个取舍是有意的：**宁可让用户填一个数，也不要给一个看起来精确、
 * 实际是瞎编的公式。**
 */

export interface CombatInput {
  monsterId: number
  /** 每小时击杀数；与 secondsPerKill 二选一 */
  killsPerHour?: number
  /** 每只耗时（秒）。填了它优先于 killsPerHour */
  secondsPerKill?: number
  /** 玩家当前装备的额外掉落加成（来自装备/工具），会叠加到怪物的 bonus 上 */
  extraDropChance?: number
}

export interface CombatResult {
  monster: Monster
  name: string
  level: number
  /** 每小时击杀数（由输入推导） */
  killsPerHour: number
  /** 每只金币期望 */
  goldPerKill: number
  goldPerHour: number
  /** 每只掉落物品数量（含额外掉落的期望） */
  dropPerKill: number
  dropPerHour: number
  /** 掉落物品的市场价值合计 */
  dropValuePerHour: number
  /** 每只经验 */
  xpPerKill: number
  xpPerHour: number
  /** 合计收益（金币 + 掉落物价值） */
  totalPerHour: number
  /** 战斗加成倍率 */
  mult: number
  /** 战斗能不能打得过（怪物攻击 vs 一个可填的血线），仅提示 */
  riskNote: string
  warnings: string[]
}

export function combatMultFor(data: GameData, p: PlayerState | null): number {
  return p ? combatMult(data, p) : 1
}

export function analyseCombat(
  data: GameData,
  book: PriceBook,
  input: CombatInput,
  opts: Options,
  player: PlayerState | null = null,
): CombatResult | null {
  const m = data.monsters.find((x) => x.id === Number(input.monsterId))
  if (!m) return null

  const warnings: string[] = []

  /* ── 击杀频率：只能由输入决定 ── */
  let killsPerHour: number
  if (input.secondsPerKill && input.secondsPerKill > 0) {
    killsPerHour = 3600 / input.secondsPerKill
  } else if (input.killsPerHour && input.killsPerHour > 0) {
    killsPerHour = input.killsPerHour
  } else {
    warnings.push('未提供击杀频率（每小时击杀数或每只耗时），以下收益按每小时 1 只计算')
    killsPerHour = 1
  }

  /* ── 金币：区间取期望 ── */
  const goldRange = Array.isArray(m.gold) ? m.gold : [0, 0]
  const goldMin = Number(goldRange[0] ?? 0)
  const goldMax = Number(goldRange[1] ?? goldMin)
  const goldPerKill = (goldMin + goldMax) / 2
  if (goldMax > goldMin) {
    warnings.push(`金币是区间（${goldMin}~${goldMax}），已按期望值 ${goldPerKill} 计算`)
  }

  /* ── 掉落 ── */
  const dropItem = book.item(m.drop)
  const bonusChance = (m.bonus?.chance ?? 0) + (input.extraDropChance ?? 0)
  const dropPerKill = 1 + bonusChance
  const dropValueEach = book.revenue(m.drop, opts).value
  const dropValuePerHour = dropValueEach * dropPerKill * killsPerHour

  const goldPerHour = goldPerKill * killsPerHour
  const mult = combatMultFor(data, player)
  const xpPerKill = m.xp * mult
  const xpPerHour = xpPerKill * killsPerHour

  // 风险提示：拿怪物攻击与玩家等级做粗略对照（不是判定，只是提醒）
  const riskNote = m.attack > 0
    ? `怪物攻击 ${m.attack} · 血量 ${m.hp} · 需自己判断能否打得过`
    : ''

  if (m.bonus) {
    warnings.push(
      `额外掉落 ${book.itemName(m.bonus.itemId)} 概率 ${(m.bonus.chance * 100).toFixed(2)}%` +
      (input.extraDropChance ? `（已额外叠加 ${(input.extraDropChance * 100).toFixed(2)}%）` : ''),
    )
  }
  if (!dropItem) warnings.push(`掉落物品 #${m.drop} 不在物品表里，价值按 0 计`)

  return {
    monster: m,
    name: m.name,
    level: m.level,
    killsPerHour,
    goldPerKill,
    goldPerHour,
    dropPerKill,
    dropPerHour: dropPerKill * killsPerHour,
    dropValuePerHour,
    xpPerKill,
    xpPerHour,
    totalPerHour: goldPerHour + dropValuePerHour,
    mult,
    riskNote,
    warnings,
  }
}

/** 批量：所有怪物的每小时收益（同一套击杀频率假设） */
export function combatAll(
  data: GameData,
  book: PriceBook,
  opts: Options,
  freq: { killsPerHour?: number; secondsPerKill?: number },
  player: PlayerState | null = null,
): CombatResult[] {
  const out: CombatResult[] = []
  for (const m of data.monsters) {
    const r = analyseCombat(data, book, { monsterId: m.id, ...freq }, opts, player)
    if (r) out.push(r)
  }
  return out
}
