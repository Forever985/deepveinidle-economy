import type { GameData, Options, StepResult } from '../types.ts'
import type { PriceBook } from './price.ts'
import type { StepCalc } from './steps.ts'
import type { ChainCalc } from './chain.ts'

/**
 * 利润排行。
 *
 * 关键点：**排行要按「整链」排，不是按单步**。
 * 一件成品的价格里含着原料成本，只看单步的「加价」会严重误导 ——
 * 高价值原料加工出来的东西，加价可能很小但绝对利润很高。
 * 所以每行都给两套数字：单步（只做这一步）与整链（自己备齐原料）。
 */

export type SortKey =
  | 'chainNet'      // 整链净利/小时（自己备料，最真实）
  | 'stepNet'       // 单步净利/小时（假设原料外购）
  | 'chainAdd'      // 整链单次加价
  | 'xp'            // 经验/小时
  | 'value'         // 成品价值
  | 'level'         // 等级门槛
  | 'tick'          // 单次耗时

export interface Row {
  actionId: number
  name: string
  skill: string
  group: string
  levelReq: number
  step: StepResult
  /** 整链结果（自己备齐原料） */
  chainNetPerHour: number
  chainAdd: number
  chainSeconds: number
  chainDepth: number
  /** 成品能卖出的最大数量（挂单量限制）。0 表示当前挂单为 0 */
  sellable: number
  /** 收益来源 */
  priceSource: string
  hasMarket: boolean
}

export interface RankFilter {
  skill?: string
  maxLevel?: number
  /** 只看有市场价的 */
  onlyMarket?: boolean
  /** 只看非负利润 */
  onlyPositive?: boolean
  keyword?: string
}

export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'chainNet', label: '整链净利/小时' },
  { key: 'stepNet', label: '单步净利/小时' },
  { key: 'chainAdd', label: '整链单次加价' },
  { key: 'xp', label: '经验/小时' },
  { key: 'value', label: '成品价值' },
  { key: 'tick', label: '单次耗时' },
  { key: 'level', label: '等级门槛' },
]

export class Rank {
  private _rows: Row[] = []
  private _built = false

  private readonly data: GameData
  private readonly book: PriceBook
  private readonly steps: StepCalc
  private readonly chain: ChainCalc

  constructor(data: GameData, book: PriceBook, steps: StepCalc, chain: ChainCalc) {
    this.data = data
    this.book = book
    this.steps = steps
    this.chain = chain
  }

  /** 构建排行（较贵，参数不变时可复用） */
  build(opts: Options): Row[] {
    const graph = this.chain.fullGraph(opts)
    const depthOf = this.depthMap()

    const rows: Row[] = []
    for (const step of this.steps.runAll(opts)) {
      if (!step.action.output) continue
      const outId = step.action.output.itemId
      const cr = graph.get(outId)
      const rev = this.book.revenue(outId, opts)
      const sellable = this.book.maxSellable(outId, 'ask')

      rows.push({
        actionId: step.action.id,
        name: step.action.name,
        skill: step.action.skill,
        group: step.action.group,
        levelReq: step.action.levelReq,
        step,
        chainNetPerHour: cr ? cr.netPerHour : step.netPerHour,
        chainAdd: cr ? cr.income - cr.cost : step.income - step.cost,
        chainSeconds: cr ? cr.steps.reduce((s, r) => s + r.seconds, 0) : step.seconds,
        chainDepth: depthOf.get(outId) ?? 0,
        sellable,
        priceSource: rev.source,
        hasMarket: rev.source === 'market',
      })
    }
    this._rows = rows
    this._built = true
    return rows
  }

  /** 每个产物的产业链深度 */
  private depthMap(): Map<number, number> {
    const memo = new Map<number, number>()
    const depth = (itemId: number, guard = 0): number => {
      if (memo.has(itemId)) return memo.get(itemId)!
      if (guard > 8) return 0
      memo.set(itemId, 0)
      const ps = this.steps.producersOf(itemId)
      if (!ps.length) return 0
      let best = 0
      for (const p of ps) {
        if (!p.inputs?.length) best = Math.max(best, 1)
        else best = Math.max(best, 1 + Math.max(...p.inputs.map(i => depth(i.itemId, guard + 1))))
      }
      memo.set(itemId, best)
      return best
    }
    for (const a of this.steps.allActions()) {
      if (a.output) depth(a.output.itemId)
    }
    return memo
  }

  get rows(): Row[] {
    return this._rows
  }

  filter(f: RankFilter): Row[] {
    const kw = f.keyword?.trim().toLowerCase()
    return this._rows.filter(r => {
      if (f.skill && f.skill !== '__all' && r.skill !== f.skill) return false
      if (f.maxLevel != null && f.maxLevel > 0 && r.levelReq > f.maxLevel) return false
      if (f.onlyMarket && !r.hasMarket) return false
      if (f.onlyPositive && r.chainNetPerHour <= 0) return false
      if (kw && !(`${r.name} ${r.group} ${r.skill}`.toLowerCase().includes(kw))) return false
      return true
    })
  }

  sort(rows: Row[], key: SortKey, desc = true): Row[] {
    const val = (r: Row): number => {
      switch (key) {
        case 'chainNet': return r.chainNetPerHour
        case 'stepNet': return r.step.netPerHour
        case 'chainAdd': return r.chainAdd
        case 'xp': return r.step.xpPerHour
        case 'value': return this.book.item(r.step.action.output!.itemId)?.value ?? 0
        case 'tick': return r.step.ticks
        case 'level': return r.levelReq
        default: return 0
      }
    }
    // 稳定的二级排序：净利相同时按等级门槛，避免行序跳动
    return [...rows].sort((a, b) => {
      const d = val(b) - val(a)
      if (d !== 0) return desc ? d : -d
      return a.levelReq - b.levelReq
    })
  }

  /** 概览统计，给顶部信息条用 */
  summary(): { total: number; positive: number; withMarket: number; skills: number } {
    const skills = new Set(this._rows.map(r => r.skill))
    return {
      total: this._rows.length,
      positive: this._rows.filter(r => r.chainNetPerHour > 0).length,
      withMarket: this._rows.filter(r => r.hasMarket).length,
      skills: skills.size,
    }
  }
}
