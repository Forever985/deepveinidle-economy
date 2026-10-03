#!/usr/bin/env python3
"""从客户端 bundle 提取「动态系数表」，写入 gamedata/balance-extra.json。

为什么要单独一个脚本：
    这些系数（增益倍率、特长每级系数、档位倍率…）会随游戏版本变化，
    写死在代码里迟早过期。提取成数据文件后，build.py 会把它并进
    DATA.balance，运行期再按玩家当前状态查表 —— 而不是把值固化进逻辑。

用法：
    python extract_balance.py            # 默认读 ./index.js
    python extract_balance.py <bundle>

产出：
    gamedata/balance-extra.json
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "gamedata" / "balance-extra.json"


def grab_array(src, pattern):
    """按正则找到起点后做括号配平切片，返回「数组/对象字面量」本身。

    注意：正则可能匹配到 `Zn=[...]` 这样的整体，所以要先定位到真正的
    括号起点，不能直接用 match.start() 当切片起点。
    """
    m = re.search(pattern, src)
    if not m:
        return None
    # 从匹配起点往后找第一个括号，作为真正的字面量起点
    start = m.start()
    while start < len(src) and src[start] not in "[{":
        start += 1
    if start >= len(src):
        return None

    i = start
    d = 0; q = None; esc = False
    while i < len(src):
        c = src[i]
        if q:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == q: q = None
        else:
            if c in "\"'`": q = c
            elif c in "[{": d += 1
            elif c in "]}":
                d -= 1
                if d == 0: return src[start:i + 1]
        i += 1
    return None


def num(src, name):
    m = re.search(rf"(?<![A-Za-z0-9_$]){re.escape(name)}=(-?[0-9.]+)", src)
    return float(m.group(1)) if m else None


def main():
    bundle = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "index.js"
    if not bundle.exists():
        sys.exit(f"找不到 bundle：{bundle}")
    src = bundle.read_text(encoding="utf-8", errors="replace")

    out = {"_source": bundle.name, "_note": "由 extract_balance.py 提取；游戏更新后重跑"}

    # ── 增益倍率表 Zn（按层数索引，Rd = Zn） ──
    raw_zn = grab_array(src, r"(?<![A-Za-z0-9_$])Zn=\[1,1\.3")
    if raw_zn:
        # [1,1.3,1.6,2.2,3] → 逗号分隔数字
        out["buffTierMults"] = [float(x) for x in raw_zn.strip("[]").split(",")]

    # ── 各增益每级系数 ──
    # 这些是 bundle 里散落的常量，逐个取
    per_rank = {
        "gatherer": num(src, "xp"),      # TT 里 1 + xp*No(o,"gatherer")
        "elixir":   num(src, "vu"),
        "hunter":   num(src, "ku"),
    }
    out["buffPerRank"] = {k: v for k, v in per_rank.items() if v is not None}

    # ── 祝福倍率 ──
    bless = {}
    tp, ip = num(src, "Tp"), num(src, "Ip")
    if tp is not None: bless["gather"] = tp
    if ip is not None: bless["combat"] = ip
    if bless: out["blessing"] = bless

    # ── 经验档位倍率 Kn ──
    raw_kn = grab_array(src, r"(?<![A-Za-z0-9_$])Kn=\[1(?:,|,)")
    if raw_kn:
        out["xpTierMults"] = [float(x) for x in raw_kn.strip("[]").split(",")]

    # ── 特长 / 精通 表（同一张表，perRank 即精通每级系数） ──
    raw_perks = grab_array(src, r'\[\{id:"xp",name:"XP gain"')
    if raw_perks:
        perks = []
        for m in re.finditer(
            r'\{id:"([a-z]+)",name:"([^"]{2,40})",blurb:"[^"]{0,80}",'
            r'lane:"([a-z]+)",perRank:([0-9.]+)(?:,unit:"([a-z%]+)")?', raw_perks):
            perks.append({
                "id": m.group(1), "name": m.group(2), "lane": m.group(3),
                "perRank": float(m.group(4)), "unit": m.group(5) or "percent",
            })
        if perks:
            out["perks"] = perks

    # ── 工具（装备）加成表 Jg ──
    # 客户端：ST(you, skill) 取对应槽位的装备，工具系数 = 1 + bonus
    raw_tools = grab_array(src, r'(?<![A-Za-z0-9_$])Jg=\[\{itemId:')
    if raw_tools:
        rows = re.findall(r'\{itemId:(\d+),slot:"([a-z]+)",bonus:([0-9.]+)\}', raw_tools)
        if rows:
            out["toolBonuses"] = [
                {"itemId": int(i), "slot": s, "bonus": float(b)} for i, s, b in rows
            ]
            # 装备槽 → 技能 的映射也一并带上，便于按技能找工具
            m_slots = re.search(r'ni=\{pickaxe:"mining".{0,300}?\}', src)
            if m_slots:
                out["toolSlots"] = dict(re.findall(r'([a-z]+):"([a-z]+)"', m_slots.group(0)))

    # ── 校验：关键项必须齐 ──
    missing = [k for k in ("buffTierMults", "buffPerRank", "xpTierMults",
                           "perks", "toolBonuses") if k not in out]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"已写入 {OUT}")
    for k, v in out.items():
        if k.startswith("_"):
            continue
        print(f"  {k}: {json.dumps(v, ensure_ascii=False)[:150]}")
    if missing:
        print(f"\n⚠ 未提取到：{missing}（游戏中可能改了命名，需要重新定位）")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
