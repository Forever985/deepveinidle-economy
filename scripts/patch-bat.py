"""给 超级一键部署.bat 插入「编码自愈」步骤。

为什么需要：多个 UTF-8 BOM 会让 Windows PowerShell 在 param() 之前
读到垃圾字符，直接 ParserError（报错还指向 param 那行，看不出真因）。
手工改脚本时踩过 —— 攒到 3 个 BOM 才炸出来。

与其小心翼翼地不写坏，不如让 .bat 每次执行前先归一化一次。
"""
from pathlib import Path

BAT = Path(__file__).resolve().parent.parent / "超级一键部署.bat"
PY = r"C:\Users\18405\.workbuddy\binaries\python\versions\3.13.12\python.exe"

OLD = 'cd /d "%~dp0"\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-once.ps1"'

NEW = f'''cd /d "%~dp0"

REM ── 编码自愈 ──
REM 多个 UTF-8 BOM 会让 PowerShell 在 param() 之前读到垃圾字符而报
REM 「赋值表达式无效」，且报错指向 param 那行，完全看不出真因。
REM 这里先归一化，保证 deploy-once.ps1 开头恰好一个 BOM。
set "DVI_PY={PY}"
if exist "%DVI_PY%" "%DVI_PY%" scripts\\ensure-bom.py deploy-once.ps1 >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-once.ps1"'''


def main() -> None:
    raw = BAT.read_bytes()
    # 剥掉全部前导 BOM 再解��，最后写回恰好一个
    n = 0
    while raw[n * 3:n * 3 + 3] == b"\xef\xbb\xbf":
        n += 1
    text = raw[n * 3:].decode("utf-8")

    if "ensure-bom.py" in text:
        print("  已有自愈步骤，跳过")
        return
    if OLD not in text:
        raise SystemExit("✗ 没在 .bat 里找到目标片段，脚本结构可能变了")

    text = text.replace(OLD, NEW, 1)
    BAT.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
    print(f"  ✓ 已插入编码自愈（原 {n} 个 BOM → 1）")


if __name__ == "__main__":
    main()
