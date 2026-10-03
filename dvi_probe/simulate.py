#!/usr/bin/env python3
"""DVI 模拟数据生成器 —— 用逆向还原的公式造出可信的测试数据。

为什么需要它：
    真实数据要等你玩几天才有。但公式已经还原完了，所以可以用公式反推出
    「一组自洽的存档 + 离线报告」，作为开发期的标定基准（ground truth）。
    等真实数据到位后，再拿真实数据校验这批模拟数据背后的公式是否属实。

产出：
    sim/dvi-capture-sim.jsonl   与真实采集格式完全一致的记录流
    sim/ground-truth.json       每个场景的期望值，供后续对拍

用法：
    python simulate.py
"""
import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
GAMEDATA = HERE / "gamedata" / "dvi-gamedata.json"
OUT = HERE / "sim"
OUT.mkdir(exist_ok=True)

# ══════════════════ 从 bundle 逆向出的平衡参数 ══════════════════
MAX_LEVEL = 99
BASE_XP = 100
XP_GROWTH = 1.12
BEYOND_STEP = 0.1
BEYOND_GROWTH = 1.145
SPEED_PER_LEVEL = 0.005      # 每超出需求等级 1 级，提速 0.5%
PERK_QUICK = 0.005           # 每级「快捷」特长提速 0.5%
MARKET_TAX_BP = 200          # 2%


# ══════════════════ 经验曲线（逐字复刻 bundle 的构造） ══════════════════
def build_xp_table():
    """cumulative[n] = 从 1 级升到 n 级所需的累计经验"""
    o = [0, 0]
    for s in range(2, MAX_LEVEL + 1):
        o.append(round(BASE_XP * (XP_GROWTH ** (s - 1) - 1) / (XP_GROWTH - 1)))
    e = o[MAX_LEVEL] * BEYOND_STEP
    t = o[MAX_LEVEL]
    s = MAX_LEVEL + 1
    while True:
        t += e
        if t > 2 ** 53:
            break
        o.append(round(t))
        e *= BEYOND_GROWTH
        s += 1
    return o


XP_TABLE = build_xp_table()
MAXIDX = len(XP_TABLE) - 1


def level_for_xp(total):
    """经验 → 等级（复刻 ve()）"""
    if total <= 0:
        return 1
    lo, hi = 1, MAXIDX
    while lo < hi:
        mid = math.ceil((lo + hi) / 2)
        if XP_TABLE[mid] <= total:
            lo = mid
        else:
            hi = mid - 1
    return lo


# ══════════════════ 耗时公式（复刻 IT / It / _$） ══════════════════
def combine(*factors):
    """加成叠加法则：各自减 1 再相加"""
    return 1 + sum(f - 1 for f in factors)


def action_ticks(action, level, tool_factor=1.0, quick_perk=0, home_factor=1.0, mastery_factor=1.0):
    """每次行动的耗时。

    ⚠️ 关键：IT() 是「每 tick 推进的进度」，不是耗时。
       代码里用的是 1/Oh(a,you)，而 Oh = min(1, IT/baseTicks)，所以
           耗时 = baseTicks / IT()
       而不是 baseTicks × IT()。等级越高 → IT 越大 → 耗时越短。
    """
    lvl_bonus = 1 + max(0, level - action["levelReq"]) * SPEED_PER_LEVEL
    quick = 1 + PERK_QUICK * quick_perk
    speed = lvl_bonus * tool_factor * combine(quick, home_factor) * mastery_factor
    return action["baseTicks"] / speed


