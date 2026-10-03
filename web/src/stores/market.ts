import { reactive } from 'vue'
import type { MarketSnapshot } from '../types'
import {
  saveHandle, loadHandle, forgetHandle, checkPermission, requestPermission, isUsableHandle,
} from '../lib/handleStore.ts'

/**
 * 价格数据 —— 全部走本机，不经过 GitHub。
 *
 * ## 为什么要这么绕
 *   游戏在 deepveinidle.com，利润站在 github.io —— **跨域**。
 *   localStorage / cookie / IndexedDB **都不跨源**，没有共同的本地存储。
 *   而把快照提交进仓库再部署，链路太长（要网络、要凭据、要等 CI）。
 *   用户明确要求「在玩家自己的电脑上就要能解决」。
 *
 * ## 三条入口（都落到 localStorage，之后完全离线可用）
 *   ① **File System Access API**：选一次 dvi-prices.json，之后每次打开
 *      网站自动重读。dvi-tools 写这个文件，网站读同一个 —— 闭环全在本机。
 *   ② **拖放**：把 dvi-tools 下载的 json 拖到页面任意处。
 *   ③ **粘贴**：把 JSON 文本贴进输入框。
 *
 * 之所以还要缓存进 localStorage：文件可能不在手边（换设备、文件被移动），
 * 而「上次看到的价格」本身就有价值 —— 它至少不是兜底价。
 */

const LS_KEY = 'dvi-profit-net:market:v2'

/** localStorage 约 5 MB，行情 JSON 约 60~120 KB，留足余量 */
const SIZE_LIMIT = 4 * 1024 * 1024

export const priceState = reactive<{
  market: Record<string, MarketSnapshot>
  /** 快照来源时间（ISO） */
  at: string | null
  /** 数据来自哪条入口，便于界面如实标注 */
  origin: 'file' | 'drop' | 'paste' | 'cache' | 'none'
  /** 已连接的文件（File System Access API） */
  fileName: string | null
  fileConnected: boolean
  /** 是否已记住文件句柄（关掉浏览器再打开仍然有效） */
  fileRemembered: boolean
  /** 需要你点一下才能继续读（浏览器要求授权必须有用户手势） */
  needsGesture: boolean
  lastRead: string | null
  error: string
}>({
  market: {}, at: null, origin: 'none',
  fileName: null, fileConnected: false, fileRemembered: false,
  needsGesture: false, lastRead: null, error: '',
})

/**
 * File System Access API 不在 TypeScript 的标准 lib 里，
 * 用索引访问拿，避免各处 @ts-expect-error。
 */
interface FSAWindow {
  showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>
}
const fsa = () => window as unknown as FSAWindow

export const supportsFileApi = typeof window !== 'undefined' && typeof fsa().showOpenFilePicker === 'function'

/**
 * 本机价格服务地址（scripts/price-server.js）。
 *
 * ## 这是首选通路
 *   dvi-tools 每次拿到行情就 POST 到 127.0.0.1:8791，网站直接 GET。
 *   **全程 localhost**：不经过文件、不经过拖拽、不经过 GitHub部署，
 *   也就绕开了那一整类「沙箱 + 文件句柄」的坑
 *   （Illegal invocation / getFile is not a function /
 *    Must be handling a user gesture / instanceof 恒 false）。
 *
 * ## 为什么 https 页面能读 http://127.0.0.1
 *   Chrome / Edge 把 127.0.0.1 与 localhost 视为「可能可信来源」，
 *   所以不算混合内容，不会被拦。
 */
export const LOCAL_SERVER = 'http://127.0.0.1:8791'

/**
 * 云端价格地址 —— **首选通路**。
 *
 * dvi-tools 充当 DVI 的「价格 API」（银河奶牛本来就有公开 API，
 * milkonomy 才那么简单；DVI 没有，我们让用户脚本补上这一层）：
 * 它把行情写进仓库里的 data/prices.json，网站从这里读。
 *
 * ## 为什么这不是「部署」
 *   网站**不需要重新构建、不需要推送**。游戏推数据、网站拉数据，各走各的。
 *   raw.githubusercontent.com 带 CORS 头，HTTPS 页面直接 fetch 即可。
 *
 * ## 隐私
 *   只上传**价格**，不含任何玩家身份信息。
 */
