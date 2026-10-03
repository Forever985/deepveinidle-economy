#!/usr/bin/env python3
"""DVI 离线收益报告抓取器 —— 零依赖（Python 3.10+ 标准库）

用法：
    python dvi-offline-report.py "sid=<你的cookie值>"
    python dvi-offline-report.py --file cookie.txt

它会：
  1. 用你的会话 cookie 建立 WebSocket 连接（= 模拟一次登录）
  2. 请求 resync，读取 welcome 帧里的 offline 字段
  3. 用本地游戏数据把 itemId 翻译成物品名，打印可读报告
  4. 同时把原始 JSON 存成 offline-report.json

⚠️ 重要：DVI 强制单会话。本脚本连接期间，你浏览器里的游戏会被踢下线
   并提示 "logged in elsewhere"。请在关闭游戏标签页后运行。
⚠️ 运行一次即「消费」掉离线进度——之后再打开游戏，那次报告就没了。
"""
import socket, ssl, base64, os, struct, json, time, sys, gzip
from pathlib import Path

HOST = "deepveinidle.com"
HERE = Path(__file__).resolve().parent
GAMEDATA = HERE / "gamedata" / "dvi-gamedata.json"


# ---------- 本地游戏数据（用于把 id 翻译成人话） ----------
def load_names():
    try:
        g = json.loads(GAMEDATA.read_text(encoding="utf-8"))
    except Exception:
        return {}, {}
    items = {str(i["id"]): i["name"] for i in g.get("items", [])}
    actions = {a["id"]: a["name"] for a in g.get("actions", [])}
    return items, actions


ITEM_NAME, ACTION_NAME = load_names()


# ---------- 极简 WebSocket 客户端 ----------
def ws_connect(cookie, timeout=20):
    key = base64.b64encode(os.urandom(16)).decode()
    ctx = ssl.create_default_context()
    raw = socket.create_connection((HOST, 443), timeout=timeout)
    s = ctx.wrap_socket(raw, server_hostname=HOST)
    s.sendall(
        f"GET /ws HTTP/1.1\r\nHost: {HOST}\r\nUpgrade: websocket\r\n"
        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\nOrigin: https://{HOST}\r\n"
        f"Cookie: {cookie}\r\n\r\n".encode()
    )
    buf = b""
    while b"\r\n\r\n" not in buf:
        c = s.recv(4096)
        if not c:
            break
        buf += c
    head, rest = buf.split(b"\r\n\r\n", 1)
    status = head.split(b"\r\n")[0].decode(errors="replace")
    if b"101" not in head.split(b"\r\n")[0]:
        raise SystemExit(f"握手失败：{status}\n（cookie 可能已失效，或需要重新登录）")
    return s, rest


def send(s, obj):
    d = json.dumps(obj).encode()
    m = os.urandom(4)
    h = bytearray([0x81])
    if len(d) < 126:
        h.append(0x80 | len(d))
    elif len(d) < 65536:
        h.append(0x80 | 126); h += struct.pack(">H", len(d))
    else:
        h.append(0x80 | 127); h += struct.pack(">Q", len(d))
    s.sendall(bytes(h) + m + bytes(b ^ m[i % 4] for i, b in enumerate(d)))


def frames(s, buf, seconds):
    """重组 WebSocket 分片（DVI 会对大帧分片）后产出完整 JSON 帧"""
    msg = bytearray(); end = time.time() + seconds
    while time.time() < end:
        while len(buf) >= 2:
            b1, b2 = buf[0], buf[1]
            fin, op, ln, i = b1 & 0x80, b1 & 0x0F, b2 & 0x7F, 2
            if ln == 126:
                if len(buf) < 4: break
                ln, i = struct.unpack(">H", buf[2:4])[0], 4
            elif ln == 127:
                if len(buf) < 10: break
                ln, i = struct.unpack(">Q", buf[2:10])[0], 10
            if len(buf) < i + ln: break
            payload, buf = buf[i:i + ln], buf[i + ln:]
            if op == 0x1: msg = bytearray(payload)
            elif op == 0x0: msg += payload
            if fin and msg:
                try: yield json.loads(msg)
                except Exception: pass
                msg = bytearray()
        try:
            s.settimeout(max(0.2, end - time.time()))
            c = s.recv(1 << 20)
            if not c: return
            buf += c
        except socket.timeout:
            return


