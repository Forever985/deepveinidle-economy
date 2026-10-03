import type { GameData, Item, MarketSnapshot, Options, Price, PriceSource } from '../types.ts'

/**
 * 三层价格来源。
 *
 * 为什么要分层而不是二选一：
 *   「原料按市场价算」和「原料按自产成本算」常常得出相反的结论，
 *   所以既不该二选一，也不该混着用 —— 而是**每个数字都带来源标记**，
 *   让人随时能看出这个价从哪来。UI 上用小圆点标出来。
 *
 * 取价优先级：手动 > 市场 > 兜底
 * 方向：   成本按 ask（挂出能拿到的价），收益按 bid（卖给收购单的价）—— 保守口径。
 */

export const SRC_LABEL: Record<PriceSource, string> = {
  market: '市场价',
  fallback: '兜底价',
  manual: '手动价',
}

export class PriceBook {
  // 注：这里刻意用「显式字段 + 构造函数赋值」而不是构造函数参数属性
  // （constructor(private x: T)）。因为本层要能被 Node 直接跑测试，
  // 而 Node 的类型剥离模式不支持参数属性语法。
  private readonly items = new Map<number, Item>()
  /** 市场快照：itemId → { ask, bid }。可随时灌入新数据 */
  private market = new Map<number, MarketSnapshot>()
  /** 手动指定价：itemId → price */
  private manual = new Map<number, number>()

  constructor(data: GameData) {
    for (const it of data.items) this.items.set(it.id, it)
  }

  item(id: number): Item | undefined {
    return this.items.get(Number(id))
  }

  itemName(id: number): string {
    return this.items.get(Number(id))?.name ?? `#${id}`
  }

  /** 灌入一批市场快照 */
  setMarket(map: Map<number, MarketSnapshot>): void {
    this.market = map
  }

  setManual(id: number, price: number | null): void {
    const k = Number(id)
    if (price == null || !Number.isFinite(price) || price < 0) this.manual.delete(k)
    else this.manual.set(k, price)
  }

  manualAll(): Record<string, number> {
    return Object.fromEntries(this.manual)
  }

  loadManual(obj: Record<string, number> | null | undefined): number {
    if (!obj || typeof obj !== 'object') return 0
    let n = 0
    for (const [k, v] of Object.entries(obj)) {
      const id = Number(k)
      const p = Number(v)
      if (Number.isFinite(id) && Number.isFinite(p) && p >= 0) {
        this.manual.set(id, p)
        n++
      }
    }
    return n
  }

  clearManual(): void {
    this.manual.clear()
  }

  /** 有市场价的物品数（用于诊断面板） */
  marketCount(): number {
    return this.market.size
  }

  /**
   * 取一个物品在指定方向上的价格。
   * @param side 'ask' 成本方向（保守：你得挂出去才卖得掉）
   *             'bid' 收益方向（保守：直接卖给收购单）
   */
  price(itemId: number, side: 'ask' | 'bid'): Price {
    const id = Number(itemId)

    const m = this.manual.get(id)
    if (m != null) return { value: m, source: 'manual', side, qty: Infinity }

    const q = this.market.get(id)
    if (q) {
      const pick = side === 'ask' ? q.ask : q.bid
      // 另一个方向也能用，但要标明用的是哪一边
      const alt = side === 'ask' ? q.bid : q.ask
      const chosen = pick ?? alt
      if (chosen) {
        return { value: chosen.price, source: 'market', side: pick ? side : (side === 'ask' ? 'bid' : 'ask'), qty: chosen.qty }
      }
    }

    const it = this.items.get(id)
    return { value: it?.value ?? 0, source: 'fallback', side }
  }

  /** 成本：按 ask 算 */
  cost(itemId: number): Price {
    return this.price(itemId, 'ask')
  }

  /** 收益：按 opts 指定的侧算，默认 bid（保守） */
  revenue(itemId: number, opts: Options): Price {
    return this.price(itemId, opts.revenueSide === 'ask' ? 'ask' : 'bid')
  }

  /** 这个价格能不能真的成交（挂单量是否够） */
  sellable(p: Price, want: number): boolean {
    if (p.qty == null) return false
    return p.qty >= want
  }

  /**
   * 挂单量不足时，实际能卖出多少。
   * 价差再大，量只有 1 也卖不掉 —— 这是「高利润 ≠ 可成交」的原因。
   */
  maxSellable(itemId: number, side: 'ask' | 'bid'): number {
    const q = this.market.get(Number(itemId))
    if (!q) return Infinity
    const pick = side === 'ask' ? q.ask : q.bid
    const alt = side === 'ask' ? q.bid : q.ask
    return (pick ?? alt)?.qty ?? 0
  }
}
