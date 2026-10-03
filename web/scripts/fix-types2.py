"""第二轮类型修复：App.vue 的导入写法 + 残留的未用字段。"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ---------- App.vue ----------
p = ROOT / "src/App.vue"
s = p.read_text(encoding="utf-8")

# ① 我把 `type` 误当成具名导入了 —— 它其实是 TS 的内建关键字，不是导出。
#    GameData 类型要从 '../types' 用 import type 取。
s = s.replace(
    "import { loadGameData, skillList, skillLabel, type } from '../api/gamedata'",
    "import { loadGameData, skillList, skillLabel } from '../api/gamedata'")

# ② .vue 里的相对导入要带 .ts 后缀，与 src/calc 的写法保持一致
for a, b in [
    ("from '../api/gamedata'", "from '../api/gamedata.ts'"),
    ("from '../calc/price'",   "from '../calc/price.ts'"),
    ("from '../calc/steps'",   "from '../calc/steps.ts'"),
    ("from '../calc/chain'",   "from '../calc/chain.ts'"),
    ("from '../calc/rank'",    "from '../calc/rank.ts'"),
    ("from '../stores/settings'", "from '../stores/settings.ts'"),
    ("from '../stores/prices'",   "from '../stores/prices.ts'"),
    ("from '../types'",        "from '../types.ts'"),
]:
    s = s.replace(a, b)

# ③ 隐式 any：补上参数类型
s = s.replace("selected.value = r.rows.find(x => x.actionId === selected.value!.actionId) || null",
              "selected.value = r.rows.find((x: Row) => x.actionId === selected.value!.actionId) || null")
s = s.replace("const f = rank.value.filter({", "const f: Row[] = rank.value.filter({")
p.write_text(s, encoding="utf-8")
print("App.vue: 修正导入与隐式 any")

# ---------- chain.ts：data / book 未用到；ticksToSeconds 未用到 ----------
p = ROOT / "src/calc/chain.ts"
s = p.read_text(encoding="utf-8")
s = s.replace("import { ticksToSeconds } from './expected.ts'\n", "")
s = s.replace("""  private readonly data: GameData
  private readonly book: PriceBook
  private readonly steps: StepCalc

  constructor(data: GameData, book: PriceBook, steps: StepCalc) {
    this.data = data
    this.book = book
    this.steps = steps
  }""",
              """  private readonly steps: StepCalc

  constructor(_data: GameData, _book: PriceBook, steps: StepCalc) {
    this.steps = steps
  }""")
p.write_text(s, encoding="utf-8")
print("chain.ts: 移除未用字段与导入")

# ---------- rank.ts：data 未用到 ----------
p = ROOT / "src/calc/rank.ts"
s = p.read_text(encoding="utf-8")
s = s.replace("""  private readonly data: GameData
  private readonly book: PriceBook""", "  private readonly book: PriceBook")
s = s.replace("""  constructor(data: GameData, book: PriceBook, steps: StepCalc, chain: ChainCalc) {
    this.book = book""",
              """  constructor(_data: GameData, book: PriceBook, steps: StepCalc, chain: ChainCalc) {
    this.book = book""")
p.write_text(s, encoding="utf-8")
print("rank.ts: 移除未用 data 字段")

# ---------- 测试：未用的 upOut ----------
p = ROOT / "test/calc.test.ts"
s = p.read_text(encoding="utf-8")
s = re.sub(r"\n\s*const upOut = [^\n]*\n", "\n", s)
p.write_text(s, encoding="utf-8")
print("test: 移除未用变量")

print("\n完成")
