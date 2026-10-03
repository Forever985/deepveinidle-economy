import { ref, computed } from 'vue'

/**
 * 极简 hash 路由。
 *
 * 为什么不用 vue-router：这个工具只有几个视图，不需要嵌套路由/守卫/懒加载。
 * 自己写一个 40 行的 hash 路由，省一个依赖、构建更快、行为完全可控。
 * 刷新后位置不丢（hash 会留在地址栏），也支持前进后退。
 */

export type ViewKey = 'dashboard' | 'profit' | 'chain' | 'enhance' | 'combat' | 'consumable' | 'market' | 'docs'

export interface ViewDef {
  key: ViewKey
  label: string
  icon: string
  desc: string
}

export const VIEWS: ViewDef[] = [
  { key: 'dashboard', label: '玩家配置', icon: '①', desc: '等级、增益、特权、工具 —— 所有利润都受它影响' },
  { key: 'profit', label: '利润排行', icon: '②', desc: '221 个配方按整链净利排序' },
  { key: 'chain', label: '产业链', icon: '③', desc: '点开任一成品，看整条原料链的成本构成' },
  { key: 'enhance', label: '强化', icon: '④', desc: '+1~+5 的成本与回报（+5 价值是 +0 的 50 倍）' },
  { key: 'combat', label: '战斗', icon: '⑤', desc: '20 个怪物的每小时收益' },
  { key: 'consumable', label: '消耗品', icon: '⑥', desc: '食物与药膏的单位治疗价值' },
  { key: 'market', label: '价格', icon: '⑦', desc: '手动定价与快照导入导出' },
  { key: 'docs', label: '说明', icon: '⑧', desc: '数据来源、计算口径、已知局限' },
]

const ALL_KEYS = VIEWS.map(v => v.key)
const isKey = (s: string): s is ViewKey => (ALL_KEYS as string[]).includes(s)

function readHash(): ViewKey {
  const h = location.hash.replace(/^#\/?/, '').trim()
  return isKey(h) ? h : 'profit'
}

const current = ref<ViewKey>(readHash())

window.addEventListener('hashchange', () => { current.value = readHash() })

export function useView() {
  return {
    current,
    view: computed(() => VIEWS.find(v => v.key === current.value)!),
    go(k: ViewKey) { location.hash = '#/' + k },
  }
}