export const CLOUD_PRICES =
  'https://raw.githubusercontent.com/Forever985/deepveinidle-economy/main/data/prices.json'

/** 云端是否可用 */
export const cloudUp = reactive<{ up: boolean; checked: boolean; at: string | null; count: number }>({
  up: false, checked: false, at: null, count: 0,
})

/** 从云端拉价格。返回 false 表示拿不到（调用方退回缓存/兜底价）。 */
export async function pullFromCloud(timeoutMs = 6000): Promise<boolean> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    // 加时间戳绕开 CDN / 浏览器缓存，保证每次打开都拿到最新的
    const url = CLOUD_PRICES + '?t=' + Date.now()
    const r = await fetch(url, { signal: ac.signal, cache: 'no-store' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const txt = await r.text()
    if (!applySnapshot(txt, 'drop')) return false
    cloudUp.up = true
    cloudUp.checked = true
    cloudUp.count = Object.keys(priceState.market).length
    cloudUp.at = priceState.at
    return true
  } catch {
    cloudUp.up = false
    cloudUp.checked = true
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 本机服务是否可用（页面加载时探一次） */
export const localServerUp = reactive<{ up: boolean; checked: boolean; count: number }>({
  up: false, checked: false, count: 0,
})

/**
 * 从本机服务拉价格。**不需要任何用户授权**，也不碰文件系统。
 * 服务没开就返回 false，调用方退回缓存 / 兜底价。
 */
export async function pullFromLocalServer(timeoutMs = 2500): Promise<boolean> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(LOCAL_SERVER + '/prices.json', { signal: ac.signal, cache: 'no-store' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const txt = await r.text()
    if (!applySnapshot(txt, 'file')) return false
    localServerUp.up = true
    localServerUp.checked = true
    localServerUp.count = Object.keys(priceState.market).length
    return true
  } catch {
    localServerUp.up = false
    localServerUp.checked = true
    return false
  } finally {
    clearTimeout(timer)
  }
}

/* ─────────────── 解析与入库 ─────────────── */

interface Snapshot {
  at?: string
  tool?: string
  count?: number
  market: Record<string, { a?: { p: number; q?: number }; b?: { p: number; q?: number } }>
}

/** 把快照解析成网站内部用的 MarketSnapshot 形状 */
export function applySnapshot(raw: unknown, origin: 'file' | 'drop' | 'paste'): boolean {
  let snap: Snapshot
  try {
    snap = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Snapshot
  } catch (e) {
    priceState.error = '不是合法的 JSON'
    return false
  }
  if (!snap || typeof snap !== 'object' || !snap.market || typeof snap.market !== 'object') {
    priceState.error = '缺少 market 字段 —— 这不像是 dvi-tools 导出的价格快照'
    return false
  }

  const out: Record<string, MarketSnapshot> = {}
  let n = 0
  for (const [id, row] of Object.entries(snap.market)) {
    const r = row || {}
    const m: MarketSnapshot = {}
    if (r.a && Number.isFinite(r.a.p)) m.ask = { price: Number(r.a.p), qty: Number(r.a.q ?? 0) }
    if (r.b && Number.isFinite(r.b.p)) m.bid = { price: Number(r.b.p), qty: Number(r.b.q ?? 0) }
    if (m.ask || m.bid) { out[id] = m; n++ }
  }
  if (!n) {
    priceState.error = '快照里没有有效的报价'
    return false
  }

  priceState.market = out
  priceState.at = snap.at || null
  priceState.origin = origin
  priceState.error = ''
  saveToCache()
  return true
}

function saveToCache() {
  try {
    const payload = JSON.stringify({ at: priceState.at, origin: priceState.origin, market: priceState.market })
    if (payload.length > SIZE_LIMIT) {
      priceState.error = '数据太大，未能缓存到 localStorage（但本次仍可正常使用）'
      return
    }
    localStorage.setItem(LS_KEY, payload)
  } catch (e) {
    priceState.error = '写入 localStorage 失败（隐私模式？）'
  }
}

export function loadCache() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return false
    const o = JSON.parse(raw)
    if (!o || !o.market) return false
    priceState.market = o.market
    priceState.at = o.at || null
    priceState.origin = 'cache'
    return true
  } catch { return false }
}

