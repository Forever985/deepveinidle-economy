// ==UserScript==
// @name         DVI 数据采集（静默累积 · 按需导出）
// @namespace    dvi.tools
// @version      2.0.0
// @description  静默采集 Deep Vein Idle 的可验证数据并在本地累积，需要时一键导出成文件。只读，不发送任何游戏指令，不需要任何常驻服务。
// @author       -
// @match        https://deepveinidle.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

/*
 * 设计原则
 * ─────────────────────────────────────────────────────────
 * 1. 无感：页面上没有任何 UI，不需要点任何东西。数据在你玩游戏时自动累积。
 * 2. 只在你要交数据时动手：油猴菜单里点一次「导出」，得到一个 JSON 文件。
 * 3. 不依赖常驻服务：默认纯本地累积。想实时上报才需打开接收端（默认关闭）。
 * 4. 隐私默认安全：聊天/私聊/公会频道/其他玩家信息在源头丢弃，永不落盘。
 * 5. 只读：仅劫持收包读取，不调用任何游戏指令。
 */

(function () {
  'use strict';

  if (window.__dviCollector) return;
  window.__dviCollector = true;

  const LIVE_ENDPOINT = 'http://127.0.0.1:8787/ingest';  // 仅在开启「实时上报」时使用
  const PROD_MS = 30000;        // 出产统计汇总间隔
  const MAX_ARCHIVE_CHARS = 3_000_000;  // 本地归档上限（约 3MB 文本）
  const DEDUPE_MAX = 800;

  let liveMode = GM_getValue('liveMode', false);   // 默认关闭，纯本地
  /* 默认「不记录」—— 装了不等于开始录。
   * 想采集时从油猴菜单显式打开，采完随时丢弃。 */
  let paused = GM_getValue('paused', true);
  let archive = GM_getValue('archive', []);        // 全部累积记录
  let sentKeys = new Set(GM_getValue('sentKeys', []));
  let stats = GM_getValue('stats', { captured: 0, exports: 0, lastCapture: null });

  /* ── 快照节流 ──
   * 游戏每次重绘都会推 snapshot，一天能堆几百条重复快照（实测 485 条 / 3.7MB）。
   * 这里限制：换作业必记，否则最多每 SELF_MIN_GAP 记一条。 */
  const SELF_MIN_GAP = 10 * 60 * 1000;   // 10 分钟
  let lastSelfFp = null;
  let lastSelfAt = 0;

  /* ══════════ 隐私过滤 ══════════ */
  const NEVER = new Set(['chat', 'whispers', 'guildChat', 'guestChat', 'guildInvites', 'mods', 'devs', 'poll']);

  // 白名单：游戏以后新增字段不会被误采
  const WORLD_KEYS = ['protocol', 'seed', 'online', 'build', 'variant', 'marketTaxBp',
                      'bossNext', 'masteryFreeUntil', 'guestChat', 'boughtGems', 'windows'];

  const SELF_KEYS = ['id', 'version', 'x', 'y', 'skills', 'equipment', 'perks', 'masteries',
    'coins', 'gems', 'hp', 'eatAt', 'foodItemId', 'foodMaxTier', 'foodPerTrip',
    'queueSlots', 'marketOrderSlots', 'bankSlotsBought', 'offlineCapTicks',
    'house', 'houseUpgrades', 'houseFurniture', 'housePoints', 'houseCells',
    'plots', 'plantPlainest', 'pack', 'bank', 'bankOrder', 'overflow',
    'route', 'workSiteId', 'workJobId', 'workRarity', 'activity',
    'enhance', 'titles', 'title', 'skins', 'mountSkins', 'pet',
    'streak', 'tally', 'questPoints', 'quests', 'achievements', 'collections',
    'ironman', 'unlimitedBank', 'lastTick', 'guide', 'actionIndex'];

  /* ══════════ 工具 ══════════ */
  const now = () => new Date().toISOString();
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  };
  const pick = (o, keys) => {
    const out = {};
    if (!o) return out;
    for (const k of keys) if (k in o) out[k] = o[k];
    return out;
  };

  function persistArchive() {
    // 超出上限就丢掉最旧的一半，保证不会撑爆油猴存储
    try {
      while (JSON.stringify(archive).length > MAX_ARCHIVE_CHARS && archive.length > 1) {
        archive = archive.slice(Math.ceil(archive.length / 2));
      }
      GM_setValue('archive', archive);
    } catch (e) { console.warn('[DVI采集] 归档写入失败', e); }
  }

  /* ══════════ 快照节流 ══════════
   * 用「结构性字段」做指纹：装备、特长、精通、房屋、作业、强化、金币。
   * 刻意排除经验值和坐标 —— 边打边涨经验不算变化，
   * 否则同等级持续作业时仍会不断记新条目。
   * 技能进度靠时间间隔兜住（默认 10 分钟一条）。 */
  const FP_KEYS = ['equipment', 'perks', 'masteries', 'house', 'houseUpgrades',
                   'houseFurniture', 'workJobId', 'workSiteId', 'workRarity',
                   'enhance', 'titles', 'talents', 'unlocks', 'coins', 'gems'];

  function selfFingerprint(self) {
    return hash(JSON.stringify(pick(self, FP_KEYS)));
  }

  /**
   * @param {boolean} force 登录时强制记一条基线
   */
  function shouldRecordSelf(self, force) {
    const fp = selfFingerprint(self);
    const nowMs = Date.now();
    if (force || fp !== lastSelfFp || nowMs - lastSelfAt > SELF_MIN_GAP) {
      lastSelfFp = fp;
      lastSelfAt = nowMs;
      return true;
    }
    return false;
  }

  /* ══════════ 记录 ══════════ */
  function push(rec) {
    if (paused) return;
    rec.at = now();
    const k = rec.kind + ':' + hash(JSON.stringify(rec));
    if (sentKeys.has(k)) return;
    sentKeys.add(k);
    if (sentKeys.size > DEDUPE_MAX) {
      sentKeys = new Set([...sentKeys].slice(-DEDUPE_MAX / 2));
      GM_setValue('sentKeys', [...sentKeys]);
    }

    archive.push(rec);
    stats.captured++;
    stats.lastCapture = rec.at;
    GM_setValue('stats', stats);
    persistArchive();

    if (liveMode) postLive(rec);
  }

  function postLive(rec) {
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: LIVE_ENDPOINT,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({ records: [rec] }),
        timeout: 6000,
        onerror: () => {}, ontimeout: () => {},   // 接收端没开是常态，静默
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ══════════ 出产统计（滚动汇总，降低数据量） ══════════ */
  let prodWindow = Object.create(null);
  let prodSince = Date.now();
  let currentWork = null;
  let myId = null;          // 自己的角色 id —— 用来过滤别人的广播

  function noteProduced(e) {
    const k = `${e.jobId ?? '-'}|${e.itemId ?? '-'}|${e.tier ?? 0}`;
    const w = prodWindow[k] || (prodWindow[k] = { n: 0, xp: 0, wire: !!e.wire });
    w.n++; w.xp += e.xp || 0;
  }

  function flushProd() {
    const keys = Object.keys(prodWindow);
    if (!keys.length) return;
    const items = {};
    let totalXp = 0;
    for (const k of keys) {
      const [jobId, itemId, tier] = k.split('|');
      items[k] = { jobId: +jobId, itemId: +itemId, tier: +tier,
                   n: prodWindow[k].n, xp: prodWindow[k].xp, wire: prodWindow[k].wire };
      totalXp += prodWindow[k].xp;
    }
    push({ kind: 'production', windowMs: Date.now() - prodSince, work: currentWork, items, totalXp });
    prodWindow = Object.create(null);
    prodSince = Date.now();
  }
  setInterval(flushProd, PROD_MS);
  window.addEventListener('beforeunload', flushProd);
  window.addEventListener('pagehide', flushProd);

  /* ══════════ 帧处理 ══════════ */
  function buildSelf(you) {
    const self = pick(you, SELF_KEYS);
    self.name = you.name;
    self.pseudonym = hash(String(you.id ?? you.name ?? '?'));
    return self;
  }

  function inspect(raw) {
    if (typeof raw !== 'string' || raw.charCodeAt(0) !== 123) return;
    let frame;
    try { frame = JSON.parse(raw); } catch (e) { return; }
    if (!frame || !Array.isArray(frame.m)) return;

    const tick = Number.isInteger(frame.tick) ? frame.tick : null;

    for (const msg of frame.m) {
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') continue;
      if (NEVER.has(msg.t)) continue;

      switch (msg.t) {
        case 'welcome': {
          const you = msg.you || {};
          const self = buildSelf(you);
          myId = you.id ?? null;              // 记住自己的 id
          // 登录基线：强制记一条，并重置节流窗口
          shouldRecordSelf(self, true);
          push({
            kind: 'self', tick, character: you.name, pseudonym: self.pseudonym,
            source: 'welcome', self, world: pick(msg, WORLD_KEYS),
            counts: {
              chat: Array.isArray(msg.chat) ? msg.chat.length : 0,
              windows: Array.isArray(msg.windows) ? msg.windows.length : 0,
              guildBoard: Array.isArray(msg.guildBoard) ? msg.guildBoard.length : 0,
            },
          });
          if (msg.offline && typeof msg.offline === 'object') {
            push({
              kind: 'offline', tick, character: you.name, pseudonym: self.pseudonym,
              offline: msg.offline, skillsAfter: you.skills || null,
            });
          }
          break;
        }

        case 'snapshot': {
          const you = msg.you || {};
          const self = buildSelf(you);
          if (you.id != null) myId = you.id;
          // 节流：结构性字段变了才记，否则最多 10 分钟一条
          if (shouldRecordSelf(self, false)) {
            push({ kind: 'self', tick, character: you.name, pseudonym: self.pseudonym,
                   source: 'snapshot', self });
          }
          flushProd();
          break;
        }

        // ⚠️ work 消息带 id，只有自己的才算数。
        //    世界会广播附近玩家的动作，不过滤就会把别人的作业记成自己的。
        case 'work':
          if (myId !== null && msg.id === myId && msg.work) {
            currentWork = { siteId: msg.work.siteId, tool: msg.work.tool, item: msg.work.item };
          }
          break;

        // ⚠️ batch 不带玩家 id，无法直接归属。
        //    已知线索：广播他人的产出带 wire:true；自己的产出不带。
        //    在没有更可靠依据前，只统计「不带 wire」的条目，并如实记录 wire 标志，
        //    让下游能自己判断这批数据可不可信。
        case 'batch':
          for (const e of (msg.e || [])) {
            if (e && e.kind === 'produced' && !e.wire) noteProduced(e);
          }
          break;

        case 'marketBook':
        case 'marketBooks':
        case 'marketDepth':
        case 'marketHistory':
          push({ kind: 'market', tick, type: msg.t,
                 data: msg.t === 'marketDepth'
                   ? { itemId: msg.itemId, bids: msg.bids, asks: msg.asks, trades: msg.trades }
                   : msg });
          break;

        default: break;
      }
    }
  }

  /* ══════════ 劫持收包 ══════════ */
  try {
    const desc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
    const origGet = desc.get;
    desc.get = function () {
      let raw;
      try { raw = origGet.call(this); } catch (e) { return origGet.call(this); }
      try {
        const s = this.currentTarget;
        if (s instanceof WebSocket && s.url && s.url.includes('deepveinidle.com')) inspect(raw);
      } catch (e) { /* 采集失败绝不冒泡给游戏 */ }
      return raw;
    };
    Object.defineProperty(MessageEvent.prototype, 'data', desc);
  } catch (e) {
    console.warn('[DVI采集] 挂载失败', e);
  }

  /* ══════════ 导出 ══════════ */
  function pack() {
    return JSON.stringify({
      exporter: 'dvi-collector',
      version: '2.0.0',
      exportedAt: now(),
      recordCount: archive.length,
      byKind: archive.reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {}),
      characters: [...new Set(archive.map(r => r.character).filter(Boolean))],
      note: '已按白名单采集；聊天、私聊、公会频道与其他玩家信息在源头丢弃。',
      records: archive,
    }, null, 1);
  }

  GM_registerMenuCommand('📦 导出采集数据（下载 JSON）', () => {
    flushProd();
    if (!archive.length) { alert('还没有采集到数据。先开启记录并玩一会儿再回来。'); return; }
    const text = pack();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = `dvi-capture-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    stats.exports++; GM_setValue('stats', stats);
    setTimeout(() => alert(`已导出 ${archive.length} 条记录。把下载到的 JSON 文件交给我即可。`), 400);
  });

  // 注意：Tampermonkey 要求菜单标题是**字符串**。
  // 传函数（动态标题）是 Violentmonkey 的用法，TM 上会抛
  // 「Uncaught (in promise) invalid name」—— 这就是之前那条报错的来源。
  GM_registerMenuCommand('▶ 开始记录 / ⏸ 停止记录（当前状态见弹窗）', () => {
    paused = !paused;
    GM_setValue('paused', paused);
    if (!paused) lastSelfAt = 0;   // 重新开始时立刻采一条基线
    alert(paused
      ? `已停止记录。已保存的 ${archive.length} 条仍在本地，随时可导出或丢弃。`
      : '已开始记录。想停随时从这个菜单关掉。');
  });

  GM_registerMenuCommand('📊 查看状态', () => {
    const byKind = archive.reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {});
    const kinds = Object.entries(byKind).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  （暂无）';
    const kb = (JSON.stringify(archive).length / 1024).toFixed(0);
    alert(
      `DVI 数据采集状态\n` +
      `────────────────\n` +
      `记录：${paused ? '关闭 ⏸' : '进行中 ▶'}\n` +
      `已保存：${archive.length} 条（${kinds}）\n` +
      `占用：约 ${kb} KB / 上限 3000 KB\n` +
      `最近记录：${stats.lastCapture || '尚未记录'}\n` +
      `实时上报：${liveMode ? '开（需接收端）' : '关（纯本地）'}\n` +
      `────────────────\n` +
      `快照最快每 10 分钟一条，换作业时立即记录。`
    );
  });

  GM_registerMenuCommand('🗑 丢弃已记录数据（不可恢复）', () => {
    if (!archive.length) { alert('本地没有已记录的数据。'); return; }
    if (!confirm(`将丢弃本地保存的 ${archive.length} 条数据，此操作不可撤销。\n\n确定丢弃？`)) return;
    archive = [];
    sentKeys = new Set();
    lastSelfFp = null;
    lastSelfAt = 0;
    GM_setValue('archive', archive);
    GM_setValue('sentKeys', []);
    GM_setValue('stats', stats = { captured: 0, exports: 0, lastCapture: null });
    alert('已丢弃。');
  });

  GM_registerMenuCommand('🔌 切换实时上报（需接收端）', () => {
    liveMode = !liveMode;
    GM_setValue('liveMode', liveMode);
    alert(liveMode
      ? '已开启实时上报。请确保已运行 dvi-capture-server.py。'
      : '已关闭实时上报，改为纯本地累积。');
  });

  /* ══════════ 启动 ══════════ */
  if (paused) {
    console.info('[DVI采集] 已安装，但**默认不记录**。要采集时点油猴菜单「▶ 开始记录」。');
  } else {
    console.info('[DVI采集] 记录中（已保存 %d 条）。随时可从菜单停止或丢弃。', archive.length);
  }
})();
