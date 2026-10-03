"""给 .ps1 加上 UTF-8 BOM。

原因：Windows PowerShell 5.1 读取**不带 BOM** 的 .ps1 时，
会按系统 ANSI 代码页（本机 GBK）解码，脚本里的中文会变成乱码，
进而导致字符串解析失败 —— 表现为「莫名其妙的语法错误」。

所以凡是含非 ASCII 字符的 .ps1，都必须存成 UTF-8 with BOM。
"""
import sys
from pathlib import Path

changed = []
for f in sys.argv[1:]:
    p = Path(f)
    raw = p.read_bytes()
    if raw[:3] == b"\xef\xbb\xbf":
        print(f"  已有 BOM，跳过: {f}")
        continue
    text = raw.decode("utf-8")
    p.write_text(text, encoding="utf-8-sig")
    print(f"  已加 BOM: {f}  ({len(raw)} -> {p.stat().st_size} 字节)")

sys.exit(0 if changed or True else 1)
