import { reactive, watch } from 'vue'
import type { Options } from '../types.ts'

/**
 * 计算口径 + 玩家设置，全部持久化到 localStorage。
 *
 * 这些开关会**显著改变排名**，所以：
 *   ① 默认值要合理（并行为默认，符合放置游戏常态）
 *   ② 界面上必须能看见当前口径
 *   ③ 不要在用户没察觉的情况下改变它们
 */

const KEY = 'dvi-profit-net:settings:v1'

export interface Settings extends Options {
  skill: string
  maxLevel: number
  sortKey: string
  onlyMarket: boolean
  onlyPositive: boolean
  keyword: string
}

const DEFAULTS: Settings = {
  parallelGrow: true,     // 并行：生长等待期去干别的
  revenueSide: 'bid',     // 保守：收益按 bid
  taxBp: 200,             // 2%
  playerLevel: 99,        // 不按等级过滤
  parallelSlots: 1,
  skill: '__all',
  maxLevel: 0,            // 0 = 不限
  sortKey: 'chainNet',
  onlyMarket: false,
  onlyPositive: false,
  keyword: '',
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export const settings = reactive<Settings>(load())

watch(settings, (v) => {
  try { localStorage.setItem(KEY, JSON.stringify(v)) } catch { /* 隐私模式下忽略 */ }
}, { deep: true })

/** 取出计算层要的那部分 */
export function calcOptions(): Options {
  return {
    parallelGrow: settings.parallelGrow,
    revenueSide: settings.revenueSide,
    taxBp: settings.taxBp,
    playerLevel: (settings.playerLevel ?? 0) > 0 ? settings.playerLevel : undefined,
    parallelSlots: settings.parallelSlots,
  }
}

export function resetSettings(): void {
  Object.assign(settings, DEFAULTS)
}