# ══════════════════ 离线结算模拟（复刻 zI） ══════════════════
def simulate_offline(save, job_id, elapsed_ticks, actions_by_id, rng):
    """推进 elapsed_ticks 个 tick，返回与游戏一致的离线报告结构"""
    cap = int(save["offlineCapTicks"] * 1.0)   # 精通 offline 加成此处按 1.0 处理
    applied = min(elapsed_ticks, cap)

    action = actions_by_id[job_id]
    skill = action["skill"]

    report = {
        "ticksElapsed": elapsed_ticks,
        "ticksApplied": applied,
        "ticksSkipped": elapsed_ticks - applied,
        "skills": {},
        "itemsGained": {},
        "deposits": 0, "drops": 0, "bonuses": 0, "burnt": 0,
        "kills": 0, "deaths": 0, "stoppedEarly": False, "coins": 0,
        "segments": [],
    }

    xp_before = save["skills"].get(skill, 0)
    level_before = level_for_xp(xp_before)

    remaining = applied
    produced = {}
    xp_gained = 0
    bank_deposits = 0
    items_carried = 0
    pack_cap = 28          # 背包格数（示例值）
    # 银行往返耗时：不是猜的，是用实测样本反推出来的。
    # 实测访客号：ticksApplied=329、产出 51 个铜矿、deposits=2、
    # 采矿 6 级无工具 → 单次 5/(1.025×1.005)=4.853 tick
    #   (329 − 2T) / 4.853 = 51  →  T ≈ 41
    trip_ticks = 41

    # 每 tick 推进：够一次行动就结算一次
    progress = 0.0
    while remaining > 0:
        cost = action_ticks(action, level_for_xp(xp_before + xp_gained),
                            quick_perk=save.get("perks", {}).get("quick", 0))
        if cost <= 0:
            break
        progress += 1.0
        remaining -= 1
        if progress + 1e-9 < cost:
            continue
        progress -= cost

        # 产出
        out = action["output"]
        iid = str(out["itemId"])
        produced[iid] = produced.get(iid, 0) + out["qty"]
        items_carried += out["qty"]

        # 经验
        xp_gained += action["xp"]

        # 稀有额外产出
        bonus = action.get("bonus")
        if bonus and rng.random() < bonus.get("chance", 0):
            bid = str(bonus["itemId"])
            produced[bid] = produced.get(bid, 0) + 1
            report["bonuses"] += 1

        # 背包满 → 跑银行存入再回来（这段不产出）
        if items_carried >= pack_cap:
            bank_deposits += 1
            items_carried = 0
            spend = min(trip_ticks, remaining)
            remaining -= spend
            progress = 0.0

    # 说明：trip_ticks 是估算值。这会明显拉低「每秒产出」，
    # 正好对应实测样本里「329 tick 只产出 51 个铜矿」(理论应为 ~68 个) 的差额。
    report["_simNote"] = f"含 {bank_deposits} 次银行往返，每次按 {trip_ticks} tick 估算"

    xp_after = xp_before + xp_gained
    level_after = level_for_xp(xp_after)

    report["skills"][skill] = {
        "xp": xp_gained,
        "levelBefore": level_before,
        "levelAfter": level_after,
    }
    report["itemsGained"] = produced
    report["deposits"] = bank_deposits
    report["segments"] = [{
        "task": {"kind": "job", "jobId": job_id, "errand": False},
        "ticks": applied,
        "xp": {skill: xp_gained},
        "items": produced,
        "kills": 0, "deaths": 0,
        "end": "running",
    }]
    return report, xp_gained


# ══════════════════ 造角色 ══════════════════
def make_save(pid, name, skills, coins, equipment=None, quick=0, offline_cap=144000):
    return {
        "id": pid, "name": name, "version": 57,
        "x": 187, "y": 77,
        "skills": skills,
        "equipment": equipment or {
            "pickaxe": None, "rod": None, "axe": None, "gloves": None, "pan": None,
            "hammer": None, "knife": None, "needle": None, "mortar": None, "hoe": None,
            "mount": None, "weapon": None, "shield": None, "helmet": None,
            "body": None, "legs": None, "ring": None, "amulet": None,
        },
        "coins": coins, "gems": 0, "hp": 10,
        "eatAt": 0.5, "foodItemId": None, "foodMaxTier": 1, "foodPerTrip": 20,
        "perks": {"pockets": 1, "hands": 1, "meals": 1, "rest": 1, "quick": quick},
        "masteries": {}, "offlineCapTicks": offline_cap,
        "bank": {}, "pack": [], "bankOrder": [], "overflow": {},
        "queueSlots": 1, "marketOrderSlots": 10, "bankSlotsBought": 0,
        "house": {}, "houseUpgrades": {}, "houseFurniture": {}, "housePoints": {},
        "houseCells": [12], "plots": {}, "plantPlainest": False,
        "route": None, "workSiteId": None, "workJobId": None, "workRarity": 0,
        "activity": "idle", "enhance": None, "titles": [], "title": None,
        "skins": [], "mountSkins": [], "pet": None,
        "streak": {"days": 0, "lastDay": None},
        "tally": {"kills": 0, "made": 0, "deaths": 0, "caught": 0, "questsDone": 0,
                  "coinsEarned": 0, "items": {}, "monsters": {}},
        "questPoints": 0, "quests": {}, "achievements": {}, "collections": {},
        "ironman": False, "unlimitedBank": False, "lastTick": 0, "guide": {},
        "actionIndex": 0,
    }


