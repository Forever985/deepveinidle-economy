/**
 * DVI Tools 主干 —— Node 冒烟测试
 *
 * 直接加载构建产物 dvi-tools.user.js，在最小 DOM/GM 桩里执行，
 * 然后对 window.DVI 的公共 API 做断言。
 * 测的是真正会被安装的那个文件，不是源码副本。
 *
 * 运行：
 *   node test/test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const USERSCRIPT = path.join(ROOT, 'dvi-tools.user.js');
const SIM_GROUND = path.resolve(ROOT, '..', 'dvi_probe', 'sim', 'ground-truth.json');

/* ══════════ 最小 DOM / GM 桩 ══════════ */
/* 只支持简单选择器：tag / .class / [attr] / [attr="v"] 及其组合。
 * 够用即可——目的是验证内联注入的挂载与去重逻辑，不是实现一个浏览器。 */
function parseSimple(sel) {
  sel = String(sel).trim();
  if (!sel || /[\s>+~,]/.test(sel)) return null;
  const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(sel);
  if (!m) return null;
  const attrPart = m[3] || '';
  const attrs = [];
  const re = /\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g;
  let a;
  while ((a = re.exec(attrPart))) {
    attrs.push({ name: a[1], value: a[2] === undefined ? null : a[2] });
  }
  // 关键：属性选择器必须全部解析成功才认。
  // 否则（比如属性名含非 ASCII 字符）会退化成「无约束」= 匹配一切，
  // 从而让测试得出假阳性 —— 真实浏览器里这种选择器是匹配 0 个的。
  const bracketCount = (attrPart.match(/\[/g) || []).length;
  if (attrs.length !== bracketCount) return null;
  return { tag: m[1] || null, classes: (m[2] || '').split('.').filter(Boolean), attrs };
}

function matchesSpec(el, spec) {
  if (spec.tag && el.tagName.toLowerCase() !== spec.tag.toLowerCase()) return false;
  const cls = String(el.className || '').split(/\s+/).filter(Boolean);
  for (const c of spec.classes) if (!cls.includes(c)) return false;
  for (const a of spec.attrs) {
    const v = el.getAttribute(a.name);
    if (v == null) return false;
    if (a.value !== null && v !== a.value) return false;
  }
  return true;
}

function findAll(el, sel, out) {
  const spec = parseSimple(sel);
  if (!spec) return out;
  for (const c of el.children || []) {
    if (matchesSpec(c, spec)) out.push(c);
    findAll(c, sel, out);
  }
  return out;
}

function makeEl(tag) {
  const el = {
    tagName: tag, children: [], style: { cssText: '' }, dataset: {}, _text: '',
    className: '', hidden: false, type: '', value: '', checked: false, title: '',
    _attrs: {}, parentNode: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(k, v) {
      this._attrs[k] = String(v);
      if (k === 'class') this.className = String(v);
      this[k] = v;
    },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : (this[k] ?? null); },
    hasAttribute(k) { return k in this._attrs; },
    insertAdjacentElement(pos, node) {
      this.children.push(node); node.parentNode = this; return node;
    },
    addEventListener() {}, removeEventListener() {},
    click() { this._clicked = true; },
    querySelector(sel) { return findAll(this, sel, [])[0] || null; },
    querySelectorAll(sel) { return findAll(this, sel, []); },
    /* matches / closest：真实 DOM 必备，而主干的「相关性过滤」正是靠它
     * 判断一次 DOM 变动跟我们有没有关系 —— 缺了这两个，那条性能关键路径
     * 在测试里根本走不到。复用已有的 parseSimple/matchesSpec，保持一致。 */
    matches(sel) {
      const spec = parseSimple(sel);
      return spec ? matchesSpec(this, spec) : false;
    },
    closest(sel) {
      let n = this;
      while (n) {
        if (typeof n.matches === 'function' && n.matches(sel)) return n;
        n = n.parentNode;
      }
      return null;
    },
    onclick: null, onchange: null,
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text; },
    /* 真实 DOM 里 textContent = '' 会**移除所有子节点**。
     * 桩以前只改文本变量、不删子节点，导致依赖「清空后重建」的逻辑
     * 在测试里全都验不出来（面板分区幂等那次就是）。 */
    set(v) {
      this._text = String(v);
      if (this._text === '') {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
      }
    },
  });
  Object.defineProperty(el, 'firstElementChild', {
    get() { return this.children[0] || null; },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) {
      this._html = String(v);
      // 把 innerHTML 里的标签解析成子元素桩，让 querySelector 能找到它们
      // <template> 的解析结果进 content（与真实 DOM 一致）
      const into = (this.tagName.toLowerCase() === 'template' && this.content)
        ? this.content : this;
      into.children = [];
      const tagRe = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
      let m;
      while ((m = tagRe.exec(this._html))) {
        const child = makeEl(m[1]);
        const attrRe = /([\w-]+)(?:\s*=\s*"([^"]*)")?/g;
        let a;
        while ((a = attrRe.exec(m[2] || ''))) {
          if (a[2] !== undefined) child.setAttribute(a[1], a[2]);
          else child._attrs[a[1]] = '';
        }
        child.parentNode = into;
        into.children.push(child);
      }
    },
  });
  // <template> 需要一个 content 容器
  if (String(tag).toLowerCase() === 'template') {
    el.content = makeEl('fragment');
  }
  return el;
}

/* 可控的选择器注册表：测试内联框架时往里塞宿主元素 */
const selectorResults = new Map();

const documentStub = {
  body: makeEl('body'),
  head: makeEl('head'),
  hidden: false,                       // 真实 DOM 属性，暂停逻辑靠它判断
  _handlers: {},
  addEventListener(type, fn) {
    (this._handlers[type] || (this._handlers[type] = [])).push(fn);
  },
  removeEventListener(type, fn) {
    this._handlers[type] = (this._handlers[type] || []).filter(f => f !== fn);
  },
  /** 测试用：派发一个事件（只有这样才验得了「切后台要停」） */
  dispatch(type) {
    for (const fn of (this._handlers[type] || [])) fn({ type, target: this });
  },
  createElement: makeEl,
  querySelector(sel) { return (selectorResults.get(sel) || [])[0] || null; },
  querySelectorAll(sel) {
    const hits = selectorResults.get(sel);
    if (hits) return hits;
    return documentStub.body.querySelectorAll(sel);
  },
};

class MessageEventStub {
  constructor(data) { this._data = data; this.currentTarget = null; }
  get data() { return this._data; }
}
class WebSocketStub {
  constructor(url) { this.url = url; this.readyState = 1; }
}

const gmStore = new Map();

/* ══════════ 模拟油猴的沙箱模型：window ≠ unsafeWindow ══════════
 * 带 @grant 的用户脚本跑在沙箱里，window 指向沙箱窗口，
 * unsafeWindow 才指向真正的页面窗口。两者必须是不同对象，
 * 否则测不出「跨脚本能否共享」这个关键点。 */
const pageWindow = {};                 // 页面窗口（unsafeWindow）

/* MutationObserver 桩。
 * 真实环境里它回调跑在「渲染之前的微任务」中 —— 主干正是靠这一点
 * 把注入赶在同一帧完成，从而不闪。所以必须能手动触发回调来验证。 */
const observerInstances = [];
class MutationObserverStub {
  constructor(cb) { this.cb = cb; this.targets = []; observerInstances.push(this); }
  observe(target, opts) { this.targets.push({ target, opts }); }
  disconnect() { this.targets = []; }
  /** 测试用：手动投递一批变动记录 */
  fire(records) { this.cb(records, this); }
}

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Math, JSON, Object, Array, Number, String, Boolean, Map, Set, Date, Error,
  isFinite, parseInt, parseFloat, Promise,
  MessageEvent: MessageEventStub,
  WebSocket: WebSocketStub,
  MutationObserver: MutationObserverStub,
  document: documentStub,
  location: { href: 'https://deepveinidle.com/', host: 'deepveinidle.com', hostname: 'deepveinidle.com', protocol: 'https:' },
  navigator: { userAgent: 'node-test-stub' },
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
  Blob: class { constructor(parts, opt) { this.parts = parts; this.type = opt && opt.type; } },
  GM_addStyle() {},
  GM_getValue(k, d) { return gmStore.has(k) ? gmStore.get(k) : d; },
  GM_setValue(k, v) { gmStore.set(k, v); },
  GM_registerMenuCommand() {},
};
sandbox.window = sandbox;              // 沙箱窗口
sandbox.unsafeWindow = pageWindow;     // 页面窗口
sandbox.globalThis = sandbox;

/* ══════════ 断言 ══════════ */
let pass = 0, fail = 0;
const results = [];

function ok(name, cond, detail) {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}
function near(name, actual, expected, tolPct) {
  const tol = Math.abs(expected) * (tolPct / 100) + 1e-9;
  const good = Math.abs(actual - expected) <= tol;
  ok(name, good,
     `期望 ${expected}，实得 ${typeof actual === 'number' ? actual.toFixed(4) : actual}` +
     `（容差 ${tolPct}%）`);
}
function section(t) { results.push(`\n${t}`); }

/* ══════════ 加载构建产物 ══════════ */
section('① 加载构建产物');
const code = fs.readFileSync(USERSCRIPT, 'utf8');
let DVI = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'dvi-tools.user.js' });
  DVI = sandbox.DVI;
  ok('userScript 执行无异常', true);
} catch (e) {
  ok('userScript 执行无异常', false, e.message);
  console.log(results.join('\n'));
  process.exit(1);
}

ok('window.DVI 已挂载', !!DVI);
if (!DVI) { console.log(results.join('\n')); process.exit(1); }
ok('版本号存在', typeof DVI.VERSION === 'string');
ok('API 版本存在', DVI.API_VERSION === 1);

/* ══════════ 数据层 ══════════ */
section('② 数据层');
const D = DVI.data;
/* 刻意**不断言具体数量** —— 之前写死 290，游戏一更新（物品已涨到 301）就直接失败，
 * 而这种失败跟代码对错无关，纯属噪声。改为断言「规模合理 + 结构完整」，
 * 真出问题时（比如提取脚本漏表）仍然会红。 */
