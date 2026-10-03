"""把 deploy-once.ps1 的 gh-pages 发布改成原生实现。

为什么不走 bash 脚本：
  本机的 `bash` 是 WSL 的占位程序（未装 WSL 时打印一行提示就退出），
  `Get-Command bash` 检测不到问题，于是每轮都失败。
  而 Node 方案要靠 spawnSync 派发子进程，受限环境里会 EBUSY。
  原生实现没有中间层 —— 直接调 git，不引入任何依赖。
"""
from pathlib import Path

PS = Path(__file__).resolve().parent.parent / "deploy-once.ps1"
s = PS.read_text(encoding="utf-8-sig")

# ① 替换调用段
start = s.find("    # ---------------------------------------------------------- [5/6] gh-pages")
end = s.find("    # ---------------------------------------------------------- [6/6] 完成")
assert start > 0 and end > start, "定位 [5/6] 段失败"

CALL = '''    # ---------------------------------------------------------- [5/6] gh-pages
    Step "[5/6] 推送构建产物到 gh-pages"
    $attempt = 0
    while ($true) {
        $attempt++
        Info "第 $attempt 次尝试 ..."
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        Publish-GhPages -Repo $Remote -Dist (Join-Path $WebDir 'dist')
        $pagesExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEap

        if ($pagesExit -eq 0) { Ok "gh-pages 推送完成"; break }
        Warn "gh-pages 推送失败"
        if ($attempt -ge $MaxAttempts) {
            throw "gh-pages 连续失败 $MaxAttempts 次。`n       注意：main 已推送成功，只是静态站未更新 —— 稍后重跑本脚本即可"
        }
        Info "3 秒后重试 ..."
        Start-Sleep -Seconds 3
    }

'''
s = s[:start] + CALL + s[end:]

# ② 插入函数定义
anchor = "$proxyProc  = $null"
assert anchor in s, "定位插入点失败"

FUNCS = '''# ── gh-pages 发布（原生实现，不依赖 bash / node）─────────────────
function Invoke-Git {
    param([string[]]$GitArgs, [string]$Cwd = $PSScriptRoot)
    $out = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
    return @{ Code = $code; Out = ($out | Out-String).Trim() }
}

function Publish-GhPages {
    param([string]$Repo, [string]$Dist, [int]$Tries = 2)

    $global:LASTEXITCODE = 1
    if (-not (Test-Path (Join-Path $Dist 'index.html'))) {
        Write-Host "      [X] 构建产物缺少 index.html：$Dist"
        return
    }

    $tmp = Join-Path $env:TEMP ("dvi-gh-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null

        $probe = Invoke-Git @('ls-remote', '--heads', $Repo, 'gh-pages')
        if ($probe.Code -eq 0 -and $probe.Out -match 'refs/heads/gh-pages') {
            Write-Host "      [i] 克隆已有 gh-pages 分支 ..."
            $r = Invoke-Git @('clone', '--branch', 'gh-pages', '--single-branch', '--depth', '1', $Repo, $tmp) $PSScriptRoot
            if ($r.Code -ne 0) { Write-Host "      [X] 克隆失败：$($r.Out)"; return }
            Invoke-Git @('rm', '-rq', '--cached', '.') $tmp | Out-Null
            Invoke-Git @('rm', '-rfq', '--ignore-unmatch', '.') $tmp | Out-Null
        } else {
            Write-Host "      [i] gh-pages 不存在，新建 ..."
            Invoke-Git @('init', '-q') $tmp | Out-Null
            Invoke-Git @('config', 'core.autocrlf', 'false') $tmp | Out-Null
            Invoke-Git @('remote', 'add', 'origin', $Repo) $tmp | Out-Null
            Invoke-Git @('checkout', '-q', '--orphan', 'gh-pages') $tmp | Out-Null
            # 新建分支时仓库还没有任何提交，**不能**跑 git rm ——
            # 会报 "pathspec '.' did not match any files" 并返回非零。
        }

        Write-Host "      [i] 拷入构建产物 ..."
        Copy-Item -Path (Join-Path $Dist '*') -Destination $tmp -Recurse -Force

        Invoke-Git @('add', '-A') $tmp | Out-Null
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Invoke-Git @('commit', '-q', '-m', "deploy: $stamp") $tmp | Out-Null

        Write-Host "      [i] 推送到 gh-pages ..."
        $ok = $false
        for ($i = 1; $i -le $Tries; $i++) {
            $r = Invoke-Git @('push', 'origin', 'gh-pages') $tmp
            if ($r.Code -eq 0) { $ok = $true; break }
            Write-Host "      [!] 第 $i 次推送失败，3 秒后重试" -ForegroundColor DarkGray
            Start-Sleep -Seconds 3
        }
        if (-not $ok) { Write-Host "      [X] 推送失败：$($r.Out)"; return }
        $global:LASTEXITCODE = 0
    } finally {
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }
}

$proxyProc  = $null'''

s = s.replace(anchor, FUNCS, 1)
PS.write_text(s, encoding="utf-8-sig")
print("OK: deploy-once.ps1 已改为原生发布")
