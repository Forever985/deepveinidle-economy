@echo off
REM ===================================================================
REM  DVI Profit Net - one-click deploy
REM
REM  [IMPORTANT] THIS FILE MUST STAY PURE ASCII, WITH NO BOM.
REM    cmd.exe decodes .bat using the system ANSI codepage (GBK here).
REM    A UTF-8 file - especially with a BOM - turns into mojibake, and
REM    the first line silently breaks because the @ gets eaten.
REM    So: not a single non-ASCII character past this point.
REM    Messages live in deploy-once.ps1, which is UTF-8 with BOM and is
REM    read by PowerShell rather than cmd, so it has no such problem.
REM
REM  Usage: double-click this file.
REM ===================================================================
setlocal
title DVI Profit Net - Deploy

echo.
echo ========== [1/3] Flush DNS ==========
ipconfig /flushdns >nul 2>&1
echo   DNS cache flushed

echo.
echo ========== [2/3] Build and push (main + gh-pages) ==========
cd /d "%~dp0"
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
