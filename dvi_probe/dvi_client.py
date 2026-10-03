#!/usr/bin/env python3
"""Deep Vein Idle — minimal WebSocket client (stdlib only, no deps).
Demonstrates: guest login -> session cookie -> wss handshake -> read the world tick stream.

Usage:  python dvi_client.py
"""
import socket, ssl, base64, os, struct, json, time, http.client

HOST = "deepveinidle.com"


def post(path, body=None, cookie=None):
    c = http.client.HTTPSConnection(HOST, timeout=20)
    h = {"content-type": "application/json"}
    if cookie:
        h["cookie"] = cookie
    c.request("POST", path, json.dumps(body or {}), h)
    r = c.getresponse()
    data = r.read().decode()
    setc = r.getheader("set-cookie") or ""
    c.close()
    return r.status, (json.loads(data) if data else {}), setc.split(";")[0].strip()


def ws_handshake(cookie):
    key = base64.b64encode(os.urandom(16)).decode()
    s = ssl.create_default_context().wrap_socket(
        socket.create_connection((HOST, 443), timeout=15), server_hostname=HOST)
    s.sendall((
        f"GET /ws HTTP/1.1\r\nHost: {HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
        f"Origin: https://{HOST}\r\nCookie: {cookie}\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += s.recv(4096)
    head, rest = buf.split(b"\r\n\r\n", 1)
    assert b"101" in head.split(b"\r\n")[0], head
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


def read_messages(s, buf, seconds):
    """Reassembles WS fragmentation, yields complete JSON frames."""
    msg = bytearray(); fin = False; end = time.time() + seconds
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


if __name__ == "__main__":
    _, guest, cookie = post("/api/guest")
    print("guest:", guest, "| cookie:", cookie[:24], "...")
    s, buf = ws_handshake(cookie)
    print("ws: 101 Switching Protocols")
    send(s, {"t": "resync"})           # ask for the full world snapshot
    for frame in read_messages(s, buf, 6):
        for e in frame.get("m", []):
            if e.get("t") == "welcome":
                print(f"welcome: protocol={e['protocol']} seed={e['seed']} "
                      f"online={e['online']} chat={len(e['chat'])} "
                      f"windows={len(e['windows'])}")
        if frame.get("m") and frame["m"][0].get("t") == "snapshot":
            you = frame["m"][0]["you"]
            print(f"snapshot: you={you['name']} at ({you['x']},{you['y']}) "
                  f"coins={you['coins']} skills={you['skills']}")
    s.close()
