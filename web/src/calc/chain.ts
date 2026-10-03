import type { ChainResult, ChainStep, GameData, Options, StepResult } from '../types.ts'
import type { PriceBook } from './price.ts'
import type { StepCalc } from './steps.ts'

/**
 * 整链核算。
 *
 * 核心机制：**中间品 0 价内部流转**。
 * 拼一条链时，把上游的产物与下游对应的原料都按 0 价记账，
 * 于是整链只认两笔账：
 *   · 买进来的第一批原料（成本）
 *   · 最后卖出去的成品（收入）
 *
 * 为什么必须这么做：否则同一个中间品会被重复计价 ——
 * 上游卖出算一次收入，下游买入又算一次成本，利润凭空蒸发或翻倍。
 * 这是自研利润工具最常见的错误来源。
 */
export class ChainCalc {
  private readonly steps: StepCalc

  constructor(_data: GameData, _book: PriceBook, steps: StepCalc) {
    this.steps = steps
  }

  /**
   * 沿链条往前回溯，自动补全缺失的中间环节。
   *
   * 例：用户只点了「Steel shield」，但它的原料是「Steel bar」，
   * 而 Steel bar 又是从「Iron ore」炼出来的 —— 缺的两步自动补上。
   *
   * @param endActionId 成品配方
   * @param opts 目标等级用于挑选可行的前置配方
   */
  autoChain(endActionId: number, opts: Options): ChainStep[] {
    const out: ChainStep[] = []
    const seen = new Set<number>()

    const visit = (id: number, depth: number): void => {
      // DVI 的链条最深只有 3 层（实测），但仍然设上限防止数据异常时死循环
      if (depth > 6 || seen.has(id)) return
      seen.add(id)

      const a = this.steps.action(id)
      if (!a) return

      // 先把原料的前置补上，再把自己放进链里 —— 保证顺序是「先料后成品」
      for (const inp of a.inputs) {
        // 优先选「能做且等级要求最低」的产出配方，避免跳到高级材料上去
        const producers = this.steps.producersOf(inp.itemId)
          .filter(p => !opts.playerLevel || p.levelReq <= opts.playerLevel)
          .sort((x, y) => x.levelReq - y.levelReq)
        const pick = producers[0] ?? producers[0]
        if (pick && pick.id !== id) visit(pick.id, depth + 1)
      }
      out.push({ actionId: a.id })
    }

    visit(Number(endActionId), 0)
    return out
  }