ok(`物品表已加载（${D.DATA.items.length}）`, D.DATA.items.length >= 250, `实得 ${D.DATA.items.length}`);
ok(`配方表已加载（${D.DATA.actions.length}）`, D.DATA.actions.length >= 180, `实得 ${D.DATA.actions.length}`);
ok(`站点表已加载（${D.DATA.sites.length}）`, D.DATA.sites.length >= 300, `实得 ${D.DATA.sites.length}`);
ok(`怪物表已加载（${D.DATA.monsters.length}）`, D.DATA.monsters.length >= 15, `实得 ${D.DATA.monsters.length}`);
ok('物品 id 无重复', new Set(D.DATA.items.map(i => i.id)).size === D.DATA.items.length);
ok('配方 id 无重复', new Set(D.DATA.actions.map(a => a.id)).size === D.DATA.actions.length);
ok('每个配方都有产出', D.DATA.actions.every(a => a.output && a.output.itemId));
ok('每个配方都有原料数组', D.DATA.actions.every(a => Array.isArray(a.inputs)));
ok('按 skill 建了索引', D.BY_SKILL.size >= 10);
ok('物品名解析', D.itemName(1) === 'Copper', `实得 ${D.itemName(1)}`);
ok('配方名解析', D.actionName(42).includes('Iron'), `实得 ${D.actionName(42)}`);
ok('未知 id 有兜底', D.itemName(999999) === '#999999');
const act42 = D.ACTION.get(42);
ok('配方 42 是铁锭', act42 && act42.name === 'Iron bar' && act42.skill === 'smithing');
ok('配方 42 输入是铁矿', act42 && act42.inputs.length === 1 && act42.inputs[0].itemId === 3);

/* ══════════ 经验曲线 ══════════ */
section('③ 经验曲线');
const C = DVI.calc;
ok('1 级累计经验为 0', C.xpForLevel(1) === 0);
ok('2 级累计经验 = 100', C.xpForLevel(2) === 100, `实得 ${C.xpForLevel(2)}`);
// 公式：round(100 × (1.12^(n-1) − 1) / 0.12)
near('3 级累计经验', C.xpForLevel(3), Math.round(100 * (1.12 ** 2 - 1) / 0.12), 0.01);
near('50 级累计经验', C.xpForLevel(50), Math.round(100 * (1.12 ** 49 - 1) / 0.12), 0.01);
ok('经验曲线单调递增', (() => {
  for (let i = 2; i <= 99; i++) if (C.xpForLevel(i) <= C.xpForLevel(i - 1)) return false;
  return true;
})());
ok('等级↔经验互逆（抽查）', (() => {
  for (const lv of [2, 5, 17, 33, 60, 88, 99]) {
    if (C.levelForXp(C.xpForLevel(lv)) !== lv) return false;
  }
  return true;
})());
ok('0 经验为 1 级', C.levelForXp(0) === 1);
ok('负经验为 1 级', C.levelForXp(-5) === 1);
ok('进度 0~1 之间', (() => {
  for (const xp of [0, 50, 100, 12345, 1e9]) {
    const p = C.levelProgress(xp);
    if (!(p >= 0 && p <= 1)) return false;
  }
  return true;
})());

/* ══════════ 耗时公式（对照实测标定） ══════════ */
section('④ 耗时公式');
const copper = D.ACTION.get(1);   // 挖铜矿，baseTicks 5
near('新角色挖铜矿 = baseTicks（速度因子 1）', C.actionTicks(copper, { level: 1 }), 5, 0.01);

// 实测样本：采矿 6 级、快捷特长 1、无工具 → 单次 4.854 tick
near('6 级挖铜矿 ≈ 4.854（对照实测）',
     C.actionTicks(copper, { level: 6, quickPerk: 1 }), 4.8536, 0.05);

ok('等级越高越快（单调）', (() => {
  let prev = Infinity;
  for (const lv of [1, 5, 10, 25, 50, 90]) {
    const t = C.actionTicks(copper, { level: lv });
    if (t >= prev) return false;
    prev = t;
  }
  return true;
})());
ok('特长加速有效', C.actionTicks(copper, { level: 10, quickPerk: 20 })
   < C.actionTicks(copper, { level: 10, quickPerk: 0 }));
ok('工具加速有效', C.actionTicks(copper, { level: 10, toolFactor: 1.3 })
   < C.actionTicks(copper, { level: 10, toolFactor: 1 }));
ok('叠加法则是「各减 1 再相加」',
   Math.abs(C.combine(1.5, 2.0) - 2.5) < 1e-9,
   `combine(1.5,2)=${C.combine(1.5, 2)}，应为 2.5`);

/* ══════════ 利润计算 ══════════ */
section('⑤ 利润计算');
const ironBar = D.ACTION.get(42);   // 铁锭：1 铁矿 → 1 铁锭，4 tick
const ironOre = D.ACTION.get(3);    // 铁矿：4 tick → 1 铁矿

// 用固定价（不用市场）验证算式
const priceOf = (id) => ({ 3: 35, 41: 200, 1: 31, 40: 6 }[id] ?? 0);
const aOre = C.analyse(ironOre, { level: 15, priceOf, taxBp: 0 });
ok('挖矿分析有结果', !!aOre);
if (aOre) {
  // 铁矿 baseTicks=6，1 tick=0.6s → 单次 3.6s → 1000 次/小时
  near('挖矿每小时产出', aOre.unitsPerHour, 1000, 0.5);
  near('挖矿每小时毛收入', aOre.grossPerHour, 1000 * 35, 0.5);
  ok('挖矿无输入成本', Math.abs(aOre.costPerHour) < 1e-9);
  near('挖矿每小时经验', aOre.xpPerHour, 5 * 1000, 0.5);
  near('单次耗时（秒）', aOre.seconds, 3.6, 0.5);
}
const aBar = C.analyse(ironBar, { level: 15, priceOf, taxBp: 0 });
ok('打铁分析有结果', !!aBar);
if (aBar) {
  // 铁锭 baseTicks=4 → 2.4s → 1500 次/小时
  near('打铁每小时产出', aBar.unitsPerHour, 1500, 0.5);
  near('打铁每小时材料成本', aBar.costPerHour, 1500 * 35, 0.5);
  near('打铁每小时净利', aBar.netPerHour, 1500 * 200 - 1500 * 35, 0.5);
}
// 税率生效
const aBarTax = C.analyse(ironBar, { level: 15, priceOf, taxBp: 200 });
ok('税率会压低净利', aBarTax.netPerHour < aBar.netPerHour);
near('2% 税率差额', aBar.netPerHour - aBarTax.netPerHour, 1500 * 200 * 0.02, 1);

/* ══════════ 强化 ══════════ */
section('⑥ 强化计算');
near('+0 强化成功率 = 100%', C.enhanceChance(0), 1, 0.01);
near('+1 成功率 = 94%', C.enhanceChance(1), 0.94, 0.01);
near('+5 成功率 = 70%', C.enhanceChance(5), 0.70, 0.01);
near('高档位触底 20%', C.enhanceChance(14), 0.20, 0.01);
near('+20 仍是 20%（下限）', C.enhanceChance(20), 0.20, 0.01);
ok('讲台加成提高成功率',
   C.enhanceChance(5, { lecternBonus: 0.05 }) > C.enhanceChance(5));
const c0 = C.enhanceCost(0, 0);
ok('+0 品质0 费用 = 100 金 / 3 碎片',
   c0.gold === 100 && c0.shards === 3, JSON.stringify(c0));
const c4 = C.enhanceCost(4, 0);
ok('+4 费用 = 8000×5 = 40000 金 / 15 碎片',
   c4.gold === 40000 && c4.shards === 15, JSON.stringify(c4));
ok('品质倍率生效', C.enhanceCost(0, 4).gold === 100 * 50);
const exp = C.enhanceExpected(5, 0);
ok('强化到 +5 的期望花费可计算', exp && exp.gold > 0 && exp.attempts > 5);
ok('期望次数 = Σ(1/成功率)', (() => {
  const want = [0, 1, 2, 3, 4].reduce((s, t) => s + 1 / C.enhanceChance(t), 0);
  return Math.abs(exp.attempts - want) < 1e-6;
})());

/* ══════════ 状态归约 ══════════ */
section('⑦ 状态归约');
const S = DVI.state.s;
DVI.state.reduce({ tick: 100, m: [
  { t: 'welcome', protocol: 3, seed: 20260831, online: 1262, build: '1db7eb7',
    marketTaxBp: 200,
    you: { id: 7337, name: 'Tester', skills: { mining: 694 }, coins: 400 },
    offline: { ticksElapsed: 329, itemsGained: { 1: 51 }, ticksSkipped: 0 },
    chat: [{}, {}], windows: [{}, {}] },
] });
ok('服务器帧已记录', S.tick === 100);
ok('世界信息已记录', S.world && S.world.online === 1262);
ok('角色已记录', S.me && S.me.name === 'Tester');
ok('离线报告已记录', S.offline && S.offline.ticksElapsed === 329);

DVI.state.reduce({ tick: 101, m: [
  { t: 'enter', player: { id: 11, name: 'A', x: 1, y: 2 } },
  { t: 'enter', player: { id: 12, name: 'B', x: 3, y: 4 } },
] });
ok('玩家进入已记录', S.players.size === 2);
DVI.state.reduce({ tick: 102, m: [{ t: 'move', id: 11, x: 9, y: 9 }] });
ok('移动已更新', S.players.get(11).x === 9);
DVI.state.reduce({ tick: 103, m: [{ t: 'leave', id: 12 }] });
ok('玩家离开已移除', S.players.size === 1);

DVI.state.reduce({ tick: 104, m: [
  { t: 'marketBooks', tops: [{ itemId: 1, bid: 31, bidQty: 100, ask: null }] },
] });
ok('市场最优价已缓存', S.market.get(1).bid === 31);
DVI.state.reduce({ tick: 105, m: [
  { t: 'marketDepth', itemId: 1,
    bids: [{ price: 31, qty: 35000 }], asks: [{ price: 40, qty: 5 }],
    trades: [{ price: 31, qty: 10, tick: 100 }] },
] });
ok('盘口深度已缓存', S.depth.get(1).trades.length === 1);
ok('取价优先用卖价', DVI.state.priceOf(1) === 40);
ok('无行情时回退到基础价值', DVI.state.priceOf(5) === 55,
   `煤的基础价值应为 55，实得 ${DVI.state.priceOf(5)}`);

DVI.state.reduce({ tick: 106, m: [
  { t: 'batch', e: [{ kind: 'produced', jobId: 1, itemId: 1, xp: 2 }] },
] });
ok('产出统计已累计', S.tallies.produced[1] === 1);
ok('经验统计已累计', S.tallies.xp[1] === 2);

/* ══════════ 插件注册表 ══════════ */
section('⑧ 插件注册表');
let setupCalled = 0, enableCalled = 0, disableCalled = 0;
const rec = DVI.plugin.register({
  id: 'test-plugin', name: '测试插件', description: '用于验证注册表',
  api: 1, defaultEnabled: true,
  settings: [{ key: 'num', label: '数值', type: 'number', default: 7 }],
  setup() { setupCalled++; },
  enable() { enableCalled++; },
  disable() { disableCalled++; },
});
ok('插件注册成功', !!rec);
ok('setup 被调用', setupCalled === 1);
ok('默认启用', rec && rec.enabled === true && enableCalled === 1);
ok('插件可读取自身设置', rec.ctx.settings.get('num') === 7);
rec.ctx.settings.set('num', 42);
ok('插件设置可写入', rec.ctx.settings.get('num') === 42);
ok('插件能拿到核心计算能力', typeof rec.ctx.core.calc.actionTicks === 'function');
ok('插件能访问状态', rec.ctx.state.tick === 106);
DVI.plugin.setEnabled('test-plugin', false);
ok('插件可停用', disableCalled === 1 && rec.enabled === false);
ok('停用状态已持久化', DVI.settings.get('plugin.test-plugin') === false);
ok('插件列表可见', DVI.plugin.list().some(p => p.id === 'test-plugin'));
ok('打包进来的插件也已注册',
   DVI.plugin.list().some(p => p.id === 'example-networth-hourly'),
   `实际插件：${DVI.plugin.list().map(p => p.id).join(', ')}`);

