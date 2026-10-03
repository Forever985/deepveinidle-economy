# Deep Vein Idle · 数据与机制分析（为「利润网」做准备）

> 性质：**只读分析**。全部数据来自客户端 bundle 提取（`0.0.1164 / commit 1db7eb7`），
> 未使用任何服务端接口，也未发送任何游戏指令。

---

## 一、数据资产盘点

| 数据 | 规模 | 文件 |
|---|---|---|
| 物品 | **290** | `gamedata/items.json` |
| 配方（作业） | **221** | `gamedata/actions.json` |
| 站点 | **383** | `gamedata/sites.json` |
| 怪物 | **20** | `gamedata/monsters.json` |
| 平衡常量 | 9 组 | `dvi-gamedata.json → balance` |
| 动态系数表 | 7 组 | `gamedata/balance-extra.json` |

### 各表字段

```
物品   { id, name, stackable, value, heals? }
配方   { id, name, skill, group, levelReq, baseTicks, xp, inputs[], output{itemId,qty},
         grow? | bonus? | burn? | caught? }
站点   { id, x, y, kind, jobIds[], look? }
怪物   { id, name, level, hp, maxHit, attack, defence, speed, xp, gold, bonus, drop }
```

### 十个技能与配方分布

| 技能 | 配方 | 终端品 | 性质 |
|---|---:|---:|---|
| smithing | 66 | 61 | 加工 |
| crafting | 65 | 64 | 加工 |
| fletching | 35 | 35 | 加工 |
| farming | 9 | 6 | 种植（有生长时间）|
| cooking | 8 | 8 | 加工（有烧焦风险）|
| herblore | 8 | 8 | 加工 |
| mining | 8 | **0** | **纯原料** |
| fishing | 8 | **0** | **纯原料** |
| thieving | 8 | 4 | 半原料 |
| woodcutting | 6 | **0** | **纯原料** |

> **采集三系（mining / fishing / woodcutting）不产出任何终端品** ——
> 它们的产出全部是别人的原料。这是理解整个经济的第一把钥匙。

---

## 二、配方网络结构（决定「利润网」做成什么样）

把这些配方当成有向图（原料 → 成品）来算：

| 指标 | 数值 |
|---|---|
| 能产出的物品 | 218 |
| 被当作原料的物品 | 64 |
| **中间品**（既被产出又被消耗） | **35** |
| **终端品**（被产出但无人消耗） | **183** |
| **有第二条产出配方的物品** | **1** |
| **最大链条深度** | **3 层** |

深度分布：

```
深度 1（纯采集原料）  63 种
深度 2（一次加工）    72 种
深度 3（二次加工）    83 种   ← 最深
```

### 这三条结论直接决定设计

1. **链深只有 3 层。** 利润网不需要递归到很深，**三层就到底了** ——
   这意味着可以直接把整张图铺开算，不必做复杂的懒加载或截断。

2. **几乎没有替代配方（218 个物品里只有 1 个有第二条产出路径）。**
   所以图是**近似一棵树**，不存在"同一物品哪条路更便宜"的套利问题。
   > ⚠️ 这条是**从提取的数据推导**的，建议在游戏里抽查一两个高级物品确认。

3. **35 个中间品是关键节点。** 183 个终端品是"卖钱的"，64 个原料是"要买的"，
   但真正把两者连起来的只有中间这 35 个 —— **利润网的主干就是它们。**

---

## 三、时间机制（这里我上一轮算错过，必须写清楚）

`baseTicks` **只是"加工"时间**，不是"获得一件成品"的总时间。
有四个字段会显著改变真实耗时，**漏掉任何一个都会得出荒谬的结论**：

| 字段 | 技能 | 含义 | 取值 |
|---|---|---|---|
| `grow` | farming | **生长时间**（tick） | 800 ~ 9000 |
| `burn` | cooking | 烧焦：`chanceAtReq` / `safeAtLevel` | 0.3 / 26~115 |
| `caught` | thieving | 被抓：`chanceAtReq` / `safeAtLevel` / `stunTicks` | 0.25 / 30~ / 8 |
| `bonus` | mining·woodcutting·thieving | 额外掉落 `itemId` / `chance` | 0.0005 等 |

### 实证：漏掉 `grow` 会错得多离谱

我第一版按「只用 `baseTicks`」算，得出 **Ember pepper（farming Lv75）每小时净利 119 万**，
排在全表第一 —— 这是**错的**：

```
Ember pepper   baseTicks = 2        → 只算加工：1.2 秒 / 件
               grow      = 9000     → 生长要 5400 秒（90 分钟）
```

真实的「获得一件」周期由 `grow` 主导，按 `baseTicks` 算会**高估三个数量级**。

