#!/usr/bin/env python3
"""DVI Tools 构建脚本

做三件事：
  1. 把游戏数据内联进主干（逐条一行，避免出现超长单行）
  2. 把 plugins/*.js 按顺序拼进同一个用户脚本
     —— 必须同脚本：油猴给每个用户脚本独立沙箱，跨脚本共享要走 unsafeWindow，
        打包成单文件最稳，也最贴合 MWITools 的做法
  3. 产出可直接安装的 dvi-tools.user.js

用法：
    python build.py

输入：
    ../dvi_probe/gamedata/dvi-gamedata.json  （由 bundle 提取）
    src/core.js                              （主干源码，含 /*@DVI_DATA@*/ 占位符）
    plugins/*.js                             （可选，会被拼到主干之后）

输出：
    dvi-tools.user.js      （最终用户脚本）
    dvi-tools.core.json    （独立的数据副本，供 Node 单测用）
"""
import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "src" / "core.js"
PLUGIN_DIR = HERE / "plugins"
GAMEDATA = HERE.parent / "dvi_probe" / "gamedata" / "dvi-gamedata.json"
BALANCE_EXTRA = HERE.parent / "dvi_probe" / "gamedata" / "balance-extra.json"
OUT_USER = HERE / "dvi-tools.user.js"
OUT_DATA = HERE / "dvi-tools.core.json"

SKILL_NAMES = {
    "mining": "采矿", "fishing": "钓鱼", "woodcutting": "伐木", "farming": "种植",
    "thieving": "偷窃", "cooking": "烹饪", "smithing": "锻造", "fletching": "制箭",
    "herblore": "炼药", "crafting": "工艺", "enhancing": "强化",
    "melee": "近战", "ranged": "远程", "magic": "魔法",
    "defence": "防御", "hitpoints": "生命",
}

_ESC = {0x2028: "\\u2028", 0x2029: "\\u2029"}


def jstr(s):
    out = json.dumps(s, ensure_ascii=False)
    for cp, esc in _ESC.items():
        out = out.replace(chr(cp), esc)
    return out


def jkey(k):
    """合法标识符则不加引号，省体积也更易读"""
    return k if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", k) else jstr(k)


MAX_WIDTH = 96


def jval(v, indent=0, maxw=MAX_WIDTH):
    """渲染成 JS 字面量：短则内联，长则换行 —— 避免出现超长单行。"""
    inline = jval_inline(v)
    if len(inline) + indent <= maxw:
        return inline
    pad = "  " * (indent + 1)
    close = "  " * indent
    if isinstance(v, list):
        parts = [pad + jval(x, indent + 1, maxw) for x in v]
        return "[\n" + ",\n".join(parts) + "\n" + close + "]"
    if isinstance(v, dict):
        parts = [f"{pad}{jkey(str(k))}:{jval(x, indent + 1, maxw)}"
                 for k, x in v.items() if x is not None]
        return "{\n" + ",\n".join(parts) + "\n" + close + "}"
    return inline