export function clearAll() {
  priceState.market = {}
  priceState.at = null
  priceState.origin = 'none'
  priceState.error = ''
  try { localStorage.removeItem(LS_KEY) } catch { /* 忽略 */ }
}

/* ─────────────── ① File System Access API ─────────────── */

let fileHandle: FileSystemFileHandle | null = null

export function isFileConnected() { return !!fileHandle }

export async function connectPriceFile(): Promise<{ ok: boolean; msg: string }> {
  if (!supportsFileApi) {
    return { ok: false, msg: '这个浏览器不支持直接读文件，请改用拖放或粘贴' }
  }
  try {
    const picker = fsa().showOpenFilePicker
    if (!picker) return { ok: false, msg: '这个浏览器不支持直接读文件' }
    fileHandle = await picker.call(window, {
      multiple: false,
      types: [{ description: 'DVI 价格快照', accept: { 'application/json': ['.json'] } }],
    })
    // ★ 关键：句柄存进 IndexedDB，**关掉浏览器再打开依然有效**。
    //   否则每次都要重选文件，等于没做持久化。
    await saveHandle(fileHandle)
    priceState.fileRemembered = true
    const name = fileHandle.name
    const r = await readPriceFile()
    return r.ok ? { ok: true, msg: `已连接 ${name}` } : { ok: false, msg: r.msg }
  } catch (e) {
    const err = e as { name?: string; message?: string }
    if (err?.name === 'AbortError') return { ok: false, msg: '已取消' }
    return { ok: false, msg: err?.message || '打开失败' }
  }
}

/** 从已连接的文件读取；会先检查/申请权限 */
export async function readPriceFile(): Promise<{ ok: boolean; msg: string }> {
  try {
    return await _readPriceFile()
  } catch (e) {
    console.warn('[dvi] 读取价格文件失败', e)
    return { ok: false, msg: '读取失败：' + ((e as Error)?.message ?? e) }
  }
}

async function _readPriceFile(): Promise<{ ok: boolean; msg: string }> {
  if (!fileHandle) return { ok: false, msg: '尚未连接文件' }
  if (!isUsableHandle(fileHandle)) {
    // 句柄还在但已失效（丢原型方法 / 被浏览器回收）——丢掉，让用户重连
    fileHandle = null
    priceState.fileConnected = false
    priceState.fileRemembered = false
    await forgetHandle()
    return { ok: false, msg: '上次记住的文件句柄已失效，请重新点一次「连接价格文件」' }
  }
  try {
    const h = fileHandle as FileSystemFileHandle & {
      queryPermission?: (d: { mode: string }) => Promise<string>
      requestPermission?: (d: { mode: string }) => Promise<string>
    }
    let perm = h.queryPermission ? await h.queryPermission({ mode: 'read' }) : 'granted'
    if (perm === 'prompt' && h.requestPermission) {
      perm = await h.requestPermission({ mode: 'read' })
    }
    if (perm !== 'granted') return { ok: false, msg: '没有读取权限，请在浏览器里重新授权' }

    const file = await fileHandle.getFile()
    // 选错文件、或文件还是空的（游戏侧还没跑过一次）——这两种情况要分开说，
    // 否则用户只看到「解析失败」，根本不知道下一步该做什么。
    if (file.size === 0) {
      return {
        ok: false,
        msg: `这个文件是空的（${file.name}）。请先在游戏里用 dvi-tools 打开一次市场页面，`
            + '油猴菜单 →「💰 立即抓一次价格」或「🔗 连接价格文件」，让它先写出内容。',
      }
    }
    const text = await file.text()
    if (!applySnapshot(text, 'file')) {
      return {
        ok: false,
        msg: (priceState.error || '解析失败')
            + '　—— 请确认选的是 dvi-tools 导出的那个 dvi-prices.json，而不是别的 json。',
      }
    }
    priceState.fileName = fileHandle.name
    priceState.fileConnected = true
    priceState.lastRead = new Date().toISOString()
    return { ok: true, msg: `已读取 ${Object.keys(priceState.market).length} 个物品` }
  } catch (e) {
    return { ok: false, msg: (e as Error)?.message || '读取失败' }
  }
}

