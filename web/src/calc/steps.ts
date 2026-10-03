import type { Action, Factor, GameData, Options, Slot, StepResult } from '../types.ts'
import type { PriceBook } from './price.ts'
import { bonusQty, effectiveTicks, failRate, ticksToSeconds } from './expected.ts'

/**
 * 单个配方的利润计算。
 *
 * 口径（保守，不虚高）：
 *   · 成本按 **ask**（你得挂出去才卖得掉原料）
 *   · 收益按 **bid**（直接卖给收购单，见 milkonomy 的做法）
 *   · 卖出扣 2% 市场税
 *   · 失败（烧焦/被抓）按期望值摊进成本与工时
 *   · 额外掉落按概率计入产出
 *
 * 返回的 factors 会说明「这个数被哪些因素改过」——
 * UI 上要能让人看见数字不是凭空来的。
 */
export class StepCalc {
  private readonly byId = new Map<number, Action>()

  private readonly data: GameData
  private readonly book: PriceBook

  constructor(data: GameData, book: PriceBook) {
    this.data = data
    this.book = book
    for (const a of data.actions) this.byId.set(a.id, a)
  }

  action(id: number): Action | undefined {
    return this.byId.get(Number(id))
  }

  allActions(): Action[] {
    return [...this.byId.values()]
  }

  /** 产出这个物品的配方（可能多个） */
  producersOf(itemId: number): Action[] {
    return this.allActions().filter(a => a.output?.itemId === Number(itemId))
  }

  /**
   * @param overrides 内部流转覆盖：{ itemId: 0 } 表示这个物品当 0 价处理。
   *        这是整链核算的关键 —— 中间品既不计成本也不计收入，
   *        整链只用「买进来的第一批原料」和「最后卖出去的成品」记账。
   *        （中间品重复计价是自研利润工具最常见的错误来源。）
   */
  run(action: Action, opts: Options, overrides: Map<number, number> = new Map()): StepResult | null {
    if (!action?.output || !(action.output.qty > 0)) return null

    const factors: Factor[] = []
    const attempts = 1 / Math.max(1e-6, 1 - failRate(action, opts))
    const rate = failRate(action, opts)

    /* ── 时间 ── */
    const ticks = effectiveTicks(action, opts)
    if (!(ticks > 0)) return null
    const seconds = ticksToSeconds(ticks)

    if (action.grow) {
      factors.push({
        label: '生长',
        detail: opts.parallelGrow
          ? `生长 ${action.grow} tick 不计入工时（并行口径：等待期去干别的）`
          : `含生长 ${action.grow} tick（单线程口径：全额计入）`,
        mult: 1,
      })
    }
    if (rate > 0) {
      factors.push({
        label: action.burn ? '烧焦' : '被抓',
        detail: `失败率 ${(rate * 100).toFixed(1)}% → 期望尝试 ${attempts.toFixed(2)} 次`,
        mult: attempts,
      })
    }

    /* ── 产出（含额外掉落） ── */
    const outQty = action.output.qty + bonusQty(action)
    if (action.bonus) {
      factors.push({
        label: '额外掉落',
        detail: `${(action.bonus.chance * 100).toFixed(2)}% 概率多出 1 个 ${this.book.itemName(action.bonus.itemId)}`,
        mult: 1,
      })
    }

    /* ── 成本 ── */
    // 失败要多试几次，原料也跟着多花
    const expectedIn: Slot[] = action.inputs.map(i => ({
      itemId: i.itemId,
      qty: i.qty * attempts,
    }))
    let cost = 0
    for (const i of expectedIn) {
      const ov = overrides.get(i.itemId)
      const p = ov != null ? { value: ov, source: 'manual' as const, side: 'ask' as const, qty: Infinity }
                          : this.book.cost(i.itemId)
      cost += p.value * i.qty
    }

    /* ── 收入 ── */
    const outOv = overrides.get(action.output.itemId)
    const rp = outOv != null
      ? { value: outOv, source: 'manual' as const, side: 'ask' as const, qty: Infinity }
      : this.book.revenue(action.output.itemId, opts)
    const tax = (opts.taxBp ?? 200) / 10000
    const income = rp.value * outQty * (1 - tax)

    const perHour = 3600 / seconds
    const net = income - cost

    return {
      action,
      /* 用 == null 而不是 !playerLevel ——
       * 等级 0 是「一个真实但很低的等级」，不能被当成「未设置」。
       * （曾用 !playerLevel，导致 playerLevel=0 时不过滤任何东西。） */
      available: opts.playerLevel == null || action.levelReq <= opts.playerLevel,
      expectedOut: outQty,
      expectedIn,
      ticks,
      seconds,
      cost,
      income,
      net,
      netPerHour: net * perHour,
      xpPerHour: (action.xp || 0) * perHour,
      factors,
    }
  }

  /** 跑全部配方 */
  runAll(opts: Options): StepResult[] {
    const out: StepResult[] = []
    for (const a of this.byId.values()) {
      const r = this.run(a, opts)
      if (r) out.push(r)
    }
    return out
  }
}
