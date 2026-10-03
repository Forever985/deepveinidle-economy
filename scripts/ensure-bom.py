"""规范化 .ps1 的 BOM —— **保证恰好一个**，而不是「有就跳过」。

## 为什么不能只做「有就跳过」
   之前这个脚本只判断 `raw[:3] == BOM`，命中就跳过。但编辑流程里
   「用 utf-8 读 → 用 utf-8-sig 写」会把已有 BOM 当成普通字符读进来，
   再写出去时又添一个 —— **BOM 会累积**。

   实际踩到过：deploy-once.ps1 开头攒了 **3 个 BOM**，
   PowerShell 在 param() 之前看到垃圾字符，直接 ParserError
   （报错还指向 param 那一行，完全看不出真实原因）。

   正确做法：先剥掉所有前导 BOM，再补**恰好一个**。
   无论被编辑多少次，结果都稳定。
"""
import sys
from pathlib import Path

BOM = b"\xef\xbb\xbf"


def count_bom(raw: bytes) -> int:
    """数开头连续的 **BOM 序列** 个数。

    ⚠️ 不要用 len(raw) - len(raw.lstrip(BOM)) —— lstrip 按**字节集合**剥离，
    而一个 BOM 是 3 个字节，那样永远得到 3（倍数），不是真正的个数。
    """
    n = 0
    while raw[n * 3:n * 3 + 3] == BOM:
        n += 1
    return n


def normalize(path: Path) -> str:
    raw = path.read_bytes()
    n_bom = count_bom(raw)
    body = raw[n_bom * 3:]
    path.write_bytes(BOM + body)                  # 写回恰好一个
    n_now = count_bom(path.read_bytes())
    assert n_now == 1, f"{path} BOM 归一化失败：{n_now}"
    if n_bom != 1:
        return f"{path.name}: BOM {n_bom} → 1 ✓"
    return f"{path.name}: 已是 1 个 BOM ✓"


def main() -> int:
    for f in sys.argv[1:]:
        p = Path(f)
        if not p.exists():
            print(f"  ! 不存在: {f}")
            continue
        try:
            print("  " + normalize(p))
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {f}: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
