#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
提取 DVI 官方中文对照表 → gamedata/i18n-zh.json

DVI 内置官方简体中文，翻译表就在客户端 bundle 里。
既然官方翻了，就**直接用官方的**，不要自己机器翻译 ——
玩家在游戏里看到的名字和这里看到的一致，才不会对不上。

做法：全量扫 bundle 里的 `英文键: "中文值"`。
**不必先确定对象边界** —— 我们只要一张扁平的对照表，
按正则全量扫比定位嵌套结构稳得多（试过按对象提取，只能覆盖 10~25%，
因为深层嵌套时很容易找错外层括号）。

只读：只读本地已下载的 bundle。
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUNDLE = ROOT / "index-new.js"
OUT = ROOT / "gamedata" / "i18n-zh.json"
DATA = ROOT / "gamedata" / "dvi-gamedata.json"

# 键可带引号可不带；值必须含中文
PAT = re.compile(r"""(?:["']?)([A-Za-z][A-Za-z0-9 _'\-\.]{0,48})(?:["']?)\s*:\s*["']([^"']*[\u4e00-\u9fff][^"']*)["']""")


def main():
    if not BUNDLE.exists():
        sys.exit(f"✗ 找不到 {BUNDLE.name}，请先跑 reextract.py --download")

    src = BUNDLE.read_text(encoding="utf-8", errors="replace")
    table: dict[str, str] = {}
    for m in PAT.finditer(src):
        table.setdefault(m.group(1), m.group(2))

    if len(table) < 500:
        sys.exit(f"✗ 只提取到 {len(table)} 条，明显不正常 —— 可能是 bundle 结构变了，先人工核对")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(table, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"✓ 提取官方中文 {len(table)} 条 → {OUT.relative_to(ROOT)}")

    # 覆盖率体检：游戏数据里用到的名字，有多少能翻出来
    if not DATA.exists():
        print("  （还没有 dvi-gamedata.json，跳过覆盖率检查）")
        return
    d = json.loads(DATA.read_text(encoding="utf-8"))
    groups = [
        ("物品名", [i["name"] for i in d["items"]]),
        ("配方名", [a["name"] for a in d["actions"]]),
        ("技能名", sorted({a["skill"] for a in d["actions"]})),
        ("分类名", sorted({a["group"] for a in d["actions"]})),
        ("怪物名", [m["name"] for m in d.get("monsters", [])]),
    ]
    print("\n覆盖率：")
    bad = 0
    for label, names in groups:
        miss = [n for n in names if n not in table]
        pct = len(names) - len(miss)
        mark = "✓" if not miss else "✗"
        print(f"  {mark} {label} {pct}/{len(names)}" + (f"  未命中: {miss[:5]}" if miss else ""))
        bad += len(miss)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
