"""修掉 vue-tsc 报出的类型问题（严格模式）。

问题分四类：
  ① TS6133 未使用的变量/字段 —— 删掉（构造函数参数属性本来是为了 Node 直跑，
     改成显式字段后有些就没用到了）
  ② TS5097 导入路径带 .ts 后缀 —— 这是为了让 Node 的类型剥离模式能跑，
     所以开 allowImportingTsExtensions，而不是改导入写法
  ③ TS18048 可能为 undefined —— 补窄化
  ④ TS2307/TS2591 找不到 node: 内置模块与 process —— 装 @types/node 并加进 types
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent   # 脚本在 web/scripts/ 下，项目根是它的上一级

# ---------- ① tsconfig：开 allowImportingTsExtensions + node 类型 ----------
p = ROOT / "tsconfig.json"
s = p.read_text(encoding="utf-8")
s = s.replace('"verbatimModuleSyntax": true,',
              '"verbatimModuleSyntax": true,\n    "allowImportingTsExtensions": true,')
s = s.replace('"types": []', '"types": ["node"]')
p.write_text(s, encoding="utf-8")
print("tsconfig: allowImportingTsExtensions + types:node")

# ---------- ② PriceBook：data 字段没用到 ----------
p = ROOT / "src/calc/price.ts"
s = p.read_text(encoding="utf-8")
s = s.replace("""  private readonly data: GameData
  private readonly items = new Map<number, Item>()""",
              "  private readonly items = new Map<number, Item>()")
s = s.replace("""  constructor(data: GameData) {
    this.data = data
    for (const it of data.items) this.items.set(it.id, it)
  }""",
              """  constructor(data: GameData) {
    for (const it of data.items) this.items.set(it.id, it)
  }""")
p.write_text(s, encoding="utf-8")
print("price.ts: 移除未用的 data 字段")

# ---------- ③ StepCalc：data 字段没用到 ----------
p = ROOT / "src/calc/steps.ts"
s = p.read_text(encoding="utf-8")
s = s.replace("""  private readonly data: GameData
  private readonly book: PriceBook

  constructor(data: GameData, book: PriceBook) {
    this.data = data
    this.book = book
    for (const a of data.actions) this.byId.set(a.id, a)
  }""",
              """  private readonly book: PriceBook

  constructor(data: GameData, book: PriceBook) {
    this.book = book
    for (const a of data.actions) this.byId.set(a.id, a)
  }""")
p.write_text(s, encoding="utf-8")
print("steps.ts: 移除未用的 data 字段")

# ---------- ④ Rank：data 与 _built 没用到 ----------
p = ROOT / "src/calc/rank.ts"
s = p.read_text(encoding="utf-8")
s = s.replace("""  private _rows: Row[] = []
  private _built = false

  private readonly data: GameData
  private readonly book: PriceBook""",
              """  private _rows: Row[] = []

  private readonly book: PriceBook""")
s = s.replace("""    this._rows = rows
    this._built = true
    return rows""", """    this._rows = rows
    return rows""")
s = s.replace("""  constructor(data: GameData, book: PriceBook, steps: StepCalc, chain: ChainCalc) {
    this.data = data
    this.book = book""",
              """  constructor(data: GameData, book: PriceBook, steps: StepCalc, chain: ChainCalc) {
    this.book = book""")
p.write_text(s, encoding="utf-8")
print("rank.ts: 移除未用的 data / _built")

# ---------- ⑤ ChainView：未用的类型导入 ----------
p = ROOT / "src/components/ChainView.vue"
s = p.read_text(encoding="utf-8")
s = s.replace("import type { PriceBook } from '../calc/price'\n", "")
p.write_text(s, encoding="utf-8")
print("ChainView.vue: 移除未用的 PriceBook 导入")

# ---------- ⑥ settings.ts：playerLevel 可能为 undefined ----------
p = ROOT / "src/stores/settings.ts"
s = p.read_text(encoding="utf-8")
s = s.replace("    playerLevel: settings.playerLevel > 0 ? settings.playerLevel : undefined,",
              "    playerLevel: (settings.playerLevel ?? 0) > 0 ? settings.playerLevel : undefined,")
p.write_text(s, encoding="utf-8")
print("settings.ts: playerLevel 窄化")

# ---------- ⑦ 测试文件 ----------
p = ROOT / "test/calc.test.ts"
s = p.read_text(encoding="utf-8")
s = s.replace(
  "import { TICK_SECONDS, HOUR_TICKS, failChance, workTicks, effectiveTicks } from '../src/calc/expected.ts'",
  "import { TICK_SECONDS, HOUR_TICKS, failChance, workTicks } from '../src/calc/expected.ts'")
s = s.replace("""  const upOut = up.output!.itemId
  // 上游那一步的产物被下游消耗 → 它的收入必须是 0""",
              """  // 上游那一步的产物被下游消耗 → 它的收入必须是 0""")
s = s.replace("""  const farm = data.actions.find(a => a.grow != null)!
  ok('种子里有 grow 字段', typeof farm.grow === 'number' && farm.grow > 0, String(farm.grow))""",
              """  const farm = data.actions.find(a => a.grow != null)!
  const farmGrow = farm.grow ?? 0
  ok('种子里有 grow 字段', farmGrow > 0, String(farmGrow))""")
s = s.replace("ok('单线程口径含生长时间', ser === farm.baseTicks + farm.grow, `${ser} vs ${farm.baseTicks + farm.grow}`)",
              "ok('单线程口径含生长时间', ser === farm.baseTicks + farmGrow, `${ser} vs ${farm.baseTicks + farmGrow}`)")
s = s.replace("  process.exitCode = 1", "  process.exitCode = 1")
p.write_text(s, encoding="utf-8")
print("test/calc.test.ts: 清理未用导入 + grow 窄化")

print("\n完成")
