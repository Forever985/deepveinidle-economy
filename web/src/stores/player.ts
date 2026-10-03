import { reactive, watch } from 'vue'
import { defaultPlayer, type PlayerState } from '../calc/player'

/**
 * 玩家配置。
 *
 * 这些系数会改变**所有**利润结果（采集速度、制作速度、经验、战斗效率），
 * 所以持久化保存，改一次全局生效。
 *
 * 与 dvi-tools 主干同一原则：玩家相关的量按当前存档填，不写死默认值。
 */

const KEY = 'dvi-profit-net:player:v1'

function load(): PlayerState {
  const base = defaultPlayer()
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return base
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return base
    return { ...base, ...o, levels: o.levels ?? {}, perkRanks: o.perkRanks ?? {}, tools: o.tools ?? {} }
  } catch {
    return base
  }
}

export const player = reactive<PlayerState>(load())

watch(player, (v) => {
  try { localStorage.setItem(KEY, JSON.stringify(v)) } catch { /* 隐私模式下忽略 */ }
}, { deep: true })

export function resetPlayer(): void {
  Object.assign(player, defaultPlayer())
}
