# DVI Tools —— 核心主干

对标 MWITools 的定位：**主干不做业务，只提供地基**。具体功能（利润面板、行情记录、资产曲线…）以插件形式挂上来。

```
dvi-tools.user.js   ← 最终用户脚本（构建产物，直接装这个）
├── src/core.js     ← 主干源码（改这个）
├── build.py        ← 把游戏数据内联进主干
├── test/test.js    ← Node 冒烟测试（83 项断言）
├── examples/       ← 插件模板
└── dvi-tools.core.json  ← 数据副本，供单测引用
```

---

## 安装

**只需要装一个文件：`dvi-tools.user.js`**（其余是源码、构建脚本和测试，不用管）

1. 把 `dvi-tools.user.js` 拖进 Tampermonkey（或复制内容新建脚本），保存
2. 打开游戏 —— **页面上不会多出任何东西**
3. 装完第一次会有一句提示，之后永久安静

需要看面板时：点油猴扩展图标 → **「打开 DVI Tools 面板」**。

### 无感是怎么做到的

| 设计 | 说明 |
|---|---|
| **默认零痕迹** | 不往页面插任何常驻元素。面板只有在你要看的时候才出现 |
| **零配置** | 所有功能插件默认全开，没有设置向导，装完即用 |
| **首次提示只说一次** | 之后不再打扰。有异常才写控制台 |
| **只想点按钮？** | 菜单里可切到「右下角按钮」模式，随时能切回无痕迹 |
| **不挡视线** | 面板在右下角，宽度 340px，可随时关闭 |

**想要按钮模式**：油猴菜单 →「显示方式」→ 切换即可。

你还可以把不需要的功能单独关掉：面板里每个插件都有独立开关。
但这属于"想折腾时"的选项，默认状态下你不需要碰它。

### 装完先确认一下

点油猴菜单 → **「运行环境自检」**，它会逐项报告：沙箱状态、GM API、
数据表、收包钩子、UI 注入、只读约束。控制台里也会自动跑一次。

> **为什么必须打包成单个文件**：Tampermonkey 给**每个用户脚本独立的沙箱**。
> 所以「主干」和「插件」如果是两个脚本，插件读 `window.DVI` 是**读不到**的。
> 本项目的做法是把插件源文件放在 `plugins/`，构建时拼进同一个脚本（MWITools 也是这么做的）。
> 主干同时也把 API 发布到 `unsafeWindow`，所以你要是想拆成独立脚本也能用——
> 插件里按 `unsafeWindow.DVI || window.DVI` 读取即可。

---

## 主干提供了什么

| 模块 | 内容 |
|---|---|
| `data` | 290 物品 / 221 配方 / 383 站点 / 20 怪物，含 id↔名称索引、按技能分组索引 |
| `calc` | 经验曲线、耗时公式、利润计算、强化期望 —— 全部是**纯函数** |
| `state` | 把 WS 消息流归约成可读状态：自己的存档、视野内玩家、市场行情、产出统计 |
| `bus` | 事件总线：`core:ready` / `game:welcome` / `game:offline` / `game:batch` / `game:market` … |
| `net` | 只读的 WebSocket 钩子（浏览器已做分包重组，无需拼帧） |
| `settings` | 持久化设置，命名空间按插件隔离 |
| `ui` | 样式注入、悬浮窗、Toast、以及「在主干面板里追加分区」的能力 |
| `plugin` | 插件注册表：注册 / 启用 / 停用 / 渲染开关面板 |

### 计算能力一览

```js
DVI.calc.xpForLevel(50)          // 达到 50 级所需累计经验
DVI.calc.levelForXp(1234567)     // 累计经验 → 等级
DVI.calc.levelProgress(1234567)  // 当前等级内进度 0~1

DVI.calc.actionTicks(action, { level, quickPerk, toolFactor, homeFactor, masteryFactor })
DVI.calc.unitsPerHour(action, opts)
DVI.calc.analyse(action, { level, priceOf, taxBp })
//  → { ticks, unitsPerHour, grossPerHour, costPerHour, netPerHour, xpPerHour, profitPerTick }

DVI.calc.enhanceChance(tier, { lecternBonus, masteryFactor })
DVI.calc.enhanceCost(tier, qualityIdx)
DVI.calc.enhanceExpected(5, 0)   // 强化到 +5 的期望金币/碎片/次数
```

> **耗时公式的正确形式**：`耗时 = baseTicks ÷ 速度因子`。
> `IT()` 是「每 tick 推进的进度」而不是耗时——这一点被真实数据校验过（预测 50.9 产出 vs 实测 51，偏差 0.2%）。

