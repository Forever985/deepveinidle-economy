#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 .bat 规范成「纯 ASCII + 无 BOM」。

## 为什么必须这样
   cmd.exe 用**系统 ANSI 代码页**（本机 GBK）解码 .bat。
   UTF-8 编码的 .bat 会被解成乱码，BOM 还会被当成正文字符 ——
   实测症状：`锘緻echo off`，`@` 被吃掉，第一条命令直接失效。
   报错完全看不出是编码问题。

   所以规则很简单：**.bat 里一个非 ASCII 字符都不能有。**
   中文提示放在 deploy-once.ps1 里（那是 UTF-8 with BOM，
   由 PowerShell 而非 cmd 读取，没这个问题）。

用法：python scripts/fix-bat.py [文件...]
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ["deploy.bat", "超级一键部署.bat", "一键部署.bat"]


def strip_bom(p: Path) -> bytes:
    """剥掉全部前导 BOM。"""
    raw = p.read_bytes()
    n = 0
    while raw[n * 3:n * 3 + 3] == b"\xef\xbb\xbf":
        n += 1
    return raw[n * 3:]


def check_ascii(p: Path) -> list[str]:
    """返回非 ASCII 的行号（1 起）。"""
    return [i for i, ln in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
            if any(ord(c) > 127 for c in ln)]


def main() -> int:
    files = sys.argv[1:] or [str(ROOT / f) for f in DEFAULT if (ROOT / f).exists()]
    if not files:
        print("  没找到 .bat 文件")
        return 0

    bad = 0
    for f in files:
        p = Path(f)
        if not p.exists():
            print(f"  · {p.name} 不存在，跳过")
            continue
        before = p.read_bytes()
        body = strip_bom(p)
        # 写成 ASCII 字节；若有非 ASCII 字符会在这里暴露
        try:
            body.decode("ascii")
            is_ascii = True
        except UnicodeDecodeError:
            is_ascii = False

        p.write_bytes(body)
        after = p.read_bytes()
        removed = "（已去 BOM）" if before != after and before[:3] == b"\xef\xbb\xbf" else ""

        if is_ascii:
            print(f"  ✓ {p.name}: 纯 ASCII、无 BOM{removed}")
        else:
            bad += 1
            print(f"  ✗ {p.name}: 仍含非 ASCII 字符，行号 {check_ascii(p)[:10]}{removed}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
