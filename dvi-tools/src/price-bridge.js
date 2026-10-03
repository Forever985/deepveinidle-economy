/**
 * 价格桥 —— 把游戏内实时行情落到玩家本机的一个 JSON 文件。
 *
 * ## 为什么需要它
 *   DVI 没有公开的价格接口（bundle 里一个外部 URL 都没有），价格只存在于
 *   游戏内的 WebSocket。而利润网站是**另一个域名**（github.io），
 *   localStorage / cookie 都不跨源 —— 所以必须借一个**双方都能读写的本地文件**中转。
 *
 * ## 为什么不走 GitHub
 *   用户明确要求「在玩家自己的电脑上就要能解决，不要兜圈子去部署」。
 *   把快照提交进仓库再部署，链路太长、还依赖网络与凭据。
 *
 * ## 机制
 *   File System Access API：玩家**选一次**文件后，浏览器记住句柄，
 *   之后每次抓价都能直接写入，不需要再弹窗。
 *   站点侧用同一套 API 读同一个文件 —— 于是数据闭环全在本机。
 *
 *   降级链：File System Access API → 下载文件 → 复制到剪贴板（仅提示）
 *
 * 只读：只读取游戏自己推送的行情，不发送任何指令。
 */
(function (DVI) {
  'use strict';

  const SNAP_KEY = 'dvi-price-snapshot';      // GM 存储的键（跨刷新保留）
  const DB_NAME = 'dvi-price-bridge';         // 句柄持久化用
  const STORE = 'handles';
  const HKEY = 'price-file';
  const FILE_NAME = 'dvi-prices.json';
  /** 抓价后延迟这么久再落盘：市场消息很密集，等一小会儿再取，避免写太频繁 */
  const WRITE_DEBOUNCE_MS = 4000;
  /** 每小时至少重新记一次时间戳（用于「多久没更新了」的提示） */
  const STALE_MS = 70 * 60 * 1000;
  /** 本机价格服务（scripts/price-server.js）。有了它，网站无需碰任何文件。 */
  const SERVER = 'http://127.0.0.1:8791';

  /* ── GitHub 传输（首选：真正的零操作）────────────────────────
   *
   * DVI 没有公开价格 API，而银河奶牛有 —— 这就是 milkonomy 简单的根本原因。
   * 我们让 dvi-tools **充当那个 API 层**：把行情写进一个 GitHub 仓库文件，
   * 网站从 raw.githubusercontent.com 读。
   *
   * 这**不是部署**：网站不用重新构建、不用推送，gitignore 也不管它。
   * 游戏推数据、网站拉数据，各自独立。
   *
   * 为什么不用共享文件：实测本机浏览器把文件句柄从 IndexedDB 取回来后
   * 会**丢失原型方法**（getFile / queryPermission 都没了），
   * 于是「一次绑定永久有效」不成立 —— 每个会话都得重连。
   * GitHub 这条路没有这个问题。
   */
  const GH = {
    owner: 'Forever985',
    repo: 'deepveinidle-economy',
    path: 'data/prices.json',
    branch: 'main',
  };
  function ghApi(pathname) {
    return `https://api.github.com/repos/${GH.owner}/${GH.repo}/${pathname}`;
  }
  function ghRaw() {
    return `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}/${GH.path}`;
  }

  /** 令牌存在脚本存储（仅本机），永不上传到别处 */
  function ghToken() { try { return GM_getValue('dvi-gh-token', '') || ''; } catch (e) { return ''; } }
  function setGhToken(t) { try { t ? GM_setValue('dvi-gh-token', t) : GM_setValue('dvi-gh-token', ''); } catch (e) {} }

  let ghUp = null;      // null=未知 true=通 false=不通

  async function pushToGitHub(snap) {
    if (ghUp === false) return 0;
    const tok = ghToken();
    if (!tok) {
      if (ghUp !== false) { ghUp = false; log('未配置 GitHub 令牌，跳过云端推送'); }
      return 0;
    }
    try {
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(snap))));
      // 1) 查现有文件（拿 sha）
      let sha = null;
      const head = await fetch(ghApi(`contents/${GH.path}?ref=${GH.branch}`), {
        headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' },
      });
      if (head.ok) { try { sha = (await head.json()).sha || null; } catch (e) {} }

      // 2) 提交（PUT 同一个 path 就是更新）
      const put = await fetch(ghApi(`contents/${GH.path}`), {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tok}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `prices: ${new Date().toISOString()}`,
          content,
          branch: GH.branch,
          ...(sha ? { sha } : {}),
        }),
      });
      if (!put.ok) throw new Error('HTTP ' + put.status + ' ' + (await put.text()).slice(0, 120));
      if (ghUp !== true) { ghUp = true; log('已连上 GitHub 传输（网站可自动读取）'); }
      return Object.keys(snap.market).length;
    } catch (e) {
      if (ghUp !== false) { ghUp = false; log('GitHub 推送失败：' + (e && e.message)); }
      return 0;
    }
  }

  let fileHandle = null;      // FileSystemFileHandle
  let timer = null;           // 落盘 debounce
  let lastWrittenAt = 0;
  let lastCount = 0;
  let listeners = [];

  function log(...a) { console.info('[DVI:价格桥]', ...a); }

  /**
   * 拿到「真正的」Window 上的文件选择器。
   *
   * ⚠ 为什么不能直接 window.showSaveFilePicker(...)：
   *   油猴的沙箱把 window 包成了一层 Proxy。用它调用原生方法时，
   *   浏览器做 brand check 会发现 this 不是真正的 Window，抛
   *   **Illegal invocation**（实测踩过，报错还看不出跟沙箱有关）。
   *
   *   所以要拿 unsafeWindow（真实页面窗口）当接收者，用 .call() 显式绑定。
   *   拿不到 unsafeWindow 时退回 window。
   */
  function filePicker() {
    const target = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    return { target, fn: target.showSaveFilePicker };
  }

  /* ── 句柄持久化 ──────────────────────────────────────────────
   * FileSystemFileHandle 是可结构化克隆的，能存进 IndexedDB 并在
   * 下次打开时取回。**不存的话，句柄只活在当前会话**，
   * 关掉浏览器就得重新选一次文件 —— 那等于「每次都要搞一下」。
   */
  function openDb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idb(mode, fn) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const q = fn(t.objectStore(STORE));
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
      t.oncomplete = () => db.close();
    });
  }
  async function saveHandle(h) {
    try { await idb('readwrite', (s) => s.put(h, HKEY)); } catch (e) { log('句柄未能持久化', e); }
  }
  /**
   * 判断句柄**是不是还能用**。
   *
   * 句柄从 IndexedDB 反序列化回来后，有时会**丢失原型方法** ——
   * 表现为 createWritable / getFile 「is not a function」（类名是浏览器
   * 内部压缩后的，看不懂是谁）。所以取回后必须先验，失效就丢弃。
   */
  function usable(h) {
    if (!h || typeof h !== 'object') return false;
    return typeof h.createWritable === 'function' && typeof h.name === 'string';
  }
  async function loadHandle() {
    try {
      const h = (await idb('readonly', (st) => st.get(HKEY))) || null;
      if (!usable(h)) { if (h) await forgetHandle(); return null; }
      return h;
    } catch { return null; }
  }
  async function forgetHandle() {
    try { await idb('readwrite', (s) => s.delete(HKEY)); } catch { /* 忽略 */ }
  }
  function permApi(h) {
    return h;
  }
  async function checkPerm(h) {
    try {
      const p = permApi(h);
      if (!p.queryPermission) return 'granted';
      return await p.queryPermission({ mode: 'readwrite' });
    } catch { return 'denied'; }
  }
  async function requestPerm(h) {
    try {
      const p = permApi(h);
      if (!p.requestPermission) return 'granted';
      return await p.requestPermission({ mode: 'readwrite' });
    } catch { return 'denied'; }
  }

  /** 当前市场快照（只取有报价的） */
  function collect() {
    const out = {};
    const mk = DVI.state.s.market;   // 状态在 state.s 下，不是 state.market
    if (!mk) return out;
    for (const [id, m] of mk) {
      const row = {};
      if (m.ask != null) row.a = { p: m.ask, q: m.askQty ?? 0 };
      if (m.bid != null) row.b = { p: m.bid, q: m.bidQty ?? 0 };
      if (row.a || row.b) out[id] = row;
    }
    return out;
  }

  function buildSnapshot() {
    const market = collect();
    const n = Object.keys(market).length;
    return {
      _note: 'DVI 价格快照。由 dvi-tools 从游戏内 WebSocket 抓取，供 dvi-economy 读取。',
      tool: 'dvi-tools ' + DVI.VERSION,
      at: new Date().toISOString(),
      count: n,
      market,
    };
  }

  /** 写盘（若已连接文件）；无论成功与否都先存进 GM 存储 */
  function flush(reason) {
    clearTimeout(timer);
    const snap = buildSnapshot();
    lastCount = snap.count;

    try { GM_setValue(SNAP_KEY, JSON.stringify(snap)); } catch (e) { /* 配额满等 */ }

    // 首选：推到 GitHub（网站自动读，零操作、零文件）
    void pushToGitHub(snap);
    // 备用：本机服务若在跑也推一份
    void pushToServer(snap);

    if (!fileHandle) {
      notify(snap, '已存入脚本存储（未连接文件）');
      return;
    }
    if (!usable(fileHandle)) {
      // 句柄在页面存活期间也可能被浏览器回收 —— 别去调 createWritable
      fileHandle = null;
      notify(snap, '文件句柄已失效，需要重新连接（面板里点「选择价格文件」）');
      return;
    }
    fileHandle.createWritable()
      .then((w) => w.write(JSON.stringify(snap, null, 1)).then(() => w.close()))
      .then(() => {
        lastWrittenAt = Date.now();
        log('已写入', FILE_NAME, snap.count, '个物品', reason || '');
        notify(snap, '已写入 ' + FILE_NAME);
      })
      .catch((e) => {
        // 句柄失效（文件被移动/删除、或用户撤销了权限）
        log('写入失败：', e && e.message);
        fileHandle = null;
        notify(snap, '写入失败，需要重新连接文件');
      });
  }

  /**
   * 把快照推给本机服务。
   *
   * 这是**首选通路**：网站从 127.0.0.1 直接读，
   * 完全不经过文件、拖拽、GitHub，也就绕开了那一整类沙箱/句柄问题。
   *
   * 用 text/plain 而不是 application/json —— 简单请求不触发 CORS 预检，
   * 少一次往返，兼容性也更好。
   */
  let serverUp = null;      // null=未知 / true=通 / false=不通

  async function pushToServer(snap) {
    if (serverUp === false) return false;
    try {
      const r = await fetch(SERVER + '/price', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(snap),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json().catch(() => ({}));
      if (serverUp !== true) { serverUp = true; log('本机价格服务已连通'); }
      return j.count != null ? j.count : Object.keys(snap.market).length;
    } catch (e) {
      if (serverUp !== false) {
        serverUp = false;
        log('连不上本机价格服务（' + SERVER + '）—— '
          + '价格仍会存到脚本存储；想启用请运行 D:////dvitools////启动价格服务.bat');
      }
      return 0;
    }
  }

  /** 供状态面板显示用 */
  function serverReachable() { return serverUp === true; }

  function schedule(reason) {
    clearTimeout(timer);
    timer = setTimeout(() => flush(reason), WRITE_DEBOUNCE_MS);
  }

  function notify(snap, msg) {
    for (const fn of listeners) { try { fn(snap, msg); } catch (e) { /* 忽略 */ } }
  }

  const PRICE = {
    /** 上次落盘时间（0 = 从未） */
    get lastWrittenAt() { return lastWrittenAt; },
    get lastCount() { return lastCount; },
    get connected() { return !!fileHandle; },
    get serverUp() { return serverReachable(); },
    gh: {
      target: `${GH.owner}/${GH.repo}/${GH.path}`,
      get token() { return ghToken(); },
      setToken: setGhToken,
      get up() { return ghUp; },
      repo: GH,
    },
    fileName: FILE_NAME,

    onUpdate(fn) { listeners.push(fn); return () => { listeners = listeners.filter(f => f !== fn); }; },

    /** 立即抓一次并落盘 */
    flushNow(reason) { flush(reason || '手动'); },

    /** 读回脚本存储里的上一次快照（页面刚加载、还没收到行情时用） */
    loadStored() {
      try {
        const raw = GM_getValue(SNAP_KEY, '');
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },

    /** 让玩家选一个文件，之后就能自动写入 */
    async connect() {
      const { target, fn } = filePicker();
      if (typeof fn !== 'function') {
        return { ok: false, why: 'unsupported' };
      }
      try {
        // ★ 必须 .call(target) —— 见 filePicker() 的注释
        fileHandle = await fn.call(target, {
          suggestedName: FILE_NAME,
          types: [{ description: 'DVI 价格快照', accept: { 'application/json': ['.json'] } }],
        });
        // ★ 存进 IndexedDB：关掉浏览器、重启电脑后依然有效，
        //   否则每次开游戏都要重选一遍文件。
        await saveHandle(fileHandle);
        flush('连接文件');
        return { ok: true, name: fileHandle.name };
      } catch (e) {
        // 用户取消不算失败
        if (e && e.name === 'AbortError') return { ok: false, why: 'cancelled' };
        return { ok: false, why: e && e.message };
      }
    },

    /** 授权被清掉后，从已保存的句柄恢复（需用户手势） */
    async reauthorise() {
      if (!fileHandle) {
        const h = await loadHandle();
        if (!h) return { ok: false, why: '没有保存过文件，请用「连接价格文件」选一次' };
        fileHandle = h;
      }
      const perm = await requestPerm(fileHandle);
      if (perm !== 'granted') return { ok: false, why: '未获得授权' };
      await saveHandle(fileHandle);
      flush('恢复连接');
      return { ok: true, name: fileHandle.name };
    },

    /** 主动断开并忘记文件 */
    async disconnect() {
      fileHandle = null;
      await forgetHandle();
    },

    /** 降级路径：下载一份 */
    download() {
      const snap = buildSnapshot();
      const text = JSON.stringify(snap, null, 1);
      const a = document.createElement('a');
      // createObjectURL/Blob 在沙箱里也可能需要真实 window，显式取一次
      const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
      a.href = W.URL.createObjectURL(new W.Blob([text], { type: 'application/json' }));
      a.download = FILE_NAME;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { W.URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return snap.count;
    },

    status() {
      const stored = this.loadStored();
      return {
        connected: !!fileHandle,
        fileName: FILE_NAME,
        supported: typeof filePicker().fn === 'function',
        count: lastCount,
        snapshotAt: stored ? stored.at : null,
        snapshotCount: stored ? stored.count : 0,
        stale: stored ? (Date.now() - Date.parse(stored.at) > STALE_MS) : true,
      };
    },
  };

  /**
   * 启动时恢复上次授权的文件。
   * 权限已是 granted 就直接写；是 prompt 则记下来，等用户点菜单时再申请
   * （浏览器硬性要求：申请权限必须有用户手势）。
   */
  async function restore() {
    const h = await loadHandle();
    if (!h) return;                     // loadHandle 内部已验过
    fileHandle = h;
    const perm = await checkPerm(h);
    if (perm === 'granted') {
      log('已恢复上次连接的文件：' + h.name);
    } else if (perm === 'prompt') {
      log('文件句柄已保存，但需要你点一下菜单里的「恢复价格文件连接」来授权');
    } else {
      fileHandle = null;
    }
  }

  /** 挂上总线：市场消息一来就（防抖后）记一次 */
  function attach() {
    void restore();
    DVI.bus.on(DVI.EVT.MARKET, () => schedule('市场更新'));
    // 每小时强制落一次，哪怕没有新消息 —— 用来刷新「快照时间」
    setInterval(() => {
      const st = PRICE.status();
      if (Date.now() - lastWrittenAt > 60 * 60 * 1000 || st.stale) flush('每小时刷新');
    }, 30 * 60 * 1000);
  }

  DVI.price = PRICE;
  DVI.attachPriceBridge = attach;
})(typeof api !== 'undefined'
    ? api                                        // 正常情况：就在主干 IIFE 作用域里
    : ((typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.DVI) || window.DVI));