def jval_inline(v):
    """强制单行渲染"""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return json.dumps(v)
    if isinstance(v, str):
        return jstr(v)
    if isinstance(v, list):
        return "[" + ",".join(jval_inline(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(f"{jkey(str(k))}:{jval_inline(x)}"
                              for k, x in v.items() if x is not None) + "}"
    return "null"


def jobj(d):
    parts = []
    for k, v in d.items():
        if v is None:
            continue
        parts.append(f"{jkey(str(k))}:{jval(v)}")
    return "{" + ",".join(parts) + "}"


def normalize_action(a):
    inputs = []
    for i in (a.get("inputs") or []):
        if not isinstance(i, dict):
            continue
        e = {"qty": i.get("qty", 1)}
        if i.get("itemId") is not None:
            e["itemId"] = i["itemId"]
        elif i.get("actionId") is not None:
            e["actionId"] = i["actionId"]
        else:
            continue
        inputs.append(e)
    out = {
        "id": a["id"], "name": a["name"], "skill": a["skill"],
        "group": a.get("group", ""), "levelReq": a.get("levelReq", 1),
        "baseTicks": a.get("baseTicks", 1), "xp": a.get("xp", 0),
        "inputs": inputs,
        "output": {"itemId": a["output"]["itemId"], "qty": a["output"].get("qty", 1)},
    }
    if a.get("grow") is not None:
        out["grow"] = a["grow"]
    if a.get("bonus"):
        out["bonus"] = {"itemId": a["bonus"]["itemId"], "chance": a["bonus"]["chance"]}
    if a.get("caught"):
        out["caught"] = a["caught"]
    if a.get("burn"):
        out["burn"] = a["burn"]
    return out


def emit_data_js(data):
    """逐条一行地生成 DATA 字面量，避免出现超长单行"""
    L = ["{",
         "  meta: " + jobj(data["meta"]) + ",",
         "  balance: " + jobj(data["balance"]) + ",",
         "  skillNames: " + jobj(data["skillNames"]) + ","]

    def arr(name, rows):
        L.append(f"  {name}: [")
        for r in rows:
            L.append("    " + jobj(r) + ",")
        L.append("  ],")

    arr("items", data["items"])
    arr("actions", data["actions"])
    arr("sites", data["sites"])
    arr("monsters", data["monsters"])
    L.append("}")
    return "\n".join(L)


def main():
    for p, label in ((GAMEDATA, "游戏数据"), (SRC, "主干源码")):
        if not p.exists():
            sys.exit(f"找不到{label}：{p}")

    g = json.loads(GAMEDATA.read_text(encoding="utf-8"))

    # 合并「动态系数表」（由 ../dvi_probe/extract_balance.py 从 bundle 提取）。
    # 这些值会随游戏版本变化，所以走数据层，运行期按玩家状态查表 —— 不写死在逻辑里。
    balance = dict(g["balance"])
    extra_note = ""
    if BALANCE_EXTRA.exists():
        extra = json.loads(BALANCE_EXTRA.read_text(encoding="utf-8"))
        extra.pop("_source", None)
        extra.pop("_note", None)
        balance.update(extra)
        extra_note = f" + 系数表({len(extra)} 组)"
    else:
        print("⚠ 未找到 gamedata/balance-extra.json —— 动态系数将退回内置默认值。")
        print("  请先运行：python ../dvi_probe/extract_balance.py")

    data = {
        "meta": g.get("meta", {}),
        "balance": balance,
        "skillNames": SKILL_NAMES,
        "items": [{"id": i["id"], "name": i["name"], "value": i.get("value", 0),
                   "stackable": bool(i.get("stackable")),
                   **({"heals": i["heals"]} if "heals" in i else {})}
                  for i in g["items"]],
        "actions": [normalize_action(a) for a in g["actions"]],
        "sites": [{"id": s["id"], "x": s["x"], "y": s["y"],
                   "kind": s.get("kind", ""), "jobIds": s.get("jobIds", [])}
                  for s in g["sites"]],
        "monsters": [{"id": m["id"], "name": m["name"], "level": m.get("level"),
                      "hp": m.get("hp"), "xp": m.get("xp"),
                      "gold": m.get("gold"), "drop": m.get("drop")}
                     for m in g["monsters"]],
    }

    core = SRC.read_text(encoding="utf-8")
    if "/*@DVI_DATA@*/" not in core:
        sys.exit("src/core.js 中找不到 /*@DVI_DATA@*/ 占位符")

    baked = "(" + emit_data_js(data) + ")"
    out = core.replace("/*@DVI_DATA@*/ null", baked)

    meta = data["meta"]
    ver = re.search(r"//\s*@version\s+(\S+)", out)
    ver = ver.group(1) if ver else "?"
    stamp = (f"// [build] v{ver} · {time.strftime('%Y-%m-%d %H:%M')}"
             f" · 游戏数据 {meta.get('version','?')} / {meta.get('commit','?')}"
             f" · 物品 {len(data['items'])} · 配方 {len(data['actions'])}"
             f" · 怪物 {len(data['monsters'])} · 站点 {len(data['sites'])}\n")
    out = out.replace("(function () {\n  'use strict';", stamp + "(function () {\n  'use strict';", 1)

    # ── 价格桥（主干级模块，必须在 api 发布之后）──
    PB = "/*@DVI_PRICE_BRIDGE@*/"
    pb_path = SRC.parent / "price-bridge.js"
    if pb_path.exists():
        if PB not in out:
            sys.exit(f"✗ 主干里找不到注入点 {PB} —— 价格桥将无处安放，已中止。")
        out = out.replace(PB, pb_path.read_text(encoding="utf-8").strip(), 1)
    if PB in out:
        sys.exit(f"✗ 注入点 {PB} 未被替换，构建结果不可信，已中止。")

    # ── 拼接插件 ──
    # 关键：插件注入到主干**内部**的 /*@DVI_PLUGINS@*/ 位置，
    # 而不是追加在文件末尾。放在末尾时插件只靠「文件顺序」与主干维系，
    # 一旦执行环境在中间截断，插件会整段不执行且不留痕迹（已实际发生过）。
    plugin_files = sorted(PLUGIN_DIR.glob("*.js")) if PLUGIN_DIR.exists() else []
    PLACEHOLDER = "/*@DVI_PLUGINS@*/"
    if plugin_files:
        chunks = ["/* ═══════════════ 以下为打包进来的插件（在主干内部执行） ═══════════════ */"]
        for p in plugin_files:
            body = p.read_text(encoding="utf-8")
            body = re.sub(r"//\s*==UserScript==.*?//\s*==/UserScript==", "", body, flags=re.S)
            chunks.append(f"\n/* ── {p.name} ── */\n{body.strip()}\n")
        block = "\n".join(chunks)

        if PLACEHOLDER not in out:
            sys.exit(f"✗ 主干里找不到注入点 {PLACEHOLDER} —— 插件将无处安放，已中止。")
        out = out.replace(PLACEHOLDER, block, 1)
    else:
        out = out.replace(PLACEHOLDER, "/* 没有插件可打包 */", 1)

    # 注入点若还残留，说明替换没生效
    if PLACEHOLDER in out:
        sys.exit(f"✗ 注入点 {PLACEHOLDER} 未被替换，构建结果不可信，已中止。")

    OUT_USER.write_text(out, encoding="utf-8")
    OUT_DATA.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    lines = out.split("\n")
    longest = max(len(l) for l in lines)
    print(f"主干源码        : {SRC.stat().st_size/1024:.1f} KB")
    print(f"打包插件        : {len(plugin_files)} 个" +
          (f"（{', '.join(p.name for p in plugin_files)}）" if plugin_files else ""))
    print(f"产出 userscript : {OUT_USER.name}  ({OUT_USER.stat().st_size/1024:.1f} KB, {len(lines)} 行)")
    print(f"最长行          : {longest} 字符 " + ("✓ 无超长行" if longest < 2000 else "✗ 仍有超长行"))
    print(f"数据副本        : {OUT_DATA.name}")
    print()
    print(f"物品 {len(data['items'])} · 配方 {len(data['actions'])} · "
          f"站点 {len(data['sites'])} · 怪物 {len(data['monsters'])}")


if __name__ == "__main__":
    main()
