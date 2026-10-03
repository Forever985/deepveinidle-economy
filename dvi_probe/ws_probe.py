import socket, ssl, base64, os, struct, json, time, sys

HOST = "deepveinidle.com"
PATH = "/ws"
COOKIE = sys.argv[1] if len(sys.argv) > 1 else ""
OPS = json.loads(sys.argv[2]) if len(sys.argv) > 2 else [{"t": "ping", "n": 1}]
LISTEN_S = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0


def ws_connect():
    key = base64.b64encode(os.urandom(16)).decode()
    ctx = ssl.create_default_context()
    raw = socket.create_connection((HOST, 443), timeout=15)
    s = ctx.wrap_socket(raw, server_hostname=HOST)
    req = (
        f"GET {PATH} HTTP/1.1\r\n"
        f"Host: {HOST}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Origin: https://deepveinidle.com\r\n"
        "User-Agent: Mozilla/5.0 (probe)\r\n"
        + (f"Cookie: {COOKIE}\r\n" if COOKIE else "")
        + "\r\n"
    )
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    print("=== HANDSHAKE RESPONSE ===")
    print(head.decode(errors="replace"))
    return s, rest


def send_text(s, text):
    data = text.encode()
    mask = os.urandom(4)
    n = len(data)
    header = bytearray([0x81])
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header += struct.pack(">H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", n)
    header += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    s.sendall(bytes(header) + masked)


def recv_frames(s, buf, deadline):
    out = []
    while time.time() < deadline:
        # try parse frames from buffer
        while True:
            if len(buf) < 2:
                break
            b1, b2 = buf[0], buf[1]
            opcode = b1 & 0x0F
            ln = b2 & 0x7F
            idx = 2
            if ln == 126:
                if len(buf) < 4:
                    break
                ln = struct.unpack(">H", buf[2:4])[0]
                idx = 4
            elif ln == 127:
                if len(buf) < 10:
                    break
                ln = struct.unpack(">Q", buf[2:10])[0]
                idx = 10
            if len(buf) < idx + ln:
                break
            payload = buf[idx:idx + ln]
            buf = buf[idx + ln:]
            out.append((opcode, payload))
        try:
            s.settimeout(max(0.2, deadline - time.time()))
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        except socket.timeout:
            break
    return out, buf


s, buf = ws_connect()
frames = []
# initial burst
frames += recv_frames(s, buf, time.time() + 2.5)[0]
print(f"\n=== INITIAL FRAMES: {len(frames)} ===")

for op in OPS:
    print(f"\n---> SEND {json.dumps(op)}")
    send_text(s, json.dumps(op))
    got, buf = recv_frames(s, buf, time.time() + 3.0)
    for opcode, payload in got:
        frames.append((opcode, payload))
        if opcode == 0x1:
            txt = payload.decode(errors="replace")
            print(f"<--- TEXT {len(txt)}B: {txt[:600]}")

print(f"\n=== TOTAL FRAMES: {len(frames)} ===")
s.close()
