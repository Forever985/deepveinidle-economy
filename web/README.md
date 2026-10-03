# DVI 利润网

> Deep Vein Idle 的配方利润与产业链分析。**纯静态、只读**，
> 部署到 GitHub Pages 免费托管。

架构参考 [MewKonomy/Milkonomy](https://github.com/forever983/mewkonomy)（奶��奶牛放置的利润工具），
但数据与 API 全部换成 DVI 的 —— 采集三系零终端品、farming 有生长时间、
烹饪会烧焦、偷窃会被抓，这些 Milkonomy 都没有。

---

## 快速开始

```bash
cd web
npm install          # 依赖装在 web/node_modules（局部，不污染全局）
npm run dev          # 开发
npm test             # 计算层测试（零依赖，68 项）
npm run build        # 产出 dist/
```

> **`.npmrc` 已配国内镜像**（`registry.npmmirror.com`），与 milkonomy 一致。
> 不配的话 `registry.npmjs.org` 会非常慢。这个文件也会被 GitHub Actions 读取。

**游戏改版后**重跑数据提取即可，代码一行不用改：

```bash
cd dvi_probe        # 重新从客户端 bundle 提取
# ……
cd ../web
python prepare-data.py
```

---

## 部署到 GitHub Pages（免费）

本仓库已带 workflow：`.github/workflows/deploy-web.yml`。

1. 把仓库推到 GitHub（默认分支叫 `main`）
2. 仓库 **Settings → Pages → Build and deployment → Source** 选
   **GitHub Actions**
3. 推上去后 Actions 会自动：装依赖 → 类型检查 → 跑测试 → 构建 → 部署

之后每次 `web/` 有改动推 `main`，都会自动重新部署。

**为什么要 `base: './'`**（已在 `vite.config.ts` 里）：
GitHub Pages 挂在 `用户名.github.io/仓库名/` 这样的**子路径**下，
用绝对路径 `/assets/...` 会全部 404。相对路径才能正常工作。

---

## 数据从哪来

游戏数据在**构建前**由 `prepare-data.py` 从 `dvi_probe` 的提取结果生成
（`public/data/dvi-gamedata.json`，约 86 KB）：

```
物品 290 · 配方 221 · 站点 383 · 怪物 20
游戏数据 0.0.1164 · commit 1db7eb7
```

来源是**客户端 bundle 提取**（只读），不涉及任何服务端接口，
不发送任何游戏指令。

---

## 关键设计

### 价格三层来源，每个数字都标出处

不纠结「按市场价还是按自产成本」——这两者常常得出相反结论。
所以三层并存，UI 上用小圆点标出来：

| 来源 | 含义 |
|---|---|
| <span>●</span> 市场价 | 导入的价格快照 |
| <span>●</span> 兜底价 | 物品基础价值（游戏里就该有的兜底） |
| <span>●</span> 手动价 | 你自己指定，优先级最高 |

**成本按 ask、收益按 bid** —— 保守口径，不虚高。

### 中间品 0 价内部流转

整链核算时，上游产物与下游原料都按 0 价记账，于是只认两笔账：
买进来的第一批原料、最后卖出去的成品。

> ⚠️ 这里的拓扑是**分叉**的：`Copper ─┐` `Tin ─┴→ Bronze bar`。
> 早期实现只检查「紧邻的下一位」，漏判了 Copper，
> 导致中间品被卖一次又算一次成本 —— 利润凭空蒸发。
> 现在改成前后两趟扫全链。测试里专门有一条断言守着这个。

### 两种口径会显著改变排名，所以必须能看见

| 开关 | 影响 |
|---|---|
| **生长口径** | farming 的 `grow` 是 800~9000 tick，往往才是时间瓶颈。并行=等待期去干别的；单线程=干等 |
| **收益口径** | 保守（bid）/ 乐观（ask） |

farming 在这两种口径下的排名**天差地别** —— 所以不设成「自动判断」，
而是让用户自己选，并且默认给放置游戏常态（并行）。

### 期望值：DVI 独有

| 字段 | 影响 |
|---|---|
| `burn` | 烹饪烧焦，失败要多试几次 → 原料与工时都摊进期望 |
| `caught` | 偷窃被抓，除了失败还晕眩（`stunTicks`）|
| `bonus` | 概率额外掉落 → 期望产量 > 名义产量 |
| `grow` | 生长时间 |

> ⚠️ 失败率用「需求等级处 `chanceAtReq`、随等级线性降到 `safeAtLevel` 的 0」
> —— 这是**从字段名与取值反推的合理形式**，不是从游戏代码里读出的精确实现，
> **需要用真实数据校验**。改版或实测不符时只改 `src/calc/expected.ts` 一个文件。

---

## 目录

```
web/
├── prepare-data.py        从 dvi_probe 生成网页数据
├── public/data/           游戏数据（构建产物，已入库）
├── src/
│   ├── calc/              ★ 纯逻辑层，零依赖，可被 Node 直接测
│   │   ├── price.ts         三层价格来源
│   │   ├── expected.ts      期望值（burn/caught/bonus/grow）
│   │   ├── steps.ts         单步计算
│   │   ├── chain.ts         整链核算（0 价内部流转）
│   │   └── rank.ts          利润排行
│   ├── stores/            口径设置与价格（持久化到 localStorage）
│   ├── components/        界面组件
│   └── App.vue
└── test/calc.test.ts      68 项断言
```

**逻辑与 UI 彻底分离**（这是从 Milkonomy 抄来的一条教训）：
筛选条件写错会让列表列不出东西，**这类错误只有拿真实数据跑一遍才看得见**。
所以 `src/calc/` 不 import 任何 Vue，可以被 Node 直接调用。

测试用 Node 原生类型剥离跑，**不需要装任何测试框架**：

```bash
node --experimental-strip-types test/calc.test.ts
```

> 因此 `calc/` 里刻意**不用构造函数参数属性**（`constructor(private x: T)`）——
> 那是 TS 语法糖，但 Node 的剥离模式不支持。

---

## 已知限制

1. **静态页拿不到实时行情。** 游戏的 WS 只在游戏页面里。
   可以从 `dvi-tools` 导出价格快照后导入，否则全部用兜底价。
2. **强化装备（+N）的额外加成**尚未展开。
3. **战斗收益**（20 个怪物的掉落与金币）未纳入。
4. **赶路时间**未纳入（站点有坐标，理论上可算）。
5. 失败率公式待实测校验（见上）。

---

*数据 0.0.1164 / commit 1db7eb7 · 只读分析，不发送任何游戏指令*