# ---------- 报告渲染 ----------
def fmt_ticks(n):
    sec = n  # ≈1 tick/秒
    if sec < 90: return f"{sec} 秒"
    if sec < 5400: return f"{sec/60:.1f} 分钟"
    return f"{sec/3600:.1f} 小时"


def render(off, you):
    L = []
    L.append("=" * 58)
    L.append("  Deep Vein Idle —— 离线收益报告")
    L.append("=" * 58)
    L.append(f"  角色：{you.get('name')}  (id {you.get('id')})")
    cap = you.get("offlineCapTicks", 0)
    L.append(f"  离线时长：{fmt_ticks(off.get('ticksElapsed',0))}"
             f"  /  上限 {fmt_ticks(cap)}")
    if off.get("ticksSkipped"):
        L.append(f"  ⚠ 超出上限被跳过：{fmt_ticks(off['ticksSkipped'])}")
    if off.get("stoppedEarly"):
        L.append("  ⚠ 提前停止（背包满 / 无材料 / 被打断）")
    L.append("-" * 58)

    L.append("  技能")
    sk = off.get("skills") or {}
    if not sk:
        L.append("    （无）")
    for name, v in sk.items():
        arrow = ""
        if v.get("levelAfter") != v.get("levelBefore"):
            arrow = f"   ★ {v['levelBefore']} → {v['levelAfter']}"
        L.append(f"    {name:<14} +{v.get('xp',0):>8} xp{arrow}")

    L.append("")
    L.append("  获得物品")
    ig = off.get("itemsGained") or {}
    if not ig:
        L.append("    （无）")
    for iid, qty in sorted(ig.items(), key=lambda x: -x[1]):
        nm = ITEM_NAME.get(str(iid), f"#{iid}")
        L.append(f"    {nm:<22} ×{qty:>7}")

    L.append("")
    L.append("  其他")
    for key, label in (("drops","稀有掉落"),("bonuses","额外产出"),
                       ("kills","击杀"),("deaths","死亡"),
                       ("burnt","烧焦"),("coins","金币"),("deposits","存入仓库")):
        v = off.get(key, 0)
        if v:
            L.append(f"    {label:<10} {v}")
    L.append(f"    {'存入仓库':<10} {off.get('deposits',0)}")

    segs = off.get("segments") or []
    if len(segs) > 1 or (segs and segs[0].get("task")):
        L.append("")
        L.append("  分段明细")
        for i, sg in enumerate(segs, 1):
            t = sg.get("task") or {}
            kind = t.get("kind", "?")
            jid = t.get("jobId")
            nm = ACTION_NAME.get(jid, f"#{jid}") if jid else kind
            L.append(f"    [{i}] {nm:<20} {fmt_ticks(sg.get('ticks',0)):>8}"
                     f"  结束={sg.get('end','?')}")
    L.append("=" * 58)
    return "\n".join(L)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); return
    if args[0] == "--file":
        cookie = Path(args[1]).read_text(encoding="utf-8").strip()
    else:
        cookie = args[0]
    cookie = cookie.replace("Cookie:", "").strip()
    if cookie.startswith("sid=") is False and "=" not in cookie:
        cookie = "sid=" + cookie

    print(f"连接 {HOST} /ws …")
    s, buf = ws_connect(cookie)
    print("已连接（注意：你的浏览器可能已被踢下线）\n")
    send(s, {"t": "resync"})

    welcome = None
    for f in frames(s, buf, 8):
        for e in f.get("m", []):
            if e.get("t") == "welcome":
                welcome = e
                break
        if welcome:
            break
    s.close()

    if not welcome:
        raise SystemExit("没收到 welcome 帧，请重试。")

    off = welcome.get("offline") or {}
    you = welcome.get("you") or {}
    print(render(off, you))

    out = HERE / "offline-report.json"
    out.write_text(json.dumps(
        {"character": {"id": you.get("id"), "name": you.get("name")},
         "offline": off, "offlineCapTicks": you.get("offlineCapTicks")},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n原始 JSON 已保存：{out}")
    print("把这个文件（或上面的文本）发给我即可。")


if __name__ == "__main__":
    main()