---

## 融入游戏：内联注入

这是主干最重要的能力。**MWITools 不是"叫出来的工具"，而是长在游戏界面里的**——
它用 MutationObserver 盯着游戏 DOM，再用 `insertAdjacentHTML` 把自己的内容插进
游戏已有的面板（`.BattlePanel_*`、`.MarketplacePanel_*` 之类）。

dvi-tools 用同样的思路，但**锚点更稳**：MWI 用的是 CSS-module 哈希
（`Component_Element__hash`，每次构建都变），而 DVI 用的是朴素语义类名
（`route`、`chat-card`、`shop-name`）和 572 个自带的 `data-*` 属性。

### 已经落地的示范

`plugins/20-job-level-estimate.js` —— 就是你说的那个功能：
**在作业列表里就地显示"还需几次行动、多长时间才能升到目标等级"**。

锚点是从客户端代码里读出来的：

```html
<button class="route" type="button" data-job="{配方id}">
  …
  <span class="route-drops route-where" data-tip-name="…" data-tip-lines="…">Where?</span>
</button>
```

注意到 `<span data-tip-name data-tip-lines>` 了吗——**游戏有一套原生 tooltip 约定**。
所以注入的元素只要带上这两个属性，提示框就和游戏自带的长得一模一样，看不出是外挂的。

### 怎么用这个能力

```js
ctx.ui.inline.add({
  id: 'my-hint',                          // 唯一标识，同时用作去重标记
  selector: 'button.route[data-job]',     // 宿主元素
  where: 'beforeend',                     // beforeend | afterend | beforebegin | afterbegin
  filter: (host) => true,                 // 可选：哪些宿主才注入
  render: (host) => `<span>…</span>`,     // 返回 HTML 字符串 / 节点 / null（null = 跳过）
});
```

框架负责：

- **自动重注入** —— 游戏重绘会把你的节点一起换掉，观察器发现后会补上
- **去重** —— 每个宿主只注入一次，靠 `data-dvi-inline="<id>"` 标记
- **节流** —— 一帧一次、最小 120ms 间隔，不拖慢游戏
- **隔离** —— 注入内容带 `.dvi-inline` 类，且单个宿主失败不影响其它宿主

排查时用控制台的 `DVI.ui.inline.report()`，会列出每个锚点匹配到多少宿主、成功注入多少。

### 还没对准的锚点

我读出了锚点**格式**，但没法在真实页面上验证每一处。所以主干里带了一个采集器：

**油猴菜单 → 「采集游戏界面结构」** —— 它会扫描作业列表、市场、仓库、技能等关键区域，
把元素结构（标签、类名、data 属性、简短文本）导出成 JSON 并复制到剪贴板。

把它发给我，我就能写出精确的锚点，把更多功能对到正确的位置上。

---

## 只读是架构级约束

不是"我们约定不发送"，而是**主干根本没有这个能力**：

```js
DVI.net.send          // undefined
DVI.net.socket        // undefined（只暴露 socketUrl 字符串）
ctx.core.net.send     // undefined —— 插件上下文里同样拿不到
```

`net` 只做了 `MessageEvent.prototype.data` 的 getter 劫持，读取后原样返回。
没有任何代码路径能把数据写回游戏。测试里专门有一组断言守着这条线（⑨ 只读约束）。

---

## 写一个插件

把下面这段存成新脚本（或直接放进主干的插件列表）即可挂载：

