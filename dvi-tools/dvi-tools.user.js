// ==UserScript==
// @name         DVI Tools（核心主干）
// @namespace    dvi.tools
// @version      2026.10.03.4
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

// [build] v2026.10.03.4 · 2026-10-03 09:39 · 游戏数据 0.0.1164 / 1db7eb7 · 物品 290 · 配方 221 · 怪物 20 · 站点 383
(function () {
  'use strict';

  const NS = 'DVI';
  const VERSION = '2026.10.03.4';   // 与文件头 @version 保持一致
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
  const DATA = ({
  meta: {source:"deepveinidle.com client bundle",version:"0.0.1164",commit:"1db7eb7",extractedAt:"2026-10-01"},
  balance: {maxLevel:99,baseXp:100,xpGrowth:1.12,beyondGrowth:1.145,speedPerLevelAboveRequirement:0.005,enhance:{
  baseChanceFloor:0.2,
  chanceDropPerTier:0.06,
  maxTier:5,
  shardsPerTier:3,
  goldTiers:[100,300,1000,3000,8000,20000],
  qualityMult:[1,3,8,20,50]
},marketTaxBp:200,perkQuickPerLevel:0.005,perkHandsBurnReduction:0.03,buffTierMults:[1.0,1.3,1.6,2.2,3.0],buffPerRank:{gatherer:0.1,elixir:0.1,hunter:0.25},blessing:{gather:1.05,combat:1.1},xpTierMults:[1.0,1.5,3.0,8.0,25.0],perks:[
  {id:"xp",name:"XP gain",lane:"efficiency",perRank:0.005,unit:"percent"},
  {id:"gather",name:"Gather speed",lane:"efficiency",perRank:0.005,unit:"percent"},
  {id:"craft",name:"Craft speed",lane:"efficiency",perRank:0.005,unit:"percent"},
  {id:"offline",name:"Offline hours",lane:"efficiency",perRank:0.005,unit:"hours"},
  {id:"move",name:"Move speed",lane:"efficiency",perRank:0.005,unit:"percent"},
  {id:"hp",name:"Max HP",lane:"efficiency",perRank:0.005,unit:"percent"},
  {id:"maxhit",name:"Max hit",lane:"power",perRank:0.005,unit:"percent"},
  {id:"accuracy",name:"Accuracy",lane:"power",perRank:0.005,unit:"percent"},
  {id:"rare",name:"Rare-find",lane:"power",perRank:0.005,unit:"percent"},
  {id:"enhance",name:"Enhance odds",lane:"power",perRank:0.0025,unit:"percent"}
],toolBonuses:[
  {itemId:80,slot:"pickaxe",bonus:0.08},
  {itemId:81,slot:"pickaxe",bonus:0.16},
  {itemId:82,slot:"pickaxe",bonus:0.25},
  {itemId:83,slot:"pickaxe",bonus:0.35},
  {itemId:84,slot:"pickaxe",bonus:0.5},
  {itemId:85,slot:"rod",bonus:0.08},
  {itemId:86,slot:"rod",bonus:0.16},
  {itemId:87,slot:"rod",bonus:0.25},
  {itemId:88,slot:"rod",bonus:0.35},
  {itemId:89,slot:"rod",bonus:0.5},
  {itemId:90,slot:"axe",bonus:0.08},
  {itemId:91,slot:"axe",bonus:0.16},
  {itemId:92,slot:"axe",bonus:0.25},
  {itemId:93,slot:"axe",bonus:0.35},
  {itemId:94,slot:"axe",bonus:0.5},
  {itemId:323,slot:"gloves",bonus:0.08},
  {itemId:324,slot:"gloves",bonus:0.16},
  {itemId:325,slot:"gloves",bonus:0.25},
  {itemId:326,slot:"gloves",bonus:0.35},
  {itemId:327,slot:"gloves",bonus:0.5},
  {itemId:360,slot:"pan",bonus:0.08},
  {itemId:361,slot:"pan",bonus:0.16},
  {itemId:362,slot:"pan",bonus:0.25},
  {itemId:363,slot:"pan",bonus:0.35},
  {itemId:364,slot:"pan",bonus:0.5},
  {itemId:365,slot:"hammer",bonus:0.08},
  {itemId:366,slot:"hammer",bonus:0.16},
  {itemId:367,slot:"hammer",bonus:0.25},
  {itemId:368,slot:"hammer",bonus:0.35},
  {itemId:369,slot:"hammer",bonus:0.5},
  {itemId:370,slot:"knife",bonus:0.08},
  {itemId:371,slot:"knife",bonus:0.16},
  {itemId:372,slot:"knife",bonus:0.25},
  {itemId:373,slot:"knife",bonus:0.35},
  {itemId:374,slot:"knife",bonus:0.5},
  {itemId:375,slot:"needle",bonus:0.08},
  {itemId:376,slot:"needle",bonus:0.16},
  {itemId:377,slot:"needle",bonus:0.25},
  {itemId:378,slot:"needle",bonus:0.35},
  {itemId:379,slot:"needle",bonus:0.5},
  {itemId:380,slot:"mortar",bonus:0.08},
  {itemId:381,slot:"mortar",bonus:0.16},
  {itemId:382,slot:"mortar",bonus:0.25},
  {itemId:383,slot:"mortar",bonus:0.35},
  {itemId:384,slot:"mortar",bonus:0.5},
  {itemId:385,slot:"hoe",bonus:0.08},
  {itemId:386,slot:"hoe",bonus:0.16},
  {itemId:387,slot:"hoe",bonus:0.25},
  {itemId:388,slot:"hoe",bonus:0.35},
  {itemId:389,slot:"hoe",bonus:0.5},
  {itemId:328,slot:"mount",bonus:0.12}
],toolSlots:{
  pickaxe:"mining",
  rod:"fishing",
  axe:"woodcutting",
  gloves:"thieving",
  pan:"cooking",
  hammer:"smithing",
  knife:"fletching",
  needle:"crafting",
  mortar:"herblore",
  hoe:"farming"
}},
  skillNames: {mining:"采矿",fishing:"钓鱼",woodcutting:"伐木",farming:"种植",thieving:"偷窃",cooking:"烹饪",smithing:"锻造",fletching:"制箭",herblore:"炼药",crafting:"工艺",enhancing:"强化",melee:"近战",ranged:"远程",magic:"魔法",defence:"防御",hitpoints:"生命"},
  items: [
    {id:1,name:"Copper",value:3,stackable:false},
    {id:2,name:"Tin",value:4,stackable:false},
    {id:3,name:"Iron",value:12,stackable:false},
    {id:4,name:"Silver",value:40,stackable:false},
    {id:5,name:"Coal",value:55,stackable:false},
    {id:6,name:"Gold",value:140,stackable:false},
    {id:7,name:"Cobalt",value:380,stackable:false},
    {id:8,name:"Meteoric",value:900,stackable:false},
    {id:10,name:"Logs",value:3,stackable:false},
    {id:11,name:"Oak logs",value:15,stackable:false},
    {id:12,name:"Willow logs",value:45,stackable:false},
    {id:13,name:"Maple logs",value:100,stackable:false},
    {id:14,name:"Yew logs",value:240,stackable:false},
    {id:15,name:"Magic logs",value:600,stackable:false},
    {id:20,name:"Shrimp",value:4,stackable:false},
    {id:21,name:"Sardine",value:9,stackable:false},
    {id:22,name:"Trout",value:26,stackable:false},
    {id:23,name:"Salmon",value:48,stackable:false},
    {id:24,name:"Tuna",value:92,stackable:false},
    {id:25,name:"Lobster",value:175,stackable:false},
    {id:26,name:"Swordfish",value:330,stackable:false},
    {id:27,name:"Shark",value:780,stackable:false},
    {id:40,name:"Bronze bar",value:12,stackable:false},
    {id:41,name:"Iron bar",value:22,stackable:false},
    {id:42,name:"Steel bar",value:156,stackable:false},
    {id:43,name:"Cobalt bar",value:660,stackable:false},
    {id:44,name:"Meteoric bar",value:1527,stackable:false},
    {id:60,name:"Cooked shrimp",value:9,stackable:false,heals:3},
    {id:61,name:"Cooked sardine",value:15,stackable:false,heals:4},
    {id:62,name:"Cooked trout",value:44,stackable:false,heals:7},
    {id:63,name:"Cooked salmon",value:82,stackable:false,heals:9},
    {id:64,name:"Cooked tuna",value:150,stackable:false,heals:12},
    {id:65,name:"Cooked lobster",value:290,stackable:false,heals:16},
    {id:66,name:"Cooked swordfish",value:550,stackable:false,heals:20},
    {id:67,name:"Cooked shark",value:1280,stackable:false,heals:26},
    {id:70,name:"Burnt food",value:0,stackable:true},
    {id:80,name:"Bronze pickaxe",value:29,stackable:false},
    {id:81,name:"Iron pickaxe",value:54,stackable:false},
    {id:82,name:"Steel pickaxe",value:346,stackable:false},
    {id:83,name:"Cobalt pickaxe",value:1435,stackable:false},
    {id:84,name:"Meteoric pickaxe",value:3461,stackable:false},
    {id:85,name:"Bronze rod",value:20,stackable:false},
    {id:86,name:"Iron rod",value:47,stackable:false},
    {id:87,name:"Steel rod",value:235,stackable:false},
    {id:88,name:"Cobalt rod",value:1015,stackable:false},
    {id:89,name:"Meteoric rod",value:2534,stackable:false},
    {id:90,name:"Bronze axe",value:29,stackable:false},
    {id:91,name:"Iron axe",value:54,stackable:false},
    {id:92,name:"Steel axe",value:346,stackable:false},
    {id:93,name:"Cobalt axe",value:1435,stackable:false},
    {id:94,name:"Meteoric axe",value:3461,stackable:false},
    {id:110,name:"Bronze blade",value:17,stackable:false},
    {id:111,name:"Iron blade",value:32,stackable:false},
    {id:112,name:"Steel blade",value:190,stackable:false},
    {id:113,name:"Cobalt blade",value:775,stackable:false},
    {id:114,name:"Meteoric blade",value:1934,stackable:false},
    {id:115,name:"Bronze shield",value:41,stackable:false},
    {id:116,name:"Iron shield",value:76,stackable:false},
    {id:117,name:"Steel shield",value:502,stackable:false},
    {id:118,name:"Cobalt shield",value:2095,stackable:false},
    {id:119,name:"Meteoric shield",value:4988,stackable:false},
    {id:120,name:"Bronze helm",value:29,stackable:false},
    {id:121,name:"Iron helm",value:54,stackable:false},
    {id:122,name:"Steel helm",value:346,stackable:false},
    {id:123,name:"Cobalt helm",value:1435,stackable:false},
    {id:124,name:"Meteoric helm",value:3461,stackable:false},
    {id:125,name:"Bronze plate",value:65,stackable:false},
    {id:126,name:"Iron plate",value:120,stackable:false},
    {id:127,name:"Steel plate",value:814,stackable:false},
    {id:128,name:"Cobalt plate",value:3415,stackable:false},
    {id:129,name:"Meteoric plate",value:8042,stackable:false},
    {id:130,name:"Bronze greaves",value:53,stackable:false},
    {id:131,name:"Iron greaves",value:98,stackable:false},
    {id:132,name:"Steel greaves",value:658,stackable:false},
    {id:133,name:"Cobalt greaves",value:2755,stackable:false},
    {id:134,name:"Meteoric greaves",value:6515,stackable:false},
    {id:140,name:"Shortbow",value:8,stackable:false},
    {id:141,name:"Oak shortbow",value:25,stackable:false},
    {id:142,name:"Willow shortbow",value:79,stackable:false},
    {id:143,name:"Maple shortbow",value:158,stackable:false},
    {id:144,name:"Yew shortbow",value:355,stackable:false},
    {id:145,name:"Magic shortbow",value:820,stackable:false},
    {id:146,name:"Longbow",value:11,stackable:false},
    {id:147,name:"Oak longbow",value:40,stackable:false},
    {id:148,name:"Willow longbow",value:124,stackable:false},
    {id:149,name:"Maple longbow",value:258,stackable:false},
    {id:150,name:"Yew longbow",value:595,stackable:false},
    {id:151,name:"Magic longbow",value:1420,stackable:false},
    {id:152,name:"Staff",value:11,stackable:false},
    {id:153,name:"Oak staff",value:40,stackable:false},
    {id:154,name:"Willow staff",value:124,stackable:false},
    {id:155,name:"Maple staff",value:258,stackable:false},
    {id:156,name:"Yew staff",value:595,stackable:false},
    {id:157,name:"Magic staff",value:1420,stackable:false},
    {id:100,name:"Rough gem",value:2500,stackable:true},
    {id:200,name:"Coins",value:1,stackable:true},
    {id:201,name:"Gnawed charm",value:1500,stackable:true},
    {id:202,name:"Bog pearl",value:4000,stackable:true},
    {id:203,name:"Dry sigil",value:12000,stackable:true},
    {id:204,name:"Cairn token",value:40000,stackable:true},
    {id:205,name:"Rime fang",value:120000,stackable:true},
    {id:206,name:"Ember heart",value:350000,stackable:true},
    {id:207,name:"Abyssal eye",value:900000,stackable:true},
    {id:208,name:"Voidshard",value:1500,stackable:true},
    {id:160,name:"Potato seed",value:2,stackable:true},
    {id:161,name:"Glowcap spore",value:6,stackable:true},
    {id:162,name:"Turnip seed",value:14,stackable:true},
    {id:163,name:"Bitterroot seed",value:30,stackable:true},
    {id:164,name:"Voidmelon seed",value:60,stackable:true},
    {id:165,name:"Pepper seed",value:110,stackable:true},
    {id:170,name:"Potato",value:7,stackable:false,heals:3},
    {id:171,name:"Glowcap",value:22,stackable:false,heals:5},
    {id:172,name:"Cave turnip",value:55,stackable:false,heals:7},
    {id:173,name:"Bitterroot",value:120,stackable:false,heals:10},
    {id:174,name:"Voidmelon",value:260,stackable:false,heals:14},
    {id:175,name:"Ember pepper",value:520,stackable:false,heals:20},
    {id:180,name:"Cut gem",value:2505,stackable:true},
    {id:181,name:"Silver ring",value:2563,stackable:false},
    {id:182,name:"Gold ring",value:2703,stackable:false},
    {id:183,name:"Meteoric ring",value:6757,stackable:false},
    {id:184,name:"Silver amulet",value:2579,stackable:false},
    {id:185,name:"Gold amulet",value:2741,stackable:false},
    {id:186,name:"Meteoric amulet",value:6944,stackable:false},
    {id:190,name:"Sage seed",value:6,stackable:true},
    {id:191,name:"Nightshade seed",value:40,stackable:true},
    {id:192,name:"Dragonleaf seed",value:220,stackable:true},
    {id:193,name:"Sage",value:18,stackable:true},
    {id:194,name:"Nightshade",value:110,stackable:true},
    {id:195,name:"Dragonleaf",value:520,stackable:true},
    {id:209,name:"Gravemaw skull",value:250000,stackable:false},
    {id:210,name:"Hollow crown",value:1000000,stackable:false},
    {id:211,name:"Riftborne heart",value:4000000,stackable:false},
    {id:212,name:"Colossus core",value:15000000,stackable:false},
    {id:213,name:"Wraith ash",value:15000,stackable:true},
    {id:214,name:"Stalker fang",value:30000,stackable:true},
    {id:215,name:"Troll tusk",value:50000,stackable:true},
    {id:216,name:"Wight crown",value:120000,stackable:true},
    {id:217,name:"Drake scale",value:250000,stackable:true},
    {id:218,name:"Colossus ember",value:500000,stackable:true},
    {id:220,name:"Gatherer's draught",value:28,stackable:true},
    {id:221,name:"Hunter's brew",value:272,stackable:true},
    {id:222,name:"Warrior's tonic",value:835,stackable:true},
    {id:223,name:"Elixir of the vein",value:1643,stackable:true},
    {id:224,name:"Abyssal tonic",value:2103,stackable:true},
    {id:225,name:"Swift draught",value:96,stackable:true},
    {id:226,name:"Nourishing draught",value:387,stackable:true},
    {id:227,name:"Haste draught",value:1205,stackable:true},
    {id:240,name:"Gnawer pelt",value:5,stackable:true},
    {id:241,name:"Bogling skin",value:12,stackable:true},
    {id:242,name:"Husk chitin",value:60,stackable:true},
    {id:243,name:"Cairn bone",value:120,stackable:true},
    {id:244,name:"Wraith dust",value:200,stackable:true},
    {id:245,name:"Rimewolf fur",value:500,stackable:true},
    {id:246,name:"Stalker claw",value:700,stackable:true},
    {id:247,name:"Ember scale",value:1200,stackable:true},
    {id:248,name:"Troll hide",value:800,stackable:true},
    {id:249,name:"Horror ichor",value:1000,stackable:true},
    {id:250,name:"Ice wight shard",value:1500,stackable:true},
    {id:251,name:"Drake hide",value:2000,stackable:true},
    {id:252,name:"Colossus chip",value:3000,stackable:true},
    {id:260,name:"Pelt coif",value:15,stackable:false},
    {id:261,name:"Pelt jerkin",value:30,stackable:false},
    {id:262,name:"Pelt chaps",value:20,stackable:false},
    {id:263,name:"Bogskin coif",value:34,stackable:false},
    {id:264,name:"Bogskin jerkin",value:70,stackable:false},
    {id:265,name:"Bogskin chaps",value:46,stackable:false},
    {id:266,name:"Chitin coif",value:154,stackable:false},
    {id:267,name:"Chitin jerkin",value:334,stackable:false},
    {id:268,name:"Chitin chaps",value:214,stackable:false},
    {id:269,name:"Fur coif",value:1115,stackable:false},
    {id:270,name:"Fur jerkin",value:2615,stackable:false},
    {id:271,name:"Fur chaps",value:1615,stackable:false},
    {id:272,name:"Scale coif",value:2807,stackable:false},
    {id:273,name:"Scale jerkin",value:6407,stackable:false},
    {id:274,name:"Scale chaps",value:4007,stackable:false},
    {id:300,name:"Homespun bolt",value:12,stackable:true},
    {id:301,name:"Silk bolt",value:70,stackable:true},
    {id:302,name:"Gilded bolt",value:260,stackable:true},
    {id:303,name:"Voidweave bolt",value:900,stackable:true},
    {id:304,name:"Homespun hood",value:29,stackable:false},
    {id:305,name:"Homespun robe",value:65,stackable:false},
    {id:306,name:"Homespun skirt",value:41,stackable:false},
    {id:307,name:"Silk hood",value:166,stackable:false},
    {id:308,name:"Silk robe",value:376,stackable:false},
    {id:309,name:"Silk skirt",value:236,stackable:false},
    {id:310,name:"Gilded hood",value:597,stackable:false},
    {id:311,name:"Gilded robe",value:1377,stackable:false},
    {id:312,name:"Gilded skirt",value:857,stackable:false},
    {id:313,name:"Voidweave hood",value:2020,stackable:false},
    {id:314,name:"Voidweave robe",value:4720,stackable:false},
    {id:315,name:"Voidweave skirt",value:2920,stackable:false},
    {id:316,name:"Rock mite nymph",value:0,stackable:false},
    {id:317,name:"Fen lurker spawn",value:0,stackable:false},
    {id:318,name:"Grave beetle grub",value:0,stackable:false},
    {id:319,name:"Sump crawler hatchling",value:0,stackable:false},
    {id:320,name:"Stone eater pebble",value:0,stackable:false},
    {id:321,name:"Barrow pup",value:0,stackable:false},
    {id:322,name:"Chalk wightling",value:0,stackable:false},
    {id:323,name:"Pelt gloves",value:75,stackable:false},
    {id:324,name:"Bogskin gloves",value:4000,stackable:false},
    {id:325,name:"Chitin gloves",value:12000,stackable:false},
    {id:326,name:"Bone gloves",value:40000,stackable:false},
    {id:327,name:"Scale gloves",value:350000,stackable:false},
    {id:328,name:"Horse",value:10000,stackable:false},
    {id:329,name:"Pelt quiver",value:18,stackable:false},
    {id:330,name:"Bogskin quiver",value:49,stackable:false},
    {id:331,name:"Chitin quiver",value:199,stackable:false},
    {id:332,name:"Fur quiver",value:1215,stackable:false},
    {id:333,name:"Scale quiver",value:3047,stackable:false},
    {id:334,name:"Linen grimoire",value:41,stackable:false},
    {id:335,name:"Silk grimoire",value:248,stackable:false},
    {id:336,name:"Gilded grimoire",value:1057,stackable:false},
    {id:337,name:"Voidweave grimoire",value:4320,stackable:false},
    {id:338,name:"Troll coif",value:2183,stackable:false},
    {id:339,name:"Troll jerkin",value:4583,stackable:false},
    {id:340,name:"Troll chaps",value:2983,stackable:false},
    {id:341,name:"Drake coif",value:4650,stackable:false},
    {id:342,name:"Drake jerkin",value:10650,stackable:false},
    {id:343,name:"Drake chaps",value:6650,stackable:false},
    {id:344,name:"Wightweave hood",value:3800,stackable:false},
    {id:345,name:"Wightweave robe",value:9500,stackable:false},
    {id:346,name:"Wightweave skirt",value:6200,stackable:false},
    {id:347,name:"Troll quiver",value:2783,stackable:false},
    {id:348,name:"Drake quiver",value:5850,stackable:false},
    {id:349,name:"Wightweave grimoire",value:6200,stackable:false},
    {id:350,name:"Colossus blade",value:11231,stackable:false},
    {id:351,name:"Colossus shield",value:11231,stackable:false},
    {id:352,name:"Colossus helm",value:6704,stackable:false},
    {id:353,name:"Colossus plate",value:17285,stackable:false},
    {id:354,name:"Colossus greaves",value:12758,stackable:false},
    {id:355,name:"Leviathan scale",value:20000,stackable:true},
    {id:356,name:"Wyrm ember",value:20000,stackable:true},
    {id:357,name:"Leviathan amulet",value:25593,stackable:false},
    {id:358,name:"Wyrm ring",value:25593,stackable:false},
    {id:359,name:"Protection scroll",value:10,stackable:true},
    {id:360,name:"Bronze pan",value:17,stackable:false},
    {id:361,name:"Iron pan",value:32,stackable:false},
    {id:362,name:"Steel pan",value:190,stackable:false},
    {id:363,name:"Cobalt pan",value:775,stackable:false},
    {id:364,name:"Meteoric pan",value:1934,stackable:false},
    {id:365,name:"Bronze hammer",value:29,stackable:false},
    {id:366,name:"Iron hammer",value:54,stackable:false},
    {id:367,name:"Steel hammer",value:346,stackable:false},
    {id:368,name:"Cobalt hammer",value:1435,stackable:false},
    {id:369,name:"Meteoric hammer",value:3461,stackable:false},
    {id:370,name:"Bronze knife",value:17,stackable:false},
    {id:371,name:"Iron knife",value:32,stackable:false},
    {id:372,name:"Steel knife",value:190,stackable:false},
    {id:373,name:"Cobalt knife",value:775,stackable:false},
    {id:374,name:"Meteoric knife",value:1934,stackable:false},
    {id:375,name:"Bronze needle",value:17,stackable:false},
    {id:376,name:"Iron needle",value:32,stackable:false},
    {id:377,name:"Steel needle",value:190,stackable:false},
    {id:378,name:"Cobalt needle",value:775,stackable:false},
    {id:379,name:"Meteoric needle",value:1934,stackable:false},
    {id:380,name:"Bronze mortar",value:29,stackable:false},
    {id:381,name:"Iron mortar",value:54,stackable:false},
    {id:382,name:"Steel mortar",value:346,stackable:false},
    {id:383,name:"Cobalt mortar",value:1435,stackable:false},
    {id:384,name:"Meteoric mortar",value:3461,stackable:false},
    {id:385,name:"Bronze hoe",value:23,stackable:false},
    {id:386,name:"Iron hoe",value:62,stackable:false},
    {id:387,name:"Steel hoe",value:280,stackable:false},
    {id:388,name:"Cobalt hoe",value:1255,stackable:false},
    {id:389,name:"Meteoric hoe",value:3134,stackable:false},
    {id:390,name:"Bronze greatsword",value:29,stackable:false},
    {id:391,name:"Iron greatsword",value:54,stackable:false},
    {id:392,name:"Steel greatsword",value:346,stackable:false},
    {id:393,name:"Cobalt greatsword",value:1435,stackable:false},
    {id:394,name:"Meteoric greatsword",value:3461,stackable:false},
    {id:395,name:"Colossus greatsword",value:12704,stackable:false},
    {id:396,name:"Golden Week gift box",value:25,stackable:true},
    {id:280,name:"Gnawer pup",value:0,stackable:false},
    {id:281,name:"Bogling tadpole",value:0,stackable:false},
    {id:282,name:"Husk grub",value:0,stackable:false},
    {id:283,name:"Cairn wisp",value:0,stackable:false},
    {id:284,name:"Rimewolf cub",value:0,stackable:false},
    {id:285,name:"Emberkin spark",value:0,stackable:false},
    {id:286,name:"Horror spawn",value:0,stackable:false},
    {id:287,name:"Wraith mote",value:0,stackable:false},
    {id:288,name:"Stalker kit",value:0,stackable:false},
    {id:289,name:"Frost troll whelp",value:0,stackable:false},
    {id:290,name:"Ice wight shard-child",value:0,stackable:false},
    {id:291,name:"Ash drake hatchling",value:0,stackable:false},
    {id:292,name:"Cinder ember",value:0,stackable:false},
    {id:293,name:"Gem pack",value:10,stackable:true},
    {id:294,name:"Pouch of gems",value:1200,stackable:true},
    {id:295,name:"Chest of gems",value:2600,stackable:true},
    {id:296,name:"Vein of gems",value:7000,stackable:true},
    {id:297,name:"Hoard of gems",value:15000,stackable:true},
  ],
  actions: [
    {id:1,name:"Copper",skill:"mining",group:"Ore",levelReq:1,baseTicks:5,xp:2,inputs:[],output:{itemId:1,qty:1}},
    {id:2,name:"Tin",skill:"mining",group:"Ore",levelReq:1,baseTicks:5,xp:3,inputs:[],output:{itemId:2,qty:1}},
    {id:3,name:"Iron",skill:"mining",group:"Ore",levelReq:15,baseTicks:6,xp:5,inputs:[],output:{itemId:3,qty:1},bonus:{itemId:100,chance:0.0005}},
    {id:4,name:"Silver",skill:"mining",group:"Ore",levelReq:30,baseTicks:7,xp:9,inputs:[],output:{itemId:4,qty:1},bonus:{itemId:100,chance:0.001}},
    {id:5,name:"Coal",skill:"mining",group:"Ore",levelReq:40,baseTicks:8,xp:14,inputs:[],output:{itemId:5,qty:1},bonus:{itemId:100,chance:0.001}},
    {id:6,name:"Gold",skill:"mining",group:"Ore",levelReq:55,baseTicks:9,xp:22,inputs:[],output:{itemId:6,qty:1},bonus:{itemId:100,chance:0.002}},
    {id:7,name:"Cobalt",skill:"mining",group:"Ore",levelReq:65,baseTicks:11,xp:37,inputs:[],output:{itemId:7,qty:1},bonus:{itemId:100,chance:0.003}},
    {id:8,name:"Meteoric",skill:"mining",group:"Ore",levelReq:85,baseTicks:13,xp:59,inputs:[],output:{itemId:8,qty:1},bonus:{itemId:100,chance:0.005}},
    {id:21,name:"Shrimp",skill:"fishing",group:"Fish",levelReq:1,baseTicks:5,xp:2,inputs:[],output:{itemId:20,qty:1}},
    {id:22,name:"Sardine",skill:"fishing",group:"Fish",levelReq:5,baseTicks:5,xp:3,inputs:[],output:{itemId:21,qty:1}},
    {id:23,name:"Trout",skill:"fishing",group:"Fish",levelReq:20,baseTicks:6,xp:7,inputs:[],output:{itemId:22,qty:1}},
    {id:24,name:"Salmon",skill:"fishing",group:"Fish",levelReq:30,baseTicks:7,xp:11,inputs:[],output:{itemId:23,qty:1}},
    {id:25,name:"Tuna",skill:"fishing",group:"Fish",levelReq:45,baseTicks:8,xp:17,inputs:[],output:{itemId:24,qty:1}},
    {id:26,name:"Lobster",skill:"fishing",group:"Fish",levelReq:60,baseTicks:10,xp:28,inputs:[],output:{itemId:25,qty:1}},
    {id:27,name:"Swordfish",skill:"fishing",group:"Fish",levelReq:75,baseTicks:11,xp:44,inputs:[],output:{itemId:26,qty:1}},
    {id:28,name:"Shark",skill:"fishing",group:"Fish",levelReq:90,baseTicks:13,xp:60,inputs:[],output:{itemId:27,qty:1}},
    {id:30,name:"Tree",skill:"woodcutting",group:"Wood",levelReq:1,baseTicks:5,xp:3,inputs:[],output:{itemId:10,qty:1},bonus:{itemId:160,chance:0.0125}},
    {id:31,name:"Oak",skill:"woodcutting",group:"Wood",levelReq:15,baseTicks:6,xp:7,inputs:[],output:{itemId:11,qty:1},bonus:{itemId:161,chance:0.008333333333333333}},
    {id:32,name:"Willow",skill:"woodcutting",group:"Wood",levelReq:30,baseTicks:7,xp:11,inputs:[],output:{itemId:12,qty:1},bonus:{itemId:162,chance:0.005555555555555556}},
    {id:33,name:"Maple",skill:"woodcutting",group:"Wood",levelReq:45,baseTicks:8,xp:18,inputs:[],output:{itemId:13,qty:1},bonus:{itemId:163,chance:0.0038461538461538464}},
    {id:34,name:"Yew",skill:"woodcutting",group:"Wood",levelReq:60,baseTicks:10,xp:29,inputs:[],output:{itemId:14,qty:1},bonus:{itemId:164,chance:0.002777777777777778}},
    {id:35,name:"Magic",skill:"woodcutting",group:"Wood",levelReq:75,baseTicks:12,xp:48,inputs:[],output:{itemId:15,qty:1},bonus:{itemId:165,chance:0.0022222222222222222}},
    {id:160,name:"Potato",skill:"farming",group:"Crops",levelReq:1,baseTicks:2,xp:110,inputs:[{qty:1,itemId:160}],output:{itemId:170,qty:1},grow:800},
    {id:161,name:"Glowcap",skill:"farming",group:"Crops",levelReq:15,baseTicks:2,xp:380,inputs:[{qty:1,itemId:161}],output:{itemId:171,qty:1},grow:1500},
    {id:162,name:"Cave turnip",skill:"farming",group:"Crops",levelReq:30,baseTicks:2,xp:900,inputs:[{qty:1,itemId:162}],output:{itemId:172,qty:1},grow:2500},
    {id:163,name:"Bitterroot",skill:"farming",group:"Crops",levelReq:45,baseTicks:2,xp:1900,inputs:[{qty:1,itemId:163}],output:{itemId:173,qty:1},grow:4000},
    {id:164,name:"Voidmelon",skill:"farming",group:"Crops",levelReq:60,baseTicks:2,xp:3800,inputs:[{qty:1,itemId:164}],output:{itemId:174,qty:1},grow:6000},
    {id:165,name:"Ember pepper",skill:"farming",group:"Crops",levelReq:75,baseTicks:2,xp:6500,inputs:[{qty:1,itemId:165}],output:{itemId:175,qty:1},grow:9000},
    {id:41,name:"Bronze bar",skill:"smithing",group:"Bars",levelReq:1,baseTicks:4,xp:6,inputs:[{qty:1,itemId:1},{qty:1,itemId:2}],output:{itemId:40,qty:1}},
    {id:42,name:"Iron bar",skill:"smithing",group:"Bars",levelReq:15,baseTicks:4,xp:8,inputs:[{qty:1,itemId:3}],output:{itemId:41,qty:1}},
    {id:43,name:"Steel bar",skill:"smithing",group:"Bars",levelReq:30,baseTicks:4,xp:35,inputs:[{qty:1,itemId:3},{qty:2,itemId:5}],output:{itemId:42,qty:1}},
    {id:44,name:"Cobalt bar",skill:"smithing",group:"Bars",levelReq:60,baseTicks:4,xp:108,inputs:[{qty:1,itemId:7},{qty:3,itemId:5}],output:{itemId:43,qty:1}},
    {id:45,name:"Meteoric bar",skill:"smithing",group:"Bars",levelReq:85,baseTicks:4,xp:253,inputs:[{qty:1,itemId:8},{qty:4,itemId:5}],output:{itemId:44,qty:1}},
    {id:51,name:"Bronze pickaxe",skill:"smithing",group:"Pickaxes",levelReq:1,baseTicks:5,xp:17,inputs:[{qty:2,itemId:40}],output:{itemId:80,qty:1}},
    {id:52,name:"Iron pickaxe",skill:"smithing",group:"Pickaxes",levelReq:15,baseTicks:5,xp:27,inputs:[{qty:2,itemId:41}],output:{itemId:81,qty:1}},
    {id:53,name:"Steel pickaxe",skill:"smithing",group:"Pickaxes",levelReq:30,baseTicks:5,xp:83,inputs:[{qty:2,itemId:42}],output:{itemId:82,qty:1}},
    {id:54,name:"Cobalt pickaxe",skill:"smithing",group:"Pickaxes",levelReq:60,baseTicks:5,xp:240,inputs:[{qty:2,itemId:43}],output:{itemId:83,qty:1}},
    {id:55,name:"Meteoric pickaxe",skill:"smithing",group:"Pickaxes",levelReq:85,baseTicks:5,xp:552,inputs:[{qty:2,itemId:44}],output:{itemId:84,qty:1}},
    {id:56,name:"Bronze rod",skill:"fletching",group:"Rods",levelReq:1,baseTicks:5,xp:8,inputs:[{qty:1,itemId:40},{qty:1,itemId:10}],output:{itemId:85,qty:1}},
    {id:57,name:"Iron rod",skill:"fletching",group:"Rods",levelReq:15,baseTicks:5,xp:13,inputs:[{qty:1,itemId:41},{qty:1,itemId:11}],output:{itemId:86,qty:1}},
    {id:58,name:"Steel rod",skill:"fletching",group:"Rods",levelReq:30,baseTicks:5,xp:41,inputs:[{qty:1,itemId:42},{qty:1,itemId:12}],output:{itemId:87,qty:1}},
    {id:59,name:"Cobalt rod",skill:"fletching",group:"Rods",levelReq:60,baseTicks:5,xp:120,inputs:[{qty:1,itemId:43},{qty:1,itemId:14}],output:{itemId:88,qty:1}},
    {id:60,name:"Meteoric rod",skill:"fletching",group:"Rods",levelReq:85,baseTicks:5,xp:276,inputs:[{qty:1,itemId:44},{qty:1,itemId:15}],output:{itemId:89,qty:1}},
    {id:308,name:"Bronze pan",skill:"smithing",group:"Pans",levelReq:1,baseTicks:5,xp:8,inputs:[{qty:1,itemId:40}],output:{itemId:360,qty:1}},
    {id:309,name:"Iron pan",skill:"smithing",group:"Pans",levelReq:15,baseTicks:5,xp:13,inputs:[{qty:1,itemId:41}],output:{itemId:361,qty:1}},
    {id:310,name:"Steel pan",skill:"smithing",group:"Pans",levelReq:30,baseTicks:5,xp:41,inputs:[{qty:1,itemId:42}],output:{itemId:362,qty:1}},
    {id:311,name:"Cobalt pan",skill:"smithing",group:"Pans",levelReq:60,baseTicks:5,xp:120,inputs:[{qty:1,itemId:43}],output:{itemId:363,qty:1}},
    {id:312,name:"Meteoric pan",skill:"smithing",group:"Pans",levelReq:85,baseTicks:5,xp:276,inputs:[{qty:1,itemId:44}],output:{itemId:364,qty:1}},
    {id:313,name:"Bronze hammer",skill:"smithing",group:"Hammers",levelReq:1,baseTicks:5,xp:17,inputs:[{qty:2,itemId:40}],output:{itemId:365,qty:1}},
    {id:314,name:"Iron hammer",skill:"smithing",group:"Hammers",levelReq:15,baseTicks:5,xp:27,inputs:[{qty:2,itemId:41}],output:{itemId:366,qty:1}},
    {id:315,name:"Steel hammer",skill:"smithing",group:"Hammers",levelReq:30,baseTicks:5,xp:83,inputs:[{qty:2,itemId:42}],output:{itemId:367,qty:1}},
    {id:316,name:"Cobalt hammer",skill:"smithing",group:"Hammers",levelReq:60,baseTicks:5,xp:240,inputs:[{qty:2,itemId:43}],output:{itemId:368,qty:1}},
    {id:317,name:"Meteoric hammer",skill:"smithing",group:"Hammers",levelReq:85,baseTicks:5,xp:552,inputs:[{qty:2,itemId:44}],output:{itemId:369,qty:1}},
    {id:318,name:"Bronze knife",skill:"smithing",group:"Knives",levelReq:1,baseTicks:5,xp:8,inputs:[{qty:1,itemId:40}],output:{itemId:370,qty:1}},
    {id:319,name:"Iron knife",skill:"smithing",group:"Knives",levelReq:15,baseTicks:5,xp:13,inputs:[{qty:1,itemId:41}],output:{itemId:371,qty:1}},
    {id:320,name:"Steel knife",skill:"smithing",group:"Knives",levelReq:30,baseTicks:5,xp:41,inputs:[{qty:1,itemId:42}],output:{itemId:372,qty:1}},
    {id:321,name:"Cobalt knife",skill:"smithing",group:"Knives",levelReq:60,baseTicks:5,xp:120,inputs:[{qty:1,itemId:43}],output:{itemId:373,qty:1}},
    {id:322,name:"Meteoric knife",skill:"smithing",group:"Knives",levelReq:85,baseTicks:5,xp:276,inputs:[{qty:1,itemId:44}],output:{itemId:374,qty:1}},
    {id:323,name:"Bronze needle",skill:"crafting",group:"Needles",levelReq:1,baseTicks:5,xp:8,inputs:[{qty:1,itemId:40}],output:{itemId:375,qty:1}},
    {id:324,name:"Iron needle",skill:"crafting",group:"Needles",levelReq:15,baseTicks:5,xp:13,inputs:[{qty:1,itemId:41}],output:{itemId:376,qty:1}},
    {id:325,name:"Steel needle",skill:"crafting",group:"Needles",levelReq:30,baseTicks:5,xp:41,inputs:[{qty:1,itemId:42}],output:{itemId:377,qty:1}},
    {id:326,name:"Cobalt needle",skill:"crafting",group:"Needles",levelReq:60,baseTicks:5,xp:120,inputs:[{qty:1,itemId:43}],output:{itemId:378,qty:1}},
    {id:327,name:"Meteoric needle",skill:"crafting",group:"Needles",levelReq:85,baseTicks:5,xp:276,inputs:[{qty:1,itemId:44}],output:{itemId:379,qty:1}},
    {id:328,name:"Bronze mortar",skill:"crafting",group:"Mortars",levelReq:1,baseTicks:5,xp:17,inputs:[{qty:2,itemId:40}],output:{itemId:380,qty:1}},
    {id:329,name:"Iron mortar",skill:"crafting",group:"Mortars",levelReq:15,baseTicks:5,xp:27,inputs:[{qty:2,itemId:41}],output:{itemId:381,qty:1}},
    {id:330,name:"Steel mortar",skill:"crafting",group:"Mortars",levelReq:30,baseTicks:5,xp:83,inputs:[{qty:2,itemId:42}],output:{itemId:382,qty:1}},
    {id:331,name:"Cobalt mortar",skill:"crafting",group:"Mortars",levelReq:60,baseTicks:5,xp:240,inputs:[{qty:2,itemId:43}],output:{itemId:383,qty:1}},
    {id:332,name:"Meteoric mortar",skill:"crafting",group:"Mortars",levelReq:85,baseTicks:5,xp:552,inputs:[{qty:2,itemId:44}],output:{itemId:384,qty:1}},
    {id:333,name:"Bronze hoe",skill:"fletching",group:"Hoes",levelReq:1,baseTicks:5,xp:17,inputs:[{qty:1,itemId:40},{qty:2,itemId:10}],output:{itemId:385,qty:1}},
    {id:334,name:"Iron hoe",skill:"fletching",group:"Hoes",levelReq:15,baseTicks:5,xp:27,inputs:[{qty:1,itemId:41},{qty:2,itemId:11}],output:{itemId:386,qty:1}},
    {id:335,name:"Steel hoe",skill:"fletching",group:"Hoes",levelReq:30,baseTicks:5,xp:83,inputs:[{qty:1,itemId:42},{qty:2,itemId:12}],output:{itemId:387,qty:1}},
    {id:336,name:"Cobalt hoe",skill:"fletching",group:"Hoes",levelReq:60,baseTicks:5,xp:240,inputs:[{qty:1,itemId:43},{qty:2,itemId:14}],output:{itemId:388,qty:1}},
    {id:337,name:"Meteoric hoe",skill:"fletching",group:"Hoes",levelReq:85,baseTicks:5,xp:552,inputs:[{qty:1,itemId:44},{qty:2,itemId:15}],output:{itemId:389,qty:1}},
    {id:46,name:"Bronze axe",skill:"smithing",group:"Axes",levelReq:1,baseTicks:5,xp:17,inputs:[{qty:2,itemId:40}],output:{itemId:90,qty:1}},
    {id:47,name:"Iron axe",skill:"smithing",group:"Axes",levelReq:15,baseTicks:5,xp:27,inputs:[{qty:2,itemId:41}],output:{itemId:91,qty:1}},
    {id:48,name:"Steel axe",skill:"smithing",group:"Axes",levelReq:30,baseTicks:5,xp:83,inputs:[{qty:2,itemId:42}],output:{itemId:92,qty:1}},
    {id:49,name:"Cobalt axe",skill:"smithing",group:"Axes",levelReq:60,baseTicks:5,xp:240,inputs:[{qty:2,itemId:43}],output:{itemId:93,qty:1}},
    {id:50,name:"Meteoric axe",skill:"smithing",group:"Axes",levelReq:85,baseTicks:5,xp:552,inputs:[{qty:2,itemId:44}],output:{itemId:94,qty:1}},
    {id:61,name:"Cook shrimp",skill:"cooking",group:"Food",levelReq:1,baseTicks:4,xp:4,inputs:[{qty:1,itemId:20}],output:{itemId:60,qty:1},burn:{itemId:70,chanceAtReq:0.3,safeAtLevel:26}},
    {id:62,name:"Cook sardine",skill:"cooking",group:"Food",levelReq:5,baseTicks:4,xp:5,inputs:[{qty:1,itemId:21}],output:{itemId:61,qty:1},burn:{itemId:70,chanceAtReq:0.3,safeAtLevel:30}},
    {id:63,name:"Cook trout",skill:"cooking",group:"Food",levelReq:20,baseTicks:4,xp:10,inputs:[{qty:1,itemId:22}],output:{itemId:62,qty:1},burn:{itemId:70,chanceAtReq:0.3,safeAtLevel:45}},
    {id:64,name:"Cook salmon",skill:"cooking",group:"Food",levelReq:30,baseTicks:4,xp:14,inputs:[{qty:1,itemId:23}],output:{itemId:63,qty:1},burn:{itemId:70,chanceAtReq:0.3,safeAtLevel:55}},
    {id:65,name:"Cook tuna",skill:"cooking",group:"Food",levelReq:45,baseTicks:4,xp:22,inputs:[{qty:1,itemId:24}],output:{itemId:64,qty:1},burn:{itemId:70,chanceAtReq:0.3,safeAtLevel:70}},
    {id:66,name:"Cook lobster",skill:"cooking",group:"Food",levelReq:60,baseTicks:4,xp:36,inputs:[{qty:1,itemId:25}],output:{itemId:65,qty:1},burn:{itemId:70,chanceAtReq:0.3,safeAtLevel:85}},
    {id:67,name:"Cook swordfish",skill:"cooking",group:"Food",levelReq:75,baseTicks:4,xp:59,inputs:[{qty:1,itemId:26}],output:{itemId:66,qty:1},burn:{itemId:70,chanceAtReq:0.3,safeAtLevel:100}},
    {id:68,name:"Cook shark",skill:"cooking",group:"Food",levelReq:90,baseTicks:4,xp:92,inputs:[{qty:1,itemId:27}],output:{itemId:67,qty:1},burn:{itemId:70,chanceAtReq:0.3,safeAtLevel:115}},
    {id:110,name:"Bronze blade",skill:"smithing",group:"Weapons",levelReq:1,baseTicks:5,xp:8,inputs:[{qty:1,itemId:40}],output:{itemId:110,qty:1}},
    {id:111,name:"Iron blade",skill:"smithing",group:"Weapons",levelReq:15,baseTicks:5,xp:13,inputs:[{qty:1,itemId:41}],output:{itemId:111,qty:1}},
    {id:112,name:"Steel blade",skill:"smithing",group:"Weapons",levelReq:30,baseTicks:5,xp:41,inputs:[{qty:1,itemId:42}],output:{itemId:112,qty:1}},
    {id:113,name:"Cobalt blade",skill:"smithing",group:"Weapons",levelReq:60,baseTicks:5,xp:120,inputs:[{qty:1,itemId:43}],output:{itemId:113,qty:1}},
    {id:114,name:"Meteoric blade",skill:"smithing",group:"Weapons",levelReq:85,baseTicks:5,xp:276,inputs:[{qty:1,itemId:44}],output:{itemId:114,qty:1}},
    {id:338,name:"Bronze greatsword",skill:"smithing",group:"Two-handers",levelReq:1,baseTicks:5,xp:17,inputs:[{qty:2,itemId:40}],output:{itemId:390,qty:1}},
    {id:339,name:"Iron greatsword",skill:"smithing",group:"Two-handers",levelReq:15,baseTicks:5,xp:27,inputs:[{qty:2,itemId:41}],output:{itemId:391,qty:1}},
    {id:340,name:"Steel greatsword",skill:"smithing",group:"Two-handers",levelReq:30,baseTicks:5,xp:83,inputs:[{qty:2,itemId:42}],output:{itemId:392,qty:1}},
    {id:341,name:"Cobalt greatsword",skill:"smithing",group:"Two-handers",levelReq:60,baseTicks:5,xp:240,inputs:[{qty:2,itemId:43}],output:{itemId:393,qty:1}},
    {id:342,name:"Meteoric greatsword",skill:"smithing",group:"Two-handers",levelReq:85,baseTicks:5,xp:552,inputs:[{qty:2,itemId:44}],output:{itemId:394,qty:1}},
    {id:343,name:"Colossus greatsword",skill:"smithing",group:"Two-handers",levelReq:99,baseTicks:6,xp:1350,inputs:[{qty:2,itemId:44},{qty:3,itemId:252}],output:{itemId:395,qty:1}},
    {id:115,name:"Bronze shield",skill:"smithing",group:"Shields",levelReq:1,baseTicks:5,xp:25,inputs:[{qty:3,itemId:40}],output:{itemId:115,qty:1}},
    {id:116,name:"Iron shield",skill:"smithing",group:"Shields",levelReq:15,baseTicks:5,xp:40,inputs:[{qty:3,itemId:41}],output:{itemId:116,qty:1}},
    {id:117,name:"Steel shield",skill:"smithing",group:"Shields",levelReq:30,baseTicks:5,xp:124,inputs:[{qty:3,itemId:42}],output:{itemId:117,qty:1}},
    {id:118,name:"Cobalt shield",skill:"smithing",group:"Shields",levelReq:60,baseTicks:5,xp:360,inputs:[{qty:3,itemId:43}],output:{itemId:118,qty:1}},
    {id:119,name:"Meteoric shield",skill:"smithing",group:"Shields",levelReq:85,baseTicks:5,xp:828,inputs:[{qty:3,itemId:44}],output:{itemId:119,qty:1}},
    {id:120,name:"Bronze helm",skill:"smithing",group:"Helmets",levelReq:1,baseTicks:5,xp:17,inputs:[{qty:2,itemId:40}],output:{itemId:120,qty:1}},
    {id:121,name:"Iron helm",skill:"smithing",group:"Helmets",levelReq:15,baseTicks:5,xp:27,inputs:[{qty:2,itemId:41}],output:{itemId:121,qty:1}},
    {id:122,name:"Steel helm",skill:"smithing",group:"Helmets",levelReq:30,baseTicks:5,xp:83,inputs:[{qty:2,itemId:42}],output:{itemId:122,qty:1}},
    {id:123,name:"Cobalt helm",skill:"smithing",group:"Helmets",levelReq:60,baseTicks:5,xp:240,inputs:[{qty:2,itemId:43}],output:{itemId:123,qty:1}},
    {id:124,name:"Meteoric helm",skill:"smithing",group:"Helmets",levelReq:85,baseTicks:5,xp:552,inputs:[{qty:2,itemId:44}],output:{itemId:124,qty:1}},
    {id:125,name:"Bronze plate",skill:"smithing",group:"Bodies",levelReq:1,baseTicks:5,xp:42,inputs:[{qty:5,itemId:40}],output:{itemId:125,qty:1}},
    {id:126,name:"Iron plate",skill:"smithing",group:"Bodies",levelReq:15,baseTicks:5,xp:67,inputs:[{qty:5,itemId:41}],output:{itemId:126,qty:1}},
    {id:127,name:"Steel plate",skill:"smithing",group:"Bodies",levelReq:30,baseTicks:5,xp:207,inputs:[{qty:5,itemId:42}],output:{itemId:127,qty:1}},
    {id:128,name:"Cobalt plate",skill:"smithing",group:"Bodies",levelReq:60,baseTicks:5,xp:600,inputs:[{qty:5,itemId:43}],output:{itemId:128,qty:1}},
    {id:129,name:"Meteoric plate",skill:"smithing",group:"Bodies",levelReq:85,baseTicks:5,xp:1380,inputs:[{qty:5,itemId:44}],output:{itemId:129,qty:1}},
    {id:130,name:"Bronze greaves",skill:"smithing",group:"Legs",levelReq:1,baseTicks:5,xp:34,inputs:[{qty:4,itemId:40}],output:{itemId:130,qty:1}},
    {id:131,name:"Iron greaves",skill:"smithing",group:"Legs",levelReq:15,baseTicks:5,xp:53,inputs:[{qty:4,itemId:41}],output:{itemId:131,qty:1}},
    {id:132,name:"Steel greaves",skill:"smithing",group:"Legs",levelReq:30,baseTicks:5,xp:165,inputs:[{qty:4,itemId:42}],output:{itemId:132,qty:1}},
    {id:133,name:"Cobalt greaves",skill:"smithing",group:"Legs",levelReq:60,baseTicks:5,xp:480,inputs:[{qty:4,itemId:43}],output:{itemId:133,qty:1}},
    {id:134,name:"Meteoric greaves",skill:"smithing",group:"Legs",levelReq:85,baseTicks:5,xp:1104,inputs:[{qty:4,itemId:44}],output:{itemId:134,qty:1}},
    {id:301,name:"Colossus blade",skill:"smithing",group:"Weapons",levelReq:99,baseTicks:6,xp:1900,inputs:[{qty:3,itemId:44},{qty:2,itemId:252}],output:{itemId:350,qty:1}},
    {id:302,name:"Colossus shield",skill:"smithing",group:"Shields",levelReq:99,baseTicks:6,xp:1900,inputs:[{qty:3,itemId:44},{qty:2,itemId:252}],output:{itemId:351,qty:1}},
    {id:303,name:"Colossus helm",skill:"smithing",group:"Helmets",levelReq:99,baseTicks:6,xp:1250,inputs:[{qty:2,itemId:44},{qty:1,itemId:252}],output:{itemId:352,qty:1}},
    {id:304,name:"Colossus plate",skill:"smithing",group:"Bodies",levelReq:99,baseTicks:6,xp:3100,inputs:[{qty:5,itemId:44},{qty:3,itemId:252}],output:{itemId:353,qty:1}},
    {id:305,name:"Colossus greaves",skill:"smithing",group:"Legs",levelReq:99,baseTicks:6,xp:2500,inputs:[{qty:4,itemId:44},{qty:2,itemId:252}],output:{itemId:354,qty:1}},
    {id:140,name:"Shortbow",skill:"fletching",group:"Shortbows",levelReq:1,baseTicks:5,xp:5,inputs:[{qty:1,itemId:10}],output:{itemId:140,qty:1}},
    {id:141,name:"Oak shortbow",skill:"fletching",group:"Shortbows",levelReq:15,baseTicks:5,xp:11,inputs:[{qty:1,itemId:11}],output:{itemId:141,qty:1}},
    {id:142,name:"Willow shortbow",skill:"fletching",group:"Shortbows",levelReq:30,baseTicks:5,xp:17,inputs:[{qty:1,itemId:12}],output:{itemId:142,qty:1}},
    {id:143,name:"Maple shortbow",skill:"fletching",group:"Shortbows",levelReq:45,baseTicks:5,xp:27,inputs:[{qty:1,itemId:13}],output:{itemId:143,qty:1}},
    {id:144,name:"Yew shortbow",skill:"fletching",group:"Shortbows",levelReq:60,baseTicks:5,xp:43,inputs:[{qty:1,itemId:14}],output:{itemId:144,qty:1}},
    {id:145,name:"Magic shortbow",skill:"fletching",group:"Shortbows",levelReq:75,baseTicks:5,xp:70,inputs:[{qty:1,itemId:15}],output:{itemId:145,qty:1}},
    {id:146,name:"Longbow",skill:"fletching",group:"Longbows",levelReq:1,baseTicks:5,xp:10,inputs:[{qty:2,itemId:10}],output:{itemId:146,qty:1}},
    {id:147,name:"Oak longbow",skill:"fletching",group:"Longbows",levelReq:15,baseTicks:5,xp:22,inputs:[{qty:2,itemId:11}],output:{itemId:147,qty:1}},
    {id:148,name:"Willow longbow",skill:"fletching",group:"Longbows",levelReq:30,baseTicks:5,xp:34,inputs:[{qty:2,itemId:12}],output:{itemId:148,qty:1}},
    {id:149,name:"Maple longbow",skill:"fletching",group:"Longbows",levelReq:45,baseTicks:5,xp:54,inputs:[{qty:2,itemId:13}],output:{itemId:149,qty:1}},
    {id:150,name:"Yew longbow",skill:"fletching",group:"Longbows",levelReq:60,baseTicks:5,xp:86,inputs:[{qty:2,itemId:14}],output:{itemId:150,qty:1}},
    {id:151,name:"Magic longbow",skill:"fletching",group:"Longbows",levelReq:75,baseTicks:5,xp:140,inputs:[{qty:2,itemId:15}],output:{itemId:151,qty:1}},
    {id:200,name:"Staff",skill:"fletching",group:"Staffs",levelReq:1,baseTicks:5,xp:8,inputs:[{qty:2,itemId:10}],output:{itemId:152,qty:1}},
    {id:201,name:"Oak staff",skill:"fletching",group:"Staffs",levelReq:15,baseTicks:5,xp:22,inputs:[{qty:2,itemId:11}],output:{itemId:153,qty:1}},
    {id:202,name:"Willow staff",skill:"fletching",group:"Staffs",levelReq:30,baseTicks:5,xp:40,inputs:[{qty:2,itemId:12}],output:{itemId:154,qty:1}},
    {id:203,name:"Maple staff",skill:"fletching",group:"Staffs",levelReq:45,baseTicks:5,xp:65,inputs:[{qty:2,itemId:13}],output:{itemId:155,qty:1}},
    {id:204,name:"Yew staff",skill:"fletching",group:"Staffs",levelReq:60,baseTicks:5,xp:100,inputs:[{qty:2,itemId:14}],output:{itemId:156,qty:1}},
    {id:205,name:"Magic staff",skill:"fletching",group:"Staffs",levelReq:75,baseTicks:5,xp:150,inputs:[{qty:2,itemId:15}],output:{itemId:157,qty:1}},
    {id:210,name:"Sage",skill:"farming",group:"Herbs",levelReq:10,baseTicks:2,xp:260,inputs:[{qty:1,itemId:190}],output:{itemId:193,qty:1},grow:1200},
    {id:211,name:"Nightshade",skill:"farming",group:"Herbs",levelReq:35,baseTicks:2,xp:1200,inputs:[{qty:1,itemId:191}],output:{itemId:194,qty:1},grow:3000},
    {id:212,name:"Dragonleaf",skill:"farming",group:"Herbs",levelReq:65,baseTicks:2,xp:4600,inputs:[{qty:1,itemId:192}],output:{itemId:195,qty:1},grow:7000},
    {id:220,name:"Gatherer's draught",skill:"herblore",group:"Potions",levelReq:1,baseTicks:6,xp:30,inputs:[{qty:1,itemId:193},{qty:1,itemId:240}],output:{itemId:220,qty:1}},
    {id:225,name:"Swift draught",skill:"herblore",group:"Potions",levelReq:20,baseTicks:6,xp:70,inputs:[{qty:1,itemId:193},{qty:1,itemId:242}],output:{itemId:225,qty:1}},
    {id:226,name:"Nourishing draught",skill:"herblore",group:"Potions",levelReq:50,baseTicks:6,xp:240,inputs:[{qty:1,itemId:194},{qty:1,itemId:244}],output:{itemId:226,qty:1}},
    {id:227,name:"Haste draught",skill:"herblore",group:"Potions",levelReq:70,baseTicks:7,xp:460,inputs:[{qty:1,itemId:195},{qty:1,itemId:245}],output:{itemId:227,qty:1}},
    {id:221,name:"Hunter's brew",skill:"herblore",group:"Potions",levelReq:35,baseTicks:6,xp:120,inputs:[{qty:1,itemId:194},{qty:1,itemId:243}],output:{itemId:221,qty:1}},
    {id:222,name:"Warrior's tonic",skill:"herblore",group:"Potions",levelReq:60,baseTicks:6,xp:300,inputs:[{qty:1,itemId:195},{qty:1,itemId:244}],output:{itemId:222,qty:1}},
    {id:223,name:"Elixir of the vein",skill:"herblore",group:"Potions",levelReq:80,baseTicks:7,xp:700,inputs:[{qty:1,itemId:194},{qty:1,itemId:195},{qty:1,itemId:246}],output:{itemId:223,qty:1}},
    {id:224,name:"Abyssal tonic",skill:"herblore",group:"Potions",levelReq:95,baseTicks:7,xp:1600,inputs:[{qty:1,itemId:195},{qty:1,itemId:249}],output:{itemId:224,qty:1}},
    {id:230,name:"Cut gem",skill:"crafting",group:"Gems",levelReq:1,baseTicks:5,xp:16,inputs:[{qty:1,itemId:100}],output:{itemId:180,qty:1}},
    {id:231,name:"Silver ring",skill:"crafting",group:"Rings",levelReq:20,baseTicks:6,xp:58,inputs:[{qty:1,itemId:4},{qty:1,itemId:180}],output:{itemId:181,qty:1}},
    {id:232,name:"Gold ring",skill:"crafting",group:"Rings",levelReq:45,baseTicks:6,xp:156,inputs:[{qty:1,itemId:6},{qty:1,itemId:180}],output:{itemId:182,qty:1}},
    {id:233,name:"Meteoric ring",skill:"crafting",group:"Rings",levelReq:75,baseTicks:7,xp:455,inputs:[{qty:1,itemId:44},{qty:2,itemId:180}],output:{itemId:183,qty:1}},
    {id:307,name:"Wyrm ring",skill:"crafting",group:"Rings",levelReq:95,baseTicks:8,xp:1200,inputs:[{qty:1,itemId:356},{qty:2,itemId:180}],output:{itemId:358,qty:1}},
    {id:234,name:"Silver amulet",skill:"crafting",group:"Amulets",levelReq:30,baseTicks:6,xp:84,inputs:[{qty:1,itemId:4},{qty:1,itemId:180}],output:{itemId:184,qty:1}},
    {id:235,name:"Gold amulet",skill:"crafting",group:"Amulets",levelReq:55,baseTicks:6,xp:221,inputs:[{qty:1,itemId:6},{qty:1,itemId:180}],output:{itemId:185,qty:1}},
    {id:236,name:"Meteoric amulet",skill:"crafting",group:"Amulets",levelReq:85,baseTicks:7,xp:618,inputs:[{qty:1,itemId:44},{qty:2,itemId:180}],output:{itemId:186,qty:1}},
    {id:306,name:"Leviathan amulet",skill:"crafting",group:"Amulets",levelReq:95,baseTicks:8,xp:1400,inputs:[{qty:1,itemId:355},{qty:2,itemId:180}],output:{itemId:357,qty:1}},
    {id:260,name:"Pelt coif",skill:"crafting",group:"Leather",levelReq:1,baseTicks:6,xp:8,inputs:[{qty:2,itemId:240}],output:{itemId:260,qty:1}},
    {id:261,name:"Pelt chaps",skill:"crafting",group:"Leather",levelReq:1,baseTicks:6,xp:12,inputs:[{qty:3,itemId:240}],output:{itemId:262,qty:1}},
    {id:262,name:"Pelt jerkin",skill:"crafting",group:"Leather",levelReq:1,baseTicks:6,xp:20,inputs:[{qty:5,itemId:240}],output:{itemId:261,qty:1}},
    {id:263,name:"Bogskin coif",skill:"crafting",group:"Leather",levelReq:15,baseTicks:6,xp:22,inputs:[{qty:2,itemId:241}],output:{itemId:263,qty:1}},
    {id:264,name:"Bogskin chaps",skill:"crafting",group:"Leather",levelReq:15,baseTicks:6,xp:33,inputs:[{qty:3,itemId:241}],output:{itemId:265,qty:1}},
    {id:265,name:"Bogskin jerkin",skill:"crafting",group:"Leather",levelReq:15,baseTicks:6,xp:55,inputs:[{qty:5,itemId:241}],output:{itemId:264,qty:1}},
    {id:266,name:"Chitin coif",skill:"crafting",group:"Leather",levelReq:30,baseTicks:6,xp:60,inputs:[{qty:2,itemId:242}],output:{itemId:266,qty:1}},
    {id:267,name:"Chitin chaps",skill:"crafting",group:"Leather",levelReq:30,baseTicks:6,xp:90,inputs:[{qty:3,itemId:242}],output:{itemId:268,qty:1}},
    {id:268,name:"Chitin jerkin",skill:"crafting",group:"Leather",levelReq:30,baseTicks:6,xp:150,inputs:[{qty:5,itemId:242}],output:{itemId:267,qty:1}},
    {id:269,name:"Fur coif",skill:"crafting",group:"Leather",levelReq:60,baseTicks:7,xp:180,inputs:[{qty:2,itemId:245}],output:{itemId:269,qty:1}},
    {id:270,name:"Fur chaps",skill:"crafting",group:"Leather",levelReq:60,baseTicks:7,xp:270,inputs:[{qty:3,itemId:245}],output:{itemId:271,qty:1}},
    {id:271,name:"Fur jerkin",skill:"crafting",group:"Leather",levelReq:60,baseTicks:7,xp:450,inputs:[{qty:5,itemId:245}],output:{itemId:270,qty:1}},
    {id:272,name:"Scale coif",skill:"crafting",group:"Leather",levelReq:85,baseTicks:7,xp:460,inputs:[{qty:2,itemId:247}],output:{itemId:272,qty:1}},
    {id:273,name:"Scale chaps",skill:"crafting",group:"Leather",levelReq:85,baseTicks:7,xp:690,inputs:[{qty:3,itemId:247}],output:{itemId:274,qty:1}},
    {id:274,name:"Scale jerkin",skill:"crafting",group:"Leather",levelReq:85,baseTicks:7,xp:1150,inputs:[{qty:5,itemId:247}],output:{itemId:273,qty:1}},
    {id:289,name:"Troll coif",skill:"crafting",group:"Leather",levelReq:95,baseTicks:8,xp:1250,inputs:[{qty:2,itemId:248}],output:{itemId:338,qty:1}},
    {id:290,name:"Troll chaps",skill:"crafting",group:"Leather",levelReq:95,baseTicks:8,xp:1900,inputs:[{qty:3,itemId:248}],output:{itemId:340,qty:1}},
    {id:291,name:"Troll jerkin",skill:"crafting",group:"Leather",levelReq:95,baseTicks:8,xp:3100,inputs:[{qty:5,itemId:248}],output:{itemId:339,qty:1}},
    {id:292,name:"Drake coif",skill:"crafting",group:"Leather",levelReq:99,baseTicks:8,xp:3300,inputs:[{qty:2,itemId:251}],output:{itemId:341,qty:1}},
    {id:293,name:"Drake chaps",skill:"crafting",group:"Leather",levelReq:99,baseTicks:8,xp:5000,inputs:[{qty:3,itemId:251}],output:{itemId:343,qty:1}},
    {id:294,name:"Drake jerkin",skill:"crafting",group:"Leather",levelReq:99,baseTicks:8,xp:8300,inputs:[{qty:5,itemId:251}],output:{itemId:342,qty:1}},
    {id:240,name:"Bread stall",skill:"thieving",group:"Stalls",levelReq:1,baseTicks:6,xp:8,inputs:[],output:{itemId:200,qty:6},caught:{chanceAtReq:0.25,safeAtLevel:30,stunTicks:8}},
    {id:241,name:"Silk stall",skill:"thieving",group:"Stalls",levelReq:25,baseTicks:7,xp:30,inputs:[],output:{itemId:200,qty:28},bonus:{itemId:191,chance:0.03333333333333333},caught:{chanceAtReq:0.3,safeAtLevel:60,stunTicks:10}},
    {id:242,name:"Gem stall",skill:"thieving",group:"Stalls",levelReq:50,baseTicks:8,xp:80,inputs:[],output:{itemId:200,qty:90},bonus:{itemId:100,chance:0.04},caught:{chanceAtReq:0.32,safeAtLevel:85,stunTicks:12}},
    {id:243,name:"Relic stall",skill:"thieving",group:"Stalls",levelReq:75,baseTicks:9,xp:200,inputs:[],output:{itemId:200,qty:260},bonus:{itemId:208,chance:0.03},caught:{chanceAtReq:0.35,safeAtLevel:110,stunTicks:15}},
    {id:244,name:"Linen line",skill:"thieving",group:"Cloth",levelReq:1,baseTicks:7,xp:7,inputs:[],output:{itemId:300,qty:1},caught:{chanceAtReq:0.25,safeAtLevel:30,stunTicks:8}},
    {id:245,name:"Silk cart",skill:"thieving",group:"Cloth",levelReq:25,baseTicks:8,xp:26,inputs:[],output:{itemId:301,qty:1},caught:{chanceAtReq:0.3,safeAtLevel:60,stunTicks:10}},
    {id:246,name:"Gilded loom",skill:"thieving",group:"Cloth",levelReq:50,baseTicks:9,xp:70,inputs:[],output:{itemId:302,qty:1},caught:{chanceAtReq:0.32,safeAtLevel:85,stunTicks:12}},
    {id:247,name:"Reliquary vestry",skill:"thieving",group:"Cloth",levelReq:75,baseTicks:10,xp:175,inputs:[],output:{itemId:303,qty:1},caught:{chanceAtReq:0.35,safeAtLevel:110,stunTicks:15}},
    {id:248,name:"Homespun hood",skill:"crafting",group:"Cloth",levelReq:1,baseTicks:6,xp:9,inputs:[{qty:2,itemId:300}],output:{itemId:304,qty:1}},
    {id:249,name:"Homespun skirt",skill:"crafting",group:"Cloth",levelReq:1,baseTicks:6,xp:14,inputs:[{qty:3,itemId:300}],output:{itemId:306,qty:1}},
    {id:250,name:"Homespun robe",skill:"crafting",group:"Cloth",levelReq:1,baseTicks:6,xp:23,inputs:[{qty:5,itemId:300}],output:{itemId:305,qty:1}},
    {id:251,name:"Silk hood",skill:"crafting",group:"Cloth",levelReq:25,baseTicks:6,xp:50,inputs:[{qty:2,itemId:301}],output:{itemId:307,qty:1}},
    {id:252,name:"Silk skirt",skill:"crafting",group:"Cloth",levelReq:25,baseTicks:6,xp:75,inputs:[{qty:3,itemId:301}],output:{itemId:309,qty:1}},
    {id:253,name:"Silk robe",skill:"crafting",group:"Cloth",levelReq:25,baseTicks:6,xp:125,inputs:[{qty:5,itemId:301}],output:{itemId:308,qty:1}},
    {id:254,name:"Gilded hood",skill:"crafting",group:"Cloth",levelReq:50,baseTicks:7,xp:145,inputs:[{qty:2,itemId:302}],output:{itemId:310,qty:1}},
    {id:255,name:"Gilded skirt",skill:"crafting",group:"Cloth",levelReq:50,baseTicks:7,xp:215,inputs:[{qty:3,itemId:302}],output:{itemId:312,qty:1}},
    {id:256,name:"Gilded robe",skill:"crafting",group:"Cloth",levelReq:50,baseTicks:7,xp:360,inputs:[{qty:5,itemId:302}],output:{itemId:311,qty:1}},
    {id:257,name:"Voidweave hood",skill:"crafting",group:"Cloth",levelReq:75,baseTicks:7,xp:380,inputs:[{qty:2,itemId:303}],output:{itemId:313,qty:1}},
    {id:258,name:"Voidweave skirt",skill:"crafting",group:"Cloth",levelReq:75,baseTicks:7,xp:570,inputs:[{qty:3,itemId:303}],output:{itemId:315,qty:1}},
    {id:259,name:"Voidweave robe",skill:"crafting",group:"Cloth",levelReq:75,baseTicks:7,xp:950,inputs:[{qty:5,itemId:303}],output:{itemId:314,qty:1}},
    {id:295,name:"Wightweave hood",skill:"crafting",group:"Cloth",levelReq:90,baseTicks:8,xp:1000,inputs:[{qty:2,itemId:303},{qty:1,itemId:250}],output:{itemId:344,qty:1}},
    {id:296,name:"Wightweave skirt",skill:"crafting",group:"Cloth",levelReq:90,baseTicks:8,xp:1500,inputs:[{qty:3,itemId:303},{qty:2,itemId:250}],output:{itemId:346,qty:1}},
    {id:297,name:"Wightweave robe",skill:"crafting",group:"Cloth",levelReq:90,baseTicks:8,xp:2500,inputs:[{qty:5,itemId:303},{qty:3,itemId:250}],output:{itemId:345,qty:1}},
    {id:275,name:"Pelt gloves",skill:"crafting",group:"Gloves",levelReq:5,baseTicks:6,xp:10,inputs:[{qty:4,itemId:240}],output:{itemId:323,qty:1}},
    {id:276,name:"Bogskin gloves",skill:"crafting",group:"Gloves",levelReq:25,baseTicks:6,xp:28,inputs:[{qty:2,itemId:241},{qty:1,itemId:202}],output:{itemId:324,qty:1}},
    {id:277,name:"Chitin gloves",skill:"crafting",group:"Gloves",levelReq:45,baseTicks:6,xp:75,inputs:[{qty:2,itemId:242},{qty:1,itemId:203}],output:{itemId:325,qty:1}},
    {id:278,name:"Bone gloves",skill:"crafting",group:"Gloves",levelReq:65,baseTicks:7,xp:225,inputs:[{qty:2,itemId:243},{qty:1,itemId:204}],output:{itemId:326,qty:1}},
    {id:280,name:"Pelt quiver",skill:"fletching",group:"Quivers",levelReq:1,baseTicks:5,xp:14,inputs:[{qty:2,itemId:240},{qty:1,itemId:10}],output:{itemId:329,qty:1}},
    {id:281,name:"Bogskin quiver",skill:"fletching",group:"Quivers",levelReq:15,baseTicks:5,xp:34,inputs:[{qty:2,itemId:241},{qty:1,itemId:11}],output:{itemId:330,qty:1}},
    {id:282,name:"Chitin quiver",skill:"fletching",group:"Quivers",levelReq:30,baseTicks:5,xp:70,inputs:[{qty:2,itemId:242},{qty:1,itemId:12}],output:{itemId:331,qty:1}},
    {id:283,name:"Fur quiver",skill:"fletching",group:"Quivers",levelReq:60,baseTicks:5,xp:150,inputs:[{qty:2,itemId:245},{qty:1,itemId:13}],output:{itemId:332,qty:1}},
    {id:284,name:"Scale quiver",skill:"fletching",group:"Quivers",levelReq:85,baseTicks:5,xp:320,inputs:[{qty:2,itemId:247},{qty:1,itemId:14}],output:{itemId:333,qty:1}},
    {id:298,name:"Troll quiver",skill:"fletching",group:"Quivers",levelReq:95,baseTicks:6,xp:700,inputs:[{qty:2,itemId:248},{qty:1,itemId:15}],output:{itemId:347,qty:1}},
    {id:299,name:"Drake quiver",skill:"fletching",group:"Quivers",levelReq:99,baseTicks:6,xp:1400,inputs:[{qty:2,itemId:251},{qty:2,itemId:15}],output:{itemId:348,qty:1}},
    {id:285,name:"Linen grimoire",skill:"crafting",group:"Grimoires",levelReq:1,baseTicks:6,xp:16,inputs:[{qty:3,itemId:300}],output:{itemId:334,qty:1}},
    {id:286,name:"Silk grimoire",skill:"crafting",group:"Grimoires",levelReq:25,baseTicks:6,xp:85,inputs:[{qty:3,itemId:301},{qty:1,itemId:241}],output:{itemId:335,qty:1}},
    {id:287,name:"Gilded grimoire",skill:"crafting",group:"Grimoires",levelReq:50,baseTicks:7,xp:230,inputs:[{qty:3,itemId:302},{qty:1,itemId:244}],output:{itemId:336,qty:1}},
    {id:288,name:"Voidweave grimoire",skill:"crafting",group:"Grimoires",levelReq:75,baseTicks:7,xp:560,inputs:[{qty:3,itemId:303},{qty:2,itemId:246}],output:{itemId:337,qty:1}},
    {id:300,name:"Wightweave grimoire",skill:"crafting",group:"Grimoires",levelReq:90,baseTicks:8,xp:1200,inputs:[{qty:3,itemId:303},{qty:2,itemId:250}],output:{itemId:349,qty:1}},
    {id:279,name:"Scale gloves",skill:"crafting",group:"Gloves",levelReq:85,baseTicks:7,xp:575,inputs:[{qty:2,itemId:247},{qty:1,itemId:206}],output:{itemId:327,qty:1}},
  ],
  sites: [
    {id:1,x:187,y:78,kind:"rock",jobIds:[1]},
    {id:2,x:194,y:91,kind:"rock",jobIds:[2]},
    {id:3,x:200,y:60,kind:"rock",jobIds:[1]},
    {id:4,x:196,y:62,kind:"rock",jobIds:[1]},
    {id:5,x:200,y:56,kind:"rock",jobIds:[2]},
    {id:6,x:192,y:63,kind:"rock",jobIds:[2]},
    {id:7,x:196,y:57,kind:"rock",jobIds:[3]},
    {id:8,x:200,y:52,kind:"rock",jobIds:[3]},
    {id:9,x:204,y:55,kind:"rock",jobIds:[3]},
    {id:10,x:200,y:45,kind:"rock",jobIds:[4]},
    {id:11,x:196,y:49,kind:"rock",jobIds:[4]},
    {id:12,x:204,y:49,kind:"rock",jobIds:[4]},
    {id:13,x:198,y:37,kind:"rock",jobIds:[5]},
    {id:14,x:202,y:40,kind:"rock",jobIds:[5]},
    {id:15,x:197,y:41,kind:"rock",jobIds:[5]},
    {id:16,x:194,y:37,kind:"rock",jobIds:[6]},
    {id:17,x:190,y:41,kind:"rock",jobIds:[6]},
    {id:18,x:186,y:45,kind:"rock",jobIds:[6]},
    {id:19,x:190,y:33,kind:"rock",jobIds:[7]},
    {id:20,x:186,y:37,kind:"rock",jobIds:[7]},
    {id:21,x:182,y:41,kind:"rock",jobIds:[7]},
    {id:22,x:181,y:35,kind:"rock",jobIds:[8]},
    {id:23,x:177,y:39,kind:"rock",jobIds:[8]},
    {id:24,x:185,y:33,kind:"rock",jobIds:[8]},
    {id:25,x:214,y:83,kind:"fishing",jobIds:[21]},
    {id:26,x:216,y:79,kind:"fishing",jobIds:[21]},
    {id:27,x:214,y:89,kind:"fishing",jobIds:[22]},
    {id:28,x:208,y:65,kind:"fishing",jobIds:[22]},
    {id:29,x:218,y:75,kind:"fishing",jobIds:[23]},
    {id:30,x:205,y:60,kind:"fishing",jobIds:[23]},
    {id:31,x:212,y:67,kind:"fishing",jobIds:[24]},
    {id:32,x:217,y:93,kind:"fishing",jobIds:[24]},
    {id:33,x:216,y:69,kind:"fishing",jobIds:[25]},
    {id:34,x:230,y:82,kind:"fishing",jobIds:[25]},
    {id:35,x:220,y:71,kind:"fishing",jobIds:[26]},
    {id:36,x:205,y:54,kind:"fishing",jobIds:[26]},
    {id:37,x:168,y:80,kind:"fishing",jobIds:[27]},
    {id:38,x:171,y:87,kind:"fishing",jobIds:[27]},
    {id:39,x:221,y:95,kind:"fishing",jobIds:[28]},
    {id:40,x:173,y:91,kind:"fishing",jobIds:[28]},
    {id:41,x:204,y:77,kind:"fountain",jobIds:[]},
    {id:42,x:197,y:85,kind:"furnace",jobIds:[41,42,43,44,45]},
    {id:43,x:204,y:86,kind:"anvil",jobIds:[
  51,
  52,
  53,
  54,
  55,
  56,
  57,
  58,
  59,
  60,
  308,
  309,
  310,
  311,
  312,
  313,
  314,
  315,
  316,
  317,
  318,
  319,
  320,
  321,
  322,
  323,
  324,
  325,
  326,
  327,
  328,
  329,
  330,
  331,
  332,
  333,
  334,
  335,
  336,
  337,
  46,
  47,
  48,
  49,
  50,
  110,
  111,
  112,
  113,
  114,
  338,
  339,
  340,
  341,
  342,
  343,
  115,
  116,
  117,
  118,
  119,
  120,
  121,
  122,
  123,
  124,
  125,
  126,
  127,
  128,
  129,
  130,
  131,
  132,
  133,
  134,
  301,
  302,
  303,
  304,
  305,
  140,
  141,
  142,
  143,
  144,
  145,
  146,
  147,
  148,
  149,
  150,
  151,
  200,
  201,
  202,
  203,
  204,
  205,
  230,
  231,
  232,
  233,
  307,
  234,
  235,
  236,
  306,
  260,
  261,
  262,
  263,
  264,
  265,
  266,
  267,
  268,
  269,
  270,
  271,
  272,
  273,
  274,
  289,
  290,
  291,
  292,
  293,
  294,
  248,
  249,
  250,
  251,
  252,
  253,
  254,
  255,
  256,
  257,
  258,
  259,
  295,
  296,
  297,
  275,
  276,
  277,
  278,
  280,
  281,
  282,
  283,
  284,
  298,
  299,
  285,
  286,
  287,
  288,
  300,
  279
]},
    {id:44,x:202,y:83,kind:"fire",jobIds:[61,62,63,64,65,66,67,68,220,225,226,227,221,222,223,224]},
    {id:45,x:110,y:181,kind:"fountain",jobIds:[]},
    {id:46,x:113,y:177,kind:"furnace",jobIds:[41,42,43,44,45]},
    {id:47,x:113,y:180,kind:"anvil",jobIds:[
  51,
  52,
  53,
  54,
  55,
  56,
  57,
  58,
  59,
  60,
  308,
  309,
  310,
  311,
  312,
  313,
  314,
  315,
  316,
  317,
  318,
  319,
  320,
  321,
  322,
  323,
  324,
  325,
  326,
  327,
  328,
  329,
  330,
  331,
  332,
  333,
  334,
  335,
  336,
  337,
  46,
  47,
  48,
  49,
  50,
  110,
  111,
  112,
  113,
  114,
  338,
  339,
  340,
  341,
  342,
  343,
  115,
  116,
  117,
  118,
  119,
  120,
  121,
  122,
  123,
  124,
  125,
  126,
  127,
  128,
  129,
  130,
  131,
  132,
  133,
  134,
  301,
  302,
  303,
  304,
  305,
  140,
  141,
  142,
  143,
  144,
  145,
  146,
  147,
  148,
  149,
  150,
  151,
  200,
  201,
  202,
  203,
  204,
  205,
  230,
  231,
  232,
  233,
  307,
  234,
  235,
  236,
  306,
  260,
  261,
  262,
  263,
  264,
  265,
  266,
  267,
  268,
  269,
  270,
  271,
  272,
  273,
  274,
  289,
  290,
  291,
  292,
  293,
  294,
  248,
  249,
  250,
  251,
  252,
  253,
  254,
  255,
  256,
  257,
  258,
  259,
  295,
  296,
  297,
  275,
  276,
  277,
  278,
  280,
  281,
  282,
  283,
  284,
  298,
  299,
  285,
  286,
  287,
  288,
  300,
  279
]},
    {id:48,x:110,y:179,kind:"fire",jobIds:[61,62,63,64,65,66,67,68,220,225,226,227,221,222,223,224]},
    {id:49,x:205,y:126,kind:"fountain",jobIds:[]},
    {id:50,x:222,y:144,kind:"fountain",jobIds:[]},
    {id:51,x:241,y:77,kind:"fountain",jobIds:[]},
    {id:52,x:130,y:181,kind:"fountain",jobIds:[]},
    {id:53,x:220,y:169,kind:"fountain",jobIds:[]},
    {id:54,x:93,y:41,kind:"fountain",jobIds:[]},
    {id:55,x:86,y:7,kind:"fountain",jobIds:[]},
    {id:56,x:172,y:39,kind:"tree",jobIds:[30]},
    {id:57,x:167,y:43,kind:"tree",jobIds:[30]},
    {id:58,x:174,y:34,kind:"tree",jobIds:[30]},
    {id:59,x:174,y:29,kind:"tree",jobIds:[31]},
    {id:60,x:169,y:34,kind:"tree",jobIds:[31]},
    {id:61,x:162,y:41,kind:"tree",jobIds:[31]},
    {id:62,x:171,y:23,kind:"tree",jobIds:[32]},
    {id:63,x:166,y:28,kind:"tree",jobIds:[32]},
    {id:64,x:161,y:33,kind:"tree",jobIds:[32]},
    {id:65,x:168,y:18,kind:"tree",jobIds:[33]},
    {id:66,x:163,y:23,kind:"tree",jobIds:[33]},
    {id:67,x:158,y:28,kind:"tree",jobIds:[33]},
    {id:68,x:161,y:16,kind:"tree",jobIds:[34]},
    {id:69,x:156,y:21,kind:"tree",jobIds:[34]},
    {id:70,x:151,y:26,kind:"tree",jobIds:[34]},
    {id:71,x:151,y:18,kind:"tree",jobIds:[35]},
    {id:72,x:146,y:25,kind:"tree",jobIds:[35]},
    {id:73,x:156,y:16,kind:"tree",jobIds:[35]},
    {id:74,x:207,y:93,kind:"field",jobIds:[160,161,162,163,164,165,210,211,212]},
    {id:75,x:209,y:93,kind:"field",jobIds:[160,161,162,163,164,165,210,211,212]},
    {id:76,x:211,y:93,kind:"field",jobIds:[160,161,162,163,164,165,210,211,212]},
    {id:77,x:207,y:97,kind:"field",jobIds:[160,161,162,163,164,165,210,211,212]},
    {id:78,x:209,y:97,kind:"field",jobIds:[160,161,162,163,164,165,210,211,212]},
    {id:79,x:211,y:97,kind:"field",jobIds:[160,161,162,163,164,165,210,211,212]},
    {id:80,x:196,y:77,kind:"stall",jobIds:[240]},
    {id:81,x:198,y:77,kind:"stall",jobIds:[241]},
    {id:82,x:200,y:77,kind:"stall",jobIds:[242]},
    {id:83,x:202,y:77,kind:"stall",jobIds:[243]},
    {id:84,x:115,y:179,kind:"stall",jobIds:[240]},
    {id:85,x:115,y:181,kind:"stall",jobIds:[241]},
    {id:86,x:112,y:182,kind:"stall",jobIds:[242]},
    {id:87,x:116,y:171,kind:"stall",jobIds:[243]},
    {id:88,x:198,y:79,kind:"scenery",jobIds:[]},
    {id:89,x:199,y:79,kind:"scenery",jobIds:[]},
    {id:90,x:200,y:79,kind:"scenery",jobIds:[]},
    {id:91,x:201,y:79,kind:"scenery",jobIds:[]},
    {id:92,x:202,y:79,kind:"scenery",jobIds:[]},
    {id:93,x:198,y:80,kind:"scenery",jobIds:[]},
    {id:94,x:199,y:80,kind:"scenery",jobIds:[]},
    {id:95,x:200,y:80,kind:"scenery",jobIds:[]},
    {id:96,x:201,y:80,kind:"scenery",jobIds:[]},
    {id:97,x:202,y:80,kind:"scenery",jobIds:[]},
    {id:98,x:198,y:81,kind:"scenery",jobIds:[]},
    {id:99,x:199,y:81,kind:"scenery",jobIds:[]},
    {id:100,x:200,y:81,kind:"scenery",jobIds:[]},
    {id:101,x:201,y:81,kind:"scenery",jobIds:[]},
    {id:102,x:202,y:81,kind:"scenery",jobIds:[]},
    {id:103,x:196,y:79,kind:"scenery",jobIds:[]},
    {id:104,x:204,y:79,kind:"scenery",jobIds:[]},
    {id:105,x:194,y:79,kind:"scenery",jobIds:[]},
    {id:106,x:206,y:79,kind:"scenery",jobIds:[]},
    {id:107,x:195,y:86,kind:"scenery",jobIds:[]},
    {id:108,x:203,y:88,kind:"scenery",jobIds:[]},
    {id:109,x:197,y:83,kind:"scenery",jobIds:[]},
    {id:110,x:204,y:82,kind:"scenery",jobIds:[]},
    {id:111,x:200,y:84,kind:"scenery",jobIds:[]},
    {id:112,x:196,y:81,kind:"scenery",jobIds:[]},
    {id:113,x:194,y:81,kind:"scenery",jobIds:[]},
    {id:114,x:206,y:81,kind:"scenery",jobIds:[]},
    {id:115,x:197,y:87,kind:"scenery",jobIds:[]},
    {id:116,x:193,y:72,kind:"scenery",jobIds:[]},
    {id:117,x:192,y:71,kind:"scenery",jobIds:[]},
    {id:118,x:193,y:71,kind:"scenery",jobIds:[]},
    {id:119,x:194,y:71,kind:"scenery",jobIds:[]},
    {id:120,x:192,y:72,kind:"scenery",jobIds:[]},
    {id:121,x:194,y:72,kind:"scenery",jobIds:[]},
    {id:122,x:198,y:72,kind:"scenery",jobIds:[]},
    {id:123,x:198,y:71,kind:"scenery",jobIds:[]},
    {id:124,x:199,y:71,kind:"scenery",jobIds:[]},
    {id:125,x:199,y:72,kind:"scenery",jobIds:[]},
    {id:126,x:203,y:72,kind:"scenery",jobIds:[]},
    {id:127,x:202,y:71,kind:"scenery",jobIds:[]},
    {id:128,x:203,y:71,kind:"scenery",jobIds:[]},
    {id:129,x:204,y:71,kind:"scenery",jobIds:[]},
    {id:130,x:205,y:71,kind:"scenery",jobIds:[]},
    {id:131,x:202,y:72,kind:"scenery",jobIds:[]},
    {id:132,x:204,y:72,kind:"scenery",jobIds:[]},
    {id:133,x:205,y:72,kind:"scenery",jobIds:[]},
    {id:134,x:208,y:72,kind:"scenery",jobIds:[]},
    {id:135,x:208,y:71,kind:"scenery",jobIds:[]},
    {id:136,x:209,y:71,kind:"scenery",jobIds:[]},
    {id:137,x:209,y:72,kind:"scenery",jobIds:[]},
    {id:138,x:192,y:77,kind:"scenery",jobIds:[]},
    {id:139,x:192,y:75,kind:"scenery",jobIds:[]},
    {id:140,x:193,y:75,kind:"scenery",jobIds:[]},
    {id:141,x:192,y:76,kind:"scenery",jobIds:[]},
    {id:142,x:193,y:76,kind:"scenery",jobIds:[]},
    {id:143,x:193,y:77,kind:"scenery",jobIds:[]},
    {id:144,x:190,y:86,kind:"scenery",jobIds:[]},
    {id:145,x:189,y:85,kind:"scenery",jobIds:[]},
    {id:146,x:190,y:85,kind:"scenery",jobIds:[]},
    {id:147,x:191,y:85,kind:"scenery",jobIds:[]},
    {id:148,x:189,y:86,kind:"scenery",jobIds:[]},
    {id:149,x:191,y:86,kind:"scenery",jobIds:[]},
    {id:150,x:209,y:87,kind:"scenery",jobIds:[]},
    {id:151,x:208,y:86,kind:"scenery",jobIds:[]},
    {id:152,x:209,y:86,kind:"scenery",jobIds:[]},
    {id:153,x:210,y:86,kind:"scenery",jobIds:[]},
    {id:154,x:208,y:87,kind:"scenery",jobIds:[]},
    {id:155,x:210,y:87,kind:"scenery",jobIds:[]},
    {id:156,x:185,y:95,kind:"scenery",jobIds:[]},
    {id:157,x:184,y:93,kind:"scenery",jobIds:[]},
    {id:158,x:185,y:93,kind:"scenery",jobIds:[]},
    {id:159,x:186,y:93,kind:"scenery",jobIds:[]},
    {id:160,x:184,y:94,kind:"scenery",jobIds:[]},
    {id:161,x:185,y:94,kind:"scenery",jobIds:[]},
    {id:162,x:186,y:94,kind:"scenery",jobIds:[]},
    {id:163,x:184,y:95,kind:"scenery",jobIds:[]},
    {id:164,x:186,y:95,kind:"scenery",jobIds:[]},
    {id:165,x:192,y:95,kind:"scenery",jobIds:[]},
    {id:166,x:192,y:93,kind:"scenery",jobIds:[]},
    {id:167,x:193,y:93,kind:"scenery",jobIds:[]},
    {id:168,x:192,y:94,kind:"scenery",jobIds:[]},
    {id:169,x:193,y:94,kind:"scenery",jobIds:[]},
    {id:170,x:193,y:95,kind:"scenery",jobIds:[]},
    {id:171,x:185,y:102,kind:"scenery",jobIds:[]},
    {id:172,x:184,y:100,kind:"scenery",jobIds:[]},
    {id:173,x:185,y:100,kind:"scenery",jobIds:[]},
    {id:174,x:186,y:100,kind:"scenery",jobIds:[]},
    {id:175,x:184,y:101,kind:"scenery",jobIds:[]},
    {id:176,x:185,y:101,kind:"scenery",jobIds:[]},
    {id:177,x:186,y:101,kind:"scenery",jobIds:[]},
    {id:178,x:184,y:102,kind:"scenery",jobIds:[]},
    {id:179,x:186,y:102,kind:"scenery",jobIds:[]},
    {id:180,x:192,y:102,kind:"scenery",jobIds:[]},
    {id:181,x:192,y:101,kind:"scenery",jobIds:[]},
    {id:182,x:193,y:101,kind:"scenery",jobIds:[]},
    {id:183,x:193,y:102,kind:"scenery",jobIds:[]},
    {id:184,x:188,y:98,kind:"scenery",jobIds:[]},
    {id:185,x:190,y:98,kind:"scenery",jobIds:[]},
    {id:186,x:181,y:98,kind:"scenery",jobIds:[]},
    {id:187,x:212,y:81,kind:"scenery",jobIds:[]},
    {id:188,x:212,y:80,kind:"scenery",jobIds:[]},
    {id:189,x:213,y:80,kind:"scenery",jobIds:[]},
    {id:190,x:213,y:81,kind:"scenery",jobIds:[]},
    {id:191,x:209,y:69,kind:"scenery",jobIds:[]},
    {id:192,x:209,y:68,kind:"scenery",jobIds:[]},
    {id:193,x:210,y:68,kind:"scenery",jobIds:[]},
    {id:194,x:210,y:69,kind:"scenery",jobIds:[]},
    {id:195,x:214,y:96,kind:"scenery",jobIds:[]},
    {id:196,x:214,y:95,kind:"scenery",jobIds:[]},
    {id:197,x:215,y:95,kind:"scenery",jobIds:[]},
    {id:198,x:215,y:96,kind:"scenery",jobIds:[]},
    {id:199,x:174,y:89,kind:"scenery",jobIds:[]},
    {id:200,x:174,y:88,kind:"scenery",jobIds:[]},
    {id:201,x:175,y:88,kind:"scenery",jobIds:[]},
    {id:202,x:175,y:89,kind:"scenery",jobIds:[]},
    {id:203,x:208,y:49,kind:"scenery",jobIds:[]},
    {id:204,x:208,y:48,kind:"scenery",jobIds:[]},
    {id:205,x:209,y:48,kind:"scenery",jobIds:[]},
    {id:206,x:209,y:49,kind:"scenery",jobIds:[]},
    {id:207,x:232,y:80,kind:"scenery",jobIds:[]},
    {id:208,x:232,y:79,kind:"scenery",jobIds:[]},
    {id:209,x:233,y:79,kind:"scenery",jobIds:[]},
    {id:210,x:233,y:80,kind:"scenery",jobIds:[]},
    {id:211,x:170,y:45,kind:"scenery",jobIds:[]},
    {id:212,x:169,y:44,kind:"scenery",jobIds:[]},
    {id:213,x:170,y:44,kind:"scenery",jobIds:[]},
    {id:214,x:171,y:44,kind:"scenery",jobIds:[]},
    {id:215,x:169,y:45,kind:"scenery",jobIds:[]},
    {id:216,x:171,y:45,kind:"scenery",jobIds:[]},
    {id:217,x:177,y:25,kind:"scenery",jobIds:[]},
    {id:218,x:176,y:24,kind:"scenery",jobIds:[]},
    {id:219,x:177,y:24,kind:"scenery",jobIds:[]},
    {id:220,x:178,y:24,kind:"scenery",jobIds:[]},
    {id:221,x:176,y:25,kind:"scenery",jobIds:[]},
    {id:222,x:178,y:25,kind:"scenery",jobIds:[]},
    {id:223,x:202,y:62,kind:"scenery",jobIds:[]},
    {id:224,x:202,y:61,kind:"scenery",jobIds:[]},
    {id:225,x:203,y:61,kind:"scenery",jobIds:[]},
    {id:226,x:203,y:62,kind:"scenery",jobIds:[]},
    {id:227,x:192,y:80,kind:"scenery",jobIds:[]},
    {id:228,x:190,y:83,kind:"scenery",jobIds:[]},
    {id:229,x:208,y:80,kind:"scenery",jobIds:[]},
    {id:230,x:200,y:90,kind:"scenery",jobIds:[]},
    {id:231,x:203,y:90,kind:"scenery",jobIds:[]},
    {id:232,x:210,y:80,kind:"scenery",jobIds:[]},
    {id:233,x:207,y:84,kind:"scenery",jobIds:[]},
    {id:234,x:207,y:89,kind:"scenery",jobIds:[]},
    {id:235,x:179,y:101,kind:"scenery",jobIds:[]},
    {id:236,x:181,y:101,kind:"scenery",jobIds:[]},
    {id:237,x:181,y:106,kind:"scenery",jobIds:[]},
    {id:238,x:222,y:102,kind:"scenery",jobIds:[]},
    {id:239,x:224,y:104,kind:"scenery",jobIds:[]},
    {id:240,x:222,y:106,kind:"scenery",jobIds:[]},
    {id:241,x:219,y:103,kind:"scenery",jobIds:[]},
    {id:242,x:224,y:102,kind:"scenery",jobIds:[]},
    {id:243,x:219,y:105,kind:"scenery",jobIds:[]},
    {id:244,x:198,y:54,kind:"scenery",jobIds:[]},
    {id:245,x:175,y:37,kind:"scenery",jobIds:[]},
    {id:246,x:209,y:95,kind:"scenery",jobIds:[]},
    {id:247,x:215,y:100,kind:"scenery",jobIds:[]},
    {id:248,x:207,y:95,kind:"scenery",jobIds:[]},
    {id:249,x:211,y:95,kind:"scenery",jobIds:[]},
    {id:250,x:205,y:99,kind:"scenery",jobIds:[]},
    {id:251,x:213,y:99,kind:"scenery",jobIds:[]},
    {id:252,x:209,y:84,kind:"scenery",jobIds:[]},
    {id:253,x:215,y:77,kind:"scenery",jobIds:[]},
    {id:254,x:212,y:69,kind:"scenery",jobIds:[]},
    {id:255,x:206,y:69,kind:"scenery",jobIds:[]},
    {id:256,x:214,y:67,kind:"scenery",jobIds:[]},
    {id:257,x:217,y:96,kind:"scenery",jobIds:[]},
    {id:258,x:210,y:99,kind:"scenery",jobIds:[]},
    {id:259,x:177,y:88,kind:"scenery",jobIds:[]},
    {id:260,x:176,y:93,kind:"scenery",jobIds:[]},
    {id:261,x:178,y:95,kind:"scenery",jobIds:[]},
    {id:262,x:211,y:48,kind:"scenery",jobIds:[]},
    {id:263,x:211,y:50,kind:"scenery",jobIds:[]},
    {id:264,x:213,y:50,kind:"scenery",jobIds:[]},
    {id:265,x:235,y:79,kind:"scenery",jobIds:[]},
    {id:266,x:232,y:82,kind:"scenery",jobIds:[]},
    {id:267,x:233,y:77,kind:"scenery",jobIds:[]},
    {id:268,x:235,y:85,kind:"scenery",jobIds:[]},
    {id:269,x:173,y:43,kind:"scenery",jobIds:[]},
    {id:270,x:167,y:45,kind:"scenery",jobIds:[]},
    {id:271,x:171,y:47,kind:"scenery",jobIds:[]},
    {id:272,x:180,y:25,kind:"scenery",jobIds:[]},
    {id:273,x:177,y:27,kind:"scenery",jobIds:[]},
    {id:274,x:179,y:27,kind:"scenery",jobIds:[]},
    {id:275,x:205,y:62,kind:"scenery",jobIds:[]},
    {id:276,x:204,y:84,kind:"scenery",jobIds:[]},
    {id:277,x:202,y:85,kind:"scenery",jobIds:[]},
    {id:278,x:189,y:90,kind:"scenery",jobIds:[]},
    {id:279,x:188,y:88,kind:"scenery",jobIds:[]},
    {id:280,x:189,y:88,kind:"scenery",jobIds:[]},
    {id:281,x:190,y:88,kind:"scenery",jobIds:[]},
    {id:282,x:191,y:88,kind:"scenery",jobIds:[]},
    {id:283,x:188,y:89,kind:"scenery",jobIds:[]},
    {id:284,x:189,y:89,kind:"scenery",jobIds:[]},
    {id:285,x:190,y:89,kind:"scenery",jobIds:[]},
    {id:286,x:191,y:89,kind:"scenery",jobIds:[]},
    {id:287,x:188,y:90,kind:"scenery",jobIds:[]},
    {id:288,x:190,y:90,kind:"scenery",jobIds:[]},
    {id:289,x:191,y:90,kind:"scenery",jobIds:[]},
    {id:290,x:193,y:89,kind:"scenery",jobIds:[]},
    {id:291,x:186,y:91,kind:"scenery",jobIds:[]},
    {id:292,x:190,y:92,kind:"scenery",jobIds:[]},
    {id:293,x:178,y:99,kind:"scenery",jobIds:[]},
    {id:294,x:178,y:98,kind:"scenery",jobIds:[]},
    {id:295,x:179,y:98,kind:"scenery",jobIds:[]},
    {id:296,x:179,y:99,kind:"scenery",jobIds:[]},
    {id:297,x:212,y:89,kind:"scenery",jobIds:[]},
    {id:298,x:213,y:92,kind:"scenery",jobIds:[]},
    {id:299,x:211,y:91,kind:"scenery",jobIds:[]},
    {id:300,x:183,y:104,kind:"scenery",jobIds:[]},
    {id:301,x:186,y:106,kind:"scenery",jobIds:[]},
    {id:302,x:189,y:105,kind:"scenery",jobIds:[]},
    {id:303,x:207,y:78,kind:"scenery",jobIds:[]},
    {id:304,x:207,y:76,kind:"scenery",jobIds:[]},
    {id:305,x:208,y:76,kind:"scenery",jobIds:[]},
    {id:306,x:207,y:77,kind:"scenery",jobIds:[]},
    {id:307,x:208,y:77,kind:"scenery",jobIds:[]},
    {id:308,x:208,y:78,kind:"scenery",jobIds:[]},
    {id:309,x:203,y:94,kind:"scenery",jobIds:[]},
    {id:310,x:203,y:92,kind:"scenery",jobIds:[]},
    {id:311,x:204,y:92,kind:"scenery",jobIds:[]},
    {id:312,x:203,y:93,kind:"scenery",jobIds:[]},
    {id:313,x:204,y:93,kind:"scenery",jobIds:[]},
    {id:314,x:204,y:94,kind:"scenery",jobIds:[]},
    {id:315,x:189,y:72,kind:"scenery",jobIds:[]},
    {id:316,x:181,y:80,kind:"scenery",jobIds:[]},
    {id:317,x:183,y:79,kind:"scenery",jobIds:[]},
    {id:318,x:180,y:83,kind:"scenery",jobIds:[]},
    {id:319,x:173,y:70,kind:"scenery",jobIds:[]},
    {id:320,x:159,y:62,kind:"scenery",jobIds:[]},
    {id:321,x:162,y:45,kind:"scenery",jobIds:[]},
    {id:322,x:200,y:101,kind:"scenery",jobIds:[]},
    {id:323,x:200,y:121,kind:"scenery",jobIds:[]},
    {id:324,x:203,y:120,kind:"scenery",jobIds:[]},
    {id:325,x:200,y:123,kind:"scenery",jobIds:[]},
    {id:326,x:189,y:130,kind:"scenery",jobIds:[]},
    {id:327,x:169,y:130,kind:"scenery",jobIds:[]},
    {id:328,x:149,y:130,kind:"scenery",jobIds:[]},
    {id:329,x:129,y:130,kind:"scenery",jobIds:[]},
    {id:330,x:114,y:135,kind:"scenery",jobIds:[]},
    {id:331,x:117,y:134,kind:"scenery",jobIds:[]},
    {id:332,x:114,y:137,kind:"scenery",jobIds:[]},
    {id:333,x:114,y:155,kind:"scenery",jobIds:[]},
    {id:334,x:115,y:177,kind:"scenery",jobIds:[]},
    {id:335,x:200,y:103,kind:"scenery",jobIds:[]},
    {id:336,x:203,y:122,kind:"scenery",jobIds:[]},
    {id:337,x:210,y:89,kind:"scenery",jobIds:[]},
    {id:338,x:209,y:91,kind:"scenery",jobIds:[]},
    {id:339,x:218,y:101,kind:"scenery",jobIds:[]},
    {id:340,x:221,y:123,kind:"scenery",jobIds:[]},
    {id:341,x:213,y:136,kind:"scenery",jobIds:[]},
    {id:342,x:223,y:100,kind:"scenery",jobIds:[]},
    {id:343,x:222,y:98,kind:"scenery",jobIds:[]},
    {id:344,x:226,y:102,kind:"scenery",jobIds:[]},
    {id:345,x:241,y:100,kind:"scenery",jobIds:[]},
    {id:346,x:247,y:86,kind:"scenery",jobIds:[]},
    {id:347,x:158,y:47,kind:"scenery",jobIds:[]},
    {id:348,x:180,y:108,kind:"scenery",jobIds:[]},
    {id:349,x:183,y:107,kind:"scenery",jobIds:[]},
    {id:350,x:182,y:109,kind:"scenery",jobIds:[]},
    {id:351,x:183,y:98,kind:"scenery",jobIds:[]},
    {id:352,x:150,y:70,kind:"scenery",jobIds:[]},
    {id:353,x:230,y:120,kind:"scenery",jobIds:[]},
    {id:354,x:120,y:120,kind:"scenery",jobIds:[]},
    {id:355,x:170,y:150,kind:"scenery",jobIds:[]},
    {id:356,x:137,y:104,kind:"scenery",jobIds:[]},
    {id:357,x:135,y:140,kind:"scenery",jobIds:[]},
    {id:358,x:239,y:99,kind:"scenery",jobIds:[]},
    {id:359,x:199,y:86,kind:"stall",jobIds:[244]},
    {id:360,x:195,y:83,kind:"stall",jobIds:[245]},
    {id:361,x:201,y:87,kind:"stall",jobIds:[246]},
    {id:362,x:195,y:88,kind:"stall",jobIds:[247]},
    {id:363,x:104,y:180,kind:"stall",jobIds:[244]},
    {id:364,x:114,y:170,kind:"stall",jobIds:[245]},
    {id:365,x:117,y:173,kind:"stall",jobIds:[246]},
    {id:366,x:117,y:181,kind:"stall",jobIds:[247]},
    {id:367,x:167,y:218,kind:"fountain",jobIds:[]},
    {id:368,x:112,y:54,kind:"fountain",jobIds:[]},
    {id:369,x:4,y:137,kind:"fountain",jobIds:[]},
    {id:370,x:23,y:92,kind:"fountain",jobIds:[]},
    {id:371,x:65,y:35,kind:"fountain",jobIds:[]},
    {id:372,x:44,y:27,kind:"fountain",jobIds:[]},
    {id:373,x:243,y:116,kind:"fountain",jobIds:[]},
    {id:374,x:146,y:190,kind:"fountain",jobIds:[]},
    {id:375,x:53,y:157,kind:"fountain",jobIds:[]},
    {id:376,x:165,y:178,kind:"fountain",jobIds:[]},
    {id:377,x:69,y:196,kind:"fountain",jobIds:[]},
    {id:378,x:79,y:107,kind:"fountain",jobIds:[]},
    {id:379,x:208,y:17,kind:"fountain",jobIds:[]},
    {id:380,x:272,y:15,kind:"scenery",jobIds:[]},
    {id:381,x:272,y:17,kind:"scenery",jobIds:[]},
    {id:382,x:211,y:76,kind:"scenery",jobIds:[]},
    {id:383,x:113,y:178,kind:"scenery",jobIds:[]},
  ],
  monsters: [
    {id:1,name:"Gnawer",level:2,hp:8,xp:8,gold:[1,2],drop:240},
    {id:2,name:"Bogling",level:8,hp:18,xp:22,gold:[2,4],drop:241},
    {id:3,name:"Husk",level:20,hp:40,xp:60,gold:[17,32],drop:242},
    {id:4,name:"Cairn wight",level:40,hp:75,xp:165,gold:[117,217],drop:243},
    {id:5,name:"Rimewolf",level:60,hp:120,xp:380,gold:[369,685],drop:245},
    {id:6,name:"Emberkin",level:80,hp:180,xp:780,gold:[837,1554],drop:247},
    {id:7,name:"Deep horror",level:95,hp:260,xp:1500,gold:[1365,2535],drop:249},
    {id:8,name:"Sand wraith",level:50,hp:95,xp:250,gold:[220,409],drop:244},
    {id:9,name:"Dune stalker",level:70,hp:150,xp:550,gold:[572,1063],drop:246},
    {id:10,name:"Frost troll",level:85,hp:210,xp:1000,gold:[994,1847],drop:248},
    {id:11,name:"Ice wight",level:105,hp:300,xp:2000,gold:[1815,3371],drop:250},
    {id:12,name:"Ash drake",level:120,hp:360,xp:2800,gold:[2655,4932],drop:251},
    {id:13,name:"Cinder colossus",level:140,hp:440,xp:4000,gold:[4120,7651],drop:252},
    {id:14,name:"Rock mite",level:3,hp:10,xp:11,gold:[1,2],drop:240},
    {id:15,name:"Fen lurker",level:5,hp:13,xp:15,gold:[1,2],drop:240},
    {id:16,name:"Grave beetle",level:12,hp:26,xp:34,gold:[4,9],drop:241},
    {id:17,name:"Sump crawler",level:16,hp:33,xp:46,gold:[9,18],drop:241},
    {id:18,name:"Stone eater",level:22,hp:44,xp:70,gold:[22,41],drop:242},
    {id:19,name:"Barrow hound",level:26,hp:51,xp:91,gold:[35,65],drop:242},
    {id:20,name:"Chalk wight",level:32,hp:61,xp:122,gold:[62,116],drop:242},
  ],
});

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
            if (sock instanceof WebSocket && sock.url && sock.url.includes('deepveinidle.com')) {
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
    let observer = null;
    let rafPending = false;
    let lastRun = 0;
    const MIN_INTERVAL = 120;   // ms，节流：游戏重绘很频繁

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

    /** 节流调度：一帧内只跑一次，且不低于最小间隔 */
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

    function applyAll() {
      if (!document.body) return;
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

      // 只在「注入总数」变化时记一条，避免每帧刷屏
      if (total !== lastLoggedTotal) {
        const first = total > 0 && lastLoggedTotal <= 0;   // 首次成功注入
        lastLoggedTotal = total;
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
            const host = document.querySelector([...anchors.values()][0].selector);
            if (host) {
              const chain = [];
              let el = host, depth = 0;
              while (el && el.tagName && depth < 4) {
                chain.push(el.tagName.toLowerCase() +
                  (el.className ? '.' + String(el.className).trim().split(/\s+/).slice(0, 2).join('.') : ''));
                el = el.parentElement; depth++;
              }
              DIAG.info('结构', `注入落点：<${chain.join(' < ')}> · ` +
                `父容器子元素 ${host.parentElement ? host.parentElement.children.length : '?'} 个 · ` +
                `列表子元素 ${(() => {
                  const list = document.querySelector('[data-routes]');
                  return list ? list.children.length : '无';
                })()} 个`);
            }
          } catch (e) { /* 诊断失败不影响功能 */ }
        }
      }
    }

    /** 观察游戏 DOM 变化，变化后自动重注入 */
    function startObserver() {
      if (observer || typeof MutationObserver !== 'function') return;
      observer = new MutationObserver(() => schedule());
      // 观察 documentElement 而不是 #app —— 游戏换掉 #app 时观察器不能跟着死
      observer.observe(document.documentElement, { childList: true, subtree: true });
      schedule();
      // 保险丝：万一观察器漏了（或 #app 被整体重建），每 2.5 秒兜底重扫一次。
      // 代价很低（只做 querySelectorAll + 已存在就跳过），换来的是「不会静默失效」。
      setInterval(() => schedule(), 2500);
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

    return { ensureCSS, ready, toast, toggle, body, renderSettings,
             makeFab, makeWindow, removeFab, applyMode,
             mode, setMode, MODE_QUIET, MODE_FAB,
             inline, startObserver, tip,
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
          panel: (title) => {           // 在主干窗口里追加一个分区
            const b = ui.body();
            const sec = document.createElement('div');
            sec.className = 'dvi-sec';
            sec.textContent = title;
            b.appendChild(sec);
            const box = document.createElement('div');
            b.appendChild(box);
            return box;
          },
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
  /* ═══════════════ 以下为打包进来的插件（在主干内部执行） ═══════════════ */

/* ── 10-example-job-yield.js ── */
/*
 * 这是一个最小可用插件，演示主干契约的全部要点：
 *   声明式设置 / 事件订阅 / 计算引擎调用 / 面板渲染 / 启停钩子
 *
 * 它做的事：在主干面板里显示「当前作业的每小时收益」。
 * 只读——不发送任何游戏指令。
 */

(function () {
  'use strict';

  /* ── 启动痕迹：证明这段代码确实被执行了（写到 DOM 属性和页面全局） ── */
  try {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-dvi-plugin-10', '1');
    }
  } catch (e) {}
  try {
    const r0 = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    (r0.__dviBoot = r0.__dviBoot || []).push('10-example-job-yield');
  } catch (e) {}
  try { console.info('[DVI] 插件 10-example-job-yield 代码已执行'); } catch (e) {}

  /* ── 引导：等主干就绪，失败要留痕（不要静默退出） ── */
  const PLUGIN_ID = 'example-networth-hourly';

  function pageRoot() {
    try { return (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window; }
    catch (e) { return window; }
  }
  function findTrunk() {
    try { return pageRoot().DVI || window.DVI; } catch (e) { return null; }
  }
  function noteFailure(reason) {
    try {
      const r = pageRoot();
      const list = r.__dviPluginErrors || (r.__dviPluginErrors = []);
      list.push({ plugin: PLUGIN_ID, reason: String(reason), at: new Date().toISOString() });
    } catch (e) {}
    try { console.error('[DVI 示例插件] ' + reason); } catch (e) {}
  }
  function whenTrunk(fn) {
    let tries = 0;
    (function attempt() {
      const D = findTrunk();
      if (D) {
        try { fn(D); } catch (e) { noteFailure('注册时抛异常：' + ((e && e.message) || e)); }
        return;
      }
      if (++tries >= 50) { noteFailure('等待 5 秒仍未找到 DVI 主干（插件未注册）'); return; }
      setTimeout(attempt, 100);
    })();
  }

  whenTrunk(function (DVI) {

  DVI.plugin.register({
    id: 'example-networth-hourly',
    name: '当前作业收益',
    nameEn: 'Hourly job yield',
    description: '在主干面板里显示当前作业的每小时净收益与经验',
    api: 1,
    defaultEnabled: true,

    settings: [
      { key: 'tax', label: '市场税率 (%)', type: 'number', default: 2, min: 0, max: 100 },
      { key: 'includeCost', label: '扣除材料成本', type: 'bool', default: true },
    ],

    /* ── 注册时调用一次：适合挂事件监听 ── */
    setup(ctx) {
      this.box = null;

      // 切角色 / 换任务 / 有产出的时机会刷新
      ctx.bus.on(ctx.EVT.SNAPSHOT, () => this.render(ctx));
      ctx.bus.on(ctx.EVT.WORK, () => this.render(ctx));
      ctx.bus.on(ctx.EVT.BATCH, () => this.tick(ctx));

      // 插件自己的设置变了也要重算
      ctx.core.settings.onChange((key) => {
        if (key.startsWith(ctx.id + '.')) this.render(ctx);
      });

      ctx.log('已就绪');
    },

    enable(ctx) {
      this.render(ctx);
    },

    disable(ctx) {
      if (this.box) { this.box.textContent = ''; }
      ctx.ui.toast('已停用：当前作业收益');
    },

    /* 简单节流：产出事件很密集，不需要每次都重算 */
    tick(ctx) {
      const now = Date.now();
      if (now - (this.last || 0) < 1500) return;
      this.last = now;
      this.render(ctx);
    },

    render(ctx) {
      ctx.core.ui.ready(() => {
        const box = ctx.ui.panel('当前作业收益');
        this.box = box;

        const me = ctx.state.me;
        const job = ctx.state.job;
        if (!me || !job || !job.jobId) {
          box.appendChild(ctx.ui.el('div', { class: 'dvi-row' }, '未在作业中'));
          return;
        }

        const action = ctx.core.data.ACTION.get(job.jobId);
        if (!action) {
          box.appendChild(ctx.ui.el('div', { class: 'dvi-row' }, `未知配方 #${job.jobId}`));
          return;
        }

        const cx = ctx.core.calc;
        const level = cx.levelForXp(me.skills?.[action.skill] || 0);

        const res = cx.analyse(action, {
          level,
          quickPerk: me.perks?.quick || 0,
          priceOf: ctx.priceOf,
          taxBp: ctx.settings.get('tax') * 100,
        });
        if (!res) {
          box.appendChild(ctx.ui.el('div', { class: 'dvi-row' }, '无法计算'));
          return;
        }

        const net = ctx.settings.get('includeCost')
          ? res.netPerHour
          : res.grossPerHour * (1 - ctx.settings.get('tax') / 100);

        const row = (label, value) => {
          const r = ctx.ui.el('div', { class: 'dvi-row' });
          r.appendChild(ctx.ui.el('label', {}, label));
          r.appendChild(ctx.ui.el('span', {}, value));
          return r;
        };

        box.appendChild(row('配方', `${action.name}（${action.skill}）`));
        box.appendChild(row('等级', `${level} / 需求 ${action.levelReq}`));
        box.appendChild(row('单次耗时', `${res.ticks.toFixed(2)} 秒`));
        box.appendChild(row('产出', `${res.unitsPerHour.toFixed(0)} / 小时`));
        box.appendChild(row('净收益', `${Math.round(net).toLocaleString()} 金 / 小时`));
        box.appendChild(row('经验', `${Math.round(res.xpPerHour).toLocaleString()} / 小时`));
        box.appendChild(row('单价', `${ctx.priceOf(action.output.itemId).toLocaleString()} 金`));

        const prog = cx.levelProgress(me.skills?.[action.skill] || 0);
        box.appendChild(row('升级进度', `${(prog * 100).toFixed(1)}%`));

        const note = ctx.ui.el('div', { class: 'dvi-note' },
          '价格取自当前行情缓存，无行情时回退到物品基础价值。');
        box.appendChild(note);
      });
    },
  });

  });   // whenTrunk
})();


/* ── 20-job-level-estimate.js ── */
/*
 * 这是「融入游戏」的示范：内容长在游戏自己的作业行里。
 *
 * 锚点 button.route[data-job] 是从客户端代码里读出来的——
 * 游戏的作业行就是 <button class="route" data-job="{配方id}">，
 * 并且它有一套原生 tooltip 约定（data-tip-name / data-tip-lines），
 * 所以注入的提示看起来和游戏自带的没有区别。
 */

(function () {
  'use strict';

  /* ── 启动痕迹 ──
   * 目的只有一个：证明「这段代码到底有没有被执行」。
   * 同时写到 DOM 属性（元素面板里直接可见）和页面全局，双保险，
   * 且都包 try/catch —— 任何情况下都不会因此中断。 */
  try {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-dvi-plugin-20', '1');
    }
  } catch (e) {}
  try {
    const r0 = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    (r0.__dviBoot = r0.__dviBoot || []).push('20-job-level-estimate');
  } catch (e) {}
  try { console.info('[DVI] 插件 20-job-level-estimate 代码已执行'); } catch (e) {}

  /* ── 引导：等主干就绪，并且失败时要留痕 ──
   * 之前这里是一句 `if (!DVI) return;` —— 找不到主干就静默退出。
   * 后果是：功能完全不出现，而用户和开发者都看不到任何原因。
   * 现在改成重试 + 把失败原因写到一个诊断能读到的地方。 */
  const PLUGIN_ID = 'job-level-estimate';

  function pageRoot() {
    try { return (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window; }
    catch (e) { return window; }
  }
  function findTrunk() {
    try { return pageRoot().DVI || window.DVI; } catch (e) { return null; }
  }
  function noteFailure(reason) {
    try {
      const r = pageRoot();
      const list = r.__dviPluginErrors || (r.__dviPluginErrors = []);
      list.push({ plugin: PLUGIN_ID, reason: String(reason), at: new Date().toISOString() });
    } catch (e) { /* 尽力而为 */ }
    try { console.error('[DVI 升级预估] ' + reason); } catch (e) {}
  }

  function whenTrunk(fn) {
    let tries = 0;
    (function attempt() {
      const D = findTrunk();
      if (D) {
        try { fn(D); }
        catch (e) { noteFailure('注册时抛异常：' + ((e && e.message) || e)); }
        return;
      }
      if (++tries >= 50) {          // 约 5 秒
        noteFailure('等待 5 秒仍未找到 DVI 主干（插件未注册）');
        return;
      }
      setTimeout(attempt, 100);
    })();
  }

  whenTrunk(function (DVI) {
  const { calc, data } = DVI;

  DVI.plugin.register({
    id: 'job-level-estimate',
    name: '作业升级预估',
    nameEn: 'Job level estimate',
    description: '在每个作业旁就地显示还需几次行动升级',
    api: 1,
    defaultEnabled: true,

    settings: [
      { key: 'target', label: '目标等级（0 = 下一级）', type: 'number',
        default: 0, min: 0, max: 120 },
      { key: 'showTime', label: '同时显示所需时间', type: 'bool', default: true },
      { key: 'refreshMode', label: '刷新方式（0 = 按需，1 = 自动）', type: 'number',
        default: 0, min: 0, max: 1 },
    ],

    /* ══════════ 为什么是「按需」而不是「即时」 ══════════
     * 计算（actionsToLevel）比重新注入贵得多：
     * 前者要按等级逐级累加经验，后者只是 Map 查表 + 插一个节点。
     * 而游戏每次重绘都会重跑 render，如果每次都重算，
     * 每秒几十次地做无用功，对浏览器和设备都是负担。
     *
     * 所以拆成两件事：
     *   render（便宜、高频）→ 只读缓存
     *   recompute（贵、低频）→ 只在「页面加载 / 用户点刷新 / 自动模式且已隔 ≥30 秒」时跑
     */
    setup(ctx) {
      this.ctx = ctx;
      this.cache = new Map();      // jobId → 渲染好的 HTML
      this.lastCalc = 0;           // 上次重算的时间戳
      this.MIN_GAP = 30 * 1000;    // 自动模式下的最小重算间隔

      // 关键：注入到游戏界面，而不是另开窗口。
      // 候选选择器按可靠度排序，逐个回退 —— 游戏改版时不会一步失效。
      //   [data-routes] 是客户端里作业列表的容器（rowFor 的父级）
      //   button.route[data-job] 是每一行本身
      //   [data-job] 是最宽的回退
      ctx.ui.inline({
        id: 'job-level-estimate',
        selector: ['[data-routes] [data-job]', 'button.route[data-job]', '[data-job]'],
        where: 'beforeend',
        render: (host) => this.renderRow(ctx, host),
      });

      /* 刷新入口**不新增任何 DOM 节点**。
       * 曾经在列表上下各插过一个独立按钮，两次都把游戏面板的排版撑坏 ——
       * 那个容器多半是 flex/grid，多一个兄弟节点就改变整个布局。
       * 改成：直接让**标注自己**可点。标注本来就长在作业行内部，
       * 不引入新节点，也就不会影响任何布局。
       * （游戏会吞掉落在 data-tip-name 上的点击，所以这里必须自己接管。） */
      this.attachClick(ctx);

      // 用户主动要求重算
      ctx.bus.on(ctx.EVT.REFRESH, () => this.recompute(ctx, true));

      // 自动模式：只在状态真的变了、且距上次重算超过 MIN_GAP 时才重算
      ctx.bus.on(ctx.EVT.SNAPSHOT, () => {
        if (this.isAuto(ctx)) this.recompute(ctx, false);
      });
      ctx.core.settings.onChange((k) => {
        if (k.startsWith(ctx.id + '.')) this.recompute(ctx, true);
      });

      // 首次进入：算一次
      this.recompute(ctx, true);
      ctx.log('已注入作业列表');
    },

    /** 自动模式？（设置项 refreshMode = 1） */
    isAuto(ctx) {
      return Number(ctx.settings.get('refreshMode')) === 1;
    },

    /**
     * 重算并刷新。
     * @param {boolean} force 忽略节流立即重算（用户主动触发时为 true）
     */
    recompute(ctx, force) {
      const now = Date.now();
      if (!force && now - this.lastCalc < this.MIN_GAP) return false;
      this.cache.clear();          // 丢掉旧结果，下次 render 会重新算
      this.lastCalc = now;
      ctx.ui.inline.refresh();
      return true;
    },

    /** 安装「点标注 → 重算」的委托监听。幂等：重复调用不会装两遍。 */
    attachClick(ctx) {
      if (this.onDocClick) return;
      this.onDocClick = (e) => {
        const t = e.target;
        const note = t && t.closest && t.closest('.dvi-inline-note');
        if (note) {
          e.preventDefault();
          e.stopPropagation();
          this.recompute(ctx, true);
          ctx.log('点击标注 → 重算');
        }
      };
      document.addEventListener('click', this.onDocClick, true);
    },

    detachClick() {
      if (this.onDocClick) {
        document.removeEventListener('click', this.onDocClick, true);
        this.onDocClick = null;
      }
    },

    enable(ctx) {
      this.attachClick(ctx);      // disable 时摘掉了，启用必须装回来
      ctx.ui.inline.refresh();
      ctx.log('已启用');
    },

    disable(ctx) {
      this.detachClick();
      if (this.cache) this.cache.clear();
      ctx.ui.uninline();
    },

    /* ── 目标等级：0 表示「下一级」 ── */
    resolveTarget(ctx, skill, xp) {
      const cur = calc.levelForXp(xp);
      const want = Number(ctx.settings.get('target')) || 0;
      if (want > 0) return want;
      return cur + 1;
    },

    /* ── 每个作业行渲染一次 ──
     * 高频路径，只读缓存：游戏每次重绘都会走这里，
     * 所以这里**绝不能做重活**。缓存未命中时才算一次（懒计算）。 */
    renderRow(ctx, host) {
      const jobId = Number(host.dataset.job);
      if (!Number.isFinite(jobId)) return null;

      if (this.cache.has(jobId)) return this.cache.get(jobId);

      const html = this.computeRow(ctx, jobId);
      this.cache.set(jobId, html);
      return html;
    },

    /* ── 真正计算一行（贵）── */
    computeRow(ctx, jobId) {
      const action = data.ACTION.get(jobId);
      if (!action) return null;

      const me = ctx.state.me;
      if (!me) return null;                       // 还没登录，什么都不显示

      const skill = action.skill;
      const xp = (me.skills && me.skills[skill]) || 0;
      const level = calc.levelForXp(xp);

      // 未达技能等级要求：这行游戏自己会标灰，我们只在行末给一句提示
      if (level < action.levelReq) {
        return `<span class="dvi-inline-note" data-tone="warn"
          ${ctx.ui.tip('升级预估', [
            `需要 ${data.skillName(skill)} ${action.levelReq} 级`,
            `当前 ${level} 级，还差 ${action.levelReq - level} 级`,
            `这个行动暂时做不了`,
          ])}>差 ${action.levelReq - level} 级</span>`;
      }

      // 不求经验的行动（比如某些采集）直接跳过
      if (!action.xp) return null;

      // 即时取「当前配置」：等级、当前装备的工具、特长、增益、社区活动、精通。
      // 全部从实时状态现算 —— 换装备或增益到期，下一次渲染就变。
      const opts = ctx.state.actionContext(action);

      const target = this.resolveTarget(ctx, skill, xp);
      if (target <= level) {
        return `<span class="dvi-inline-note" data-tone="done"
          ${ctx.ui.tip('升级预估', [`已经是 ${level} 级`])}>已达标</span>`;
      }

      const est = calc.actionsToLevel(action, xp, target, opts);
      if (!est) return null;

      const showTime = ctx.settings.get('showTime');
      const label = showTime
        ? `需 ${est.actions.toLocaleString()} 次 · ${calc.humanDuration(est.seconds)}`
        : `需 ${est.actions.toLocaleString()} 次`;

      // tooltip 必须有节制：游戏的原生提示框没有滚动条，
      // 行数一多就撑破屏幕（曾经堆到 22 行，直接「爆」了）。
      // 所以这里硬性裁剪，只保留最该看的，分段明细最多 4 行且超出就汇总。
      const lines = [
        `${data.skillName(skill)} ${est.fromLevel} → ${est.toLevel} 级`,
        `共 ${est.actions.toLocaleString()} 次 · 每次 ${est.xpPerAction} 经验`,
        `纯作业耗时 ${calc.humanDuration(est.seconds)}`,
      ];

      // 当前配置：只列「非默认」的项，最多 4 条 —— 全是默认值时不占篇幅
      const cfg = ctx.state.configSummary(action)
        .filter(c => c.label === '工具' ? !c.value.includes('未装备') : true)
        .slice(0, 4);
      if (cfg.length) {
        lines.push('— 当前配置 —');
        for (const c of cfg) lines.push(`${c.label}：${c.value}`);
      }

      // 分段明细：只在跨越不多时给，最多 4 段，超出就只说平均
      if (est.perLevel.length > 1 && est.perLevel.length <= 4) {
        lines.push('— 分段 —');
        for (const seg of est.perLevel) {
          lines.push(`${seg.level}→${seg.level + 1}：${seg.actions} 次`);
        }
      } else if (est.perLevel.length > 4) {
        lines.push(`跨 ${est.perLevel.length} 级，平均每级 ${Math.round(est.actions / est.perLevel.length)} 次`);
      }

      lines.push('不含赶路时间');
      lines.push(this.isAuto(ctx)
        ? '自动模式：状态变化后会自动重算'
        : '点一下这条标注即可重算');

      return `<span class="dvi-inline-note" data-tone="${est.actions > 1000 ? 'warn' : ''}"
        ${ctx.ui.tip('升级预估 · ' + action.name, lines)}>${label}</span>`;
    },
  });

  });   // whenTrunk
})();


  /* ═══════════════════════════════════════════════════════════════
   * 10. 启动
   * ═══════════════════════════════════════════════════════════════ */
  net.install();
  ui.ensureCSS();

  ui.ready(() => {
    ui.makeWindow();          // 面板先建好但保持隐藏
    ui.applyMode();           // 按当前模式决定要不要放悬浮按钮（默认不放）
    ui.startObserver();       // 开始观察游戏 DOM，供内联注入使用

    // 启动日志：一次把定位问题需要的环境信息记全
    DIAG.info('启动', `v${VERSION} · ${location.host} · ` +
      `游戏数据 ${DATA.meta ? DATA.meta.version : '?'} · ` +
      `物品${ITEM.size}/配方${ACTION.size}/站点${SITE.size}`);
    DIAG.info('启动', `插件 ${registry.list().length} 个 · 内联锚点 ${ui.inline.size} 个 · ` +
      `沙箱 ${(typeof unsafeWindow !== 'undefined' && unsafeWindow) ? '正常' : '无 unsafeWindow'}`);

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

  GM_registerMenuCommand('打开 DVI Tools 面板', () => ui.toggle(true));
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
      const b = ui.body();
      ui.toggle(true);
      const sec = document.createElement('div');
      sec.className = 'dvi-sec';
      sec.textContent = `环境自检 — ${st.summary}`;
      b.appendChild(sec);
      for (const c of st.checks) {
        const row = document.createElement('div');
        row.className = 'dvi-row' + (c.pass ? '' : ' dvi-err');
        row.textContent = `${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`;
        b.appendChild(row);
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
