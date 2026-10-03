"""补齐全站汉化 + 加测试钉住覆盖率。

## 漏在哪
1. **特权名**：`XP gain` / `Gather speed` 官方有译文（经验获取 / 采集速度），
   但 prepare-data.py 裁剪 i18n 时只按物品/配方/技能/分类/怪物取 `need`，
   **把特权名裁掉了**。
2. **lane 是内部 ID**：`efficiency` / `power` 游戏里根本不显示，也没有官方译文。
   界面上却直接渲染出来了 —— 属于我们自造的信息，必须给中文标签。
3. **9 处模板直接输出 `.name` 没走 `t()`**：链路视图、强化页、价格页、
   战斗页（雪藏中）、玩家配置页。

## 怎么钉住
新增测试：把「界面可能显示的每个名字」列出来，逐个断言有中文译文。
以后再加新视图忘了包 `t()`，或裁剪把某个名字裁掉，测试立刻红。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ── ① prepare-data.py：裁剪时把特权名也算进去 ──
p = ROOT / "web/prepare-data.py"
s = p.read_text(encoding="utf-8")
old = """    need = set()
    for i in items: need.add(i["name"])
    for a in actions:
        need.add(a["name"]); need.add(a["skill"]); need.add(a["group"])
    for m in monsters: need.add(m["name"])"""
new = """    need = set()
    for i in items: need.add(i["name"])
    for a in actions:
        need.add(a["name"]); need.add(a["skill"]); need.add(a["group"])
    for m in monsters: need.add(m["name"])
    # 特权名也要留 —— 玩家配置页会显示（官方有译文：XP gain → 经验获取）
    for pk in extra.get("perks", []):
        need.add(pk["name"])"""
assert old in s, "未找到 need 集合"
s = s.replace(old, new, 1)
p.write_text(s, encoding="utf-8")
print("OK: prepare-data.py 裁剪时纳入特权名")

# ── ② i18n.ts：补 lane 标签 ──
p = ROOT / "web/src/i18n.ts"
s = p.read_text(encoding="utf-8")
s = s.replace("""/** 技能显示名：官方译文优先 */""",
"""/**
 * 特权所属 lane 的中文标签。
 *
 * ⚠ lane（efficiency / power）是**游戏内部的分类 ID**，玩家在游戏里
 * 根本看不到它，官方也没有译文。是我们自己在玩家配置页上显示的，
 * 所以标签由这里定义 —— 不写清楚就等于自己往界面上塞英文。
 */
const LANE: Record<string, { zh: string; en: string }> = {
  efficiency: { zh: '效率', en: 'Efficiency' },
  power: { zh: '战力', en: 'Power' },
}

export function laneLabel(lane: string): string {
  if (langState.lang === 'en') return LANE[lane]?.en ?? lane
  return LANE[lane]?.zh ?? lane
}

/** 技能显示名：官方译文优先 */""")
p.write_text(s, encoding="utf-8")
print("OK: i18n.ts 补 lane 标签")

# ── ③ 各视图补 t() ──
FIXES = [
    ("web/src/components/ChainView.vue", [
        ("function name(id: number): string {\n  return props.ctx.step.action(id)?.name || `#${id}`\n}",
         "function name(id: number): string {\n  // 名称走官方译文；查不到时回退英文原文，不显示空白\n  return t(props.ctx.step.action(id)?.name || `#${id}`)\n}"),
        ("{{ result.steps[result.steps.length - 1]?.action.name }}",
         "{{ t(result.steps[result.steps.length - 1]?.action.name) }}"),
    ]),
    ("web/src/views/DashboardView.vue", [
        ("<label>{{ p.name }}<span class=\"tag\">{{ p.lane }}</span></label>",
         "<label>{{ t(p.name) }}<span class=\"tag\">{{ laneLabel(p.lane) }}</span></label>"),
        ("import { player, resetPlayer } from '../stores/player'",
         "import { player, resetPlayer } from '../stores/player'\nimport { t, laneLabel } from '../i18n'"),
    ]),
    ("web/src/views/EnhanceView.vue", [
        ("              {{ i.name }}（基础 {{ i.value }}）",
         "              {{ t(i.name) }}（基础 {{ i.value }}）"),
        ("                <td class=\"l\">{{ r.name }}</td>",
         "                <td class=\"l\">{{ t(r.name) }}</td>"),
        ("{{ t(detail.itemName) }}", "{{ t(detail.itemName) }}"),
    ]),
    ("web/src/views/PriceView.vue", [
        ("              <td class=\"l\">{{ s.name }}</td>",
         "              <td class=\"l\">{{ t(s.name) }}</td>"),
    ]),
    ("web/src/views/CombatView.vue", [
        ("                <td class=\"l\">{{ r.name }}</td>",
         "                <td class=\"l\">{{ t(r.name) }}</td>"),
        ("<div class=\"kv\"><span>怪物</span><span>{{ detail.name }}（Lv{{ detail.level }}）</span></div>",
         "<div class=\"kv\"><span>怪物</span><span>{{ t(detail.name) }}（Lv{{ detail.level }}）</span></div>"),
    ]),
    ("web/src/views/ConsumableView.vue", [
        ("            <td class=\"l\">{{ r.name }}</td>",
         "            <td class=\"l\">{{ t(r.name) }}</td>"),
    ]),
]

for rel, pairs in FIXES:
    f = ROOT / rel
    if not f.exists():
        print(f"  ! 跳过（不存在）{rel}")
        continue
    t2 = f.read_text(encoding="utf-8")
    n = 0
    for a, b in pairs:
        if a in t2:
            t2 = t2.replace(a, b)
            n += 1
    # 保证 t / laneLabel 已导入
    if n and "from '../i18n'" not in t2 and "from '../../i18n'" not in t2:
        depth = rel.count("/") - 1          # web/src/xxx.vue → ../
        imp = f"import {{ t, laneLabel }} from '{'../' * depth}i18n'"
        lines = t2.split("\n")
        for i, ln in enumerate(lines):
            if ln.startswith("import "):
                lines.insert(i, imp)
                break
        t2 = "\n".join(lines)
    f.write_text(t2, encoding="utf-8")
    print(f"OK: {rel}  {n} 处")

# 未用到的导入由 vue-tsc 报出来，最后统一清
print("\n完成 —— 下一步跑构建，若报未使用导入再清")
