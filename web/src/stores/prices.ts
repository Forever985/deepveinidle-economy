import { reactive } from 'vue'
import type { MarketSnapshot, PriceSource } from '../types.ts'

/**
 * 手动价格 + 市场快照。
 *
 * 静态页拿不到游戏内实时行情（WS 只在游戏页面里），所以：
 *   · 市场快照可由**导入**灌入（例如从 dvi-tools 导出的价格快照）
 *   · 没有快照时退回兜底价（物品基础价值）
 *   · 任何时候都可以手动指定，覆盖前两者
 *
 * 三层来源与优先级在 calc/price.ts 里，这里只管存。
 */

const KEY = 'dvi-profit-net:manual-prices:v1'
const MKEY = 'dvi-profit-net:market-snapshot:v1'

export const priceState = reactive<{
  manual: Record<string, number>
  market: Record<string, MarketSnapshot>
  marketLoadedAt: number
}>({
  manual: {},
  market: {},
  marketLoadedAt: 0,
})

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

export function loadPrices(): void {
  priceState.manual = safeParse(localStorage.getItem(KEY), {})
  const m = safeParse<{ at?: number; data?: Record<string, MarketSnapshot> }>(
    localStorage.getItem(MKEY), {},
  )
  priceState.market = m.data || {}
  priceState.marketLoadedAt = m.at || 0
}

export function saveManual(): void {
  try { localStorage.setItem(KEY, JSON.stringify(priceState.manual)) } catch { /* 忽略 */ }
}

export function saveMarket(): void {
  try {
    localStorage.setItem(MKEY, JSON.stringify({ at: Date.now(), data: priceState.market }))
  } catch { /* 忽略 */ }
}

export function clearManual(): void {
  priceState.manual = {}
  saveManual()
}

/** 「ID=价格,ID=价格」→ 写入。返回成功条数 */
export function applyManualText(text: string): { ok: number; bad: string[] } {
  const bad: string[] = []
  let ok = 0
  const next: Record<string, number> = { ...priceState.manual }
  for (const chunk of text.split(/[,，\n\s]+/)) {
    if (!chunk.trim()) continue
    const m = /^(\d+)\s*[=:：]\s*(\d+(?:\.\d+)?)$/.exec(chunk.trim())
    if (!m) { bad.push(chunk.trim()); continue }
    next[m[1]] = Number(m[2])
    ok++
  }
  if (ok) { priceState.manual = next; saveManual() }
  return { ok, bad }
}

/** 导出成 JSON 文本（手动价 + 市场快照一起带走） */
export function exportJson(): string {
  return JSON.stringify({
    _note: 'DVI 利润网 · 价格数据。market 段可由 dvi-tools 的价格快照导入。',
    at: new Date().toISOString(),
    manual: priceState.manual,
    market: priceState.market,
  }, null, 2)
}

export function importJson(text: string): { manual: number; market: number } {
  const o = safeParse<{ manual?: Record<string, number>; market?: Record<string, MarketSnapshot> }>(text, {})
  let manual = 0, market = 0
  if (o.manual && typeof o.manual === 'object') {
    const next = { ...priceState.manual }
    for (const [k, v] of Object.entries(o.manual)) {
      const id = Number(k), p = Number(v)
      if (Number.isFinite(id) && Number.isFinite(p) && p >= 0) { next[k] = p; manual++ }
    }
    priceState.manual = next
    saveManual()
  }
  if (o.market && typeof o.market === 'object') {
    priceState.market = { ...priceState.market, ...o.market }
    priceState.marketLoadedAt = Date.now()
    saveMarket()
    market = Object.keys(o.market).length
  }
  return { manual, market }
}

export const SRC_TEXT: Record<PriceSource, string> = {
  market: '市场价',
  fallback: '兜底价',
  manual: '手动价',
}
