/**
 * 价格文件句柄的**持久化**（IndexedDB）。
 *
 * ## 为什么需要这一层
 *   FileSystemFileHandle 是可结构化克隆的，**能存进 IndexedDB 并在下次打开时取回**。
 *   不存的话，句柄只活在当前会话里 —— 关掉浏览器就得重新选一次文件，
 *   那等于「每次都要搞一下」，不是能接受的设计。
 *
 *   取回后先 `queryPermission()`：
 *     · granted → 直接读，**零交互**
 *     · prompt  → 需要你点一下（浏览器要求授权必须有用户手势）
 *     · denied  → 文件被移动/删除，或你撤销了授权
 *
 *   Chromium 系（Chrome / Edge / Quetta）对文件句柄的授权是**按来源记住**的，
 *   所以正常情况下重新打开网站会直接是 granted —— 也就是**只连一次**。
 *
 *   Firefox 不支持这个 API，会走拖放/粘贴的降级路径。
 *
 * 只读：只保存「你授权过的那个文件」的句柄，不涉及任何网络。
 */

const DB_NAME = 'dvi-profit-net'
const STORE = 'handles'
const KEY = 'price-file'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
    t.oncomplete = () => db.close()
  })
}

/** 记住用户授权的那个文件 */
export async function saveHandle(h: FileSystemFileHandle): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(h, KEY))
  } catch (e) {
    // 存不进去不算致命：本次会话仍可用，只是下次要重连
    console.warn('[dvi] 价格文件句柄未能持久化：', e)
  }
}

/** 取回上次授权过的文件（可能已失效） */
export async function loadHandle(): Promise<FileSystemFileHandle | null> {
  try {
    const h = await tx<FileSystemFileHandle | undefined>('readonly', (s) => s.get(KEY))
    return h ?? null
  } catch {
    return null
  }
}

export async function forgetHandle(): Promise<void> {
  try { await tx('readwrite', (s) => s.delete(KEY)) } catch { /* 忽略 */ }
}

type PermState = 'granted' | 'denied' | 'prompt'

function permApi(h: FileSystemFileHandle) {
  return h as FileSystemFileHandle & {
    queryPermission?: (d: { mode: string }) => Promise<PermState>
    requestPermission?: (d: { mode: string }) => Promise<PermState>
  }
}

/** 只**查询**权限，不触发弹窗 —— 页面加载时可以安全调用 */
export async function checkPermission(h: FileSystemFileHandle): Promise<PermState> {
  try {
    const p = permApi(h)
    if (!p.queryPermission) return 'granted'      // 老浏览器：尝试直接读
    return await p.queryPermission({ mode: 'read' })
  } catch {
    return 'denied'
  }
}

/** 申请权限 —— **必须在用户手势里调用**，否则浏览器直接拒绝 */
export async function requestPermission(h: FileSystemFileHandle): Promise<PermState> {
  try {
    const p = permApi(h)
    if (!p.requestPermission) return 'granted'
    return await p.requestPermission({ mode: 'read' })
  } catch {
    return 'denied'
  }
}