def main():
    rng = random.Random(20261001)
    g = json.loads(GAMEDATA.read_text(encoding="utf-8"))
    actions = g["actions"]
    items = {str(i["id"]): i for i in g["items"]}
    by_id = {a["id"]: a for a in actions}

    def xp_to_level(n):
        return XP_TABLE[n]

    scenarios = []

    # ── 场景 1：新手挖铜矿，离线 6 小时 ──
    s1 = make_save(900001, "SimMiner", {"mining": xp_to_level(12)}, 1450,
                   equipment={"pickaxe": 81}, quick=3)
    scenarios.append(("新手挖矿 · 离线6小时", s1, 1, 6 * 3600))

    # ── 场景 2：中级钓鱼，过夜 12 小时 ──
    s2 = make_save(900002, "SimAngler", {"fishing": xp_to_level(42)}, 88000,
                   equipment={"rod": 87}, quick=12, offline_cap=144000)
    scenarios.append(("中级钓鱼 · 离线12小时", s2, 24, 12 * 3600))   # 24=Salmon

    # ── 场景 3：打铁，离线 3 天（触发上限截断） ──
    s3 = make_save(900003, "SimSmith", {"smithing": xp_to_level(55)}, 640000,
                   equipment={"hammer": 83}, quick=25, offline_cap=144000)
    scenarios.append(("高级打铁 · 离线3天(触发上限)", s3, 43, 3 * 24 * 3600))

    # ── 场景 4：超长离线，离线上限被商店扩到一周 ──
    s4 = make_save(900004, "SimWhale", {"mining": xp_to_level(70)}, 2100000,
                   equipment={"pickaxe": 84}, quick=40, offline_cap=604800)
    scenarios.append(("满配挖矿 · 离线7天(上限已扩容)", s4, 7, 7 * 24 * 3600))

    records = []
    truth = []
    t0 = datetime(2026, 10, 1, 3, 0, 0, tzinfo=timezone.utc)

    for idx, (label, save, job_id, secs) in enumerate(scenarios):
        action = by_id[job_id]
        report, xp_gained = simulate_offline(save, job_id, secs, by_id, rng)

        # 结算后写回存档
        skill = action["skill"]
        save["skills"][skill] = save["skills"].get(skill, 0) + xp_gained
        for k, v in report["itemsGained"].items():
            save["bank"][k] = save["bank"].get(k, 0) + v

        at = (t0 + timedelta(hours=idx * 7)).isoformat().replace("+00:00", "Z")
        pseudonym = f"sim{idx + 1}"

        records.append({
            "kind": "self", "at": at, "tick": 39324000 + idx * 1000,
            "character": save["name"], "pseudonym": pseudonym, "source": "welcome",
            "self": {**save, "pseudonym": pseudonym},
            "world": {"protocol": 3, "seed": 20260831, "online": 1262,
                      "build": "1db7eb7", "marketTaxBp": MARKET_TAX_BP},
            "counts": {"chat": 810, "windows": 83, "guildBoard": 10},
            "simulated": True,
        })
        records.append({
            "kind": "offline", "at": at, "tick": 39324000 + idx * 1000,
            "character": save["name"], "pseudonym": pseudonym,
            "offline": report, "skillsAfter": save["skills"], "simulated": True,
        })

        # 出产速率记录（把整段离线切成 30 秒窗口的等价形式）
        items_in_window = {f"{job_id}|{action['output']['itemId']}|0": {
            "jobId": job_id, "itemId": action["output"]["itemId"], "tier": 0,
            "n": action["output"]["qty"], "xp": action["xp"], "wire": True}}
        records.append({
            "kind": "production", "at": at, "windowMs": 30000,
            "work": {"siteId": 1, "tool": None, "item": action["output"]["itemId"]},
            "items": items_in_window, "totalXp": action["xp"], "simulated": True,
        })

        applied = report["ticksApplied"]
        eff = action_ticks(action, level_for_xp(save["skills"][skill] - xp_gained),
                           quick_perk=save["perks"]["quick"])
        truth.append({
            "scenario": label,
            "character": save["name"],
            "jobId": job_id,
            "jobName": action["name"],
            "skill": skill,
            "secondsOffline": secs,
            "ticksElapsed": report["ticksElapsed"],
            "ticksApplied": report["ticksApplied"],
            "ticksSkipped": report["ticksSkipped"],
            "cappedByOfflineLimit": report["ticksSkipped"] > 0,
            "effectiveTicksPerAction": round(eff, 4),
            "expectedUnits": sum(report["itemsGained"].values()),
            "xpGained": xp_gained,
            "levelBefore": report["skills"][skill]["levelBefore"],
            "levelAfter": report["skills"][skill]["levelAfter"],
            "unitsPerHour": round(sum(report["itemsGained"].values()) / (applied / 3600), 2) if applied else 0,
            "itemNames": {k: items.get(k, {}).get("name", f"#{k}") for k in report["itemsGained"]},
        })

    # ── 市场记录：用实测拿到的真实盘口做样本 ──
    market_samples = [
        {"itemId": 1, "bids": [{"price": 31, "qty": 35000}, {"price": 30, "qty": 14106}],
         "asks": [], "trades": [{"price": 31, "qty": 20054, "tick": 39320525}]},
        {"itemId": 41, "bids": [{"price": 14, "qty": 1000}], "asks": [],
         "trades": [{"price": 14, "qty": 320, "tick": 39319000}]},
        {"itemId": 1001, "bids": [{"price": 5, "qty": 950}],
         "asks": [{"price": 392, "qty": 3}, {"price": 395, "qty": 24}],
         "trades": [{"price": 395, "qty": 1, "tick": 39319469}]},
    ]
    for m in market_samples:
        records.append({
            "kind": "market", "at": t0.isoformat().replace("+00:00", "Z"),
            "tick": 39324000, "type": "marketDepth", "data": m, "simulated": True,
        })

    # ── 落盘 ──
    jsonl = OUT / "dvi-capture-sim.jsonl"
    with jsonl.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    gt = OUT / "ground-truth.json"
    gt.write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "note": "用逆向还原的公式生成，作为开发期标定基准。真实数据到位后需重新校验公式本身。",
        "balance": {
            "maxLevel": MAX_LEVEL, "baseXp": BASE_XP, "xpGrowth": XP_GROWTH,
            "beyondGrowth": BEYOND_GROWTH, "speedPerLevelAboveRequirement": SPEED_PER_LEVEL,
            "perkQuickPerLevel": PERK_QUICK, "marketTaxBp": MARKET_TAX_BP,
        },
        "xpTableSample": {str(n): XP_TABLE[n] for n in (2, 5, 10, 20, 40, 60, 80, 99)},
        "scenarios": truth,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    # ── 控制台汇总 ──
    print(f"已生成 {len(records)} 条记录 → {jsonl}")
    print(f"标定基准 → {gt}\n")
    print(f"{'场景':<28}{'行动':<14}{'耗时tick':>9}{'产出':>7}{'经验':>8}{'等级':>10}")
    print("-" * 78)
    for t in truth:
        lv = f"{t['levelBefore']}→{t['levelAfter']}" if t["levelBefore"] != t["levelAfter"] else str(t["levelBefore"])
        cap = " ⚠截断" if t["cappedByOfflineLimit"] else ""
        print(f"{t['scenario']:<28}{t['jobName']:<14}{t['ticksApplied']:>9}{t['expectedUnits']:>7}"
              f"{t['xpGained']:>8}{lv:>10}{cap}")


if __name__ == "__main__":
    main()
