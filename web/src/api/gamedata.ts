import type { GameData } from '../types.ts'

/**
 * 游戏数据加载与索引。
 *
 * 数据是构建时从 dvi_probe 提取的（prepare-data.py 生成），
 * 运行时只读一次、只发一个相对路径请求 —— 静态托管友好。
 */

const DATA_URL = 'data/dvi-gamedata.json'   // 相对路径：子路径部署也能用

let cache: GameData | null = null

export async function loadGameData(): Promise<GameData> {
  if (cache) return cache
  const res = await fetch(DATA_URL)
  if (!res.ok) {
    throw new Error(`加载游戏数据失败：${res.status} ${res.statusText}`)
  }
  const data = (await res.json()) as GameData
  if (!data?.items?.length || !data?.actions?.length) {
    throw new Error('游戏数据格式不对（缺少 items / actions）')
  }
  cache = data
  return data
}

export function loadedData(): GameData | null {
  return cache
}

/** 全部技能名（按配方数降序） */
export function skillList(data: GameData): string[] {
  const n = new Map<string, number>()
  for (const a of data.actions) n.set(a.skill, (n.get(a.skill) || 0) + 1)
  return [...n.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k)
}

export const SKILL_LABEL: Record<string, string> = {
  mining: '挖矿',
  fishing: '钓鱼',
  woodcutting: '伐木',
  farming: '种植',
  smithing: '锻造',
  fletching: '制箭',
  crafting: '制作',
  cooking: '烹饪',
  herblore: '草药学',
  thieving: '偷窃',
}

export function skillLabel(s: string): string {
  return SKILL_LABEL[s] || s
}