  /** 跑一条链 */
  run(chain: ChainStep[], opts: Options): ChainResult | null {
    if (!chain.length) return null
    const warnings: string[] = []

    /* ── 第 1 趟：索引每个物品由哪一步产出 ── */
    const producedAt = new Map<number, number>()   // itemId → 步骤下标
    const results: StepResult[] = []
    for (let i = 0; i < chain.length; i++) {
      const a = this.steps.action(chain[i].actionId)
      if (!a) { warnings.push(`第 ${i + 1} 步找不到配方 #${chain[i].actionId}`); return null }
      if (a.output && !producedAt.has(a.output.itemId)) producedAt.set(a.output.itemId, i)
    }

    /* ── 第 2 趟：找出「中间品」──
     * 判据：某个物品被**前面某一步**产出，且被**后面某一步**消耗。
     *
     * ⚠️ 这里必须扫全链，不能只看「紧邻的下一位」。
     * 真实的配方拓扑是**分叉**的，例如：
     *     Copper ─┐
     *     Tin    ─┴→ Bronze bar
     * Copper 后面并没有紧邻的消费者，若只看下一位就会漏判，
     * 导致中间品被当成终端品卖一次、又在下一步算一次成本 ——
     * **重复计价，利润凭空蒸发**。这正是整链核算最容易踩的坑。 */
    const internal = new Set<number>()
    for (let i = 0; i < chain.length; i++) {
      const a = this.steps.action(chain[i].actionId)!
      for (const inp of a.inputs) {
        const p = producedAt.get(inp.itemId)
        if (p != null && p < i) internal.add(inp.itemId)
      }
    }

    /* ── 第 3 趟：带 0 价覆盖逐步计算 ──
     * 中间品既不计收入也不计成本，整链只认两笔账：
     *   · 买进来的第一批原料（没有上游的那部分）
     *   · 最后卖出去的成品（没有下游的那部分） */
    const last = chain.length - 1
    for (let i = 0; i < chain.length; i++) {
      const a = this.steps.action(chain[i].actionId)!

      const ov = new Map<number, number>()
      // 本步产出是中间品 → 收入计 0
      if (a.output && internal.has(a.output.itemId)) ov.set(a.output.itemId, 0)
      // 本步原料是中间品 → 成本计 0
      for (const inp of a.inputs) {
        if (internal.has(inp.itemId)) ov.set(inp.itemId, 0)
      }
      // 显式对齐仍然有效：用户可以指定这一步只跟某个上游衔接
      const alignNext = i < last ? chain[i + 1].alignItemId : undefined
      if (alignNext != null) {
        // 指定了对齐物品，则只把该物品当内部流转，其余原料照常计价
        for (const k of [...ov.keys()]) if (k !== alignNext) ov.delete(k)
      }

      const r = this.steps.run(a, opts, ov)
      if (!r) { warnings.push(`第 ${i + 1} 步「${a.name}」无法计算`); return null }
      if (!r.available) warnings.push(`第 ${i + 1} 步「${a.name}」需要 Lv${a.levelReq}，当前等级不够`)
      results.push(r)
    }

    /* 整链账目：只认「买进来的第一批原料」与「最后卖出去的成品」 */
    let cost = 0
    let income = 0
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (i === 0) cost += r.cost          // 第一步的原料是真的要买的
      if (i === last) income += r.income   // 最后一步的成品是真的要卖的
    }

    // 整链耗时：各步串行相加。并行口径下 farming 的等待已被剔除
    const totalSeconds = results.reduce((s, r) => s + r.seconds, 0)
    const net = income - cost
    const perHour = totalSeconds > 0 ? 3600 / totalSeconds : 0

    // 瓶颈：耗时最长的那一步
    let bottleneck: number | null = null
    let worst = -1
    results.forEach((r, i) => { if (r.seconds > worst) { worst = r.seconds; bottleneck = i } })

    return {
      steps: results,
      cost,
      income,
      net,
      netPerHour: net * perHour,
      bottleneck,
      warnings,
    }
  }

  /** 跑某条链，自动补全前置 */
  runAuto(endActionId: number, opts: Options): ChainResult | null {
    return this.run(this.autoChain(endActionId, opts), opts)
  }

  /**
   * 把整张图铺开：对每个可产出物品，算出「从原料到它」的完整成本。
   *
   * DVI 的链条最深只有 3 层（实测 63/72/83 种物品分布在深度 1/2/3），
   * 所以**可以一次性把整张图算完**，不需要懒加载或增量计算。
   */
  fullGraph(opts: Options): Map<number, ChainResult> {
    const out = new Map<number, ChainResult>()
    for (const a of this.steps.allActions()) {
      if (!a.output) continue
      const r = this.runAuto(a.id, opts)
      if (r) out.set(a.output.itemId, r)
    }
    return out
  }

  /** 统计产业链深度分布，用于诊断面板 */
  depthHistogram(): Record<number, number> {
    const memo = new Map<number, number>()
    const depth = (itemId: number, guard = 0): number => {
      if (memo.has(itemId)) return memo.get(itemId)!
      if (guard > 8) return 0
      memo.set(itemId, 0)                    // 防环
      const producers = this.steps.producersOf(itemId)
      if (!producers.length) { memo.set(itemId, 0); return 0 }
      let best = 0
      for (const p of producers) {
        if (!p.inputs?.length) best = Math.max(best, 1)
        else best = Math.max(best, 1 + Math.max(...p.inputs.map(i => depth(i.itemId, guard + 1))))
      }
      memo.set(itemId, best)
      return best
    }
    const hist: Record<number, number> = {}
    for (const a of this.steps.allActions()) {
      if (!a.output) continue
      const d = depth(a.output.itemId)
      hist[d] = (hist[d] || 0) + 1
    }
    return hist
  }
}
