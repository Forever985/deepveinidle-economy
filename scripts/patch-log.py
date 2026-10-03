"""给 deploy-once.ps1 加运行日志。

## 为什么加
   连续三次部署失败，每次都要用户把控制台输出整段复制过来 ——
   又长又容易漏关键行。改成**写日志文件**之后：
     · 用户只需说「看日志」，我直接读文件
     · 失败现场留在盘上，可以事后查
     · 成功也留痕，能对照「上次是什么时候推的」

实现用 Start-Transcript —— 它能一并捕获 node / git 等**原生命令**的输出，
不用逐个 echo 重定向。
"""
from pathlib import Path

PS = Path(__file__).resolve().parent.parent / "deploy-once.ps1"
s = PS.read_text(encoding="utf-8-sig")

# ── ① 在 $proxyProc 之前初始化日志 ──
anchor = "$proxyProc  = $null"
assert anchor in s, "定位插入点失败"

INIT = '''# ── 运行日志 ──────────────────────────────────────────────────
# 每��都落一份：deploy-latest.log（固定名，永远指向最近一次）
#              deploy-<时间戳>.log（留档，可对照历史）
# 用户只需说「看日志」，不需要再复制控制台输出。
$LogDir = Join-Path $PSScriptRoot 'logs'
$LogLatest = Join-Path $LogDir 'deploy-latest.log'
try {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    # 清掉上一次的，避免新旧混在一起
    if (Test-Path $LogLatest) { Remove-Item $LogLatest -Force -ErrorAction SilentlyContinue }
    Start-Transcript -Path $LogLatest -Force | Out-Null
} catch {
    $LogLatest = $null       # 日志是辅助功能，起不来不该挡住部署
}

$proxyProc  = $null'''
s = s.replace(anchor, INIT, 1)

# ── ② 开头打印日志位置 ──
old_head = '''    Write-Host "  DVI 利润网 · 一键部署" -ForegroundColor White
    Write-Host "  仓库 : $Remote"
    Write-Host "  站点 : $Site"'''
new_head = '''    Write-Host "  DVI 利润网 · 一键部署" -ForegroundColor White
    Write-Host "  仓库 : $Remote"
    Write-Host "  站点 : $Site"
    if ($LogLatest) { Write-Host "  日志 : $LogLatest" -ForegroundColor DarkGray }'''
assert old_head in s
s = s.replace(old_head, new_head, 1)

# ── ③ 失败时把关键信息写进日志 ──
old_catch = '''    Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  本脚本不会产生半成品状态：测试/构建失败则完全没推送；" -ForegroundColor DarkGray
    Write-Host "  main 成功但 gh-pages 失败时，直接重跑即可补推。" -ForegroundColor DarkGray'''
new_catch = '''    Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  本脚本不会产生半成品状态：测试/构建失败则完全没推送；" -ForegroundColor DarkGray
    Write-Host "  main 成功但 gh-pages 失败时，直接重跑即可补推。" -ForegroundColor DarkGray
    # 日志里写清「失败在第几步、当时 git 看到的原文」，省去翻整份日志
    Write-Host ""
    Write-Host "──────── 失败摘要 ────────" -ForegroundColor DarkGray
    Write-Host "  时间    : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
    Write-Host "  阶段    : $script:Stage" -ForegroundColor DarkGray
    Write-Host "  信息    : $($_.Exception.Message)" -ForegroundColor DarkGray
    if ($script:LastGitOut) {
        Write-Host "  git 输出 :" -ForegroundColor DarkGray
        ($script:LastGitOut -split "`n" | Select-Object -Last 8) |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
    if ($LogLatest) { Write-Host "  完整日志: $LogLatest" -ForegroundColor DarkGray }'''
assert old_catch in s
s = s.replace(old_catch, new_catch, 1)

# ── ④ 记录当前阶段 + 最近的 git 输出 ──
s = s.replace('''function Step([string]$t) {
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor DarkCyan''',
'''$script:Stage = ''
$script:LastGitOut = ''

function Step([string]$t) {
    $script:Stage = $t
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor DarkCyan''', 1)

s = s.replace('''    $out = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
    return @{ Code = $code; Out = ($out | Out-String).Trim() }''',
'''    $out = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
    $txt = ($out | Out-String).Trim()
    if ($code -ne 0) { $script:LastGitOut = "git $($GitArgs -join ' ')`n$txt" }
    return @{ Code = $code; Out = $txt }''', 1)

# main 推送失败时也记下原文
s = s.replace('''            $pushText = ($pushOut -join "`n")''',
'''            $pushText = ($pushOut -join "`n")
            if ($pushExit -ne 0) { $script:LastGitOut = "git push origin $branch`n$pushText" }''', 1)

# ── ⑤ finally 里停 transcript + 留档 ──
old_fin = '''finally {
    # 只关掉本脚本自己启动的反代，复用的不动'''
new_fin = '''finally {
    if ($LogLatest) {
        Write-Host ""
        Write-Host "  [i]  日志已保存：$LogLatest" -ForegroundColor DarkGray
        try {
            Stop-Transcript | Out-Null
            $archive = Join-Path $LogDir ("deploy-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
            Copy-Item $LogLatest $archive -Force -ErrorAction SilentlyContinue
            # 只留最近 30 份，避免日志目录无限膨胀
            $old = Get-ChildItem $LogDir -Filter 'deploy-????????-??????.log' -ErrorAction SilentlyContinue |
                   Sort-Object LastWriteTime -Descending | Select-Object -Skip 30
            if ($old) { $old | Remove-Item -Force -ErrorAction SilentlyContinue }
        } catch { }
    }

    # 只关掉本脚本自己启动的反代，复用的不动'''
assert old_fin in s
s = s.replace(old_fin, new_fin, 1)

PS.write_text(s, encoding="utf-8-sig")
print("OK: deploy-once.ps1 已加运行日志")
