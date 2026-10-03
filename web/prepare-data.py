#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 dvi_probe 提取出来的游戏数据整理成网页要用的单个 JSON。

数据来源：客户端 bundle 提取结果（只读，不涉及任何服务端接口）。
游戏改版后重跑本脚本即可，**网页代码一行不用改**。

    python prepare-data.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def _pick_data_dir() -> Path:
    """挑一份最新的 gamedata。

    历史上 dvi_probe 有两份副本（git 仓库内一份、工作区一份），
    容易改了一份忘了另一份 —— 网页于是读到了旧数据。
    所以这里**按修改时间自动选最新的那份**，而不是写死路径。
    """
    cands = [
        ROOT.parent / "dvi_probe" / "gamedata",
        Path("C:/Users/18405/WorkBuddy/2026-10-01-09-35-15/dvi_probe/gamedata"),
    ]
    ok = [d for d in cands if (d / "items.json").exists()]
    if not ok:
        die("找不到 gamedata（候选：\n  " + "\n  ".join(str(c) for c in cands))
    newest = max(ok, key=lambda d: (d / "items.json").stat().st_mtime)
    if len(ok) > 1:
        others = [d for d in ok if d != newest]
        print(f"⚠ 发现 {len(ok)} 份 gamedata，用最新的那份：")
        print(f"    {newest}")
        for o in others:
            print(f"    （跳过较早的：{o}）")
    return newest

SRC = _pick_data_dir()
OUT = ROOT / "public" / "data" / "dvi-gamedata.json"

# 只需要这几个字段，其余一律不带（体积减半，也避免塞进用不上的东西）
ITEM_FIELDS = ("id", "name", "stackable", "value", "heals")
ACTION_FIELDS = ("id", "name", "skill", "group", "levelReq", "baseTicks", "xp")
SITE_FIELDS = ("id", "x", "y", "kind", "jobIds")


def pick(obj, fields):
    return {k: obj[k] for k in fields if k in obj}


def die(msg):
    print("✗ " + msg)
    sys.exit(1)


def main():
    def load(name):
        p = SRC / name
        if not p.exists():
            die(f"缺少 {p}\n  请先在 dvi_probe 里跑提取流程。")
        return json.loads(p.read_text(encoding="utf-8"))

    g = load("dvi-gamedata.json")
    extra = load("balance-extra.json")

    items = [pick(i, ITEM_FIELDS) for i in g["items"]]
    actions = []
    for a in g["actions"]:
        row = pick(a, ACTION_FIELDS)
        if a.get("inputs"):
            row["inputs"] = [{"itemId": x["itemId"], "qty": x["qty"]} for x in a["inputs"]]
        else:
            row["inputs"] = []
        if a.get("output"):
            row["output"] = {"itemId": a["output"]["itemId"], "qty": a["output"]["qty"]}
        # 这四个字段直接决定利润计算的正确性，一个都不能漏
        for k in ("grow", "bonus", "burn", "caught"):
            if k in a:
                row[k] = a[k]
        actions.append(row)
    sites = g["sites"]   # 只取数量，坐标数据网站用不上（见下方裁剪）
    monsters = g.get("monsters", [])

    # 官方中文对照表（游戏自带，不是机器翻译）
    i18n_all = json.loads((SRC / "i18n-zh.json").read_text(encoding="utf-8")) \
        if (SRC / "i18n-zh.json").exists() else {}
    # 只保留网站会显示的名字：物品 / 配方 / 技能 / 分类 / 怪物。
    # 全量有 2518 条（169 KB），实际只用 388 条 —— 其余是界面文案，
    # 利润网用不上。裁剪后数据文件从 248 KB 降到 ~90 KB。
    need = set()
    for i in items: need.add(i["name"])
    for a in actions:
        need.add(a["name"]); need.add(a["skill"]); need.add(a["group"])
    for m in monsters: need.add(m["name"])
    i18n = {k: v for k, v in i18n_all.items() if k in need}
    missing = sorted(need - set(i18n))

    payload = {
        "meta": g.get("meta", {}),
        "i18nZh": i18n,
        "balance": g.get("balance", {}),
        "extra": {k: v for k, v in extra.items() if not k.startswith("_")},
        "items": items,
        "actions": actions,
        # 站点坐标有 39 KB 但界面只用得上「有多少个」这一条信息 —— 不带上。
        # 将来真要做赶路时间计算时，从 dvi_probe/gamedata/sites.json 现取即可。
        "siteCount": len(sites),
        "monsters": monsters,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(text, encoding="utf-8")

    kb = OUT.stat().st_size / 1024
    ver = payload["meta"].get("version", "?")
    print("✓ 产出 public/data/dvi-gamedata.json")
    print(f"  游戏数据 {ver} · commit {payload['meta'].get('commit', '?')}")
    print(f"  物品 {len(items)} · 配方 {len(actions)} · 站点 {len(sites)} · 怪物 {len(monsters)}")
    print(f"  官方中文 {len(i18n)} 条（全量 {len(i18n_all)}，已裁剪 {len(i18n_all)-len(i18n)}）")
    if missing:
        print(f"  ⚠ 有 {len(missing)} 个名字没有官方译文，将回退显示英文：{missing[:5]}")
    print(f"  体积 {kb:.0f} KB")
    print("  游戏改版后重跑本脚本即可，代码不用动。")


if __name__ == "__main__":
    main()