// API 版本守卫
const old = DVI.plugin.register({ id: 'too-new', name: '需要更高 API', api: 99 });
ok('API 版本不匹配时拒绝注册', old === null);

/* ══════════ 只读约束 ══════════ */
section('⑨ 只读约束（架构级）');
ok('net 不暴露 send', DVI.net.send === undefined);
ok('net 不暴露 socket 实例', DVI.net.socket === undefined);
ok('net 只提供连接状态与地址',
   typeof DVI.net.connected === 'boolean' && 'socketUrl' in DVI.net);
ok('插件上下文里也拿不到 send',
   rec.ctx.core.net.send === undefined);

/* ══════════ 对照模拟数据基准 ══════════ */
section('⑩ 对照 ground-truth（模拟数据基准）');
if (fs.existsSync(SIM_GROUND)) {
  const gt = JSON.parse(fs.readFileSync(SIM_GROUND, 'utf8'));
  ok('基准文件可读', !!gt.scenarios);
  const sc = gt.scenarios.find(x => x.jobName === 'Copper');
  if (sc) {
    const action = D.NAME_TO_ACTION.get('copper');
    const t = C.actionTicks(action, { level: sc.levelBefore, quickPerk: 3 });
    ok(`基准里「${sc.scenario}」的单次耗时可比对`, t > 0 && t < action.baseTicks,
       `实得 ${t.toFixed(3)} vs baseTicks ${action.baseTicks}`);
  }
  // 检查基准自洽：ticksApplied + ticksSkipped === ticksElapsed
  let selfConsistent = true;
  for (const s of gt.scenarios) {
    if (s.ticksApplied + s.ticksSkipped !== s.ticksElapsed) selfConsistent = false;
  }
  ok('基准数据自洽（applied + skipped = elapsed）', selfConsistent);
  const capped = gt.scenarios.filter(s => s.cappedByOfflineLimit);
  ok('基准含离线上限截断场景', capped.length >= 1);
} else {
  results.push('  ⚠ 未找到 ground-truth.json，跳过');
}

/* ══════════ 油猴兼容性 ══════════ */
section('⑪ 油猴兼容性（沙箱模型）');
ok('API 已发布到页面窗口 unsafeWindow', !!pageWindow.DVI,
   '独立脚本形式的插件靠这个读取主干');
ok('API 同时也挂在沙箱 window 上', !!sandbox.window.DVI,
   '同脚本打包的插件靠这个读取主干');
ok('两处是同一个对象', pageWindow.DVI === sandbox.window.DVI);
ok('只注入一次（防重复）', typeof pageWindow.DVI.selfTest === 'function');

// 自检函数本身
const st = pageWindow.DVI.selfTest();
ok('selfTest 返回结构化结果', st && Array.isArray(st.checks) && typeof st.summary === 'string');
ok('selfTest 覆盖了关键项', st.checks.length >= 10, `共 ${st.checks.length} 项`);
const names = st.checks.map(c => c.name);
for (const must of ['GM_getValue 可用', '游戏数据已内联', '计算引擎正常',
                    '收包钩子已安装', '无发送通道（只读约束）']) {
  ok(`自检项存在：${must}`, names.includes(must));
}
// 在桩环境里，这几项应该通过
const byName = Object.fromEntries(st.checks.map(c => [c.name, c.pass]));
ok('自检：GM API 判定通过', byName['GM_getValue 可用'] === true);
ok('自检：数据层判定通过', byName['游戏数据已内联'] === true);
ok('自检：计算引擎判定通过', byName['计算引擎正常'] === true);
ok('自检：只读约束判定通过', byName['无发送通道（只读约束）'] === true);

// 沙箱下崩溃的常见来源：模拟「body 尚不存在」的 document-start 时刻
ok('document-start 时 body 为空也不崩', (() => {
  const saved = documentStub.body;
  try {
    documentStub.body = null;
    // ui.ready 会挂到 DOMContentLoaded 上而不是立刻执行
    DVI.ui.ready(() => {});
    return true;
  } catch (e) {
    return false;
  } finally {
    documentStub.body = saved;
  }
})());

// 头部元信息完整性（用户脚本能否被正确识别，全靠这段）
section('⑫ userscript 头部元信息');
const head = code.split('==/UserScript==')[0];
ok('有 @name', /\/\/\s*@name\s+\S/.test(head));
ok('有 @version', /\/\/\s*@version\s+[\d.]+/.test(head));
ok('有 @match 且覆盖游戏域名', /@match\s+https:\/\/deepveinidle\.com\/\*/.test(head));
ok('有 @run-at document-start', /@run-at\s+document-start/.test(head));
ok('声明了 unsafewindow 权限', /@grant\s+unsafeWindow/.test(head),
   '跨脚本共享所必需');
ok('声明了全部用到的 GM API',
   ['GM_addStyle', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand']
     .every(g => new RegExp('@grant\\s+' + g + '\\b').test(head)));
ok('头部无超长行', head.split('\n').every(l => l.length < 300));
ok('整个文件无超长行（预览器友好）',
   code.split('\n').every(l => l.length < 2000),
   `最长 ${Math.max(...code.split('\n').map(l => l.length))} 字符`);

// 版本号防漂移：文件头与运行时常量必须一致，
// 且不能是「万年不变」的初始值 —— 否则用户无法分辨新旧构建。
{
  const hv = (head.match(/@version\s+(\S+)/) || [])[1];
  ok('头部 @version 存在', !!hv, `实得 ${hv}`);
  ok('运行时 VERSION 与头部一致',
     DVI.version === hv, `头部 ${hv} vs 运行时 ${DVI.version}`);
  ok('版本号不是占位值（能分辨新旧构建）',
     !/^1\.0\.0$/.test(hv) && /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(hv),
     `实得 ${hv}，应为日期版本如 2026.10.02.1`);
  ok('构建标记里带版本号', /\[build\] v\S+/.test(code.slice(0, 4000)));
}

/* ══════════ 无感契约 ══════════ */
section('⑬ 无感契约（默认不打扰用户）');
ok('默认显示方式是「无痕迹」', DVI.ui.mode() === DVI.ui.MODE_QUIET,
   `实得 ${DVI.ui.mode()}`);
ok('无痕迹模式下不创建悬浮按钮', !documentStub.body.children.some(
   c => c.className === 'dvi-fab'), '页面上不应多出任何元素');
ok('面板已预先建好但保持隐藏', (() => {
  DVI.ui.makeWindow();
  const w = documentStub.body.children.find(c => c.className === 'dvi-win');
  return !!w && w.hidden === true;
})());
ok('可从菜单直接打开面板（无需按钮）', (() => {
  DVI.ui.toggle(true);
  const w = documentStub.body.children.find(c => c.className === 'dvi-win');
  return w && w.hidden === false;
})());
ok('可切到按钮模式', (() => {
  DVI.ui.setMode(DVI.ui.MODE_FAB);
  return DVI.ui.mode() === DVI.ui.MODE_FAB;
})());
ok('切回无痕迹模式会移除按钮', (() => {
  DVI.ui.setMode(DVI.ui.MODE_QUIET);
  DVI.ui.removeFab();
  return DVI.ui.mode() === DVI.ui.MODE_QUIET;
})());
ok('首次安装提示只出现一次', (() => {
  // 启动时已把 installed 置为 true，再次启动不应重复提示
  return DVI.settings.get('installed', false) === true;
})());
ok('所有插件默认启用（零配置）',
   DVI.plugin.list().every(p => p.def.defaultEnabled !== false),
   '装完即用，不需要逐项打开');

/* ══════════ 健壮性 ══════════ */
section('⑭ 健壮性（游戏改版不会连锁崩溃）');
ok('插件抛异常不影响事件总线', (() => {
  const off = DVI.bus.on('test:boom', () => { throw new Error('故意的'); });
  let reached = false;
  DVI.bus.on('test:boom', () => { reached = true; });
  DVI.bus.emit('test:boom', {});
  off();
  return reached;
})());
ok('畸形帧不会抛异常', (() => {
  try {
    DVI.state.reduce({ tick: 1, m: [null, undefined, 42, {}, { t: 'not_a_real_type' }] });
    DVI.state.reduce({ tick: 2, m: 'not-an-array' });
    DVI.state.reduce({});
    return true;
  } catch (e) { return false; }
})());
ok('未知消息类型被安全忽略', (() => {
  try { DVI.state.reduce({ tick: 3, m: [{ t: 'future_feature_xyz', data: {} }] }); return true; }
  catch (e) { return false; }
})());
ok('窗口对象没有泄漏 send 能力', (() => {
  const seen = new Set();
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 4 || seen.has(o)) return true;
    seen.add(o);
    for (const k of Object.keys(o)) {
      if (k === 'send') return false;
      if (typeof o[k] === 'object' && !walk(o[k], d + 1)) return false;
    }
    return true;
  };
  return walk(pageWindow.DVI, 0);
})());

