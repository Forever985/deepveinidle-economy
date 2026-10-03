@echo off
setlocal
title DVI Profit Net - Deploy GitHub Pages

echo.
echo ========== [1/3] Flush DNS ==========
ipconfig /flushdns >nul 2>&1
echo   DNS cache flushed

echo.
echo ========== [2/3] Build and push (main + gh-pages) ==========
cd /d "%~dp0"

REM ── 编码自愈 ──
REM 多个 UTF-8 BOM 会让 PowerShell 在 param() 之前读到垃圾字符而报
REM 「赋值表达式无效」，且报错指向 param 那行，完全看不出真因。
REM 这里先归一化，保证 deploy-once.ps1 开头恰好一个 BOM。
set "DVI_PY=C:\Users\18405\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if exist "%DVI_PY%" "%DVI_PY%" scripts\ensure-bom.py deploy-once.ps1 >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-once.ps1"
set PS_EXIT=%errorlevel%

echo.
echo ========== [3/3] Done ==========
if "%PS_EXIT%"=="0" (
    echo   [OK] Deploy finished. Visit https://forever985.github.io/deepveinidle-economy/
    echo   Hard refresh with Ctrl+F5 to see the update.
) else (
    echo   [!!] Deploy failed, please check the log above.
)
echo.
pause