> **教训**：`baseTicks` 是"动手时间"，`grow` 是"等待时间"。
> 对放置类游戏，**等待时间往往才是瓶颈**，而它是可以被并行化的
> （同时种多块地），所以两种口径都有意义 —— 这正是一个必须问清的设计问题。

---

## 四、市场机制

### 税率

```js
marketTaxBp = 200    // 基点 → 2%
```

卖出时按 2% 扣税。`calc.analyse` 已按此实现。

### 可用的市场数据（全部来自服务器推送，只读）

| 消息 | 内容 | 用途 |
|---|---|---|
| `marketBook` / `marketBooks` | `{itemId, bid, bidQty, ask, askQty}` | **最优买卖价 + 挂单量** |
| `marketDepth` | `{itemId, bids[], asks[], trades[]}` | 档位深度 + 成交记录 |
| `marketHistory` | `rows[]` | 历史成交 |

### 取价策略（现成实现）

```
priceOf(itemId):  最优卖价 ask  →  最优买价 bid  →  基础价值 value
```

**挂单量（`bidQty` / `askQty`）是利润网必须用起来的东西** ——
一个价差很大但挂单量只有 1 的物品，实际是卖不掉的。**高利润 ≠ 可成交。**

---

## 五、现有计算能力（主干已具备）

`calc` 模块已经能算：

```js
analyse(action, opts) → {
  ticks, seconds,               // 时间
  unitsPerHour,                 // 每小时产量
  grossPerHour,                 // 毛收入
  costPerHour,                  // 原料成本
  netPerHour,                   // ★ 净利
  xpPerHour,                    // 经验效率
  profitPerTick,
}
```

**但目前没有处理 `grow` / `burn` / `caught` / `bonus`。**
做利润网之前，这层要先补上（见下节）。

---

## 六、第一版利润分布（基础价值口径，**仅作方向参考**）

> 口径：`价格 = items.value`（不是真实市场价），`时间 = baseTicks`，
> 已扣 2% 税。**不含 grow/burn/caught**，所以 farming/cooking/thieving 的数偏乐观。

**单次加价最高的配方**（成品价值 − 原料价值）：

| 加价 | 配方 | 技能 | 等级 |
|---:|---|---|---|
| +900 | Meteoric | mining | Lv85 |
| +900 | Reliquary vestry | thieving | Lv75 |
| +780 | Shark | fishing | Lv90 |
| +650 | Colossus 系列（剑/盾/盔/甲/腿） | smithing | Lv99 |
| +650 | Drake 系列（头/腿/身） | crafting | Lv99 |

**单次加价为负（越做越亏）的只有 4 个，全是手套系列：**

```
Scale gloves  (crafting Lv85)   −2400
Bone gloves   (crafting Lv65)    −240
Chitin gloves (crafting Lv45)    −120
Bogskin gloves(crafting Lv25)     −24
```

> 手套全线为负，很可能是**数据里 `output.qty` 与实际不符**，或这批物品
> 在真实市场里的售价远高于基础价值。**这是一个值得优先核实的点。**

**按技能看平均加价：**

```
thieving 203 · mining 192 · fishing 183 · herblore 167 · woodcutting 167
smithing 163 · crafting 141 · farming 127 · fletching 122 · cooking 120
```

---

## 七、做利润网之前要补的三件事

1. **时间模型补全** —— 把 `grow` / `burn` / `caught` 纳入，
   并区分「动手时间」与「等待时间」（后者可并行）。
2. **市场口径补全** —— 用真实 `ask`/`bid` 与**挂单量**，
   而不是基础价值；并把"卖不掉"量化（例如可成交量上限）。
3. **手套异常核实** —— 4 个负利润配方要么是数据问题，要么是市场现象。

---

## 八、待你确认的设计问题

这几条会显著改变实现方向，**先问清再动手**：

1. **利润口径**：原料按**市场买入价**算，还是按**自己生产的成本**算？
   两者结论常常相反（自己采的矿对"记账"是 0 成本，但占用了时间）。
2. **并行怎么算**：farming 的 `grow` 期间可以干别的 ——
   利润是按「单线程逐个做」还是「多线并行」算？
3. **「网」的形态**：你要的是
   （a）**配方依赖图**（点开一个成品，看到它整条原料链的成本构成），还是
   （b）**利润排行/热力图**（哪些东西现在最值得做），还是
   （c）**两者结合** —— 排行点进去看链路？
4. **要不要含战斗**：20 个怪物有 `drop` / `gold`，战斗收益也是一条独立的利润来源，
   要不要一并纳进来？
5. **是否只看已解锁的**：利润网是否应该按玩家当前等级过滤掉做不了的东西。

---

*分析基于游戏数据 0.0.1164 / commit 1db7eb7 · 2026-10-03*