/* ══════════ 升级预估 ══════════ */
section('⑮ 升级预估（「还需几次行动」）');
{
  const copperA = D.ACTION.get(1);        // 铜矿：5 tick/次，2 xp/次，需求 1 级
  const xp2 = C.xpForLevel(2);            // 升到 2 级所需累计经验
  const xp3 = C.xpForLevel(3);

  const e1 = C.actionsToLevel(copperA, 0, 2, { level: 1 });
  ok('升到 2 级：次数正确', e1.actions === Math.ceil(xp2 / 2),
     `实得 ${e1.actions}，应为 ${Math.ceil(xp2 / 2)}`);
  // 1 tick = 0.6 秒，所以秒数 = 次数 × 5 tick × 0.6
  ok('升到 2 级：时间按 0.6 秒/tick 换算',
     Math.abs(e1.seconds - e1.actions * 5 * 0.6) < 1e-6,
     `实得 ${e1.seconds}，应为 ${e1.actions * 5 * 0.6}`);
  ok('同时给出 tick 总数', e1.ticks === e1.actions * 5);
  ok('秒数 = tick 数 × 0.6', Math.abs(e1.seconds - e1.ticks * 0.6) < 1e-9);
  ok('起始等级正确', e1.fromLevel === 1 && e1.toLevel === 2);
  ok('经验缺口正确', e1.xpNeeded === xp2);

  // 跨级：应该分段计算（等级提升会加速，分段才准）
  const e2 = C.actionsToLevel(copperA, 0, 3, { level: 1 });
  ok('跨级：总数 = 各段之和',
     e2.actions === e2.perLevel.reduce((s, x) => s + x.actions, 0));
  ok('跨级：分成 2 段', e2.perLevel.length === 2, `实得 ${e2.perLevel.length} 段`);
  ok('跨级：总次数正确', e2.actions === Math.ceil(xp3 / 2),
     `实得 ${e2.actions}，应为 ${Math.ceil(xp3 / 2)}`);
  ok('升级后单次更快（分段有效）',
     e2.perLevel[1].seconds / e2.perLevel[1].actions
     < e2.perLevel[0].seconds / e2.perLevel[0].actions,
     '第二段每次耗时应更短');

  const e3 = C.actionsToLevel(copperA, 0, 1, { level: 1 });
  ok('目标已达成时返回 alreadyThere', e3.alreadyThere === true && e3.actions === 0);
  const e4 = C.actionsToLevel(copperA, 999999, 5, { level: 1 });
  ok('目标低于当前等级时 alreadyThere', e4.alreadyThere === true);

  const noXp = { id: -1, xp: 0, skill: 'mining', levelReq: 1, baseTicks: 5, inputs: [],
                 output: { itemId: 1, qty: 1 } };
  ok('不给经验的行动返回 null', C.actionsToLevel(noXp, 0, 5, { level: 1 }) === null);
  const high = C.actionsToLevel(copperA, 0, 9999, { level: 1 });
  ok('目标超出上限时被夹紧', high.toLevel <= C.MAX_LEVEL,
     `实得 ${high.toLevel}，上限 ${C.MAX_LEVEL}`);
  ok('不会死循环（有界）', Number.isFinite(high.actions) && high.actions > 0);
}

section('⑯ 时长格式化');
ok('秒', C.humanDuration(30) === '30 秒');
ok('分秒', C.humanDuration(90) === '1 分 30 秒', `实得 ${C.humanDuration(90)}`);
ok('小时', C.humanDuration(3660) === '1 小时 1 分', `实得 ${C.humanDuration(3660)}`);
ok('天', /天/.test(C.humanDuration(90000)), `实得 ${C.humanDuration(90000)}`);
ok('非法输入有兜底', C.humanDuration(NaN) === '—');

/* ══════════ 内联注入 ══════════ */
section('⑰ 内联注入（融入游戏界面）');
{
  const hostA = makeEl('button');
  hostA.className = 'route';
  hostA.dataset.job = '1';
  const hostB = makeEl('button');
  hostB.className = 'route';
  hostB.dataset.job = '3';
  selectorResults.set('button.route[data-job]', [hostA, hostB]);
  // 挂进 body，这样 document 级查询（移除锚点时的清理）能找到它们
  documentStub.body.appendChild(hostA);
  documentStub.body.appendChild(hostB);

  ok('注册锚点成功',
     DVI.ui.inline.add({ id: 'test-anchor', selector: 'button.route[data-job]',
                         render: (h) => `<span>需 ${h.dataset.job} 次</span>` }) === 'test-anchor');

  DVI.ui.inline.applyAll();
  // 注意：真实插件也会往同一批宿主注入，所以只数「本测试的锚点」注入的节点
  const mine = (h) => h.children.filter(
    c => c.getAttribute('data-dvi-inline') === 'test-anchor').length;
  ok('注入了所有匹配的宿主', mine(hostA) === 1 && mine(hostB) === 1,
     `hostA ${mine(hostA)}，hostB ${mine(hostB)}`);
  ok('注入内容带去重标记',
     hostA.children.some(c => c.getAttribute('data-dvi-inline') === 'test-anchor'));
  ok('注入内容带通用样式类',
     hostA.children.every(c => String(c.className).includes('dvi-inline')));
  ok('HTML 字符串被解析成正确的元素',
     hostA.children.some(c => c.tagName === 'span'),
     `子节点：${hostA.children.map(c => c.tagName).join(',')}`);

  DVI.ui.inline.applyAll();
  ok('重复执行不会重复注入（去重有效）', mine(hostA) === 1,
     `实得 ${mine(hostA)} 个`);

  const rep = DVI.ui.inline.report();
  const row = rep.find(r => r.锚点 === 'test-anchor');
  ok('诊断报告可用', !!row && row['找到宿主'] === 2, JSON.stringify(row));
  ok('诊断报告标出命中的选择器',
     row && row['命中的'] === 'button.route[data-job]', JSON.stringify(row));

  // 多候选选择器：第一个不中就自动回退
  ok('候选选择器可按顺序回退', (() => {
    const h = makeEl('div');
    h.setAttribute('data-job', '5');
    selectorResults.set('[data-fallback] [data-job]', [h]);
    DVI.ui.inline.add({
      id: 'fallback-anchor',
      selector: ['[不存在的容器] [data-job]', '[data-fallback] [data-job]'],
      render: () => '<span>回退成功</span>',
    });
    DVI.ui.inline.applyAll();
    const r = DVI.ui.inline.report().find(x => x.锚点 === 'fallback-anchor');
    return r && r['命中的'] === '[data-fallback] [data-job]'
        && r['已注入'] === 1;
  })());

  // 多候选全部落空时：不报错、不注入，并在报告里显示为 0
  {
    DVI.ui.inline.add({
      id: 'no-hit-anchor',
      selector: ['[压根不存在]', '[也不存在]'],
      render: () => '<span>x</span>',
    });
    DVI.ui.inline.applyAll();
    const r = DVI.ui.inline.report().find(x => x.锚点 === 'no-hit-anchor');
    ok('全部候选都不中时报告为空且不报错',
       r && r['找到宿主'] === 0 && r['已注入'] === 0 && !r['错误'],
       JSON.stringify(r));
  }

  ok('render 返回 null 时跳过',
     (() => {
       const h3 = makeEl('button');
       h3.dataset.job = '9';
       selectorResults.set('button.route.nulltest', [h3]);
       DVI.ui.inline.add({ id: 'skip-anchor', selector: 'button.route.nulltest',
                           render: () => null });
       DVI.ui.inline.applyAll();
       return !h3.children.some(c => c.getAttribute('data-dvi-inline') === 'skip-anchor');
     })());

  ok('render 抛异常不影响其它宿主',
     (() => {
       const ok1 = makeEl('button'); ok1.dataset.job = '1';
       const bad = makeEl('button'); bad.dataset.job = '2';
       selectorResults.set('button.route[data-job]', [bad, ok1]);
       DVI.ui.inline.add({ id: 'boom-anchor', selector: 'button.route[data-job]',
                           render: (h) => { if (h.dataset.job === '2') throw new Error('x');
                                            return '<span>好</span>'; } });
       DVI.ui.inline.applyAll();
       return ok1.children.length >= 1;
     })());

  ok('非法选择器不会抛异常',
     (() => {
       try {
         DVI.ui.inline.add({ id: 'bad-sel', selector: '>>>bad<<<', render: () => '<i></i>' });
         DVI.ui.inline.applyAll();
         return true;
       } catch (e) { return false; }
     })());

  DVI.ui.inline.remove('test-anchor');
  ok('移除锚点会清掉已注入内容',
     !hostA.children.some(c => c.getAttribute('data-dvi-inline') === 'test-anchor'));
  selectorResults.clear();
}

/* ══════════ tooltip 约定 ══════════ */
section('⑱ 原生 tooltip 约定');
{
  const t = DVI.ui.tip('标题', ['第一行', '第二行']);
  ok('生成 data-tip-name', /data-tip-name="标题"/.test(t));
  ok('生成 data-tip-lines 且用 | 分隔', /data-tip-lines="第一行\|第二行"/.test(t));
  ok('引号被转义', /&quot;/.test(DVI.ui.tip('含"引号"', ['a'])));
  ok('过滤空行', DVI.ui.tip('t', ['a', null, '', 'b']) === 'data-tip-name="t" data-tip-lines="a|b"');
  ok('接受单个字符串', /data-tip-lines="只有一行"/.test(DVI.ui.tip('t', '只有一行')));
}

/* ══════════ 时间单位（tick = 0.6 秒） ══════════ */
section('⑲ 时间单位换算（1 tick = 0.6 秒）');
ok('MS_PER_TICK = 600', C.MS_PER_TICK === 600, `实得 ${C.MS_PER_TICK}`);
ok('SECONDS_PER_TICK = 0.6', C.SECONDS_PER_TICK === 0.6);
ok('ticksToSeconds(10) = 6', C.ticksToSeconds(10) === 6);
ok('secondsToTicks(6) = 10', C.secondsToTicks(6) === 10);
ok('互为逆运算', Math.abs(C.secondsToTicks(C.ticksToSeconds(37)) - 37) < 1e-9);
{
  // 一小时有多少 tick：3600 / 0.6 = 6000
  ok('一小时 = 6000 tick', C.secondsToTicks(3600) === 6000);
  // 用真实数据校对：访客号离线 329 tick，铜矿 4.854 tick/次
  const copperA = D.ACTION.get(1);
  const per = C.actionTicks(copperA, { level: 6, quickPerk: 1 });
  ok('单次 4.854 tick = 2.91 秒',
     Math.abs(C.ticksToSeconds(per) - 2.912) < 0.01,
     `实得 ${C.ticksToSeconds(per).toFixed(3)} 秒`);
  ok('每小时应产出约 1236 个（不含背包往返）',
     Math.abs(C.unitsPerHour(copperA, { level: 6, quickPerk: 1 }) - 1236) < 5,
     `实得 ${C.unitsPerHour(copperA, { level: 6, quickPerk: 1 }).toFixed(0)}`);
}