```js
(function () {
  'use strict';
  const DVI = window.DVI;
  if (!DVI) { console.warn('DVI Tools 主干未加载'); return; }

  DVI.plugin.register({
    id: 'my-panel',
    name: '我的面板',
    nameEn: 'My Panel',
    description: '在主干面板里显示当前作业的每小时收益',
    api: 1,                    // 依赖的核心 API 版本
    defaultEnabled: true,

    // 声明式设置项，主干会自动渲染成表单并持久化
    settings: [
      { key: 'tax', label: '税率 (%)', type: 'number', default: 2, min: 0, max: 100 },
    ],

    // 注册时调用一次：适合建监听、挂事件
    setup(ctx) {
      ctx.bus.on(ctx.EVT.SNAPSHOT, () => this.refresh(ctx));
      ctx.bus.on(ctx.EVT.BATCH,    () => this.refresh(ctx));
      ctx.log('已就绪');
    },

    // 被启用 / 停用时调用
    enable(ctx)  { this.refresh(ctx); },
    disable(ctx) { ctx.ui.toast('我的面板已停用'); },

    refresh(ctx) {
      const me = ctx.state.me;
      if (!me || !ctx.state.job) return;

      const action = ctx.core.data.ACTION.get(ctx.state.job.jobId);
      if (!action) return;

      const res = ctx.core.calc.analyse(action, {
        level: ctx.core.calc.levelForXp(me.skills[action.skill] || 0),
        quickPerk: me.perks?.quick || 0,
        priceOf: ctx.priceOf,               // 已内置「卖价→买价→基础价值」回退
        taxBp: ctx.settings.get('tax') * 100,
      });
      if (!res) return;

      // 在主干面板里追加一个分区
      const box = ctx.ui.panel('我的面板');
      box.appendChild(ctx.ui.el('div', { class: 'dvi-row' },
        `${action.name}：${Math.round(res.netPerHour).toLocaleString()} 金/小时`));
      box.appendChild(ctx.ui.el('div', { class: 'dvi-row' },
        `产出 ${res.unitsPerHour.toFixed(0)}/h · 经验 ${Math.round(res.xpPerHour)}/h`));
    },
  });
})();
```

### 插件上下文（`ctx`）都有什么

| 字段 | 说明 |
|---|---|
| `ctx.core` | 主干公共 API 本体（`data` / `calc` / `state` / `bus` / `ui` …） |
| `ctx.state` | 归约后的游戏状态（`me` / `world` / `players` / `market` / `offline` / `tick`） |
| `ctx.priceOf(itemId)` | 取参考价，自动回退 |
| `ctx.bus` / `ctx.EVT` | 事件总线与事件名常量 |
| `ctx.settings.get(k)` / `.set(k,v)` | 插件私有设置，键名自动加 `插件id.` 前缀 |
| `ctx.ui.toast(msg)` / `.el(tag, attrs, text)` / `.panel(title)` | UI 原语 |
| `ctx.log(...)` | 带插件名前缀的日志 |

核心 API 版本变化时会拒绝加载声明了更高版本的插件，避免插件静默跑错。

---

## 构建与测试

游戏更新后，数据表可能需要重新提取（见 `web-game-bundle-teardown` 流程），然后：

```bash
cd dvi-tools
python build.py          # 重新内联数据 + 打包 plugins/ → dvi-tools.user.js
node test/test.js        # 108 项断言，全绿才算通过
node --check dvi-tools.user.js   # 独立语法校验（不依赖测试桩）
```

测试**直接加载构建产物**（不是源码副本）在 Node 的最小 DOM 桩里跑。
桩里刻意让 `window` 与 `unsafeWindow` 是**两个不同对象**，以还原油猴的沙箱模型——
否则测不出「跨脚本能否共享」这个最容易出错的地方。

覆盖范围：

- 数据表加载与索引
- 经验曲线（对照公式、单调性、等级↔经验互逆）
- 耗时公式（对照实测标定的 4.854 tick）
- 利润计算（含税率、材料成本递归展开）
- 强化（成功率、费用、期望值）
- 状态归约（welcome / enter / move / leave / market / batch）
- 插件注册表（注册、启停、设置隔离、API 版本守卫）
- **只读约束**（确认 `send` 在任何路径下都拿不到）
- **油猴兼容性**（沙箱发布、`document-start` 时 body 为空、自检函数）
- **userscript 头部元信息**（`@match` / `@grant` 完整性、无超长行）

这样改完主干能立刻知道有没有打断既有行为，不用等到游戏里才发现。

---

## 已知边界

- 测试是**逻辑层**的验证，不能替代在真实 Tampermonkey 里跑一次。
  所以装了之后请先跑一遍「运行环境自检」——它就是为了补上这一段。
- **绝对收益会偏低**：装备品质加成表、精通系数表还是空缺，目前按 `1.0` 处理。
  等拿到真实存档就能反推补上。

---

## 下一步

主干就绪后，可以按可行性报告里的优先级把功能挂上来：

1. **离线收益报告** —— 数据由 `game:offline` 事件直接给出，最容易出成品
2. **利润计算面板** —— `calc.analyse` 已经写好并测过，只剩 UI
3. **市场行情记录** —— 用 `ctx.bus.on(EVT.MARKET)` 累积时间序列
4. **每日资产曲线** —— 按天快照 `state.me` 的资产

等真实数据到位后，需要回头校验两件事：**装备品质加成的数值表**、**精通系数表**——
这两个还是空缺，目前按 1.0 处理，会让绝对收益偏低。
