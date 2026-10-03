import socket, ssl, base64, os, struct, json, time, sys, zlib

HOST = "deepveinidle.com"
COOKIE = sys.argv[1] if len(sys.argv) > 1 else ""
OPS = json.loads(sys.argv[2]) if len(sys.argv) > 2 else [{"t": "ping", "n": 1}]
PER_OP_S = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0


def ws_connect():
    key = base64.b64encode(os.urandom(16)).decode()
    ctx = ssl.create_default_context()
    raw = socket.create_connection((HOST, 443), timeout=15)
    s = ctx.wrap_socket(raw, server_hostname=HOST)
    req = (
        f"GET /ws HTTP/1.1\r\nHost: {HOST}\r\nUpgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
        "Origin: https://deepveinidle.com\r\n"
        "User-Agent: Mozilla/5.0 (probe)\r\n"
        + (f"Cookie: {COOKIE}\r\n" if COOKIE else "")
        + "\r\n"
    )
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        c = s.recv(4096)
        if not c:
            break
        buf += c
    head, rest = buf.split(b"\r\n\r\n", 1)
    print("HANDSHAKE:", head.decode(errors="replace").splitlines()[0])
    return s, rest


def send_text(s, text):
    data = text.encode()
    mask = os.urandom(4)
    n = len(data)
    h = bytearray([0x81])
    if n < 126:
        h.append(0x80 | n)
    elif n < 65536:
        h.append(0x80 | 126); h += struct.pack(">H", n)
    else:
        h.append(0x80 | 127); h += struct.pack(">Q", n)
    h += mask
    s.sendall(bytes(h) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


class Reader:
    def __init__(self, s, buf):
        self.s = s
        self.buf = buf
        self.msg = bytearray()
        self.op = None
        self.rsv1 = False

    def messages(self, deadline):
        """yield fully reassembled text messages"""
        out = []
        while time.time() < deadline:
            while True:
                if len(self.buf) < 2:
                    break
                b1, b2 = self.buf[0], self.buf[1]
                fin = b1 & 0x80
                rsv1 = b1 & 0x40
                opcode = b1 & 0x0F
                ln = b2 & 0x7F
                idx = 2
                if ln == 126:
                    if len(self.buf) < 4: break
                    ln = struct.unpack(">H", self.buf[2:4])[0]; idx = 4
                elif ln == 127:
                    if len(self.buf) < 10: break
                    ln = struct.unpack(">Q", self.buf[2:10])[0]; idx = 10
                if len(self.buf) < idx + ln:
                    break
                payload = self.buf[idx:idx + ln]
                self.buf = self.buf[idx + ln:]
                if opcode == 0x8:
                    out.append(("CLOSE", payload)); continue
                if opcode == 0x9:
                    out.append(("PING", payload)); continue
                if opcode in (0x1, 0x2):
                    self.msg = bytearray(payload); self.op = opcode; self.rsv1 = bool(rsv1)
                elif opcode == 0x0:
                    self.msg += payload
                if fin:
                    raw = bytes(self.msg)
                    if self.rsv1:
                        try:
                            raw = zlib.decompress(raw, -zlib.MAX_WBITS)
                        except Exception:
                            raw = b"<inflate-failed>" + raw[:80]
                    out.append(("MSG", raw, self.op, self.rsv1))
                    self.msg = bytearray(); self.op = None; self.rsv1 = False
            if time.time() >= deadline:
                break
            try:
                self.s.settimeout(max(0.15, deadline - time.time()))
                c = self.s.recv(1 << 20)
                if not c:
                    break
                self.buf += c
            except socket.timeout:
                break
        return out


s, buf = ws_connect()
r = Reader(s, buf)
allmsgs = []

print("\n== INITIAL BURST ==")
for m in r.messages(time.time() + 2.5):
    if m[0] == "MSG":
        allmsgs.append(m[1])
        print(f"  frame op={m[2]} rsv1={m[3]} len={len(m[1])}")

for op in OPS:
    print(f"\n--> {json.dumps(op)}")
    send_text(s, json.dumps(op))
    for m in r.messages(time.time() + PER_OP_S):
        if m[0] == "MSG":
            allmsgs.append(m[1])
            txt = m[1].decode(errors="replace")
            print(f"  <-- len={len(m[1])} rsv1={m[3]} : {txt[:280]}")

with open("msgs.jsonl", "a", encoding="utf-8") as f:
    for m in allmsgs:
        f.write(m.decode(errors="replace") + "\n")
print(f"\nTOTAL frames: {len(allmsgs)} (appended to msgs.jsonl)")
s.close()