/* ══════════ 经验加成链 ══════════ */
section('㉑ 经验加成链（按当前环境计算）');
{
  const copperA = D.ACTION.get(1);     // 铜矿：xp 2，纯采集（无输入）
  const steelA = D.ACTION.get(43);     // 钢锭：xp 35，有输入

  ok('无加成时 = 基础经验', C.xpPerAction(copperA, {}) === 2,
     `实得 ${C.xpPerAction(copperA, {})}`);
  ok('档位 0 倍率 = 1', C.XP.tierMult[0] === 1);
  ok('档位 1 倍率 = 1.5', C.XP.tierMult[1] === 1.5);
  ok('档位 4 倍率 = 25', C.XP.tierMult[4] === 25);

  ok('档位 1 使经验 ×1.5', C.xpPerAction(copperA, { tier: 1 }) === 3,
     `实得 ${C.xpPerAction(copperA, { tier: 1 })}`);
  ok('档位 4 使经验 ×25', C.xpPerAction(copperA, { tier: 4 }) === 50);
  ok('档位越界被夹紧', C.xpPerAction(copperA, { tier: 99 }) === 50);

  // 采集者增益：倍率来自 Zn 表（1 / 1.3 / 1.6 / 2.2 / 3），不是线性等级
  ok('增益倍率表来自数据层',
     JSON.stringify(C.XP.buffTierMults) === JSON.stringify([1, 1.3, 1.6, 2.2, 3]),
     JSON.stringify(C.XP.buffTierMults));
  ok('采集者增益对纯采集生效',
     C.xpPerAction(copperA, { gathererMult: 2 }) === Math.round(2 * (1 + 0.1 * 2)),
     `实得 ${C.xpPerAction(copperA, { gathererMult: 2 })}，` +
     `应为 ${Math.round(2 * (1 + 0.1 * 2))}`);
  ok('采集者增益对含输入配方无效',
     C.xpPerAction(steelA, { gathererMult: 3 }) === 35,
     `实得 ${C.xpPerAction(steelA, { gathererMult: 3 })}`);
  ok('未生效的增益倍率为 0', C.xpPerAction(copperA, { gathererMult: 0 }) === 2);

  // 精通每级系数从特长表查（xp 项为 0.005），不再写死
  ok('perkPerRank 从数据表取值', C.perkPerRank('xp') === 0.005,
     `实得 ${C.perkPerRank('xp')}`);
  ok('perkPerRank 对未知 id 返回 0', C.perkPerRank('不存在的特长') === 0);
  ok('表里确有 10 项特长', C.PERK_BY_ID.size >= 10, `实得 ${C.PERK_BY_ID.size}`);

  ok('社区经验倍率生效',
     C.xpPerAction(copperA, { windowXpMult: 1.25 }) === 3,
     `2×1.25=2.5 四舍五入为 3，实得 ${C.xpPerAction(copperA, { windowXpMult: 1.25 })}`);
  ok('倍率 1 时不改变结果', C.xpPerAction(copperA, { windowXpMult: 1 }) === 2);

  // 叠加法则：各自减 1 再相加
  ok('多项加成按「各减 1 相加」叠加',
     C.xpPerAction(copperA, { gathererMult: 1, elixirMult: 1 }) === Math.round(2 * 1.2),
     `实得 ${C.xpPerAction(copperA, { gathererMult: 1, elixirMult: 1 })}`);

  ok('祝福 ×1.05 生效',
     C.xpPerAction(steelA, { blessing: true }) === Math.round(35 * 1.05));
  ok('祝福倍率来自数据层', C.XP.blessing.gather === 1.05);
  ok('公会加成生效',
     C.xpPerAction(steelA, { guildBonus: 0.05 }) === Math.round(35 * 1.05));

  ok('不给经验的行动返回 0',
     C.xpPerAction({ id: -1, xp: 0, inputs: [] }, {}) === 0);
  ok('结果至少为 1（不会因四舍五入变 0）',
     C.xpPerAction({ id: -2, xp: 0.4, inputs: [] }, {}) >= 1);
}

section('㉒ 按当前环境取参数');
{
  // 造一个含 windows 的世界状态
  DVI.state.reduce({ tick: 1000, m: [{
    t: 'welcome', protocol: 3, seed: 1, online: 10, build: 'x',
    you: { id: 1, name: 'T', skills: { mining: 0 }, perks: { gatherer: 5, quick: 2 } },
    windows: [
      { fromTick: 0, toTick: 2000, xpMult: 1.25, rarityMult: 1 },
      { fromTick: 0, toTick: 2000, xpMult: 1.5, rarityMult: 2 },
      { fromTick: 5000, toTick: 6000, xpMult: 3, rarityMult: 1 },
    ],
  }] });

  const m = DVI.state.windowMultsAt(1000);
  // 两个窗口生效：1 + (0.25 + 0.5) = 1.75
  ok('窗口倍率按「各减 1 相加」累加',
     Math.abs(m.xpMult - 1.75) < 1e-9, `实得 ${m.xpMult}`);
  ok('稀有倍率同理', Math.abs(m.rarityMult - 2) < 1e-9, `实得 ${m.rarityMult}`);
  ok('时间窗外的活动不计入',
     Math.abs(DVI.state.windowMultsAt(3000).xpMult - 1) < 1e-9);
  ok('currentXpMult 用当前 tick', Math.abs(DVI.state.currentXpMult() - 1.75) < 1e-9);

  const cx = DVI.state.xpContext({ level: 33 });
  ok('xpContext 带出等级', cx.level === 33);
  ok('xpContext 带出社区倍率', Math.abs(cx.windowXpMult - 1.75) < 1e-9);
  ok('xpContext 带出存档引用（供现算增益层数）', cx.you && cx.you.id === 1);
  ok('xpContext 带出快捷特长', cx.quickPerk === 2);
  ok('xpContext 可直接喂给 actionsToLevel', (() => {
    const a = D.ACTION.get(1);
    const r = C.actionsToLevel(a, 0, 5, cx);
    return r && r.actions > 0;
  })());
  ok('xpContext 每次调用都重算（不是缓存快照）', (() => {
    const a1 = DVI.state.xpContext().windowXpMult;
    DVI.state.reduce({ tick: 5500, m: [] });   // 进入第三个窗口的时间段
    const a2 = DVI.state.xpContext().windowXpMult;
    return a1 !== a2;
  })());
}

section('㉓ 增益层数与时间衰减（动态）');
{
  // 构造一个存档：gatherer 增益生效，共 3 层，已过去一部分时间
  const mk = (brews, buckets, lastTick, tier) => ({ brews, brewBuckets: buckets, lastTick, brewTier: tier });

  const you = mk({ gatherer: 1000 }, { gatherer: [100, 100, 100] }, 700, {});
  // total=300, elapsed = 700 - (1000-300) = 0 → 落在最内层 a=2 → 倍率 1.6
  ok('增益层数按时间衰减计算', C.buffTier(you, 'gatherer') === 2,
     `实得 ${C.buffTier(you, 'gatherer')}`);
  ok('倍率按层数查表', C.buffMult(you, 'gatherer') === 1.6,
     `实得 ${C.buffMult(you, 'gatherer')}`);
  ok('增益生效判定正确', C.buffActive(you, 'gatherer') === true);

  // 时间推进 → 层数下降
  const later = mk({ gatherer: 1000 }, { gatherer: [100, 100, 100] }, 950, {});
  // elapsed = 950 - 700 = 250 → 250<300 → a=2 仍成立；再推到 1000
  ok('时间越久倍率越低',
     C.buffMult(mk({ gatherer: 1000 }, { gatherer: [100, 100, 100] }, 1000, {}), 'gatherer')
     <= C.buffMult(you, 'gatherer'));

  // 增益过期
  const expired = mk({ gatherer: 500 }, { gatherer: [100] }, 600, {});
  ok('过期增益判定为未生效', C.buffActive(expired, 'gatherer') === false);
  ok('未生效时倍率为 0', C.buffMult(expired, 'gatherer') === 0);

  // 没有 brewBuckets 时退回 brewTier
  const simple = mk({ gatherer: 9999 }, null, 1, { gatherer: 4 });
  ok('无 bucket 时退回 brewTier', C.buffTier(simple, 'gatherer') === 4);
  ok('档位越界被夹紧',
     C.buffTier(mk({ gatherer: 9999 }, null, 1, { gatherer: 99 }), 'gatherer') === 4);

  // 完整链路：xpPerAction 能从存档里自动推出增益。
  // 用 Meteoric 矿（xp 59，纯采集）——基础值大才看得出倍率效果，
  // 铜矿只有 2 点经验，round(2×1.16) 还是 2，会被四舍五入掩盖。
  const bigGather = D.ACTION.get(8);
  ok('Meteoric 是纯采集且经验够大',
     bigGather && bigGather.inputs.length === 0 && bigGather.xp >= 50,
     `xp=${bigGather && bigGather.xp}`);
  const withBuff = C.xpPerAction(bigGather, { you });
  const withoutBuff = C.xpPerAction(bigGather, {});
  ok('xpPerAction 能从存档自动推增益', withBuff > withoutBuff,
     `有增益 ${withBuff} vs 无增益 ${withoutBuff}`);
  ok('推出的增益量正确',
     withBuff === Math.round(bigGather.xp * (1 + 0.1 * 1.6)),
     `实得 ${withBuff}，应为 ${Math.round(bigGather.xp * (1 + 0.1 * 1.6))}`);
}

/* ══════════ 装备（工具）加成 ══════════ */
section('㉔ 当前装备的工具加成');
{
  ok('工具加成表来自数据层', C.TOOL_BONUS_BY_ITEM.size >= 40,
     `实得 ${C.TOOL_BONUS_BY_ITEM.size} 件`);
  ok('技能→槽位映射来自数据层',
     C.SLOT_FOR_SKILL.mining === 'pickaxe' && C.SLOT_FOR_SKILL.fishing === 'rod',
     JSON.stringify(C.SLOT_FOR_SKILL));
  ok('加成值与提取结果一致（pickaxe 81 = 0.16）',
     C.TOOL_BONUS_BY_ITEM.get(81) === 0.16,
     `实得 ${C.TOOL_BONUS_BY_ITEM.get(81)}`);

  const mine = D.ACTION.get(1);      // 铜矿（mining）
  const smith = D.ACTION.get(42);    // 铁锭（smithing）

  const none = { equipment: { pickaxe: null } };
  const iron = { equipment: { pickaxe: 81 } };
  const best = { equipment: { pickaxe: 84 } };

  ok('未装备工具 → 系数 1', C.toolFactor(none, mine) === 1);
  ok('铁镐(81) → 系数 1.16', Math.abs(C.toolFactor(iron, mine) - 1.16) < 1e-9,
     `实得 ${C.toolFactor(iron, mine)}`);
  ok('顶配镐(84) → 系数 1.5', Math.abs(C.toolFactor(best, mine) - 1.5) < 1e-9);
  ok('槽位不匹配的装备不生效',
     C.toolFactor({ equipment: { pickaxe: 81 } }, smith) === 1,
     '镐子不该加速锻造');

  const eq = C.equippedTool(iron, 'mining');
  ok('能报出当前装备详情', eq && eq.slot === 'pickaxe' && eq.itemId === 81,
     JSON.stringify(eq));
  ok('报出加成百分比', Math.abs(eq.bonus - 0.16) < 1e-9);
  ok('报出物品名', typeof eq.name === 'string' && eq.name.length > 0, eq.name);
  ok('未装备时返回 null', C.equippedTool(none, 'mining') === null);

  // 装备应让作业更快
  const tNoTool = C.actionTicks(mine, { level: 40 });
  const tTool = C.actionTicks(mine, { level: 40, toolFactor: C.toolFactor(iron, mine) });
  ok('装了工具单次更快', tTool < tNoTool,
     `${tNoTool.toFixed(3)} → ${tTool.toFixed(3)} tick`);
  ok('提速比例与加成一致',
     Math.abs(tNoTool / tTool - 1.16) < 1e-9,
     `实得 ${(tNoTool / tTool).toFixed(4)}`);
}

