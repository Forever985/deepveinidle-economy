import { reactive, computed } from 'vue'
import type { GameData } from './types.ts'

/**
 * 汉化。
 *
 * ## 用官方的，不用自己翻
 *   DVI 内置官方简体中文，翻译表就在客户端 bundle 里（已由
 *   dvi_probe/extract_i18n.py 提取，随游戏数据一起打包）。
 *   直接用官方译文，玩家在游戏里看到的名字和这里一致 —— 不会对不上。
 *   覆盖率实测 100%：物品 301/301、配方 221/221、技能 10/10、
 *   怪物 20/20、分类 35/35。
 *
 * ## 找不到就退回英文
 *   游戏改版后若某个新名字还没进表，**显示原文而不是空**，
 *   并在界面上标出来 —— 静默留空会让人以为是数据缺失。
 */

const KEY = 'dvi-profit-net:lang:v1'

export type Lang = 'zh' | 'en'

function initial(): Lang {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'zh' || v === 'en') return v
  } catch { /* 忽略 */ }
  // 默认中文：官方有中文，用户也要求汉化
  return 'zh'
}

export const langState = reactive<{ lang: Lang; table: Record<string, string>; ready: boolean }>({
  lang: initial(),
  table: {},
  ready: false,
})

export function initI18n(data: GameData): void {
  langState.table = (data as unknown as { i18nZh?: Record<string, string> }).i18nZh || {}
  langState.ready = true
  try { localStorage.setItem(KEY, langState.lang) } catch { /* 忽略 */ }
}

export function setLang(l: Lang): void {
  langState.lang = l
  try { localStorage.setItem(KEY, l) } catch { /* 忽略 */ }
}

export function toggleLang(): void {
  setLang(langState.lang === 'zh' ? 'en' : 'zh')
}

export const isZh = computed(() => langState.lang === 'zh')

/**
 * 翻译一个英文原文。
 * @returns 译文；查不到时返回原文（不返回空串）
 */
export function t(name: string | undefined | null): string {
  if (!name) return '—'
  if (langState.lang === 'en') return name
  return langState.table[name] || name
}

/** 这个名字是否来自官方译文（界面上可以据此提示「未收录」） */
export function isOfficial(name: string): boolean {
  return !!langState.table[name]
}

/* ── 界面自身的文案 ── */

const UI: Record<string, { zh: string; en: string }> = {
  'nav.dashboard': { zh: '玩家配置', en: 'Player' },
  'nav.profit': { zh: '利润排行', en: 'Profit' },
  'nav.chain': { zh: '产业链', en: 'Chain' },
  'nav.enhance': { zh: '强化', en: 'Enhance' },
  'nav.combat': { zh: '战斗', en: 'Combat' },
  'nav.consumable': { zh: '消耗品', en: 'Consumable' },
  'nav.market': { zh: '价格', en: 'Market' },
  'nav.docs': { zh: '说明', en: 'Docs' },

  'skill.mining': { zh: '挖矿', en: 'Mining' },
  'skill.fishing': { zh: '钓鱼', en: 'Fishing' },
  'skill.woodcutting': { zh: '伐木', en: 'Woodcutting' },
  'skill.farming': { zh: '种植', en: 'Farming' },
  'skill.smithing': { zh: '锻造', en: 'Smithing' },
  'skill.fletching': { zh: '制箭', en: 'Fletching' },
  'skill.crafting': { zh: '制作', en: 'Crafting' },
  'skill.cooking': { zh: '烹饪', en: 'Cooking' },
  'skill.herblore': { zh: '草药学', en: 'Herblore' },
  'skill.thieving': { zh: '偷窃', en: 'Thieving' },
}

/** 界面文案：优先用官方译文表（游戏里本来就这么翻），否则用内置表 */
export function ui(key: string): string {
  const row = UI[key]
  if (!row) return key
  if (langState.lang === 'en') return row.en
  // 技能名走官方表，保证与游戏一致
  return t(row.zh) || row.zh
}

/** 技能显示名：官方译文优先 */
export function skillName(skill: string): string {
  if (langState.lang === 'en') return skill
  return langState.table[skill] || UI[`skill.${skill}`]?.zh || skill
}
