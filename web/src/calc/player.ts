import type { GameData } from '../types.ts'

/**
 * 玩家状态 —— 影响**所有**利润计算的一组系数。
 *
 * 为什么单独一层：
 *   同一个配方在不同玩家手里利润完全不同（吃了增益、带了工具、点了特权之后）。
 *   这些系数若散落在各个计算里，改一处就会漏另一处。
 *   所以统一在这里建模，页面改一次、全部重算。
 *
 * ⚠️ 口径与 dvi-tools 主干一致：玩家相关的量**必须按当前存档现算**，
 *   不能写死。这里的字段是「输入」，由玩家按自己的存档填。
 */

/** 采集系技能 —— 吃采集增益与采集祝福 */
export const GATHER_SKILLS = ['mining', 'fishing', 'woodcutting', 'farming']
/** 战斗祝福作用于战斗，不作用于采集 */
export const COMBAT = 'combat'

export interface Perk {
  id: string
  name: string
  lane: string
  perRank: number
  unit: string
}

export interface PlayerState {
  /** 各技能等级，key = skill */
  levels: Record<string, number>
  /** 采集增益层数（0 表示无） */
  buffTier: number
  /** 战斗增益层数 */
  combatBuffTier: number
  /** 祝福是否生效 */
  blessing: boolean
  /** 社区活动经验倍率，1 = 无活动 */
  communityMult: number
  /** 特权等级，key = perk.id */
  perkRanks: Record<string, number>
  /** 已装备工具，key = 槽位（pickaxe/rod/axe/…），值为物品 id */
  tools: Record<string, number>
  /** 精通等级 */
  mastery: number
}

export function defaultPlayer(): PlayerState {
  return {
    levels: {},
    buffTier: 0,
    combatBuffTier: 0,
    blessing: false,
    communityMult: 1,
    perkRanks: {},
    tools: {},
    mastery: 0,
  }
}

/* ───────────── 数据表读取（都来自 balance-extra.json） ───────────── */

export function perksOf(data: GameData): Perk[] {
  const raw = (data.extra as Record<string, unknown>)?.perks
  return Array.isArray(raw) ? (raw as Perk[]) : []
}

export function buffTierMults(data: GameData): number[] {
  const v = (data.extra as any)?.buffTierMults
  return Array.isArray(v) ? v : [1]
}

export function blessingMults(data: GameData): { gather: number; combat: number } {
  const v = (data.extra as any)?.blessing ?? (data.extra as any)?.buffPerRank
  return { gather: v?.gather ?? 1, combat: v?.combat ?? 1 }
}

export function toolSlots(data: GameData): Record<string, string> {
  return (data.extra as any)?.toolSlots ?? {}
}

export function toolBonus(data: GameData, itemId: number): number {
  const list = (data.extra as any)?.toolBonuses
  if (!Array.isArray(list)) return 0
  return list.find((t: any) => Number(t.itemId) === Number(itemId))?.bonus ?? 0
}

/** 某个槽位可选的工具（该槽位所有加成不为 0 的物品） */
export function toolsForSlot(data: GameData, slot: string): { itemId: number; bonus: number }[] {
  const list = (data.extra as any)?.toolBonuses
  if (!Array.isArray(list)) return []
  return list
    .filter((t: any) => t.slot === slot)
    .map((t: any) => ({ itemId: Number(t.itemId), bonus: Number(t.bonus) }))
    .filter((t: any) => t.bonus > 0)
}

/** 层数 → 倍率（越界取最后一档） */
export function tierMult(tier: number, table: number[]): number {
  if (!tier || tier <= 0) return 1
  return table[Math.min(tier, table.length) - 1] ?? 1
}

/* ───────────── 核心：算出某技能的总倍率 ───────────── */

/**
 * 速度/产出总倍率。
 * @param kind 'gather' 走采集增益路线；'craft' 走制作特权路线
 */
export function skillMult(data: GameData, p: PlayerState, skill: string): number {
  let m = 1
  const isGather = GATHER_SKILLS.includes(skill)

  if (isGather) {
    m *= tierMult(p.buffTier, buffTierMults(data))
    if (p.blessing) m *= blessingMults(data).gather
  }
  m *= perkMult(data, p, isGather ? 'gather' : 'craft')
  m *= equippedToolMult(data, p, skill)
  if (p.communityMult > 0) m *= p.communityMult

  return m
}

function perkMult(data: GameData, p: PlayerState, perkId: string): number {
  const rank = p.perkRanks[perkId] ?? 0
  if (!rank) return 1
  const pk = perksOf(data).find((x) => x.id === perkId)
  if (!pk) return 1
  return 1 + pk.perRank * rank
}

function equippedToolMult(data: GameData, p: PlayerState, skill: string): number {
  let m = 1
  const slots = toolSlots(data)
  for (const [slot, itemId] of Object.entries(p.tools)) {
    if (slots[slot] !== skill) continue
    m *= 1 + toolBonus(data, Number(itemId))
  }
  return m
}

/** 战斗倍率：战斗增益 + 战斗祝福 + 社区活动 */
export function combatMult(data: GameData, p: PlayerState): number {
  let m = tierMult(p.combatBuffTier, buffTierMults(data))
  if (p.blessing) m *= blessingMults(data).combat
  if (p.communityMult > 0) m *= p.communityMult
  return m
}

/* ───────────── 与计算口径的衔接 ───────────── */

/** 该玩家在某个技能上的最高可用等级（用于「我能做哪些」过滤） */
export function levelFor(p: PlayerState, skill: string): number {
  return p.levels[skill] ?? 0
}

/**
 * 玩家是否做过任何配置。
 * 全是默认值时返回 false —— 界面据此提示「还没配置玩家数据」。
 */
export function isPristine(p: PlayerState): boolean {
  return (
    Object.keys(p.levels).length === 0 &&
    !p.buffTier && !p.combatBuffTier && !p.blessing &&
    p.communityMult === 1 &&
    Object.keys(p.perkRanks).length === 0 &&
    Object.keys(p.tools).length === 0
  )
}

/** 把玩家配置存/读（localStorage 由调用方负责） */
export function serialize(p: PlayerState): string {
  return JSON.stringify(p)
}
export function deserialize(raw: string | null | undefined): PlayerState {
  const base = defaultPlayer()
  if (!raw) return base
  try {
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return base
    return {
      ...base,
      ...o,
      levels: o.levels ?? {},
      perkRanks: o.perkRanks ?? {},
      tools: o.tools ?? {},
    }
  } catch {
    return base
  }
}