section('㉕ 即时取当前配置（统一入口）');
{
  // 造一个完整状态：有装备、有特长、有增益、有社区活动
  DVI.state.reduce({ tick: 1000, m: [{
    t: 'welcome', protocol: 3, seed: 1, online: 10, build: 'x',
    you: {
      id: 7, name: 'Cfg', skills: { mining: C.xpForLevel(30) },
      equipment: { pickaxe: 82 },
      perks: { quick: 4 },
      brews: { gatherer: 2000 }, brewBuckets: { gatherer: [100] },
      masteries: { xp: 10 }, lastTick: 1000,
    },
    windows: [{ fromTick: 0, toTick: 9999, xpMult: 1.25, rarityMult: 1 }],
  }] });

  const a = D.ACTION.get(1);
  const cx = DVI.state.actionContext(a);

  ok('带出当前等级', cx.level === 30, `实得 ${cx.level}`);
  ok('带出当前装备的工具系数',
     Math.abs(cx.toolFactor - 1.25) < 1e-9, `实得 ${cx.toolFactor}`);
  ok('带出快捷特长', cx.quickPerk === 4);
  ok('带出社区倍率', Math.abs(cx.windowXpMult - 1.25) < 1e-9);
  ok('带出存档引用', cx.you && cx.you.id === 7);

  // 计算结果应同时体现装备与增益
  const est = C.actionsToLevel(a, C.xpForLevel(30), 31, cx);
  ok('统一入口可直接用于升级预估', est && est.actions > 0);
  const noGear = C.actionsToLevel(a, C.xpForLevel(30), 31, { level: 30 });
  ok('有装备+增益时更快升级', est.seconds < noGear.seconds,
     `${est.seconds.toFixed(1)}s vs ${noGear.seconds.toFixed(1)}s`);

  // 配置摘要（用于在界面上如实展示）
  const cfg = DVI.state.configSummary(a);
  ok('配置摘要非空', Array.isArray(cfg) && cfg.length >= 3, `实得 ${cfg.length} 项`);
  const labels = cfg.map(c => c.label);
  ok('摘要含技能等级', labels.some(l => l.includes('采矿')));
  ok('摘要含工具', labels.includes('工具'), JSON.stringify(labels));
  ok('摘要含社区活动', labels.includes('社区活动'), JSON.stringify(labels));
  ok('摘要里工具显示为 +25%',
     cfg.find(c => c.label === '工具').value.includes('25%'),
     cfg.find(c => c.label === '工具').value);

  // 换装备后应立刻反映
  DVI.state.s.me.equipment.pickaxe = 84;
  ok('换装备后即时反映',
     Math.abs(DVI.state.actionContext(a).toolFactor - 1.5) < 1e-9,
     `实得 ${DVI.state.actionContext(a).toolFactor}`);
}

/* ══════════ 插件真实跑起来了没有 ══════════ */
section('㉖ 插件契约（防止「装了但没跑起来」）');
{
  const list = DVI.plugin.list();
  ok('注册表非空', list.length > 0, `实得 ${list.length} 个`);

  // 这条是本轮 bug 的护栏：注册表会吞掉 setup 异常（为了不拖垮游戏），
  // 但必须把失败记下来，否则「功能完全不出现」会被静默掩盖。
  const broken = list.filter(p => p.setupError);
  ok('没有任何插件初始化失败', broken.length === 0,
     broken.map(p => `${p.id}: ${p.setupError}`).join(' | '));

  // 真实插件必须真的注册出了锚点，而不只是"注册了插件"
  const rep = DVI.ui.inline.report();
  ok('真实插件注册出了内联锚点', rep.length > 0,
     `锚点数 ${rep.length}`);
  ok('锚点带候选选择器', rep.every(r => r['候选选择器'] && r['候选选择器'].length > 0));
  ok('作业升级插件的锚点存在',
     rep.some(r => r['锚点'] === 'job-level-estimate'),
     JSON.stringify(rep.map(r => r['锚点'])));

  // ctx.ui.inline 必须「既能当函数调用，又带方法」——两种写法都不能炸
  const rec = DVI.plugin.get('job-level-estimate');
  ok('能取到插件实例', !!rec);
  if (rec && rec.ctx) {
    ok('ctx.ui.inline 可当函数调用', typeof rec.ctx.ui.inline === 'function');
    ok('ctx.ui.inline 同时带 refresh 方法',
       typeof rec.ctx.ui.inline.refresh === 'function');
    ok('ctx.ui.inline 同时带 report 方法',
       typeof rec.ctx.ui.inline.report === 'function');
    ok('两种调用方式都不抛异常', (() => {
      try {
        const n0 = rec.ctx.ui.inline.report().length;
        // 必须用独立 id —— 缺省 id 会落到插件自身 id 上，把已有锚点覆盖掉
        const id = rec.ctx.ui.inline({ id: 'probe-anchor-tmp',
                                       selector: '[不可能命中]', render: () => null });
        rec.ctx.ui.inline.refresh();
        const grew = rec.ctx.ui.inline.report().length === n0 + 1;
        rec.ctx.ui.inline.remove('probe-anchor-tmp');
        return typeof id === 'string' && grew;
      } catch (e) { return false; }
    })());
  }

  // 启用/禁用不应抛异常
  ok('禁用再启用不抛异常', (() => {
    try { DVI.plugin.disable('job-level-estimate');
          DVI.plugin.enable('job-level-estimate'); return true; }
    catch (e) { return false; }
  })());
}

/* ══════════ 运行日志 ══════════ */
section('㉗ 运行日志（用于直接定位问题）');
{
  const G = DVI.diag;
  ok('日志模块已暴露', !!G && typeof G.info === 'function');
  ok('已有启动日志', G.size() > 0, `实得 ${G.size()} 条`);

  G.clear();
  ok('clear 后为空', G.size() === 0);

  G.info('测试', '普通信息', 123);
  G.warn('测试', '警告');
  G.error('测试', '错误');
  ok('三种级别都能写入', G.size() === 3, `实得 ${G.size()}`);

  const all = G.all();
  ok('条目含级别与标签', all[0].level === 'info' && all[0].tag === '测试',
     JSON.stringify(all[0]));
  ok('条目含序号与相对时间', typeof all[0].n === 'number' && typeof all[0].ms === 'number');
  ok('多条参数被拼成消息', all[0].msg.includes('普通信息') && all[0].msg.includes('123'),
     all[0].msg);

  ok('tail 取最后 N 条', G.tail(2).length === 2);
  ok('tail 超出总数时返回全部', G.tail(999).length === 3);

  const txt = G.text();
  ok('text() 返回字符串', typeof txt === 'string' && txt.length > 0);
  ok('text() 含版本号', txt.includes(DVI.version), `版本 ${DVI.version}`);
  ok('text() 含日志正文', txt.includes('普通信息'));

  // 健壮性：日志自身绝不能把主流程带崩
  ok('畸形输入不抛异常（循环引用）', (() => {
    try {
      const a = { name: 'x' }; a.self = a;
      G.info('测试', a);
      G.info('测试', undefined, null, NaN, Symbol('s'), () => {});
      const big = {}; for (let i = 0; i < 50; i++) big['k' + i] = i;
      G.info('测试', big);
      G.error('测试', new Error('故意抛的'));
      return true;
    } catch (e) { return false; }
  })());
  ok('抛异常的 getter 也不炸', (() => {
    try {
      const bad = {}; Object.defineProperty(bad, 'boom',
        { enumerable: true, get() { throw new Error('getter 炸了'); } });
      G.info('测试', bad);
      return true;
    } catch (e) { return false; }
  })());

  // 环形缓冲：超容量应丢最旧的，且不无限增长
  ok('环形缓冲有上限', (() => {
    G.clear();
    for (let i = 0; i < 2000; i++) G.info('压测', 'x' + i);
    const n = G.size();
    const okCap = n > 0 && n <= 800;
    G.clear();
    return okCap;
  })());

  G.clear();
  G.info('测试', '恢复');
  ok('清空后还能继续写', G.size() === 1);
}

/* ══════════ 打包结构（防止插件被甩在主干之外） ══════════ */
section('㉘ 打包结构：插件必须在主干内部');
{
  // 曾经的故障：插件作为顶层 IIFE 追加在文件末尾，只靠「文件顺序」与主干维系。
  // 实际运行时它们整段没执行，而且不留任何痕迹（0 插件、0 报错）。
  // 现在改为注入到主干内部的 /*@DVI_PLUGINS@*/ 位置 —— 这几条断言守住它。
  ok('主干里没有残留的注入占位符', !code.includes('/*@DVI_PLUGINS@*/'));

  ok('插件段标记存在', code.includes('以下为打包进来的插件'),
     '插件的代码块应出现在产物里');

  const markerIdx = code.indexOf('以下为打包进来的插件');
  const trunkStart = code.indexOf('(function () {');
  ok('插件在主干的 IIFE 之内', trunkStart >= 0 && markerIdx > trunkStart,
     `主干起点 ${trunkStart}，插件 ${markerIdx}`);

  // 主干结束之后不应再有任何非空顶层代码
  const lines = code.split('\n');
  let closeLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '})();') { closeLine = i; break; }
  }
  const after = lines.slice(closeLine + 1).filter(l => l.trim()).length;
  ok('主干之后没有遗留的顶层代码', after === 0,
     `主干在第 ${closeLine + 1} 行结束，之后还有 ${after} 行非空内容`);

  // 启动痕迹必须在插件里，且插件必须在主干内部——否则痕迹机制形同虚设
  ok('插件带有启动痕迹代码', code.includes('data-dvi-plugin-20') && code.includes('data-dvi-plugin-10'));
  const markIdx = code.indexOf('data-dvi-plugin-20');
  ok('启动痕迹位于主干内部', markIdx > 0 && markIdx < code.lastIndexOf('})();'),
     `痕迹在 ${markIdx}，主干结束在 ${code.lastIndexOf('})();')}`);
}

