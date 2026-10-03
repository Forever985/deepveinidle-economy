import type { Action, FailSpec, Options } from '../types.ts'

/**
 * 期望值：DVI 特有的四类修正，全在这一层，别的模块不用操心。
 *
 * ⚠️ 公式来源说明（重要）：
 *   下面这些公式是**从字段名与取值反推的合理形式**，不是从游戏代码里读出来的
 *   精确实现。其中失败率的「线性衰减」尤其需要用真实数据校验
 *   （见 DVI-PROFIT-NET-ANALYSIS.md 第七节的待办）。
 *   一旦游戏改版或实测不符，改这一个文件即可，其余模块不受影响。
 */

/** 1 tick = 600ms（实测确认，不是 1 秒） */
export const TICK_SECONDS = 0.6
export const HOUR_TICKS = 3600 / TICK_SECONDS   // 6000

export function ticksToSeconds(t: number): number {
  return t * TICK_SECONDS
}

/**
 * 失败率：达到需求等级时是 chanceAtReq，随等级线性降到 safeAtLevel 处的 0。
 *
 * 例：Cook shrimp  chanceAtReq=0.3  safeAtLevel=26  需求 Lv1
 *     Lv1 → 30%   Lv13 → 15%   Lv26 → 0%
 */
export function failChance(action: Action, spec: FailSpec, level: number): number {
  const lv = Number.isFinite(level) ? level : action.levelReq
  const span = spec.safeAtLevel - action.levelReq
  if (span <= 0) return 0
  const remain = (spec.safeAtLevel - lv) / span
  const k = Math.max(0, Math.min(1, remain))
  return Math.max(0, Math.min(1, spec.chanceAtReq * k))
}

/** 该配方当前会不会失败 */
export function failRate(action: Action, opts: Options): number {
  const lv = opts.playerLevel ?? action.levelReq
  if (action.burn) return failChance(action, action.burn, lv)
  if (action.caught) return failChance(action, action.caught, lv)
  return 0
}

/**
 * 失败会额外消耗多少原料。
 * 游戏里失败是「产物烧掉/被抓」，原料已经花了 —— 所以原料要按
 * 「成功 1 件 + 失败 N 件」的期望次数来买。
 */
export function expectedAttempts(rate: number): number {
  // rate=0 → 1 次；rate→1 → 趋近无穷（数学上无法完成）
  return 1 / Math.max(1e-6, 1 - rate)
}

/** 额外掉落的期望件数 */
export function bonusQty(action: Action): number {
  return action.bonus ? action.bonus.chance : 0
}

/**
 * 单次「动手」周期的工时（tick）。
 *
 * ★ 这里体现 DVI 与普通 crafting 最大的不同：
 *   `baseTicks` 只是**动手时间**，farming 还有 `grow`（生长等待）。
 *   两种口径结论完全相反，所以必须显式选：
 *     并行（默认）：生长期间去干别的，只按动手时间计工时
 *     单线程：种下去就干等，生长时间全额计入
 */
export function workTicks(action: Action, opts: Options): number {
  const base = action.baseTicks || 0
  if (!action.grow) return base
  if (opts.parallelGrow) {
    // 并行：动手时间照算。种得多快取决于同时照料几块地，
    // 但那部分由「每块地的占坑时间」体现，不摊到单件工时里。
    return base
  }
  return base + action.grow
}

/** 被抓后晕眩造成的额外时间损失（tick），按失败概率计入期望 */
export function stunCost(action: Action, opts: Options): number {
  if (!action.caught?.stunTicks) return 0
  return failRate(action, opts) * action.caught.stunTicks
}

/**
 * 一次「成功产出」所需的期望工时（tick）。
 * 失败要多试几次，每次都花工时 —— 所以工时也要乘上尝试次数。
 */
export function effectiveTicks(action: Action, opts: Options): number {
  const rate = failRate(action, opts)
  const per = workTicks(action, opts) + stunCost(action, opts)
  return per * expectedAttempts(rate)
}