/**
 * 页面打开时自动恢复。
 *
 * 三种结果：
 *   ① 句柄还在且权限 granted → **直接读，零交互**（绝大多数情况）
 *   ② 句柄还在但权限 prompt  → 设 needsGesture，界面上出一个「点一下继续」的小条
 *   ③ 句柄没了/文件被删     → 静默退回 localStorage 缓存，界面标明数据是缓存
 */
export async function autoReconnect(): Promise<void> {
  // 整体兜底：自动恢复失败只意味着「这次没连上文件」，
  // 绝不能抛出去 —— 它是无 await 调用，抛了就是未捕获拒绝，
  // 会让整页报错（用户看到的 Se.getFile is not a function 就是这么来的）。
  try {
    await _autoReconnect()
  } catch (e) {
    console.warn('[dvi] 自动恢复价格文件失败（不影响使用）', e)
    priceState.fileConnected = false
    priceState.needsGesture = false
  }
}

async function _autoReconnect(): Promise<void> {
  if (fileHandle) { await readPriceFile(); return }

  const h = await loadHandle()
  if (!h) return                       // 首次使用，或用户主动断开过
  if (!isUsableHandle(h)) {
    // 反序列化后丢了原型方法，留着只会每次都抛 getFile is not a function
    await forgetHandle()
    priceState.fileRemembered = false
    return
  }

  const perm = await checkPermission(h)
  if (perm === 'granted') {
    fileHandle = h
    priceState.fileRemembered = true
    await readPriceFile()
    return
  }
  if (perm === 'prompt') {
    // 只记下句柄，真正申请要等用户点击（浏览器硬性要求用户手势）
    fileHandle = h
    priceState.fileName = h.name
    priceState.fileRemembered = true
    priceState.needsGesture = true
  }
}

/** 用户点击「继续」后调用（申请权限必须有手势） */
export async function grantAndRead(): Promise<{ ok: boolean; msg: string }> {
  if (!fileHandle) return { ok: false, msg: '没有可用的文件句柄' }
  if (!isUsableHandle(fileHandle)) {
    fileHandle = null
    await forgetHandle()
    return { ok: false, msg: '文件句柄已失效，请重新点「连接价格文件」' }
  }
  const perm = await requestPermission(fileHandle)
  if (perm !== 'granted') {
    return { ok: false, msg: perm === 'denied' ? '授权被拒绝' : '未获得授权' }
  }
  priceState.needsGesture = false
  await saveHandle(fileHandle)          // 确认有效，重新写回以防被清
  return readPriceFile()
}

/** 主动断开（换文件 / 不想要了） */
export async function disconnect(): Promise<void> {
  fileHandle = null
  priceState.fileName = null
  priceState.fileConnected = false
  priceState.fileRemembered = false
  priceState.needsGesture = false
  await forgetHandle()
}

/* ─────────────── ② 拖放 ③ 粘贴 ─────────────── */

export function handleFiles(files: FileList | File[]): { ok: boolean; msg: string } {
  const f = Array.from(files).find(x => /\.json$/i.test(x.name)) || Array.from(files)[0]
  if (!f) return { ok: false, msg: '没有找到文件' }
  const rd = new FileReader()
  rd.onload = () => {
    if (applySnapshot(String(rd.result), 'drop')) {
      priceState.lastRead = new Date().toISOString()
    }
  }
  rd.readAsText(f)
  return { ok: true, msg: `正在读取 ${f.name}…` }
}

export function applyPasted(text: string): { ok: boolean; msg: string } {
  if (!text.trim()) return { ok: false, msg: '内容为空' }
  if (applySnapshot(text, 'paste')) {
    priceState.lastRead = new Date().toISOString()
    return { ok: true, msg: `已载入 ${Object.keys(priceState.market).length} 个物品` }
  }
  return { ok: false, msg: priceState.error || '解析失败' }
}

/* ─────────────── 手动改价（优先级最高） ─────────────── */

const MANUAL_KEY = 'dvi-profit-net:manual-prices:v2'

export function loadManual(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(MANUAL_KEY) || '{}') } catch { return {} }
}
export function saveManual(m: Record<string, number>): void {
  try { localStorage.setItem(MANUAL_KEY, JSON.stringify(m)) } catch { /* 忽略 */ }
}
export function clearManual(): void {
  try { localStorage.removeItem(MANUAL_KEY) } catch { /* 忽略 */ }
}