/* ══════════ ctx 契约：插件用到的每一个接口都必须真的存在 ══════════ */
section('㉙ ctx 契约：插件用到的接口逐个实测');
{
  // 这节的由来：ctx.state 以前是 `state: state.s`（只透传原始字段），
  // 插件调 ctx.state.actionContext() 时报「不是函数」，而测试全绿。
  // 现在把插件实际用到的接口**逐个调一遍**，缺一个就红。
  const rec = DVI.plugin.get('job-level-estimate');
  const ctx = rec && rec.ctx;
  ok('能取到插件上下文', !!ctx);

  if (ctx) {
    // ── 取值类 ──
    ok('ctx.id 是字符串', typeof ctx.id === 'string' && ctx.id.length > 0, ctx.id);
    ok('ctx.EVT 存在且含所需事件',
       ctx.EVT && 'SNAPSHOT' in ctx.EVT && 'WORK' in ctx.EVT && 'BATCH' in ctx.EVT,
       ctx.EVT ? Object.keys(ctx.EVT).join(',') : '无');
    ok('ctx.core 指向公共 API', !!ctx.core && typeof ctx.core.calc === 'object');
    ok('ctx.priceOf 是函数', typeof ctx.priceOf === 'function');
    ok('ctx.log 是函数', typeof ctx.log === 'function');

    // ── bus ──
    ok('ctx.bus.on 是函数', typeof ctx.bus.on === 'function');
    ok('ctx.bus.on 可订阅且返回退订函数', (() => {
      try {
        const off = ctx.bus.on(ctx.EVT.SNAPSHOT, () => {});
        if (typeof off !== 'function') return false;
        off(); return true;
      } catch (e) { return false; }
    })());

    // ── settings ──
    ok('ctx.settings.get 是函数', typeof ctx.settings.get === 'function');
    ok('ctx.settings.set 是函数', typeof ctx.settings.set === 'function');

    // ── state：字段 + 方法都要可达（Proxy 的意义所在）──
    ok('ctx.state.me 字段可达（初始可为 null）', 'me' in ctx.state);
    ok('ctx.state.job 字段可达', 'job' in ctx.state);
    ok('ctx.state.tick 字段可达', typeof ctx.state.tick === 'number');
    ok('ctx.state.actionContext 是函数',
       typeof ctx.state.actionContext === 'function',
       `实得 ${typeof ctx.state.actionContext}`);
    ok('ctx.state.configSummary 是函数',
       typeof ctx.state.configSummary === 'function');
    ok('ctx.state.xpContext 是函数', typeof ctx.state.xpContext === 'function');
    ok('ctx.state.currentXpMult 是函数', typeof ctx.state.currentXpMult === 'function');

    // ── core 里的东西 ──
    ok('ctx.core.calc 可用', typeof ctx.core.calc.actionsToLevel === 'function');
    ok('ctx.core.data.ACTION.get 可用', typeof ctx.core.data.ACTION.get === 'function');
    ok('ctx.core.settings.onChange 是函数', typeof ctx.core.settings.onChange === 'function');
    ok('ctx.core.ui.ready 是函数', typeof ctx.core.ui.ready === 'function');

    // ── ui ──
    ok('ctx.ui.toast 是函数', typeof ctx.ui.toast === 'function');
    ok('ctx.ui.tip 是函数', typeof ctx.ui.tip === 'function');
    ok('ctx.ui.el 是函数', typeof ctx.ui.el === 'function');
    ok('ctx.ui.panel 是函数', typeof ctx.ui.panel === 'function');
    ok('ctx.ui.uninline 是函数', typeof ctx.ui.uninline === 'function');
    ok('ctx.ui.inline 可当函数调用', typeof ctx.ui.inline === 'function');
    ok('ctx.ui.inline.refresh 是函数', typeof ctx.ui.inline.refresh === 'function');

    // ── 真正的端到端：拿一个真实配方跑通完整渲染 ──
    let e2eErr = null;
    let e2eOut = 'undefined';
    (() => {
      DVI.state.reduce({ tick: 100, m: [{
        t: 'welcome', protocol: 3, seed: 1, online: 5, build: 'x',
        you: { id: 1, name: 'E2E', skills: { mining: DVI.calc.xpForLevel(30) },
              equipment: { pickaxe: 81 }, perks: {}, masteries: {}, lastTick: 100 },
        windows: [],
      }] });
      try {
        // 宿主必须是「真实元素的样子」：插件用的是 host.dataset.job，
        // 而不是 getAttribute（浏览器里两者都行，但 dataset 更常用）。
        const host = { dataset: { job: '1' }, getAttribute: () => '1' };
        e2eOut = rec.def.renderRow(ctx, host);
      } catch (e) { e2eErr = (e && e.message) || String(e); }
    })();
    ok('用当前状态跑一次真实渲染不抛异常',
       e2eErr === null && (e2eOut === null || typeof e2eOut === 'string'),
       e2eErr ? `抛异常：${e2eErr}` : `返回 ${typeof e2eOut}`);
    ok('渲染结果确实带上了预估内容',
       typeof e2eOut === 'string' && e2eOut.includes('需'),
       typeof e2eOut === 'string' ? e2eOut.slice(0, 120) : String(e2eOut));
  }
}

/* ══════════ 按需刷新（性能约定） ══════════ */
section('㉚ 按需刷新：高频渲染不得重算');
{
  // 由来：游戏每次重绘都会重跑 render，若每次都重新计算（逐级累加经验），
  // 每秒几十次做无用功，对浏览器和设备都是负担。
  // 约定：render 只读缓存，recompute 才清缓存重算。
  const rec = DVI.plugin.get('job-level-estimate');
  const def = rec && rec.def;
  ok('插件实例可取', !!def && !!def.cache);

  if (def) {
    // 造一个已登录状态，让 computeRow 能真的算出东西
    DVI.state.reduce({ tick: 100, m: [{
      t: 'welcome', protocol: 3, seed: 1, online: 5, build: 'x',
      you: { id: 1, name: 'Cache', skills: { mining: DVI.calc.xpForLevel(30) },
            equipment: { pickaxe: 81 }, perks: {}, masteries: {}, lastTick: 100 },
      windows: [],
    }] });

    let calls = 0;
    const orig = def.computeRow;
    def.computeRow = function (...a) { calls++; return orig.apply(this, a); };

    const host = { dataset: { job: '1' }, getAttribute: () => '1' };

    def.cache.clear();
    const first = def.renderRow(rec.ctx, host);
    const afterFirst = calls;
    ok('首次渲染会真的计算', afterFirst === 1, `调用 ${afterFirst} 次`);

    for (let i = 0; i < 20; i++) def.renderRow(rec.ctx, host);
    ok('后续 20 次渲染全部命中缓存，零重算',
       calls === afterFirst, `累计调用 ${calls} 次`);

    ok('缓存命中返回同一份结果', def.renderRow(rec.ctx, host) === first);

    def.recompute(rec.ctx, true);
    ok('recompute 清空了缓存', def.cache.size === 0, `残留 ${def.cache.size} 条`);

    def.renderRow(rec.ctx, host);
    ok('清空后再渲染会重新计算', calls === afterFirst + 1, `累计 ${calls} 次`);

    // 自动模式下的节流：非强制重算在 MIN_GAP 内应被忽略
    ok('非强制重算受最小间隔约束', (() => {
      def.recompute(rec.ctx, true);          // 先算一次，刷新 lastCalc
      const before = def.cache.size;
      def.cache.set(999999, 'x');            // 塞个哨兵
      const didRun = def.recompute(rec.ctx, false);   // 立刻再要求，应被节流
      return didRun === false && def.cache.has(999999) && before >= 0;
    })());

    def.computeRow = orig;
    def.cache.clear();
  }

  // 默认必须是「按需」，不能默认成自动 —— 否则又变回每帧重算
  ok('默认刷新方式是「按需」',
     Number(rec.def.settings.find(s => s.key === 'refreshMode').default) === 0);

  // 主干必须提供主动重算的入口
  ok('主干声明了 REFRESH 事件', DVI.EVT.REFRESH === 'core:refresh');

  /* 只允许往「作业行内部」注入，不许往面板布局里塞新节点。
   * 曾经在 [data-routes] 前后插过独立刷新按钮，两次都把游戏面板撑坏 ——
   * 那个容器是 flex/grid，多一个兄弟节点就改变整个排版。 */
  const anchors = DVI.ui.inline.report();
  const layoutAnchors = anchors.filter(a =>
    /\[data-routes\]\s*$/.test((a['候选选择器'] || '').split('|').pop().trim()) ||
    (a['候选选择器'] || '').includes('[data-routes]'));
  ok('没有往面板布局容器上挂锚点（只挂在行内部）',
     layoutAnchors.length === 0,
     layoutAnchors.map(a => a['锚点'] + ' → ' + a['候选选择器']).join(' ; '));

  ok('重算是靠「点标注」触发的，不需要额外节点',
     typeof DVI.plugin.get('job-level-estimate').def.onDocClick === 'function');
}

/* ══════════ tooltip 体积（防止撑爆屏幕） ══════════ */
section('㉛ 原生 tooltip 必须克制');
{
  // 由来：标注的提示框曾经堆到 22 行（头部 4 + 配置 6 + 分段 11 + 说明 1），
  // 而游戏的原生提示框没有滚动条 —— 直接撑破屏幕。
  // 这里守住行数上限。
  const LIMIT = 12;

  const rec = DVI.plugin.get('job-level-estimate');
  DVI.state.reduce({ tick: 100, m: [{
    t: 'welcome', protocol: 3, seed: 1, online: 5, build: 'x',
    you: { id: 1, name: 'Tip', skills: { mining: DVI.calc.xpForLevel(1) },
          equipment: { pickaxe: 84 }, perks: { quick: 10 },
          masteries: { xp: 20 }, lastTick: 100, guildBonus: 0.05 },
    windows: [{ fromTick: 0, toTick: 9999, xpMult: 1.5, rarityMult: 1 }],
  }] });

  // 挑一个「跨级很多」的场景：1 级去做高经验配方，必然有很多分段
  const rows = [];
  for (const id of [1, 8, 12, 42]) {
    if (!D.ACTION.get(id)) continue;
    rec.def.cache.clear();
    const html = rec.def.renderRow(rec.ctx, { dataset: { job: String(id) } });
    if (html) rows.push({ id, html });
  }

  ok('至少渲染出一行', rows.length > 0, `实得 ${rows.length} 行`);

  const countLines = (html) => {
    const m = /data-tip-lines="([^"]*)"/.exec(html);
    if (!m) return 1;
    return m[1].split('|').filter(Boolean).length;
  };

  for (const r of rows) {
    const n = countLines(r.html);
    ok(`配方 ${r.id} 的提示框行数 ≤ ${LIMIT}`, n <= LIMIT, `实得 ${n} 行`);
  }

  ok('提示框内容里不含分隔符 |（否则会被拆行）',
     rows.every(r => !/data-tip-lines="[^"]*\|[^"]*"/.test('') &&
                     (() => {
                       const m = /data-tip-lines="([^"]*)"/.exec(r.html);
                       return !m || !m[1].includes('||');
                     })()));

  rec.def.cache.clear();
}

