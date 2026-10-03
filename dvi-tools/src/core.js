// ==UserScript==
// @name         DVI Tools（核心主干）
// @namespace    dvi.tools
// @version      2026.10.03.18
// @description  Deep Vein Idle 增强工具集的核心主干：静态数据、计算引擎、状态归约、事件总线、UI 框架与插件注册表。本身不含业务功能，只读，不发送任何游戏指令。
// @author       -
// @match        https://deepveinidle.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════════
 *  DVI Tools —— 核心主干
 *
 *  设计原则（与 MWITools 同构，但按 DVI 的实际情况重做）
 *  ─────────────────────────────────────────────────────────────────────
 *  1. 主干不做业务。它只提供：数据 / 计算 / 状态 / 事件 / UI / 插件注册。
 *     具体功能（利润面板、行情记录、资产曲线…）以插件形式挂上来。
 *  2. 只读是架构级约束，不是口头约定。
 *     `net` 模块只暴露 socket 的读取，**不提供任何 send 通道**；
 *     任何插件都无法通过本主干发送游戏指令。全局还有一个守卫，
 *     会拦截对本插件发起的写操作。
 *  3. 数据层是纯函数。calc 里的所有计算不依赖 DOM、不依赖游戏，
 *     因此可以在 Node 里直接单测（见 test/）。
 *  4. 不假设 DOM 结构。DVI 的界面由 JS 构建，类名不稳定；
 *     主干只依赖 <div id="app"> 和 572 个 data-* 属性中的少数几个，
 *     其余一律通过自建容器承载。
 * ═══════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  const NS = 'DVI';
  const VERSION = '2026.10.03.18';   // 与文件头 @version 保持一致
  const API_VERSION = 1;

  /* ═══ 沙箱与页面窗口的桥接 ═══
   * 带 @grant 的 Tampermonkey 脚本跑在独立沙箱里，每个用户脚本各有一个沙箱。
   * 因此「本脚本设置 window.DVI」对另一个用户脚本是不可见的。
   * 要让插件（无论同脚本还是独立脚本）都能拿到主干，必须挂到 unsafeWindow。
   */
  const ROOT = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  if (ROOT[NS]) return;   // 防重复注入
  if (window[NS]) return;

  /* ═══════════════════════════════════════════════════════════════
   * 运行日志 —— 用来「直接定位问题」
   *
   * 为什么需要它：出问题时用户只能看到「什么都没发生」，
   * 而原因可能藏在控制台几百行输出里。这里把关键节点记进一个环形缓冲，
   * 一条命令就能导出成文件，不必让用户去翻控制台。
   *
   * 设计约束：
   *   - 绝不因为日志本身抛异常（所有写入都包 try/catch）
   *   - 绝不无限增长（固定容量，超了丢最旧的）
   *   - 绝不记录隐私内容（只记计数、id、错误信息，不记聊天/他人数据）
   * ═══════════════════════════════════════════════════════════════ */
  const DIAG = (() => {
    const CAP = 800;
    const buf = [];
    const T0 = Date.now();
    let seq = 0;

    const pad = (n, w) => String(n).padStart(w, '0');

    /** 把任意值转成短字符串，处理循环引用 */
    function fmt(v, depth) {
      const d = depth || 0;
      try {
        if (v == null) return String(v);
        if (typeof v === 'string') return v.length > 400 ? v.slice(0, 400) + '…' : v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (typeof v === 'function') return `[fn ${v.name || 'anon'}]`;
        if (v instanceof Error) return `${v.name}: ${v.message}`;
        if (d >= 2) return Array.isArray(v) ? `[${v.length} 项]` : '[obj]';
        if (Array.isArray(v)) {
          return `[${v.slice(0, 6).map(x => fmt(x, d + 1)).join(', ')}` +
                 (v.length > 6 ? `, …共${v.length}` : '') + ']';
        }
        if (typeof v === 'object') {
          const keys = Object.keys(v).slice(0, 8);
          return '{' + keys.map(k => `${k}:${fmt(v[k], d + 1)}`).join(', ') +
                 (Object.keys(v).length > 8 ? ', …' : '') + '}';
        }
        return String(v);
      } catch (e) { return '[不可序列化]'; }
    }

    function write(level, tag, args) {
      try {
        if (buf.length >= CAP) buf.splice(0, Math.floor(CAP / 4));   // 丢最旧的四分之一
        const at = Date.now() - T0;
        const msg = args.map(a => fmt(a)).join(' ');
        buf.push({ n: ++seq, ms: at, level, tag, msg });
        // 同时打到控制台，方便实时盯
        const line = `[DVI ${tag}] ${msg}`;
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.info(line);
      } catch (e) { /* 日志自身绝不抛 */ }
    }

    const clock = (ms) => `${pad(Math.floor(ms / 60000), 2)}:${pad(Math.floor(ms / 1000) % 60, 2)}.${pad(ms % 1000, 3)}`;

    return {
      info: (tag, ...a) => write('info', tag, a),
      warn: (tag, ...a) => write('warn', tag, a),
      error: (tag, ...a) => write('error', tag, a),
      all: () => buf.slice(),
      tail: (n) => buf.slice(-(n || 40)),
      size: () => buf.length,
      clear: () => { buf.length = 0; seq = 0; },
      /** 转成可直接保存的纯文本 */
      text() {
        try {
          const head = [
            `DVI 运行日志`,
            `版本：${VERSION}`,
            `时间：${new Date().toISOString()}`,
            `页面：${location.href}`,
            `UA：${navigator.userAgent}`,
            `沙箱：${(typeof unsafeWindow !== 'undefined' && unsafeWindow) ? '有 unsafeWindow（正常）' : '无 unsafeWindow'}`,
            `记录条数：${buf.length}`,
            '─'.repeat(60),
          ].join('\n');
          const body = buf.map(e =>
            `${clock(e.ms)} ${e.level.toUpperCase().padEnd(5)} ${e.tag.padEnd(14)} ${e.msg}`
          ).join('\n');
          return head + '\n' + body + '\n';
        } catch (e) { return '日志导出失败：' + e.message; }
      },
    };
  })();

  /* 未捕获异常也记进日志 —— 这类错误最容易被漏掉 */
  try {
    const prevOnError = window.onerror;
    window.onerror = function (msg, src, line, col, err) {
      DIAG.error('未捕获', `${msg} @ ${src}:${line}:${col}`);
      if (typeof prevOnError === 'function') {
        try { return prevOnError.apply(this, arguments); } catch (e) {}
      }
      return false;
    };
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev && ev.reason;
      DIAG.error('未处理拒绝', (r && r.message) ? `${r.name}: ${r.message}` : String(r));
    });
  } catch (e) { /* 环境不支持就算了 */ }

  /* ═══════════════════════════════════════════════════════════════
   * 0. 静态游戏数据
   *    由 build.py 从客户端 bundle 提取后内联到这里。
   *    更新游戏版本后重新跑 build.py 即可。
   * ═══════════════════════════════════════════════════════════════ */
  const DATA = /*@DVI_DATA@*/ null;

  const ITEM = new Map();       // id → {id,name,value,stackable,heals}
  const ACTION = new Map();     // id → 行动对象
  const SITE = new Map();       // id → 站点
  const MONSTER = new Map();
  const BY_SKILL = new Map();   // skill → [action]
  const BY_GROUP = new Map();   // skill/group → [action]
  const NAME_TO_ACTION = new Map();

  function buildIndices() {
    for (const it of DATA.items) ITEM.set(it.id, it);
    for (const a of DATA.actions) {
      ACTION.set(a.id, a);
      if (!BY_SKILL.has(a.skill)) BY_SKILL.set(a.skill, []);
      BY_SKILL.get(a.skill).push(a);
      const gk = a.skill + '/' + (a.group || '');
      if (!BY_GROUP.has(gk)) BY_GROUP.set(gk, []);
      BY_GROUP.get(gk).push(a);
      NAME_TO_ACTION.set(a.name.toLowerCase(), a);
    }
    for (const s of DATA.sites) SITE.set(s.id, s);
    for (const m of DATA.monsters) MONSTER.set(m.id, m);
  }
  buildIndices();

  const itemName = (id) => (ITEM.get(Number(id)) || {}).name || `#${id}`;
  const itemValue = (id) => (ITEM.get(Number(id)) || {}).value ?? 0;
  const actionName = (id) => (ACTION.get(Number(id)) || {}).name || `#${id}`;
  const skillName = (s) => DATA.skillNames[s] || s;

  /* ═══════════════════════════════════════════════════════════════
   * 1. 计算引擎（纯函数，可在 Node 里单测）
   * ═══════════════════════════════════════════════════════════════ */
  const B = DATA.balance;

  /* ═══ 时间单位 ═══
   * 客户端用常量 ae=600 做换算，证据：
   *   Ro = o => `${(o*ae/1e3).toFixed(1)}s`     tick → 秒
   *   Ht(o){ Math.round(o*ae/1e3) }             同上
   *   Ed(o){ Math.round(o*3600*1e3/ae) }        小时 → tick
   * 所以 1 tick = 600ms = 0.6 秒，不是 1 秒。 */
  const MS_PER_TICK = 600;
  const SECONDS_PER_TICK = MS_PER_TICK / 1000;   // 0.6
  const ticksToSeconds = (t) => t * SECONDS_PER_TICK;
  const secondsToTicks = (s) => s / SECONDS_PER_TICK;

  /* ---- 经验曲线：逐字复刻客户端构造 ---- */
  const XP_TABLE = (() => {
    const o = [0, 0];
    for (let s = 2; s <= B.maxLevel; s++) {
      o.push(Math.round(B.baseXp * (B.xpGrowth ** (s - 1) - 1) / (B.xpGrowth - 1)));
    }
    let e = o[B.maxLevel] * B.beyondStep, t = o[B.maxLevel];
    for (let s = B.maxLevel + 1; t + e <= Number.MAX_SAFE_INTEGER; s++) {
      t += e; o.push(Math.round(t)); e *= B.beyondGrowth;
    }
    return o;
  })();
  const MAX_IDX = XP_TABLE.length - 1;

  /** 等级 → 达到该等级所需累计经验 */
  const xpForLevel = (lv) => XP_TABLE[Math.min(Math.max(Math.floor(lv), 1), MAX_IDX)];

  /** 累计经验 → 等级（二分，复刻客户端 ve()） */
  function levelForXp(total) {
    if (total <= 0) return 1;
    let lo = 1, hi = MAX_IDX;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (XP_TABLE[mid] <= total) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** 当前等级内的进度 0~1 */
  function levelProgress(total) {
    const lv = levelForXp(total);
    if (lv >= MAX_IDX) return 1;
    const from = XP_TABLE[lv], to = XP_TABLE[lv + 1];
    if (to <= from) return 1;
    return Math.max(0, Math.min(1, (total - from) / (to - from)));
  }

  /* ── 工具（装备）加成：表来自数据层 ──
   * 客户端：工具系数 = 1 + 该装备的 bonus（ST/Qn 两个函数合起来的效果） */
  const TOOL_BONUS_BY_ITEM = new Map(
    (B.toolBonuses || []).map(t => [t.itemId, t.bonus]));
  // 技能 → 装备槽（数据层给的是 槽→技能，这里反过来）
  const SLOT_FOR_SKILL = {};
  for (const [slot, skill] of Object.entries(B.toolSlots || {})) {
    SLOT_FOR_SKILL[skill] = slot;
  }

  /**
   * 该行动在当前装备下的工具系数。
   * 没装备 / 该槽无加成 → 1（不影响速度）。
   */
  function toolFactor(you, action) {
    if (!you || !you.equipment || !action) return 1;
    const slot = SLOT_FOR_SKILL[action.skill];
    if (!slot) return 1;
    const itemId = you.equipment[slot];
    if (itemId == null) return 1;
    const bonus = TOOL_BONUS_BY_ITEM.get(itemId);
    return bonus != null ? 1 + bonus : 1;
  }

  /** 某个技能当前装了什么工具（供 UI 展示「当前配置」） */
  function equippedTool(you, skill) {
    const slot = SLOT_FOR_SKILL[skill];
    if (!slot || !you || !you.equipment) return null;
    const itemId = you.equipment[slot];
    if (itemId == null) return null;
    const bonus = TOOL_BONUS_BY_ITEM.get(itemId);
    return { slot, itemId, name: itemName(itemId),
             bonus: bonus != null ? bonus : 0,
             factor: bonus != null ? 1 + bonus : 1 };
  }

  /* ---- 加成叠加：各自减 1 再相加 ---- */
  const combine = (...fs) => 1 + fs.reduce((s, f) => s + (f - 1), 0);

  /**
   * 行动速度因子。
   * ⚠️ IT() 是「每 tick 推进的进度」，不是耗时。耗时 = baseTicks / IT。
   *    已用实测数据校验：预测 50.9 产出 vs 实测 51，偏差 0.2%。
   */
  function speedFactor(action, opts) {
    const o = opts || {};
    const level = o.level || 1;
    const lvl = 1 + Math.max(0, level - action.levelReq) * B.speedPerLevelAboveRequirement;
    const quick = 1 + B.perkQuickPerLevel * (o.quickPerk || 0);
    const home = o.homeFactor || 1;
    const mastery = o.masteryFactor || 1;
    const tool = o.toolFactor || 1;
    return lvl * tool * combine(quick, home) * mastery;
  }

  /** 单次行动耗时（tick） */
  function actionTicks(action, opts) {
    return action.baseTicks / speedFactor(action, opts);
  }

  /** 每小时理论产出（未计背包往返）。返回值基于秒，不是 tick。 */
  function unitsPerHour(action, opts) {
    const ticks = actionTicks(action, opts);
    if (!(ticks > 0)) return 0;
    return 3600 / ticksToSeconds(ticks) * (action.output ? action.output.qty : 1);
  }

  /* ═══ 经验加成：全部走数据层 + 运行期查表 ═══
   * 系数表由 ../dvi_probe/extract_balance.py 从 bundle 提取，
   * 经 build.py 并进 DATA.balance。游戏改版后重跑提取器即可，
   * 不需要改这里的任何逻辑。
   *
   * 客户端原始机制（本文件据此复刻）：
   *   Zn = [1, 1.3, 1.6, 2.2, 3]          增益按「层数」查的倍率表
   *   ra(you,id) = brews[id] > lastTick   增益是否生效
   *   n5(you,id) = 按 brewBuckets 时间衰减算当前层数
   *   No(you,id) = ra ? Zn[n5] : 0
   *   TT = It(1 + 0.1*No('gatherer'), 1 + 0.1*No('elixir'), 祝福, 公会)
   *   xp = round(base × Kn[tier] × It(windowMult, TT, 技能buff, 精通))
   */
  const XP = {
    tierMult: B.xpTierMults || [1, 1.5, 3, 8, 25],
    buffTierMults: B.buffTierMults || [1, 1.3, 1.6, 2.2, 3],
    buffPerRank: B.buffPerRank || { gatherer: 0.1, elixir: 0.1, hunter: 0.25 },
    blessing: B.blessing || { gather: 1.05, combat: 1.1 },
  };

  /** 特长/精通表（同一张表，perRank 即精通每级系数） */
  const PERK_BY_ID = new Map((B.perks || []).map(p => [p.id, p]));

  /** 取某项特长/精通的每级系数；表里没有就返回 0（不加成） */
  function perkPerRank(id) {
    const p = PERK_BY_ID.get(id);
    return p ? p.perRank : 0;
  }

  const clampTier = (n) =>
    Math.max(0, Math.min(XP.buffTierMults.length - 1, n | 0));

  /** 增益是否生效（复刻 ra） */
  function buffActive(you, id) {
    if (!you || !you.brews) return false;
    return (you.brews[id] ?? 0) > (you.lastTick ?? 0);
  }

  /**
   * 增益当前层数（复刻 n5 + wh）。
   * 层数会随时间衰减：brewBuckets 记录每层的时长，
   * 已过去的时间落在哪一层的区间里，就是当前层。
   */
  function buffTier(you, id) {
    if (!you) return 0;
    const buckets = you.brewBuckets && you.brewBuckets[id];
    if (buckets && buckets.length) {
      const total = buckets.reduce((a, i) => a + i, 0);
      const elapsed = Math.max(0, (you.lastTick ?? 0) - ((you.brews?.[id] ?? 0) - total));
      let n = 0;
      for (let a = buckets.length - 1; a >= 0; a--) {
        n += buckets[a];
        if (elapsed < n) return clampTier(a);
      }
    }
    return clampTier((you.brewTier && you.brewTier[id]) || 0);
  }

  /** 增益当前倍率（复刻 No）：未生效返回 0 */
  function buffMult(you, id) {
    if (!buffActive(you, id)) return 0;
    return XP.buffTierMults[buffTier(you, id)] || 0;
  }

  /**
   * 单次行动实际获得的经验（已含各项加成）。
   * 所有加成都可以缺省；缺省即 1（无加成）。
   *
   * @param {object} action
   * @param {object} [o] 见 state.xpContext() —— 那里会把当前状态一次备齐
   *   you           玩家存档（用于算增益层数，缺省则视为无增益）
   *   windowXpMult  当前社区活动经验倍率
   *   tier          稀有档位
   *   gathererMult/elixirMult  增益倍率（也可由 you 自动推）
   *   blessing      祝福是否生效
   *   guildBonus    公会加成
   *   skillBuffMult 技能 buff 倍率
   *   masteryXpRank 精通（xp 分支）等级
   */
  function xpPerAction(action, o) {
    const c = o || {};
    if (!action.xp) return 0;

    const tier = Math.max(0, Math.min(c.tier || 0, XP.tierMult.length - 1));

    // 增益倍率：调用方给了就用给的，否则从存档里现算
    const you = c.you;
    const gMult = c.gathererMult != null ? c.gathererMult : (you ? buffMult(you, 'gatherer') : 0);
    const eMult = c.elixirMult != null ? c.elixirMult : (you ? buffMult(you, 'elixir') : 0);
    const blessingOn = c.blessing != null
      ? !!c.blessing
      : (you ? buffActive(you, 'blessing') : false);

    const pureGather = (action.inputs || []).length === 0;
    const tt = combine(
      pureGather ? 1 + XP.buffPerRank.gatherer * gMult : 1,
      1 + XP.buffPerRank.elixir * eMult,
      blessingOn ? XP.blessing.gather : 1,
      1 + (c.guildBonus || 0),
    );
    // 精通每级系数也从特长表里查，不再写死
    const masteryRank = c.masteryXpRank != null
      ? c.masteryXpRank
      : ((you && you.masteries && you.masteries.xp) || 0);
    const mastery = 1 + masteryRank * perkPerRank('xp');
    const total = combine(c.windowXpMult || 1, tt, c.skillBuffMult || 1, mastery);

    return Math.max(1, Math.round(action.xp * XP.tierMult[tier] * total));
  }

  /**
   * 从当前经验升到目标等级，还需要多少次这个行动。
   *
   * 逐级推进而不是一次除完——因为等级提升会加速，
   * 每一级的实际耗时不同，分段算才准确（等级内速度是常量）。
   * 不计赶路/转场时间：只回答「还要做多少次」。
   *
   * @returns {{fromLevel, toLevel, alreadyThere, xpNeeded, xpPerAction,
   *            actions, ticks, seconds, perLevel} | null}
   */
  function actionsToLevel(action, currentXp, targetLevel, opts) {
    const o = opts || {};
    // 用完整的经验加成链，而不是配方的裸 xp —— 这样才算「按当前环境」
    const perAction = xpPerAction(action, o);
    if (perAction <= 0) return null;              // 该行动不给经验

    let xp = Math.max(0, currentXp);
    const fromLevel = levelForXp(xp);
    let target = Math.floor(targetLevel);
    if (!Number.isFinite(target)) target = fromLevel + 1;
    target = Math.min(Math.max(target, fromLevel), MAX_IDX);

    if (target <= fromLevel) {
      return { fromLevel, toLevel: fromLevel, alreadyThere: true,
               xpNeeded: 0, actions: 0, seconds: 0, perLevel: [] };
    }

    const goalXp = xpForLevel(target);
    const xpNeeded = goalXp - xp;

    let lv = fromLevel;
    let actions = 0, seconds = 0, totalTicks = 0;
    const perLevel = [];

    // 最多推进 MAX_IDX 级，天然有界
    while (lv < target) {
      const nextCap = xpForLevel(lv + 1);           // 升到下一级所需累计经验
      const chunkEnd = Math.min(nextCap, goalXp);   // 本段的目标经验
      const need = chunkEnd - xp;
      if (need <= 0) { lv++; continue; }

      const n = Math.ceil(need / perAction);
      const ticks = actionTicks(action, { ...o, level: lv });
      // 注意换算：tick ≠ 秒，1 tick = 0.6 秒
      const seg = { level: lv, actions: n, ticks: n * ticks,
                    seconds: ticksToSeconds(n * ticks) };
      perLevel.push(seg);
      actions += n;
      seconds += seg.seconds;
      totalTicks += seg.ticks;

      xp += n * perAction;
      const newLv = levelForXp(xp);
      lv = newLv > lv ? newLv : lv + 1;             // 防御：保证前进，不死循环
    }

    return {
      fromLevel, toLevel: target, alreadyThere: false,
      xpNeeded, xpPerAction: perAction,
      actions, ticks: totalTicks, seconds, perLevel, exact: true,
    };
  }

  /** 把秒数说成人话 */
  function humanDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    if (sec < 60) return `${Math.round(sec)} 秒`;
    if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
    return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 小时`;
  }

  /* ---- 利润 ---- */
  /**
   * 单位成本（递归展开配方）。市场价缺失时回退到物品基础价值。
   * @param {object} action 行动
   * @param {(id:number)=>number} priceOf 取价函数
   * @param {object} memo 缓存
   */
  function inputCost(action, priceOf, memo) {
    const m = memo || new Map();
    if (m.has(action.id)) return m.get(action.id);
    let total = 0;
    for (const inp of (action.inputs || [])) {
      let unit;
      if (inp.actionId) {
        unit = inputCost(ACTION.get(inp.actionId), priceOf, m) / (ACTION.get(inp.actionId).output.qty || 1);
      } else {
        unit = priceOf(inp.itemId);
      }
      total += unit * inp.qty;
    }
    m.set(action.id, total);
    return total;
  }

  /**
   * 行动的收益分析。所有 /小时 的数值都已换算成真实秒（1 tick = 0.6 秒）。
   * @returns {{ticks, seconds, unitsPerHour, grossPerHour, costPerHour, netPerHour, xpPerHour, profitPerTick}}
   */
  function analyse(action, opts) {
    const o = opts || {};
    const priceOf = o.priceOf || itemValue;
    const taxRate = (o.taxBp ?? B.marketTaxBp) / 10000;
    const ticks = actionTicks(action, o);
    const outQty = action.output ? action.output.qty : 0;

    if (!(ticks > 0)) return null;
    const seconds = ticksToSeconds(ticks);
    const perHour = 3600 / seconds;

    const sellUnit = priceOf(action.output.itemId);
    const gross = sellUnit * outQty * perHour;
    const net = gross * (1 - taxRate);
    const cost = inputCost(action, priceOf) * perHour;

    return {
      ticks,
      seconds,
      unitsPerHour: outQty * perHour,
      grossPerHour: gross,
      costPerHour: cost,
      netPerHour: net - cost,
      xpPerHour: (action.xp || 0) * perHour,
      profitPerTick: (net - cost) / secondsToTicks(3600),
    };
  }

  /* ---- 强化 ---- */
  const EN = B.enhance;
  /** 强化成功率：min(1, max(floor, 1 − tier×drop) × (1+讲台) × 精通) */
  function enhanceChance(tier, opts) {
    const o = opts || {};
    const base = Math.max(EN.baseChanceFloor, 1 - tier * EN.chanceDropPerTier);
    return Math.min(1, base * (1 + (o.lecternBonus || 0)) * (o.masteryFactor || 1));
  }
  /** 单次强化费用 */
  function enhanceCost(tier, qualityIdx) {
    const g = EN.goldTiers[Math.min(tier, EN.goldTiers.length - 1)];
    const q = EN.qualityMult[Math.min(qualityIdx, EN.qualityMult.length - 1)];
    return { gold: g * q * (tier + 1), shards: EN.shardsPerTier * (tier + 1) };
  }
  /** 从 +0 强化到 +target 的期望花费 */
  function enhanceExpected(target, qualityIdx, opts) {
    let gold = 0, shards = 0, attempts = 0;
    for (let t = 0; t < target; t++) {
      const p = enhanceChance(t, opts);
      if (p <= 0) return null;
      const n = 1 / p, c = enhanceCost(t, qualityIdx);
      gold += c.gold * n; shards += c.shards * n; attempts += n;
    }
    return { gold, shards, attempts };
  }

  /* ═══════════════════════════════════════════════════════════════
   * 2. 事件总线
   * ═══════════════════════════════════════════════════════════════ */
  const bus = (() => {
    const map = new Map();
    const on = (evt, fn) => {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => off(evt, fn);
    };
    const off = (evt, fn) => { map.get(evt)?.delete(fn); };
    const emit = (evt, payload) => {
      for (const fn of (map.get(evt) || [])) {
        try { fn(payload); } catch (e) { console.error(`[DVI] 事件 ${evt} 处理出错`, e); }
      }
      for (const fn of (map.get('*') || [])) {
        try { fn({ type: evt, payload }); } catch (e) {}
      }
    };
    return { on, off, emit, _map: map };
  })();

  /* 主干向外发出的事件名 */
  const EVT = {
    READY: 'core:ready',
    WELCOME: 'game:welcome',
    SNAPSHOT: 'game:snapshot',
    OFFLINE: 'game:offline',
    BATCH: 'game:batch',
    WORK: 'game:work',
    MARKET: 'game:market',
    TICK: 'game:tick',
    PLUGIN_ON: 'plugin:enabled',
    PLUGIN_OFF: 'plugin:disabled',
    SETTINGS: 'settings:changed',
    /** 用户主动要求重算（菜单项 / 内联按钮触发）。
     *  插件收到后应丢弃缓存并重新计算 —— 见「按需刷新」的约定。 */
    REFRESH: 'core:refresh',
  };

  /* ═══════════════════════════════════════════════════════════════
   * 3. 状态归约
   *    把 WS 消息流归约成一份可读的游戏状态。
   * ═══════════════════════════════════════════════════════════════ */
  const state = (() => {
    const s = {
      me: null,            // 角色存档（welcome/snapshot 的 you）
      world: null,         // 世界信息（seed/online/build…）
      offline: null,       // 最近一次离线报告
      market: new Map(),   // itemId → {bid,bidQty,ask,askQty,floor}
      depth: new Map(),    // itemId → {bids,asks,trades}
      players: new Map(),  // id → {name,x,y,gear,mount,tag,title}
      tick: 0,
      connected: false,
      lastBatch: null,     // 最近一次产出结算
      job: null,           // 当前作业 {siteId,tool,item}
      tallies: { produced: {}, xp: {}, kills: 0 },
    };

    function reset() {
      s.players.clear(); s.market.clear(); s.depth.clear();
      s.tallies = { produced: {}, xp: {}, kills: 0 };
    }

    function applySelf(you) {
      if (!you) return;
      s.me = you;
      if (you.workSiteId != null && you.workJobId != null) {
        s.job = { siteId: you.workSiteId, jobId: you.workJobId };
      }
      bus.emit(EVT.SNAPSHOT, s.me);
    }

    function reduce(frame) {
      if (Number.isInteger(frame.tick)) s.tick = frame.tick;
      const msgs = Array.isArray(frame.m) ? frame.m : [];
      for (const m of msgs) {
        if (!m || typeof m.t !== 'string') continue;
        switch (m.t) {
          case 'welcome': {
            s.world = {
              protocol: m.protocol, seed: m.seed, online: m.online,
              build: m.build, variant: m.variant, marketTaxBp: m.marketTaxBp,
              bossNext: m.bossNext, windows: m.windows || [],
            };
            applySelf(m.you);
            if (m.offline) { s.offline = m.offline; bus.emit(EVT.OFFLINE, m.offline); }
            bus.emit(EVT.WELCOME, { world: s.world, me: s.me });
            break;
          }
          case 'snapshot':
            applySelf(m.you);
            break;

          case 'enter':
            if (m.player) s.players.set(m.player.id, m.player);
            break;
          case 'leave':
            s.players.delete(m.id);
            break;
          case 'move': {
            const p = s.players.get(m.id);
            if (p) { p.x = m.x; p.y = m.y; }
            break;
          }
          case 'work': {
            const p = s.players.get(m.id);
            if (p) p.work = m.work;
            if (s.me && m.id === s.me.id) s.job = m.work
              ? { siteId: m.work.siteId, jobId: s.job?.jobId }
              : null;
            bus.emit(EVT.WORK, m);
            break;
          }
          case 'batch': {
            for (const e of (m.e || [])) {
              if (e && e.kind === 'produced') {
                s.tallies.produced[e.itemId] = (s.tallies.produced[e.itemId] || 0) + 1;
                s.tallies.xp[e.jobId] = (s.tallies.xp[e.jobId] || 0) + (e.xp || 0);
              }
            }
            s.lastBatch = m.e;
            bus.emit(EVT.BATCH, m.e);
            break;
          }

          case 'marketBook':
            if (m.top) s.market.set(m.top.itemId, m.top);
            bus.emit(EVT.MARKET, { type: 'book', data: m.top });
            break;
          case 'marketBooks':
            for (const t of (m.tops || [])) s.market.set(t.itemId, t);
            bus.emit(EVT.MARKET, { type: 'books', data: m.tops });
            break;
          case 'marketDepth':
            s.depth.set(m.itemId, { bids: m.bids, asks: m.asks, trades: m.trades });
            if (m.bids?.[0]) {
              const cur = s.market.get(m.itemId) || { itemId: m.itemId };
              cur.bid = m.bids[0].price;
              cur.bidQty = m.bids[0].qty;
              if (m.asks?.[0]) {
                cur.ask = m.asks[0].price;
                cur.askQty = m.asks[0].qty;
              }
              s.market.set(m.itemId, cur);
            }
            bus.emit(EVT.MARKET, { type: 'depth', data: { itemId: m.itemId, ...s.depth.get(m.itemId) } });
            break;
          case 'marketHistory':
            bus.emit(EVT.MARKET, { type: 'history', data: m.rows || [] });
            break;
          case 'online':
            if (s.world) s.world.online = m.n;
            break;
          default: break;
        }
      }
      bus.emit(EVT.TICK, frame);
    }

    /** 取某个物品的参考价：优先最优卖价，其次买价，最后基础价值 */
    function priceOf(itemId) {
      const mk = s.market.get(Number(itemId));
      if (mk) {
        if (mk.ask != null) return mk.ask;
        if (mk.bid != null) return mk.bid;
      }
      return itemValue(itemId);
    }

    /**
     * 某个 tick 时刻生效的社区活动倍率（复刻客户端 la()）。
     * 客户端原式：遍历 windows，落在 [fromTick, toTick] 内的把 (mult-1) 累加。
     * @returns {{xpMult:number, rarityMult:number}}
     */
    function windowMultsAt(tick) {
      const t = Number.isFinite(tick) ? tick : s.tick;
      let xp = 0, rarity = 0;
      for (const w of (s.world && s.world.windows) || []) {
        if (!w) continue;
        if (t < (w.fromTick ?? -Infinity) || t > (w.toTick ?? Infinity)) continue;
        xp += (w.xpMult ?? 1) - 1;
        rarity += (w.rarityMult ?? 1) - 1;
      }
      return { xpMult: 1 + xp, rarityMult: 1 + rarity };
    }

    /** 当前生效的社区经验倍率 */
    function currentXpMult() { return windowMultsAt(s.tick).xpMult; }

    /**
     * 汇总「按当前环境」计算经验所需的全部参数 —— **每次调用都重新算**。
     * 插件直接把它丢给 calc.xpPerAction / calc.actionsToLevel 即可。
     *
     * 动态来源：
     *   社区活动倍率 ← s.world.windows 按当前 tick 过滤
     *   增益层数     ← s.me.brews / brewBuckets 按 lastTick 时间衰减
     *   精通等级     ← s.me.masteries
     *   稀有档位     ← s.me.workRarity
     *   特长         ← s.me.perks
     */
    function xpContext(extra) {
      const me = s.me || {};
      return {
        you: me,                                   // 增益层数由 xpPerAction 按存档现算
        windowXpMult: currentXpMult(),
        tier: me.workRarity || 0,
        guildBonus: me.guildBonus || 0,
        masteryXpRank: (me.masteries && me.masteries.xp) || 0,
        quickPerk: (me.perks && me.perks.quick) || 0,
        ...(extra || {}),
      };
    }

    /**
     * 【统一入口】针对某个行动，即时汇总「我此刻的配置」。
     * 每次调用都重新求值 —— 换装备、升级、增益到期、社区活动开始，下一次调用就会反映出来。
     * 插件把它直接丢给 calc.actionsToLevel / calc.analyse / calc.xpPerAction 即可。
     *
     * 汇总内容：
     *   速度侧：等级、快捷特长、当前装备的工具系数
     *   经验侧：社区活动倍率、稀有档位、各项增益、精通
     */
    function actionContext(action, extra) {
      const me = s.me || {};
      const skill = action && action.skill;
      const xp = (skill && me.skills && me.skills[skill]) || 0;
      return {
        you: me,                                   // 增益层数由 calc 按存档现算
        level: levelForXp(xp),                     // 速度用
        xp,                                        // 经验用
        toolFactor: toolFactor(me, action),        // ← 当前装备
        quickPerk: (me.perks && me.perks.quick) || 0,
        windowXpMult: currentXpMult(),             // ← 当前社区活动
        tier: me.workRarity || 0,
        guildBonus: me.guildBonus || 0,
        masteryXpRank: (me.masteries && me.masteries.xp) || 0,
        ...(extra || {}),
      };
    }

    /**
     * 生成一份「当前配置」的可读说明，用于在界面上如实展示
     * —— 让用户看得见这些数字是从他的实时状态来的，而不是写死的。
     */
    function configSummary(action) {
      const me = s.me || {};
      if (!me || !action) return [];
      const skill = action.skill;
      const xp = (me.skills && me.skills[skill]) || 0;
      const level = levelForXp(xp);
      const tool = equippedTool(me, skill);
      const lines = [
        { label: skillName(skill), value: `${level} 级（${Math.round(xp).toLocaleString()} xp）` },
        { label: action.name + ' 需求', value: `${action.levelReq} 级${level < action.levelReq ? '（未达标）' : ''}` },
      ];
      if (tool) {
        lines.push({ label: '工具', value: `${tool.name} +${Math.round(tool.bonus * 100)}%` });
      } else {
        lines.push({ label: '工具', value: '未装备（无加成）' });
      }
      const q = (me.perks && me.perks.quick) || 0;
      if (q) lines.push({ label: '快捷特长', value: `${q} 级 +${(q * 0.5).toFixed(1)}%` });
      const wm = currentXpMult();
      if (wm !== 1) lines.push({ label: '社区活动', value: `经验 ×${wm.toFixed(2)}` });
      const gt = buffActive(me, 'gatherer') ? buffMult(me, 'gatherer') : 0;
      if (gt) lines.push({ label: '采集增益', value: `层数 ×${gt}（有效）` });
      if (buffActive(me, 'blessing')) lines.push({ label: '祝福', value: '生效中' });
      const mr = (me.masteries && me.masteries.xp) || 0;
      if (mr) lines.push({ label: '精通 xp', value: `${mr} 阶` });
      return lines;
    }

    return { s, reduce, reset, priceOf, windowMultsAt, currentXpMult,
             xpContext, actionContext, configSummary };
  })();

  /* ═══════════════════════════════════════════════════════════════
   * 4. 网络层（只读）
   *    ⚠️ 刻意不提供 send。这是架构级约束：
   *       插件拿不到任何发送游戏指令的通道。
   * ═══════════════════════════════════════════════════════════════ */
  const net = (() => {
    const stats = { frames: 0, bytes: 0, socket: null, since: Date.now() };

    function install() {
      try {
        const desc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
        const origGet = desc.get;

        desc.get = function () {
          let raw;
          try { raw = origGet.call(this); } catch (e) { return origGet.call(this); }
          try {
            const sock = this.currentTarget;
            /* ⚠ 千万不要用 `sock instanceof WebSocket` 判断。
             * 油猴的沙箱有自己的 WebSocket 构造器，页面创建的那个
             * 对它 instanceof 恒为 false —— 于是**一条消息都抓不到**，
             * 表现为「无 socket / 尚未收到服务器帧」。
             * 沙箱模式下 console 还会报 Illegal invocation（接收者不对）。
             * 改成鸭子类型：只看有没有带 deepveinidle.com 的 url。
             */
            const url = sock && sock.url;
            if (typeof url === 'string' && url.indexOf('deepveinidle.com') >= 0) {
              stats.socket = sock;
              stats.bytes += (typeof raw === 'string' ? raw.length : 0);
              // 浏览器已完成分包重组，这里拿到的总是完整消息
              if (typeof raw === 'string' && raw.charCodeAt(0) === 123) {
                const frame = JSON.parse(raw);
                if (frame && Array.isArray(frame.m)) {
                  stats.frames++;
                  if (!state.s.connected) { state.s.connected = true; bus.emit('net:online'); }
                  state.reduce(frame);
                }
              }
            }
          } catch (e) { /* 绝不冒泡给游戏 */ }
          return raw;
        };
        Object.defineProperty(MessageEvent.prototype, 'data', desc);
      } catch (e) {
        console.error('[DVI] 网络钩子安装失败', e);
      }
    }

    return {
      install, stats,
      get connected() { return state.s.connected; },
      /* 只读句柄：明确不暴露 send / close */
      get socketUrl() { return stats.socket ? stats.socket.url : null; },
    };
  })();

  /* ═══════════════════════════════════════════════════════════════
   * 5. 设置
   * ═══════════════════════════════════════════════════════════════ */
  const settings = (() => {
    const KEY = 'dvi_tools_settings';
    let all = GM_getValue(KEY, {});
    const listeners = new Set();

    function get(k, dflt) {
      return Object.prototype.hasOwnProperty.call(all, k) ? all[k] : dflt;
    }
    function set(k, v) {
      all[k] = v;
      GM_setValue(KEY, all);
      listeners.forEach(fn => { try { fn(k, v); } catch (e) {} });
      bus.emit(EVT.SETTINGS, { key: k, value: v });
    }
    function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    function snapshot() { return { ...all }; }

    return { get, set, onChange, snapshot, get all() { return all; } };
  })();

  /* ═══════════════════════════════════════════════════════════════
   * 6. UI 框架
   * ═══════════════════════════════════════════════════════════════ */
  const ui = (() => {
    const CSS = `
      .dvi-fab{position:fixed;right:14px;bottom:14px;z-index:2147483000;width:40px;height:40px;
        border-radius:50%;border:1px solid #2c3540;background:#1c1f23;color:#dfe4ea;cursor:pointer;
        font:600 15px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
        box-shadow:0 3px 14px rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;
        user-select:none;transition:transform .12s}
      .dvi-fab:hover{transform:scale(1.07)}
      .dvi-fab[data-open="1"]{background:#2f6fed;border-color:#2f6fed;color:#fff}
      .dvi-win{position:fixed;right:14px;bottom:62px;z-index:2147483001;width:340px;max-height:72vh;
        overflow:auto;background:#fff;color:#1c1f23;border:1px solid #d8dce1;border-radius:12px;
        box-shadow:0 10px 34px rgba(0,0,0,.2);font:13px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
      .dvi-win[hidden]{display:none}
      .dvi-hd{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #eceff2;
        font-weight:600;font-size:13.5px;position:sticky;top:0;background:#fff;border-radius:12px 12px 0 0}
      .dvi-hd .dvi-x{margin-left:auto;cursor:pointer;color:#8b96a3;font-size:16px;line-height:1;padding:0 4px}
      .dvi-hd .dvi-x:hover{color:#c0392b}
      .dvi-bd{padding:12px 14px}
      .dvi-sec{font-weight:600;font-size:12.5px;color:#5f6b76;margin:14px 0 6px;
        text-transform:uppercase;letter-spacing:.04em}
      .dvi-sec:first-child{margin-top:0}
      .dvi-row{display:flex;align-items:center;gap:9px;padding:6px 0}
      .dvi-row label{flex:1;cursor:pointer}
      .dvi-row .dvi-sub{display:block;color:#8b96a3;font-size:11.5px;line-height:1.4}
      .dvi-row input[type=number],.dvi-row input[type=text]{width:74px;padding:3px 7px;border:1px solid #d8dce1;
        border-radius:5px;font-size:12.5px;font-family:inherit}
      .dvi-row input[type=checkbox]{width:15px;height:15px;cursor:pointer;accent-color:#2f6fed}
      .dvi-note{color:#8b96a3;font-size:11.5px;margin-top:9px;line-height:1.5}
      .dvi-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:2147483002;
        background:#1c1f23;color:#e6e8ea;padding:8px 16px;border-radius:8px;font-size:13px;
        box-shadow:0 5px 18px rgba(0,0,0,.28);opacity:0;transition:opacity .18s}
      .dvi-toast[data-show="1"]{opacity:1}
      .dvi-tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:4px;
        background:#eef1f5;color:#5f6b76}
      .dvi-err{color:#c0392b}

      /* ── 内联注入：刻意做得低调，像游戏自带的注释 ── */
      .dvi-inline{font-size:11.5px;line-height:1.45;opacity:.92}
      .dvi-inline-note{display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;
        background:rgba(255,255,255,.08);color:#9aa7b4;font-variant-numeric:tabular-nums;
        white-space:nowrap;cursor:help}
      .dvi-inline-note[data-tone="warn"]{color:#d8a657}
      .dvi-inline-note[data-tone="done"]{color:#6fbf8b}
      .dvi-inline-row{display:block;margin-top:2px;color:#8b96a3;font-size:11px}
      /* 标注可点（用于重算）：给一点可点的暗示，但不改变原有观感 */
      .dvi-inline-note{cursor:pointer}
      .dvi-inline-note:hover{background:rgba(255,255,255,.14)}
    `;

    let cssInjected = false;
    let fab = null, win = null, toastEl = null;
    /* 插件在面板里占的「分区」，按 (插件id, 标题) 归并。
     * 以前 panel() 是纯追加，插件每次渲染都调它 → 面板无限变长。
     * 现在同一 key 只建一次并复用，且每次返回前清空内容。 */
    const sections = new Map();

    /* 「无感」的关键：默认不往页面上放任何常驻元素。
     * quiet = 页面零痕迹，面板从油猴菜单叫出来（默认）
     * fab   = 右下角常驻一个圆形按钮（给想随手点开的人） */
    const MODE_QUIET = 'quiet', MODE_FAB = 'fab';
    const mode = () => settings.get('ui.mode', MODE_QUIET);
    const setMode = (m) => { settings.set('ui.mode', m); applyMode(); };

    function ensureCSS() {
      if (cssInjected) return;
      try { GM_addStyle(CSS); } catch (e) {
        const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
      }
      cssInjected = true;
    }

    function ready(fn) {
      if (document.body) fn();
      else document.addEventListener('DOMContentLoaded', fn, { once: true });
    }

    function makeFab() {
      if (fab) return fab;
      fab = document.createElement('div');
      fab.className = 'dvi-fab';
      fab.textContent = 'DVI';
      fab.title = 'DVI Tools';
      fab.setAttribute('data-dvi-fab', '');
      fab.onclick = () => toggle();
      document.body.appendChild(fab);
      return fab;
    }

    function removeFab() {
      if (fab && fab.parentNode) fab.parentNode.removeChild(fab);
      fab = null;
    }

    function applyMode() {
      ready(() => {
        makeWindow();
        if (mode() === MODE_FAB) makeFab();
        else removeFab();
      });
    }

    function makeWindow() {
      if (win) return win;
      win = document.createElement('div');
      win.className = 'dvi-win';
      win.setAttribute('data-dvi-win', '');
      win.hidden = true;
      win.innerHTML =
        '<div class="dvi-hd"><span>DVI Tools</span>' +
        `<span class="dvi-tag">v${VERSION}</span>` +
        '<span class="dvi-x" data-dvi-close>×</span></div>' +
        '<div class="dvi-bd"></div>';
      win.querySelector('[data-dvi-close]').onclick = () => toggle(false);
      document.body.appendChild(win);
      return win;
    }

    function toggle(force) {
      ready(() => {
        makeWindow();
        if (mode() === MODE_FAB) makeFab();
        const open = force === undefined ? win.hidden : !!force;
        win.hidden = !open;
        if (fab) fab.setAttribute('data-open', open ? '1' : '0');
        if (open) renderSettings();
      });
    }

    function body() { makeWindow(); return win.querySelector('.dvi-bd'); }

    /** 主干自用的幂等分区（与插件的 ctx.ui.panel 同一套机制） */
    function ownSection(title, key) {
      const b = body();
      let box = sections.get(key);
      if (!box || !box.parentNode || !sections.has(key)) {
        const sec = document.createElement('div');
        sec.className = 'dvi-sec';
        sec.setAttribute('data-dvi-sec', key);
        sec.textContent = title;
        b.appendChild(sec);
        box = document.createElement('div');
        box.setAttribute('data-dvi-panel', key);
        b.appendChild(box);
        sections.set(key, box);
      }
      box.textContent = '';
      return box;
    }

    function toast(msg, ms) {
      ready(() => {
        ensureCSS();
        if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'dvi-toast'; document.body.appendChild(toastEl); }
        toastEl.textContent = msg;
        toastEl.setAttribute('data-show', '1');
        clearTimeout(toastEl._t);
        toastEl._t = setTimeout(() => toastEl.setAttribute('data-show', '0'), ms || 2000);
      });
    }

    /** 把一段设置表单渲染进主干窗口（由插件注册表调用） */
    function renderSettings() {
      const b = body();
      b.innerHTML = '';
      /* 面板被整体重绘，分区表必须一起作废。
       * 以前靠「节点的 parentNode 是否还在」来间接判断失效 ——
       * 那依赖 DOM 的隐式行为，不够显式，也更容易出错。 */
      sections.clear();

      const sec0 = document.createElement('div');
      sec0.className = 'dvi-sec';
      sec0.textContent = '状态';
      b.appendChild(sec0);

      const info = document.createElement('div');
      const me = state.s.me;
      info.innerHTML =
        `<div class="dvi-row"><label>连接</label><span class="dvi-tag">${state.s.connected ? '已连接' : '未连接'}</span></div>` +
        `<div class="dvi-row"><label>角色</label><span>${me ? me.name : '—'}</span></div>` +
        `<div class="dvi-row"><label>服务器帧</label><span>${state.s.tick || '—'}</span></div>` +
        `<div class="dvi-row"><label>在线</label><span>${state.s.world ? state.s.world.online : '—'}</span></div>` +
        `<div class="dvi-row"><label>数据表</label><span>${DATA.items.length} 物品 / ${DATA.actions.length} 配方 / ${DATA.sites.length} 站点</span></div>`;
      b.appendChild(info);

      registry.renderPanel(b);

      const note = document.createElement('div');
      note.className = 'dvi-note';
      note.textContent = '本工具只读取游戏数据用于本地分析，不会向游戏发送任何指令。';
      b.appendChild(note);
    }

    /* ═══════════════════════════════════════════════════════════
     * 内联注入框架
     *
     * 这是「融入游戏」的关键：不另开悬浮窗，而是把自己的内容
     * 插进游戏已有的界面元素里。MWITools 也是这么做的。
     *
     * DVI 比 MWI 好办：它用的是朴素语义类名（chat-card / shop-name…）
     * 和一批 data-* 属性，不像 MWI 那样是 CSS-module 哈希。
     *
     * 用法：
     *   ui.inline.add({
     *     id: 'job-level',                    // 唯一标识，同时用作去重标记
     *     selector: 'button.route[data-job]', // 宿主元素
     *     where: 'beforeend',                 // 插入位置
     *     filter: (host) => true,             // 可选：哪些宿主才注入
     *     render: (host, extra) => string|Node|null,   // 返回 null 表示本次跳过
     *   })
     * ═══════════════════════════════════════════════════════════ */
    const anchors = new Map();
    let rafPending = false;
    let lastRun = 0;
    const MIN_INTERVAL = 120;   // ms，节流：显式 refresh 时合并高频调用

    const MARK = 'data-dvi-inline';

    function addAnchor(def) {
      if (!def || !def.id || !def.selector || typeof def.render !== 'function') {
        console.error('[DVI] 内联锚点定义不完整', def);
        return null;
      }
      // selector 可以是字符串或多个候选（按顺序取第一个能命中的）
      const sels = (Array.isArray(def.selector) ? def.selector : [def.selector])
        .filter(Boolean);
      anchors.set(def.id, {
        id: def.id,
        selectors: sels,
        selector: sels[0],
        where: def.where || 'beforeend',
        filter: def.filter || null,
        render: def.render,
        count: 0,           // 本次渲染注入了多少个
        hostsFound: 0,
        matchedBy: null,    // 实际命中的是哪个候选选择器
        lastError: null,
      });
      schedule();
      return def.id;
    }

    /** 依次尝试候选选择器，返回第一个能命中的结果 */
    function queryHosts(a) {
      for (const sel of a.selectors) {
        let hits;
        try { hits = document.querySelectorAll(sel); }
        catch (e) { a.lastError = `选择器非法：${sel}`; continue; }
        if (hits.length) { a.matchedBy = sel; return hits; }
      }
      // 都没命中时也要暴露错误
      if (!a.lastError) {
        try { document.querySelectorAll(a.selector); }
        catch (e) { a.lastError = `选择器非法：${a.selector}`; }
      }
      a.matchedBy = null;
      return [];
    }

    function removeAnchor(id) {
      anchors.delete(id);
      document.querySelectorAll(`[${MARK}="${id}"]`).forEach(n => n.remove());
      schedule();
    }

    /** 节流调度：一帧内只跑一次，且不低于最小间隔。
     *  **只用于「非游戏重绘驱动」的场合**（显式 refresh、兜底重扫）。
     *  游戏重绘驱动的补注走观察器里的**同步** applyAll，
     *  否则会延后一帧、表现为闪烁。 */
    function schedule() {
      if (rafPending) return;
      rafPending = true;
      const run = () => {
        rafPending = false;
        const now = Date.now();
        if (now - lastRun < MIN_INTERVAL) {
          setTimeout(schedule, MIN_INTERVAL - (now - lastRun));
          return;
        }
        lastRun = now;
        applyAll();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 16);
    }

    /** HTML 字符串 → 元素节点。优先用 <template>，不可用时退回 div。 */
    function htmlToNode(html) {
      const s = String(html).trim();
      if (!s) return null;
      try {
        const tpl = document.createElement('template');
        if (tpl && tpl.content) {
          tpl.innerHTML = s;
          if (tpl.content.firstElementChild) return tpl.content.firstElementChild;
        }
      } catch (e) { /* 继续走兜底 */ }
      try {
        const d = document.createElement('div');
        d.innerHTML = s;
        return d.firstElementChild || (d.children && d.children[0]) || null;
      } catch (e) { return null; }
    }

    let lastLoggedTotal = -1;   // 只在注入总数变化时记日志，避免每帧刷屏
    let lastLoggedAt = 0;       // 日志时间节流，console 输出本身也是开销

    let applying = false;        // 重入保护：我们自己插节点会再触发观察器

    function applyAll() {
      if (applying) return;      // 已经在一轮里了，直接退出（观察器会过滤自身变动）
      if (!document.body) return;
      applying = true;
      try {
        applyAllInner();
      } finally {
        applying = false;
      }
    }

    function applyAllInner() {
      let total = 0;
      for (const a of anchors.values()) {
        a.count = 0;
        a.lastError = null;
        const hosts = queryHosts(a);
        a.hostsFound = hosts.length;

        for (const host of hosts) {
          try {
            // 已经注入过就跳过（游戏重绘会把我们的节点一起换掉，下一轮会补上）
            if (host.querySelector(`[${MARK}="${a.id}"]`)) { a.count++; continue; }
            if (a.filter && !a.filter(host)) continue;

            const out = a.render(host, { id: a.id, core: api });
            if (out == null) continue;

            let node;
            if (typeof out === 'string') {
              node = htmlToNode(out);
              if (!node) continue;
            } else {
              node = out;
            }
            node.setAttribute(MARK, a.id);
            // 明确标记为插件内容，方便排查与样式隔离
            if (!String(node.className || '').includes('dvi-inline')) {
              node.className = (node.className ? node.className + ' ' : '') + 'dvi-inline';
            }

            if (a.where === 'afterend') host.insertAdjacentElement('afterend', node);
            else if (a.where === 'beforebegin') host.insertAdjacentElement('beforebegin', node);
            else if (a.where === 'afterbegin') host.insertAdjacentElement('afterbegin', node);
            else host.appendChild(node);

            a.count++;
          } catch (e) {
            // 单个宿主失败绝不影响其它宿主，更不影响游戏
            a.lastError = e.message;
          }
        }
        total += a.count;
      }

      lastInjectedTotal = total;   // 供每秒的存在性检查比对

      // 只在「注入总数」变化、且距上次记录超过 30 秒时才写日志。
      // 这个窗口刻意放得很宽：console 输出本身有成本，
      // 若游戏每帧重建列表、总数在 8/0 之间反复跳，1 秒一条会把控制台刷爆，
      // 开着 DevTools 时越跑越卡（日志条目会一直堆在控制台里）。
      if (total !== lastLoggedTotal) {
        const first = total > 0 && lastLoggedTotal <= 0;
        const now = Date.now();
        lastLoggedTotal = total;

        if (first || now - lastLoggedAt > 30000) {
          lastLoggedAt = now;
          const detail = [...anchors.values()]
            .map(a => `${a.id}:宿主${a.hostsFound}/注入${a.count}${a.lastError ? ' ⚠' + a.lastError : ''}`)
            .join(' · ');
          if (total > 0) DIAG.info('内联', `已注入 ${total} 处 · ${detail}`);
          else DIAG.warn('内联', `未注入任何内容 · ${detail || '（无锚点）'}`);

          // 首次注入时把「落点周围的 DOM 结构」也记下来。
          // 出过的问题：注入的元素把游戏面板排版撑坏，但日志里只有数量，
          // 看不出它到底被放进了什么样的容器。这里把父链和容器子元素数记清楚。
          if (first) {
            try {
              const a0 = [...anchors.values()][0];
              const host = a0 && document.querySelector(a0.selector);
              if (host) {
                const chain = [];
                let el = host, depth = 0;
                while (el && el.tagName && depth < 4) {
                  chain.push(el.tagName.toLowerCase() +
                    (el.className ? '.' + String(el.className).trim().split(/\s+/).slice(0, 2).join('.') : ''));
                  el = el.parentElement; depth++;
                }
                DIAG.info('结构', `注入落点：<${chain.join(' < ')}> · ` +
                  `父容器子元素 ${host.parentElement ? host.parentElement.children.length : '?'} 个`);
              }
            } catch (e) { /* 诊断失败不影响功能 */ }
          }
        }
      }
    }

    /* ── 注入的自愈：只做「极廉价的存在性检查」 ──
     *
     * 这里走过一段弯路：为了让标注在游戏重绘后立刻补回，
     * 我挂了 MutationObserver，并在**每一次** DOM 变动上同步重注入，
     * 后来又加了一层「相关性过滤」。结果是**掉帧严重**。
     *
     * 其实没必要。这份预估只需要「及时、相对准确」：
     * 它不随 tick 变化，玩家要的是点一下能拿到当下的数。
     * 所以：**不监听 DOM 变动**，只每秒做一次存在性检查，
     * 发现标注被游戏打扫掉了就补一次。
     *
     * 代价是每秒一次 querySelectorAll（可忽略），
     * 相比「挂在所有变动上」，负担小了两个数量级。
     */
    let watchTimer = null;
    let lastInjectedTotal = -1;
    let reinjectCount = 0;      // 启动以来补注过多少次（诊断用，不刷日志）

    function startInlineWatch() {
      if (watchTimer) return;
      applyAll();                        // 先注入一次

      const tick = () => {
        if (!anchors.size) return;       // 没有锚点就什么都不做
        let live = 0;
        try { live = document.querySelectorAll(`[${MARK}]`).length; } catch (e) { return; }
        // 数量对得上就立刻返回 —— 这是绝大多数情况，成本极低
        if (live === lastInjectedTotal) return;
        reinjectCount++;
        applyAll();                      // 被游戏重绘抹掉了，补一次
      };

      const start = () => {
        if (watchTimer) return;
        watchTimer = setInterval(tick, 1000);
      };
      const stop = () => {
        if (!watchTimer) return;
        clearInterval(watchTimer);
        watchTimer = null;
      };

      start();

      /* 页面不可见时**完全停掉**。
       * 用户反馈过：「放在后台一段时间回来好像还在持续运行」——
       * 一个静态的小东西不该在后台消耗任何东西。
       * 切回来时立刻补一次，所以体感上没有任何延迟。 */
      try {
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) stop();
          else { tick(); start(); }
        });
      } catch (e) { /* 不支持就退化成一直跑 */ }
    }

    /** 诊断：报告每个锚点当前匹配到多少宿主 */
    function inlineReport() {
      const rows = [];
      for (const a of anchors.values()) {
        rows.push({
          锚点: a.id,
          候选选择器: a.selectors.join(' | '),
          命中的: a.matchedBy || '（都没命中）',
          找到宿主: a.hostsFound,
          已注入: a.count,
          错误: a.lastError || '',
        });
      }
      return rows;
    }

    /* 游戏原生 tooltip 约定：data-tip-name + data-tip-lines（用 | 分隔）
     * 照这个格式生成，注入内容的提示就能和游戏自带的一模一样。 */
    function tip(name, lines) {
      /* 注意：游戏用 `|` 当行分隔符，且**没有办法转义它** ——
       * 内容里一旦出现 `|`，那一行就会被拆成两行，提示框随即错乱。
       * 所以这里直接把 `|` 换成视觉相近的 `｜`（全角），宁可字形略有差异，
       * 也不要让整个提示框崩掉。 */
      const esc = (s) => String(s)
        .replace(/\|/g, '｜')
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const body = (Array.isArray(lines) ? lines : [lines])
        .filter(l => l != null && l !== '')
        .map(esc).join('|');
      return `data-tip-name="${esc(name)}"` + (body ? ` data-tip-lines="${body}"` : '');
    }

    const inline = { add: addAnchor, remove: removeAnchor, refresh: schedule,
                     report: inlineReport, applyAll,
                     /** 运行统计：补注过多少次 —— 用来判断是否在跟游戏「较劲」 */
                     stats: () => ({ reinjects: reinjectCount, watching: !!watchTimer }),
                     get size() { return anchors.size; } };

    /* ═══════════════════════════════════════════════════════════
     * 导出成文件
     *
     * 只提供下载，不做剪贴板。
     * 原因：导出内容动辄几十上百 KB，塞进剪贴板既不实用也难粘贴；
     *      而且从油猴菜单触发时页面没有焦点，剪贴板 API 本就不可靠。
     * ═══════════════════════════════════════════════════════════ */
    function downloadText(text, filename, mime) {
      try {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
          if (a.parentNode) a.parentNode.removeChild(a);
        }, 1000);
        return true;
      } catch (e) { return false; }
    }

    return { ensureCSS, ready, toast, toggle, body, renderSettings, ownSection,
             makeFab, makeWindow, removeFab, applyMode,
             mode, setMode, MODE_QUIET, MODE_FAB,
             inline, startInlineWatch, tip,
             downloadText };
  })();

  /* ═══════════════════════════════════════════════════════════════
   * 7. 插件注册表
   *    插件的契约：
   *    {
   *      id, name, nameEn?, description?, defaultEnabled?,
   *      api: 1,                       // 依赖的核心 API 版本
   *      settings: [{key,label,type,default,min,max,onChange}],
   *      setup(ctx),                   // 注册时调用一次
   *      enable(ctx), disable(ctx),    // 开关切换
   *    }
   * ═══════════════════════════════════════════════════════════════ */
  const registry = (() => {
    const plugins = new Map();

    function register(def) {
      if (!def || !def.id) { console.error('[DVI] 插件缺少 id', def); return null; }
      if (plugins.has(def.id)) { console.warn('[DVI] 插件重复注册：' + def.id); return plugins.get(def.id); }
      if (def.api && def.api > API_VERSION) {
        console.warn(`[DVI] 插件 ${def.id} 需要 API v${def.api}，当前 v${API_VERSION}，已跳过`);
        return null;
      }

      const rec = {
        def,
        id: def.id,
        name: def.name || def.id,
        nameEn: def.nameEn || def.name || def.id,
        enabled: false,
        ctx: null,
        defaults: {},
      };
      for (const s of (def.settings || [])) rec.defaults[s.key] = s.default;

      plugins.set(def.id, rec);

      // 默认开关：插件自身声明 × 用户覆盖
      const wantOn = settings.get('plugin.' + def.id,
        def.defaultEnabled !== false);

      rec.ctx = makeCtx(rec);
      try {
        def.setup && def.setup(rec.ctx);
        DIAG.info('插件', `初始化完成 ${def.id}`);
      } catch (e) {
        // 绝不能静默：setup 失败意味着这个插件的功能完全不会出现，
        // 而用户只会看到「什么都没发生」。记下来，让自检和诊断能报出来。
        rec.setupError = (e && e.message) ? e.message : String(e);
        console.error(`[DVI] 插件 ${def.id} 初始化失败，它的功能将不会出现：`, e);
        DIAG.error('插件', `初始化失败 ${def.id}：${rec.setupError}`);
      }

      if (wantOn) enable(def.id, true);
      return rec;
    }

    function makeCtx(rec) {
      return {
        id: rec.id,
        core: api,                      // 指向公共 API 本体
        bus,
        /* state 用 Proxy 透明转发，而不是 Field 白名单。
         * 曾经这里写的是 `state: state.s` —— 只透传原始字段，
         * 结果插件调 ctx.state.actionContext() 时报「不是函数」，
         * 因为方法全被挡在外面了。而且每次给 state 加新方法都要记得同步，
         * 迟早会再漏。Proxy 把「读取」直接转给状态模块，字段和方法一起可达，
         * 新增接口无需改动这里。 */
        state: new Proxy({}, {
          get: (_, k) => (k in state ? state[k] : state.s[k]),
          has: (_, k) => (k in state) || (k in state.s),
          ownKeys: () => [...new Set([...Object.keys(state.s), ...Object.keys(state)])],
          getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        }),
        priceOf: state.priceOf,
        EVT,
        settings: {
          get: (k, d) => settings.get(rec.id + '.' + k, d === undefined ? rec.defaults[k] : d),
          set: (k, v) => settings.set(rec.id + '.' + k, v),
        },
        ui: {
          toast: ui.toast,
          onReady: ui.ready,
          /** 把内容注入游戏已有界面（这是「融入游戏」的正路）。
           *  id 缺省时用插件 id，省得每个锚点都想名字。 */
          /* 内联注入入口。刻意做成「既能当函数调用、又带方法」：
           *   ctx.ui.inline({...})          ← 注册锚点
           *   ctx.ui.inline.refresh()       ← 立即重扫
           * 这样两种写法都成立，不会因为改了其中一种而打断插件。 */
          inline: (() => {
            const fn = (def) => ui.inline.add({ ...def, id: (def && def.id) || rec.id });
            fn.add = fn;
            fn.remove = (id) => ui.inline.remove(id || rec.id);
            fn.refresh = () => ui.inline.refresh();
            fn.applyNow = () => ui.inline.applyAll();
            fn.report = () => ui.inline.report();
            return fn;
          })(),
          /** 兼容写法 */
          uninline: (id) => ui.inline.remove(id || rec.id),
          /** 生成游戏原生 tooltip 属性，拼进注入的 HTML 里 */
          tip: ui.tip,
          el: (tag, attrs, text) => {
            const e = document.createElement(tag);
            for (const [k, v] of Object.entries(attrs || {})) {
              if (k === 'class') e.className = v;
              else if (k === 'style') e.style.cssText = v;
              else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
              else e.setAttribute(k, v);
            }
            if (text != null) e.textContent = text;
            return e;
          },
          /* 在主干窗口里取一个分区（**幂等**）。
           *
           * 约定：同一个插件的同一个标题永远只占一个分区，
           * 每次调用会**先清空**再返回，调用方只管 appendChild 即可。
           *
           * 以前这里是纯追加，而插件把它挂在定时器上（每 1.5 秒调一次），
           * 于是面板每 tick 多一个分区、越拉越长 —— 这就是用户报的
           * 「窗口无限向下延伸」。API 不该设这种陷阱，所以从主干这边改。
           * 委托给 ui.ownSection，让分区机制只有一份实现。 */
          panel: (title, id) => ui.ownSection(title, `${rec.id}::${id || title}`),
        },
        log: (...a) => console.info(`[DVI:${rec.id}]`, ...a),
      };
    }

    function enable(id, silent) {
      const rec = plugins.get(id);
      if (!rec || rec.enabled) return;
      try { rec.def.enable && rec.def.enable(rec.ctx); rec.enabled = true; }
      catch (e) { console.error(`[DVI] 插件 ${id} 启用失败`, e); return; }
      if (!silent) { ui.toast(`已启用：${rec.name}`); bus.emit(EVT.PLUGIN_ON, rec); }
      ui.renderSettings && (window.__dviWinOpen && ui.renderSettings());
    }

    function disable(id, silent) {
      const rec = plugins.get(id);
      if (!rec || !rec.enabled) return;
      try { rec.def.disable && rec.def.disable(rec.ctx); } catch (e) {}
      rec.enabled = false;
      if (!silent) { ui.toast(`已停用：${rec.name}`); bus.emit(EVT.PLUGIN_OFF, rec); }
    }

    function setEnabled(id, on) {
      settings.set('plugin.' + id, !!on);
      on ? enable(id) : disable(id);
    }

    const list = () => [...plugins.values()];

    /** 在主干窗口渲染插件开关列表 */
    function renderPanel(host) {
      const sec = document.createElement('div');
      sec.className = 'dvi-sec';
      sec.textContent = `插件（${list().filter(p => p.enabled).length}/${plugins.size} 启用）`;
      host.appendChild(sec);

      if (!plugins.size) {
        const em = document.createElement('div');
        em.className = 'dvi-note';
        em.textContent = '尚未注册任何插件。主干已就绪，功能插件可以挂载上来。';
        host.appendChild(em);
        return;
      }

      for (const rec of list()) {
        const row = document.createElement('div');
        row.className = 'dvi-row';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = rec.enabled;
        cb.onchange = () => setEnabled(rec.id, cb.checked);

        const lb = document.createElement('label');
        const nm = document.createElement('span');
        nm.textContent = rec.name;
        lb.appendChild(nm);
        if (rec.def.description) {
          const sub = document.createElement('span');
          sub.className = 'dvi-sub';
          sub.textContent = rec.def.description;
          lb.appendChild(sub);
        }
        lb.onclick = (e) => { if (e.target !== cb) { cb.checked = !cb.checked; setEnabled(rec.id, cb.checked); } };

        row.appendChild(cb);
        row.appendChild(lb);
        host.appendChild(row);

        // 插件自带设置项
        for (const sd of (rec.def.settings || [])) {
          if (!sd || sd.panel === false) continue;
          const r2 = document.createElement('div');
          r2.className = 'dvi-row';
          const l2 = document.createElement('label');
          l2.textContent = sd.label || sd.key;
          r2.appendChild(l2);
          let input;
          if (sd.type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            if (sd.min != null) input.min = sd.min;
            if (sd.max != null) input.max = sd.max;
            input.value = rec.ctx.settings.get(sd.key);
            input.onchange = () => {
              const v = Number(input.value);
              rec.ctx.settings.set(sd.key, Number.isFinite(v) ? v : sd.default);
              sd.onChange && sd.onChange(Number(input.value), rec.ctx);
            };
          } else if (sd.type === 'bool') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!rec.ctx.settings.get(sd.key);
            input.onchange = () => {
              rec.ctx.settings.set(sd.key, input.checked);
              sd.onChange && sd.onChange(input.checked, rec.ctx);
            };
          }
          if (input) r2.appendChild(input);
          host.appendChild(r2);
        }

        /* 插件的「快捷操作」。
         * 有些设置光靠一个输入框很难用（比如「升到第几级」——
         * 用数字框意味着要先知道目标等级，还得翻面板才找得到）。
         * 插件可以声明自己的快捷入口，主干负责在面板里渲染按钮、并挂到油猴菜单，
         * 这样主干不必知道任何插件的具体逻辑。 */
        for (const qa of (rec.def.quickActions || [])) {
          const r3 = document.createElement('div');
          r3.className = 'dvi-row dvi-quick';
          const b3 = document.createElement('button');
          b3.type = 'button';
          b3.className = 'dvi-btn';
          b3.textContent = qa.label;
          b3.onclick = () => {
            try { qa.run(rec.ctx); renderSettings && renderSettings(); }
            catch (e) { console.error('[DVI] 快捷操作失败', e); }
          };
          r3.appendChild(b3);
          host.appendChild(r3);
        }
      }
    }

    return { register, enable, disable, setEnabled, list, renderPanel, get: (id) => plugins.get(id) };
  })();

  /* ═══════════════════════════════════════════════════════════════
   * 8. 环境自检
   *    油猴环境千差万别（沙箱模式、CSP、脚本管理器差异），
   *    与其"应该能跑"，不如给一个能在浏览器里当场跑的自检。
   * ═══════════════════════════════════════════════════════════════ */
  function selfTest() {
    const checks = [];
    const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

    // 运行环境
    const hasUnsafe = (typeof unsafeWindow !== 'undefined' && !!unsafeWindow);
    add('处于页面上下文', ROOT === window, ROOT === window ? '未沙箱化' : '已沙箱化（正常）');
    add('unsafeWindow 可用', hasUnsafe, hasUnsafe ? '是' : '否（独立脚本的插件将读不到主干）');

    // GM API
    add('GM_getValue 可用', typeof GM_getValue === 'function');
    add('GM_setValue 可用', typeof GM_setValue === 'function');
    add('GM_addStyle 可用', typeof GM_addStyle === 'function');
    add('GM_registerMenuCommand 可用', typeof GM_registerMenuCommand === 'function');

    // 数据层
    add('游戏数据已内联',
        DATA && DATA.items.length > 0,
        DATA ? `${DATA.items.length} 物品 / ${DATA.actions.length} 配方` : '缺失');

    // 计算引擎抽检
    const t = actionTicks(ACTION.get(1), { level: 1 });
    add('计算引擎正常', Math.abs(t - 5) < 1e-6, `1 级挖铜矿 = ${t} 秒（应 5）`);

    // 事件钩子
    const hooked = (() => {
      try {
        const d = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
        return !!(d && d.get && d.get.name === '' || (d && d.get));
      } catch (e) { return false; }
    })();
    add('收包钩子已安装', hooked);

    // 游戏数据流
    add('已收到服务器帧', net.stats.frames > 0,
        net.stats.frames > 0 ? `${net.stats.frames} 帧 / ${Math.round(net.stats.bytes / 1024)} KB`
                             : '尚未收到——可能还没连上游戏，或钩子未生效');
    add('已建立游戏连接', state.s.connected, net.stats.socket ? net.stats.socket.url : '无 socket');

    // UI：默认「无痕迹」模式，页面上本就不该有多余元素
    const fabEl = document.querySelector('[data-dvi-fab]');
    const fabMode = ui.mode() === ui.MODE_FAB;
    add('面板容器已就绪', !!document.querySelector('[data-dvi-win]'));
    add('显示方式符合预期',
        fabMode ? !!fabEl : !fabEl,
        fabMode ? '右下角按钮已显示' : '无痕迹（页面上无多余元素）');

    // 只读约束
    add('无发送通道（只读约束）', api.net.send === undefined && api.net.socket === undefined);

    // 插件
    add('插件注册表可用', typeof registry.register === 'function');

    const failed = checks.filter(c => !c.pass);
    const summary = failed.length === 0
      ? `全部通过（${checks.length} 项）`
      : `${checks.length - failed.length}/${checks.length} 通过，${failed.length} 项异常`;

    return { summary, checks, failed };
  }

  /* ═══════════════════════════════════════════════════════════════
   * 9. 公共 API
   * ═══════════════════════════════════════════════════════════════ */
  const api = {
    NS, VERSION, version: VERSION, API_VERSION, apiVersion: API_VERSION,
    data: { DATA, ITEM, ACTION, SITE, MONSTER, BY_SKILL, BY_GROUP, NAME_TO_ACTION,
            itemName, itemValue, actionName, skillName },
    calc: { xpForLevel, levelForXp, levelProgress, combine, speedFactor, actionTicks,
            unitsPerHour, inputCost, analyse, enhanceChance, enhanceCost, enhanceExpected,
            actionsToLevel, humanDuration, MAX_LEVEL: MAX_IDX, XP, xpPerAction,
            buffActive, buffTier, buffMult, perkPerRank, PERK_BY_ID,
            toolFactor, equippedTool, TOOL_BONUS_BY_ITEM, SLOT_FOR_SKILL,
            MS_PER_TICK, SECONDS_PER_TICK, ticksToSeconds, secondsToTicks },
    bus, EVT,
    state,
    net,
    settings,
    ui,
    plugin: registry,
    diag: DIAG,
    log: (...a) => { DIAG.info('通用', ...a); },
  };

  /* 发布到页面窗口（独立脚本的插件靠它读取），同时留在沙箱 window 上便于同源引用 */
  ROOT[NS] = api;
  try { window[NS] = api; } catch (e) { /* 某些沙箱模式不允许，忽略 */ }

  /* 方便在控制台直接折腾 */
  api.selfTest = selfTest;

  /* ═══════════════════════════════════════════════════════════════
   * 价格桥注入点
   *
   * 必须放在 api 发布**之后** —— 它要用 api.bus / api.EVT / api.state。
   * build.py 会把 src/price-bridge.js 整段塞到这里（仍在主干 IIFE 内部）。
   * ═══════════════════════════════════════════════════════════════ */
  /*@DVI_PRICE_BRIDGE@*/

  /* ═══════════════════════════════════════════════════════════════
   * 插件注入点
   *
   * build.py 会把插件的代码直接放进这里 —— **在主干内部**，
   * 而不是像以前那样追加在整个文件的最末尾。
   *
   * 为什么改：放在末尾时，插件与主干只靠「文件顺序」维系。
   * 一旦执行环境在中间截断、或边界处出任何岔子，插件会整段不执行，
   * 而且不留任何痕迹（已实际发生：插件 0 个、无报错、无痕迹）。
   * 放进主干内部后，插件与主干同生共死，不再依赖文件边界。
   * ═══════════════════════════════════════════════════════════════ */
  /*@DVI_PLUGINS@*/

  /* ═══════════════════════════════════════════════════════════════
   * 10. 启动
   * ═══════════════════════════════════════════════════════════════ */
  net.install();
  ui.ensureCSS();

  ui.ready(() => {
    ui.makeWindow();          // 面板先建好但保持隐藏
    ui.applyMode();           // 按当前模式决定要不要放悬浮按钮（默认不放）
    ui.startInlineWatch();    // 注入一次，之后每秒做一次廉价的存在性检查

    // 启动日志：一次把定位问题需要的环境信息记全
    DIAG.info('启动', `v${VERSION} · ${location.host} · ` +
      `游戏数据 ${DATA.meta ? DATA.meta.version : '?'} · ` +
      `物品${ITEM.size}/配方${ACTION.size}/站点${SITE.size}`);
    DIAG.info('启动', `插件 ${registry.list().length} 个 · 内联锚点 ${ui.inline.size} 个 · ` +
      `沙箱 ${(typeof unsafeWindow !== 'undefined' && unsafeWindow) ? '正常' : '无 unsafeWindow'}`);

    /* 插件声明的快捷操作也挂到油猴菜单 ——
     * 打开面板要点菜单再点按钮，而这里一步就到位。
     * 插件在 document-start 注册，ui.ready 之前必然已完成，所以此时能拿到全量。 */
    try {
      for (const rec of registry.list()) {
        for (const qa of (rec.def.quickActions || [])) {
          if (!qa.label || typeof qa.run !== 'function') continue;
          GM_registerMenuCommand(`${qa.menuIcon || '⚙'} ${qa.label}（${rec.name}）`, () => {
            try { qa.run(rec.ctx); }
            catch (e) { console.error('[DVI] 快捷操作失败', e); ui.toast('操作失败：' + e.message); }
          });
        }
      }
    } catch (e) { /* 菜单注册失败不该影响主干 */ }

    bus.emit(EVT.READY, api);

    api.log(`主干就绪 v${VERSION}（API v${API_VERSION}）· ` +
            `数据 ${DATA.items.length} 物品 / ${DATA.actions.length} 配方 / ${DATA.sites.length} 站点`);

    // 静默自检：有异常才出声，正常就当没发生
    const st = selfTest();
    if (st.failed.length) {
      api.log('自检发现问题：', st.failed.map(f => `${f.name}${f.detail ? '（' + f.detail + '）' : ''}`));
    }

    // 首次安装说一句话，之后永远安静
    if (!settings.get('installed', false)) {
      settings.set('installed', true);
      ui.toast('DVI Tools 已就绪 —— 页面无痕迹运行中', 2600);
      api.log('首次安装完成。之后不会再打扰你；需要面板时从油猴菜单打开。');
    }

    /* ── 自动体检：不让用户自己去菜单里翻 ──
     * 延迟几秒（等游戏把界面画出来），自动跑一次内联诊断：
     *   有标注 → 说一声「已就绪」；没标注 → 说清楚卡在哪一环。
     * 每种结果只提示一次，不反复打扰。 */
    setTimeout(() => {
      const rep = ui.inline.report();
      const injected = rep.reduce((n, r) => n + (r['已注入'] || 0), 0);
      const hosts = rep.reduce((n, r) => n + (r['找到宿主'] || 0), 0);

      if (injected > 0) {
        if (!settings.get('report.ok', false)) {
          settings.set('report.ok', true);
          ui.toast(`DVI v${VERSION} 已就绪：作业列表已标注 ${injected} 项`, 3200);
          api.log('内联注入正常', rep);
        }
        return;
      }
      // 没注入成功：给出可操作的原因，而不是沉默
      let reason;
      const broken = registry.list().filter(p => p.setupError);
      if (broken.length) {
        reason = `插件初始化失败：${broken.map(p => p.id).join('、')}（详见控制台）`;
      } else if (!rep.length) {
        reason = '插件未注册锚点';
      } else if (hosts === 0) {
        reason = '没找到作业列表 —— 先在游戏里打开作业/技能面板';
      } else {
        reason = '找到列表但未能渲染，请跑「检查内联注入」看详情';
      }
      if (settings.get('report.fail') !== reason) {
        settings.set('report.fail', reason);
        api.log('内联注入未生效：' + reason, rep);
        ui.toast(`DVI v${VERSION}：${reason}`, 4500);
      }
    }, 4000);
  });

  /* ── 价格桥 · 面板分区 ────────────────────────────────────────
   *
   * 为什么入口必须放在**页面里的面板**上，而不是只放油猴菜单：
   *   浏览器规定 showSaveFilePicker / showOpenFilePicker **必须有真实用户手势**
   *   （真实的点击），而 GM_registerMenuCommand 的回调**不算**用户手势 ——
   *   实测报 "Must be handling a user gesture to show a file picker"。
   *   从油猴菜单调，永远打不开这个对话框。
   *
   * 所以：菜单负责「打开面板」，面板里的按钮负责「选文件」。
   * 而这只是一次性动作 —— 句柄存进 IndexedDB 之后，
   * 以后每次打开自动写入，永不再问。
   */
  function renderPriceBridgePanel() {
    if (!api.price) return;
    const box = ui.ownSection('价格桥 — 给利润网站提供行情', 'trunk:price-bridge');
    const st = api.price.status();

    const info = document.createElement('div');
    info.className = 'dvi-row';
    info.innerHTML = '<span style="flex:1;font-size:12.5px;color:#5f6b76"></span>';
    const when = st.snapshotAt ? new Date(st.snapshotAt).toLocaleString('zh-CN') : '从未';
    info.firstChild.textContent =
      `状态：${st.connected ? '已连接 ' + st.fileName + (st.remembered ? '（已记住，永久有效）' : '（仅本次会话）')
                           : '未连接'}　上次快照：${when}（${st.snapshotCount} 个物品）`
      + (st.supported ? '' : '　⚠ 此浏览器不支持自动写入，请用「💾 下载价格文件」');
    box.appendChild(info);

    const row = document.createElement('div');
    row.className = 'dvi-row';

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'dvi-btn';
    pick.textContent = st.connected ? '换一个价格文件' : '选择价格文件（只需这一次）';
    pick.onclick = (ev) => {
      // 真实点击 → 浏览器认这个手势。**不要**把 picker 调用挪进 Promise/定时器。
      ev.preventDefault();
      api.price.connect().then((r) => {
        if (r.ok) ui.toast(`已连接 ${r.name} —— 之后自动写入，网站读同一个文件即可`);
        else if (r.why === 'unsupported') ui.toast('此浏览器不支持，请用菜单里的「💾 下载价格文件」');
        else if (r.why === 'cancelled') ui.toast('已取消');
        else ui.toast('连接失败：' + r.why);
        renderPriceBridgePanel();
      });
    };
    row.appendChild(pick);

    const grab = document.createElement('button');
    grab.type = 'button';
    grab.className = 'dvi-btn';
    grab.textContent = '立即抓一次';
    grab.onclick = () => { api.price.flushNow('手动'); setTimeout(renderPriceBridgePanel, 200); };
    row.appendChild(grab);

    if (st.connected) {
      const re = document.createElement('button');
      re.type = 'button';
      re.className = 'dvi-btn';
      re.textContent = '恢复授权';
      re.onclick = () => {
        api.price.reauthorise().then((r) => {
          ui.toast(r.ok ? '已恢复' : '恢复失败：' + r.why);
          renderPriceBridgePanel();
        });
      };
      row.appendChild(re);
    }

    const gh = api.price.gh;
    const note = document.createElement('div');
    note.className = 'dvi-row';
    const span = document.createElement('span');
    span.style.cssText = 'flex:1;font-size:11.5px;color:#8a95a0';
    span.textContent = gh.token
      ? `云端传输：已配置 → ${gh.target}（${gh.up ? '已连通' : '待首次推送'}）`
      : `云端传输：未配置令牌（用油猴菜单「☁️ 设置云端传输令牌」开启，网站即可自动读取）`;
    note.appendChild(span);
    row.appendChild(note);

    box.appendChild(row);
  }

  /* 价格桥常驻：市场消息一来就防抖落盘（途径①）；另有每小时兜底（途径②） */
  if (typeof api.attachPriceBridge === 'function') api.attachPriceBridge();

  GM_registerMenuCommand('打开 DVI Tools 面板', () => { ui.toggle(true); renderPriceBridgePanel(); });
  GM_registerMenuCommand('关闭面板', () => ui.toggle(false));

  /* 主动重算。默认是「按需刷新」：游戏状态变了不会自动重算，
   * 因为重算比重新注入贵得多，每帧重算对设备是负担。
   * 想自动的话把插件的「刷新方式」设成「自动」。 */
  GM_registerMenuCommand('🔄 重算并刷新（按需）', () => {
    bus.emit(EVT.REFRESH);
    ui.toast('已重算');
  });

  // 注意：Tampermonkey 的 GM_registerMenuCommand 要求第一个参数是**字符串**。
  // 传函数（动态标题）是 Violentmonkey 的用法，在 TM 上可能直接抛错，
  // 而抛错会中断它之后所有的菜单注册与代码执行 —— 代价太大，不值得。
  GM_registerMenuCommand('切换显示方式（无痕迹 / 右下角按钮）', () => {
    const next = ui.mode() === ui.MODE_FAB ? ui.MODE_QUIET : ui.MODE_FAB;
    ui.setMode(next);
    ui.toast(next === ui.MODE_FAB ? '已显示右下角按钮' : '已切回无痕迹模式');
  });

  /* --- 环境自检：在游戏里当场确认它真的跑起来了 --- */
  GM_registerMenuCommand('运行环境自检', () => {
    const st = selfTest();
    console.info('[DVI] 自检', st.summary);
    console.table(st.checks.map(c => ({ 项目: c.name, 结果: c.pass ? '✓' : '✗', 说明: c.detail || '' })));
    if (document.body) {
      ui.toggle(true);
      // 先开面板（它会重绘并清空），再取分区 —— 顺序反了会被清掉
      const box = ui.ownSection(`环境自检 — ${st.summary}`, 'trunk:selftest');
      for (const c of st.checks) {
        const row = document.createElement('div');
        row.className = 'dvi-row' + (c.pass ? '' : ' dvi-err');
        row.textContent = `${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`;
        box.appendChild(row);
      }
    }
    ui.toast(st.summary);
  });

  /* --- 采集游戏 DOM 结构：用来确定内联注入的锚点 ---
   * 我不知道游戏界面的确切结构就无法对准注入位置。
   * 点一次这个，把它导出的 JSON 给开发者，就能写出精确的锚点。 */
  GM_registerMenuCommand('采集游戏界面结构（供开发者对准锚点）', () => {
    const INTERESTING = [
      'button.route[data-job]', '[data-job]', '[data-act]', '[data-skill]',
      '[data-works-body]', '[data-works]', '[data-skills]', '[data-item]',
      '[data-market]', '[data-bank]', '[data-level]', '[data-level-card]',
      '.route', '.works', '.skill', '.level', '.market', '.bank', '.item',
    ];

    const describe = (el, depth, maxDepth) => {
      const attrs = {};
      for (const a of el.attributes || []) {
        // 只留有价值的属性，控制体积
        if (a.name === 'style') continue;
        attrs[a.name] = a.value.length > 120 ? a.value.slice(0, 120) + '…' : a.value;
      }
      // 直接文本（不含子元素文本），截断
      const own = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3).map(n => n.textContent.trim())
        .join(' ').trim();
      const node = {
        tag: el.tagName.toLowerCase(),
        ...(el.className ? { class: String(el.className).slice(0, 160) } : {}),
        ...(Object.keys(attrs).length ? { attrs } : {}),
        ...(own ? { text: own.slice(0, 60) } : {}),
      };
      if (depth < maxDepth && el.children.length) {
        node.children = Array.from(el.children)
          .slice(0, 25)
          .map(c => describe(c, depth + 1, maxDepth));
        if (el.children.length > 25) node.truncatedAt = el.children.length;
      }
      return node;
    };

    const dump = {
      capturedAt: new Date().toISOString(),
      url: location.href,
      viewport: { w: innerWidth, h: innerHeight },
      appRoot: (() => {
        const app = document.querySelector('#app');
        return app ? { childCount: app.children.length,
                       firstChildren: Array.from(app.children).slice(0, 12).map(c => ({
                         tag: c.tagName.toLowerCase(),
                         class: String(c.className || '').slice(0, 120),
                       })) } : null;
      })(),
      probes: {},
      inlineReport: ui.inline.report(),
    };

    for (const sel of INTERESTING) {
      let els;
      try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      if (!els.length) continue;
      dump.probes[sel] = {
        count: els.length,
        samples: Array.from(els).slice(0, 3).map(el => describe(el, 0, 3)),
      };
    }

    const text = JSON.stringify(dump, null, 1);
    console.info('[DVI] 界面结构已采集', dump);
    const kb = Math.round(text.length / 1024);
    if (ui.downloadText(text, 'dvi-dom-probe.json', 'application/json')) {
      ui.toast(`已导出 dvi-dom-probe.json（${kb} KB），把这个文件发给我`);
    } else {
      ui.toast('导出失败，请从控制台复制（见 [DVI] 界面结构已采集）');
    }
  });

  /* --- 运行日志：出问题时直接导出，不用翻控制台 --- */
  /* --- 价格桥：把游戏内行情落到本机文件，供 dvi-economy 读取 ---
   *
   * 两条更新途径（用户要求）：
   *   ① 每次刷新页面 —— 市场消息一到就防抖落盘（见 price-bridge 的 attach）
   *   ② 每小时一次 —— 即使没有新消息也刷新一次「快照时间」
   *
   * 之所以要落成本机文件：游戏域名与利润网站域名不同，
   * localStorage / cookie **不跨源**，没有共同的本地存储可用。
   * 而走 GitHub 提交部署又太绕。File System Access API 让两边
   * 各选一次同一个文件即可，闭环全在本机。
   */
  GM_registerMenuCommand('💰 立即抓一次价格', () => {
    if (!api.price) { ui.toast('价格桥未就绪'); return; }
    api.price.flushNow('手动');
    ui.toast(`已抓取 ${api.price.lastCount} 个物品（1 秒内落盘）`);
  });

  /* 菜单**不能**直接开文件选择器：浏览器不认 GM_registerMenuCommand 的用户手势
   * （报 "Must be handling a user gesture to show a file picker"），
   * 从这里调必然失败。所以这个入口只负责把面板打开并露出价格桥分区，
   * 真正选文件的按钮在面板里 —— 那是页面内的真实点击。 */
  GM_registerMenuCommand('🔗 连接价格文件（给利润网站用）', () => {
    if (!api.price) { ui.toast('价格桥未就绪'); return; }
    ui.toggle(true);
    renderPriceBridgePanel();
    const st = api.price.status();
    if (st.connected) {
      ui.toast(st.fileRemembered
        ? `已连接 ${st.fileName}（已记住，永久有效）—— 无需再操作`
        : `已连接 ${st.fileName}，但尚未记住：点面板里的「恢复授权」以免下次要重选`);
    } else {
      ui.toast('请点面板里的「选择价格文件（只需这一次）」');
    }
  });

  GM_registerMenuCommand('🔄 恢复价格文件连接', () => {
    if (!api.price) { ui.toast('价格桥未就绪'); return; }
    api.price.reauthorise().then((r) => {
      ui.toast(r.ok ? `已恢复 ${r.name}，之后自动写入` : '恢复失败：' + r.why);
    });
  });

  /* 云端传输：让 dvi-tools 充当银河奶牛那样的「价格 API」——
   * 游戏把行情写进仓库文件，网站从 raw.githubusercontent.com 读。
   * 不需要网站重新部署，是真正的零操作。 */
  GM_registerMenuCommand('☁️ 设置云端传输令牌（GitHub）', () => {
    if (!api.price) { ui.toast('价格桥未就绪'); return; }
    const cur = api.price.gh.token ? '（已配置）' : '（未配置）';
    const v = prompt(
      `云端传输把价格写到 GitHub 仓库，网站自动读取。\n\n` +
      `目标：${api.price.gh.target}\n当前：${cur}\n\n` +
      `粘贴一个 Personal Access Token（需要 contents:write 权限）。\n` +
      `留空则清除。\n\n` +
      `令牌只存在本机脚本存储里，不会外传。`, '');
    if (v === null) { ui.toast('已取消'); return; }
    api.price.gh.setToken(v.trim());
    ui.toast(v.trim() ? '令牌已保存，下次抓价时自动推送' : '已清除令牌');
  });

  GM_registerMenuCommand('☁️ 立即推送到云端', () => {
    if (!api.price) { ui.toast('价格桥未就绪'); return; }
    if (!api.price.gh.token) { ui.toast('还没设置令牌（用菜单「☁️ 设置云端传输令牌」）'); return; }
    api.price.flushNow('手动推送');
    setTimeout(() => {
      ui.toast(api.price.gh.up ? '已推送，网站现在能读到了' : '推送失败，详情见控制台 [DVI:价格桥]');
    }, 2500);
  });

  /* 一键把价格送到利润网站：数据走网址 # 片段，网站收下存 localStorage。
   * 不经过文件、不经过后台服务、不经过 GitHub。 */
  GM_registerMenuCommand('📤 送到利润网站（一键同步）', () => {
    if (!api.price) { ui.toast('价格桥未就绪'); return; }
    ui.toast('正在打包…');
    api.price.sendToSite().then((r) => {
      if (r.ok) ui.toast(`已送出 ${r.count} 个物品 · 指纹 ${r.fp}\n到网站「⑥ 价格」页顶部核对`);
      else ui.toast('发送失败：' + r.why);
    });
  });

  /* 核对凭证：让用户能证明「数据真的送到网站并被用上了」。
   * 游戏侧算出指纹 → 网站侧算出同一个指纹 → 两串对上就是证据。 */
  GM_registerMenuCommand('🔏 查看送出凭证（核对用）', () => {
    if (!api.price) { ui.toast('价格桥未就绪'); return; }
    const r = api.price.sentReceipt();
    const st = api.price.status();
    const lines = [
      '── 我方送出凭证 ──',
      r ? `送出时间   : ${new Date(r.at).toLocaleString('zh-CN')}` : '送出时间   : 还没送过',
      r ? `送出物品数 : ${r.count}` : '',
      r ? `数据指纹   : ${r.fp}` : '',
      '',
      '── 网站侧应显示 ──',
      r ? '「⑥ 价格」页顶部的「数据来源」栏里，'
         + '「指纹」那一行应当是同一个值' : '',
      '',
      '两串一致 ⇒ 数据一字节不差地送达并正在使用。',
      '',
      '── 本机状态 ──',
      `上次快照   : ${st.snapshotAt ? new Date(st.snapshotAt).toLocaleString('zh-CN') : '从未'}（${st.snapshotCount} 个）`,
      `文件连接   : ${st.connected ? st.fileName + (st.fileRemembered ? '（已记住）' : '（仅本次）') : '未连接'}`,
    ].filter(Boolean);
    alert(lines.join('\n'));
  });

  GM_registerMenuCommand('💾 下载价格文件（降级方式）', () => {
    if (!api.price) { ui.toast('价格桥未就绪'); return; }
    const n = api.price.download();
    ui.toast(`已下载 ${api.price.fileName}（${n} 个物品）—— 打开利润网站，把它直接拖到页面上`) +
      '（浏览器不支持自动写入时的备用路径）';
  });

  GM_registerMenuCommand('📈 价格桥状态', () => {
    if (!api.price) { ui.toast('价格桥未就绪'); return; }
    const st = api.price.status();
    const when = st.snapshotAt ? new Date(st.snapshotAt).toLocaleString('zh-CN') : '从未';
    const lines = [
      `自动写入：${st.connected ? '已连接 ' + st.fileName : '未连接（菜单里点「连接价格文件」）'}`,
      `连接是否记住：${st.connected ? '是 —— 关浏览器、重启电脑都有效' : '否'}`,
      `浏览器支持：${st.supported ? '是' : '否（只能下载）'}`,
      `上次快照：${when}`,
      `快照物品数：${st.snapshotCount}`,
      `是否过期（>70 分钟）：${st.stale ? '是' : '否'}`,
      '',
      '利润网站读法：网站里点「连接本地价格文件」，选同一个 ' + st.fileName,
    ];
    alert(lines.join('\n'));
  });

  GM_registerMenuCommand('⏱ 测市场推送频率（跑 1 分钟）', () => {
    const buckets = {};
    const times = [];
    const t0 = Date.now();
    // 市场消息统一从 EVT.MARKET 抛出，载荷是 { type, data }
    const onMsg = (e) => {
      const k = (e && e.type) || 'unknown';
      buckets[k] = (buckets[k] || 0) + 1;
      times.push(Date.now() - t0);
    };
    bus.on(EVT.MARKET, onMsg);
    ui.toast('开始记录，60 秒后自动出结果');
    setTimeout(() => {
      bus.off(EVT.MARKET, onMsg);
      const total = times.length;
      if (!total) { ui.toast('60 秒内一条市场消息都没有 —— 请先打开游戏里的市场页面'); return; }
      const gaps = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
      gaps.sort((a, b) => a - b);
      const med = gaps[Math.floor(gaps.length / 2)] || 0;
      const lines = [
        `记录时长 ${(times[times.length - 1] / 1000).toFixed(0)} 秒，共 ${total} 条市场消息`,
        ...Object.entries(buckets).filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`),
        `相邻间隔 中位数 ${med} ms · 最小 ${gaps[0] ?? '-'} ms · 最大 ${gaps[gaps.length - 1] ?? '-'} ms`,
        med ? `→ 约每 ${(med / 1000).toFixed(1)} 秒收到一次市场推送` : '',
      ].filter(Boolean);
      const text = lines.join('\n');
      if (ui.downloadText(text, `dvi-market-rate-${Date.now()}.txt`, 'text/plain')) {
        ui.toast('推送频率已导出');
      } else {
        alert(text);
      }
      console.info('[DVI] 市场推送频率', { buckets, median: med, samples: total });
    }, 60000);
  });

  GM_registerMenuCommand('📄 保存运行日志（下载 txt）', () => {
    const text = DIAG.text();
    const name = `dvi-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt`;
    if (ui.downloadText(text, name, 'text/plain')) {
      ui.toast(`已导出运行日志（${DIAG.size()} 条），发给我即可定位问题`);
    } else {
      console.info(text);
      ui.toast('导出失败，日志已打到控制台');
    }
  });

  GM_registerMenuCommand('🔎 查看最近日志（50 条）', () => {
    const rows = DIAG.tail(50);
    if (!rows.length) { alert('日志为空。'); return; }
    const txt = rows.map(e => {
      const ms = e.ms;
      const clock = `${String(Math.floor(ms / 60000)).padStart(2, '0')}:` +
                    `${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.` +
                    `${String(ms % 1000).padStart(3, '0')}`;
      return `${clock} ${e.level.toUpperCase().padEnd(5)} ${e.tag.padEnd(12)} ${e.msg}`;
    }).join('\n');
    alert(`DVI 最近 ${rows.length} 条日志（共 ${DIAG.size()} 条）\n` +
          `────────────────────────────\n${txt}\n` +
          `────────────────────────────\n窗口大小有限，完整日志请用「保存运行日志」。`);
  });

  GM_registerMenuCommand('🧹 清空运行日志', () => {
    const n = DIAG.size();
    DIAG.clear();
    ui.toast(`已清空 ${n} 条日志`);
  });

  /* --- 内联注入诊断：功能没出现时，先跑这个 --- */
  GM_registerMenuCommand('🔍 检查内联注入（功能没出现时跑这个）', () => {
    const rep = ui.inline.report();
    const lines = rep.length
      ? rep.map(r =>
          `${r.锚点}\n  候选：${r.候选选择器}\n  命中：${r.命中的}\n` +
          `  找到宿主 ${r.找到宿主} 个，已注入 ${r.已注入} 个` +
          (r.错误 ? `\n  ⚠ ${r.错误}` : ''))
      : ['（没有任何锚点注册 —— 插件可能没加载）'];

    // 顺带把可能的宿主数量也报出来，便于判断锚点对不对
    const probes = [
      '[data-routes]', '[data-job]', 'button.route', '.route',
      '#app', 'body',
    ].map(sel => {
      let n = 0;
      try { n = document.querySelectorAll(sel).length; } catch (e) { n = -1; }
      return `  ${sel}: ${n < 0 ? '选择器非法' : n + ' 个'}`;
    });

    const broken = registry.list().filter(p => p.setupError);
    const pluginLine = registry.list()
      .map(p => p.id + (p.setupError ? '⚠初始化失败' : p.enabled ? '✓' : '✗'))
      .join(', ') || '无';

    // 插件脚本自身未能启动时留下的痕迹（见各插件里的 whenTrunk）
    let loadErrors = [];
    try {
      const r = ROOT.__dviPluginErrors || [];
      loadErrors = r.map(x => `${x.plugin}：${x.reason}`);
    } catch (e) {}
    if (!registry.list().length) DIAG.warn('诊断', '注册表为空，插件可能未启动');

    const msg =
      `DVI 内联注入诊断\n` +
      `────────────────\n` +
      `${lines.join('\n')}\n` +
      `────────────────\n` +
      `页面元素探测：\n${probes.join('\n')}\n` +
      `────────────────\n` +
      `已注册插件：${pluginLine}` +
      `\n运行统计：补注 ${inline.stats().reinjects} 次 · 每秒巡检 ${inline.stats().watching ? '进行中' : '已停（页面不可见）'}` +
      (inline.stats().reinjects > 200
        ? `\n⚠ 补注次数偏高，说明游戏在频繁重建列表，我们一直在补 —— 这不影响正确性，但可以反馈。`
        : '') +
      (broken.length
        ? `\n\n⚠ 插件初始化失败（功能不会出现）：\n` +
          broken.map(p => `  ${p.id}：${p.setupError}`).join('\n')
        : '') +
      (loadErrors.length
        ? `\n\n⚠ 插件脚本未能启动：\n` + loadErrors.map(x => `  ${x}`).join('\n')
        : '') +
      (!registry.list().length && !loadErrors.length
        ? `\n\n⚠ 注册表为空，但没有失败记录 —— 插件代码可能根本没被执行到。\n` +
          `  请把「📄 保存运行日志」导出的文件发给我。`
        : '');

    console.info('[DVI] 内联注入诊断', { report: rep, probes, plugins: registry.list(), loadErrors });
    alert(msg);
  });

  /* --- 诊断：把关键指标打到控制台，便于核对数据流 --- */
  GM_registerMenuCommand('输出诊断信息', () => {
    const d = {
      version: VERSION,
      已连接: state.s.connected,
      服务器帧: state.s.tick,
      角色: state.s.me ? `${state.s.me.name} (id ${state.s.me.id})` : null,
      世界: state.s.world,
      视野内玩家: state.s.players.size,
      已缓存行情: state.s.market.size,
      收到帧数: net.stats.frames,
      吞吐KB: Math.round(net.stats.bytes / 1024),
      离线报告: state.s.offline ? {
        时长tick: state.s.offline.ticksElapsed,
        获得物品: state.s.offline.itemsGained,
      } : null,
      插件: registry.list().map(p => `${p.id}:${p.enabled ? 'on' : 'off'}`),
    };
    console.info('[DVI] 诊断', d);
    ui.toast('诊断信息已输出到控制台');
  });
})();