/* ══════════ 轻量：不监听 DOM 变动 ══════════ */
section('㉜ 注入保持轻量：不按 DOM 变动重跑');
{
  // 由来（两轮弯路）：
  //   ① 先为了让标注在游戏重绘后立刻补回，挂了 MutationObserver
  //      并在**每一次** DOM 变动上同步重注入 → 用户反馈「技能列表一直闪」
  //   ② 改成「同帧注入 + 相关性过滤」→ 闪没了，但用户反馈「掉帧好厉害」
  //
  // 结论：这份预估只需要「及时、相对准确」，不随 tick 变化。
  // **根本不监听 DOM 变动**才是对的 —— 每秒做一次存在性检查即可。

  ok('提供 startInlineWatch（而非观察器）',
     typeof DVI.ui.startInlineWatch === 'function');

  // 最关键的护栏：不允许再创建 MutationObserver。
  // 一旦有人把观察器加回来，掉帧就会复发。
  ok('没有创建任何 MutationObserver（不做按变动重跑）',
     observerInstances.length === 0,
     `实得 ${observerInstances.length} 个：按 DOM 变动重跑会直接拖垮帧率`);

  // 存在性检查是「数量对得上就返回」，所以常态下几乎零成本。
  // 这里验证自愈能力：标注被打扫掉后，补一次就能回来。
  const host = makeEl('button');
  host.dataset.job = '1';
  documentStub.body.appendChild(host);
  selectorResults.set('[data-routes] [data-job]', [host]);

  DVI.ui.inline.add({ id: 'lite-anchor', selector: '[data-routes] [data-job]',
                      where: 'beforeend', render: () => '<span class="dvi-inline-note">x</span>' });
  DVI.ui.inline.applyAll();
  const countNotes = () => Array.from(host.children)
    .filter(c => c.getAttribute('data-dvi-inline') === 'lite-anchor').length;
  ok('注入生效', countNotes() === 1, `实得 ${countNotes()}`);

  host.children.forEach(c => { if (c.getAttribute('data-dvi-inline')) c.remove(); });
  ok('游戏重绘后标注确实被抹掉', countNotes() === 0);

  DVI.ui.inline.applyAll();          // 存在性检查发现数量不符时会调它
  ok('自愈：补一次就回来', countNotes() === 1, `实得 ${countNotes()}`);

  // 重复补注不应堆积
  for (let i = 0; i < 40; i++) {
    host.children.forEach(c => { if (c.getAttribute('data-dvi-inline')) c.remove(); });
    DVI.ui.inline.applyAll();
  }
  ok('40 轮「抹掉 → 补回」后仍只有一份', countNotes() === 1, `实得 ${countNotes()}`);

  ok('清理锚点后不留残留', (() => {
    DVI.ui.inline.remove('lite-anchor');
    return countNotes() === 0;
  })());

  // ── 页面不可见时必须完全停掉 ──
  // 用户反馈：「放在后台一段时间回来好像还在持续运行」——
  // 一个静态的小东西不该在后台消耗任何东西。
  DVI.ui.startInlineWatch();
  ok('提供运行统计', typeof DVI.ui.inline.stats === 'function');
  ok('可见时巡检进行中', DVI.ui.inline.stats().watching === true,
     JSON.stringify(DVI.ui.inline.stats()));

  documentStub.hidden = true;
  documentStub.dispatch('visibilitychange');
  ok('切到后台后巡检停止', DVI.ui.inline.stats().watching === false,
     JSON.stringify(DVI.ui.inline.stats()));

  documentStub.hidden = false;
  documentStub.dispatch('visibilitychange');
  ok('切回前台后巡检恢复', DVI.ui.inline.stats().watching === true,
     JSON.stringify(DVI.ui.inline.stats()));

  ok('统计里带补注次数', typeof DVI.ui.inline.stats().reinjects === 'number',
     `实得 ${DVI.ui.inline.stats().reinjects}`);
}

/* ══════════ 目标等级 ══════════ */
section('㉝ 目标等级：可以升到指定级，而不只是下一级');
{
  const rec = DVI.plugin.get('job-level-estimate');
  const def = rec.def;
  const ctx = rec.ctx;

  // 造一个「挖矿 30 级」的状态
  DVI.state.reduce({ tick: 100, m: [{
    t: 'welcome', protocol: 3, seed: 1, online: 5, build: 'x',
    you: { id: 1, name: 'Tgt', skills: { mining: DVI.calc.xpForLevel(30) },
          equipment: { pickaxe: 81 }, perks: {}, masteries: {}, lastTick: 100 },
    windows: [],
  }] });

  const xp = DVI.state.s.me.skills.mining;
  ok('当前等级算出来是 30', DVI.calc.levelForXp(xp) === 30,
     `实得 ${DVI.calc.levelForXp(xp)}`);

  const setT = (v) => { ctx.settings.set('target', v); def.cache.clear(); };

  setT(0);
  ok('目标 0 → 下一级（31）', def.resolveTarget(ctx, 'mining', xp) === 31,
     `实得 ${def.resolveTarget(ctx, 'mining', xp)}`);

  setT(50);
  ok('目标 50 → 就是 50', def.resolveTarget(ctx, 'mining', xp) === 50,
     `实得 ${def.resolveTarget(ctx, 'mining', xp)}`);

  setT(31);
  ok('目标等于下一级时也正确', def.resolveTarget(ctx, 'mining', xp) === 31);

  // 真正影响渲染结果：目标不同，得出「还需几次」应当不同
  const jobHost = { dataset: { job: '1' } };
  const countFor = (v) => {
    setT(v);
    const html = def.renderRow(ctx, jobHost) || '';
    const m = /共 ([\d,]+) 次/.exec(html);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  const nNext = countFor(0);
  const nFar = countFor(60);
  ok('渲染结果会随目标等级变化', nNext != null && nFar != null && nFar > nNext,
     `下一级 ${nNext} 次 vs 目标 60 级 ${nFar} 次`);

  // 提示里要写明当前目标，并指出改它的入口
  setT(60);
  const html60 = def.renderRow(ctx, jobHost) || '';
  ok('提示里写出当前目标', html60.includes('升到第 60 级'), html60.slice(0, 120));
  ok('提示里指出修改入口', html60.includes('设置目标等级'));

  // 快捷操作已声明，并挂了菜单/面板
  ok('声明了快捷操作', Array.isArray(def.quickActions) && def.quickActions.length > 0);
  const qa = (def.quickActions || [])[0];
  ok('快捷操作有标签与执行体',
     qa && typeof qa.label === 'string' && typeof qa.run === 'function', JSON.stringify(qa && qa.label));
  ok('快捷操作挂了菜单图标', !!(qa && qa.menuIcon));

  // 工具函数应在 [0,120] 内夹取（用桩替换 prompt 验证）
  const origPrompt = sandbox.prompt;
  sandbox.prompt = () => '999';
  try { qa.run(ctx); } catch (e) { /* toast 在桩里可能不可用 */ }
  sandbox.prompt = origPrompt;
  ok('超范围输入被夹到 120', Number(ctx.settings.get('target')) === 120,
     `实得 ${ctx.settings.get('target')}`);

  setT(0);
  def.cache.clear();
}

/* ══════════ 面板分区必须幂等 ══════════ */
section('㉞ 面板分区幂等：重复渲染不累积');
{
  // 由来：用户报「右下角按钮打开的面板无限向下延伸」。
  // 根因是 ui.panel() 原本是**纯追加**，而插件把它挂在定时器上
  // （每 1.5 秒调一次）→ 每 tick 多一个分区，窗口越拉越长。
  // 从主干改成幂等：同一 (插件, 标题) 只建一次，复用并清空。
  const rec = DVI.plugin.get('example-networth-hourly') || DVI.plugin.get('10-example-job-yield');
  const rec2 = DVI.plugin.get('job-level-estimate');
  ok('能取到插件上下文', !!(rec && rec.ctx && rec2 && rec2.ctx));

  if (rec && rec.ctx) {
    DVI.ui.toggle(true);
    const b = () => DVI.ui.body();

    // 连着取 50 次同一个分区
    for (let i = 0; i < 50; i++) rec.ctx.ui.panel('幂等测试分区');

    const secs = () => b().querySelectorAll('[data-dvi-sec]')
      .filter(s => s.textContent === '幂等测试分区');
    const boxes = () => b().querySelectorAll('[data-dvi-panel]');

    ok('50 次调用后标题分区仍然只有 1 个', secs().length === 1,
       `实得 ${secs().length} 个`);

    // 每次返回前应清空，所以箱内不该累积
    const box = rec.ctx.ui.panel('幂等测试分区');
    for (let i = 0; i < 20; i++) {
      const bx = rec.ctx.ui.panel('幂等测试分区');
      bx.appendChild(rec.ctx.ui.el('div', { class: 'dvi-row' }, `第 ${i} 次`));
    }
    ok('箱内不累积（每次返回前已清空）',
       box.children.length === 1,
       `实得 ${box.children.length} 个子节点`);

    // 不同插件用同标题也应各自独立
    if (rec2) {
      rec.ctx.ui.panel('同名分区');
      rec2.ctx.ui.panel('同名分区');
      const all = b().querySelectorAll('[data-dvi-sec]')
        .filter(s => s.textContent === '同名分区');
      ok('不同插件的同名分区互不干扰', all.length === 2,
         `实得 ${all.length} 个`);
    }

    // 面板整体重绘后仍能正常重建
    DVI.ui.renderSettings();
    const again = rec.ctx.ui.panel('幂等测试分区');
    ok('面板重绘后分区可重建', !!again && !!again.parentNode);
    again.appendChild(rec.ctx.ui.el('div', { class: 'dvi-row' }, 'x'));
    ok('重建后仍只有一个分区', secs().length === 1, `实得 ${secs().length} 个`);

    DVI.ui.toggle(false);
  }

  // 主干自用分区同样幂等
  ok('主干自用分区可用', typeof DVI.ui.ownSection === 'function');
  if (typeof DVI.ui.ownSection === 'function') {
    DVI.ui.toggle(true);
    for (let i = 0; i < 30; i++) DVI.ui.ownSection('自检', 'trunk:test');
    const n = DVI.ui.body().querySelectorAll('[data-dvi-panel]')
      .filter(x => x.getAttribute('data-dvi-panel') === 'trunk:test').length;
    ok('主干分区 30 次调用仍只有 1 个', n === 1, `实得 ${n} 个`);
    DVI.ui.toggle(false);
  }
}

/* ══════════ 导出（只做下载） ══════════ */
(async () => {
  section('⑳ 导出成文件（只保留下载）');

  ok('不再提供剪贴板能力', DVI.ui.copyText === undefined && DVI.ui.copyOrDownload === undefined,
     '复制功能已按要求移除');
  ok('导出仍可用', typeof DVI.ui.downloadText === 'function');

  let clicked = null;
  const origCreate = documentStub.createElement;
  documentStub.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'a') el.click = function () { clicked = this; };
    return el;
  };

  const okDown = DVI.ui.downloadText('{"a":1}', 'x.json', 'application/json');
  ok('downloadText 返回成功', okDown === true);
  ok('确实触发了下载', !!clicked && clicked.download === 'x.json',
     `download=${clicked && clicked.download}`);
  ok('下载的是 blob 地址', String(clicked && clicked.href).startsWith('blob:'));

  documentStub.createElement = origCreate;

  /* ══════════ 输出 ══════════ */
  console.log(results.join('\n'));
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`通过 ${pass} / ${pass + fail}${fail ? `　失败 ${fail}` : '　全部通过 ✓'}`);
  process.exit(fail ? 1 : 0);
})();
