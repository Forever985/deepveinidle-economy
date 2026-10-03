"""修 Publish-GhPages：Invoke-Git 形同虚设的 Cwd 参数 + 全程不检查退出码。

## 两个真 bug

**① `Invoke-Git` 收了 `$Cwd` 却从不使用**
```powershell
function Invoke-Git {
    param([string[]]$GitArgs, [string]$Cwd = $PSScriptRoot)
    $out = & git @GitArgs 2>&1      # ← 根本没切目录
```
于是 `git rm` / `git add` / `git commit` / `git push` **全都跑在主仓库里**，
而不是临时克隆目录。最后 `git push origin gh-pages` 在主仓库找不到
该分支 → `src refspec gh-pages does not match any`。

**② 每一步的退出码都被 `| Out-Null` 吞掉**
提交其实失败了也没人知道，直接往下走去 push，报错指向 push ——
于是排查方向完全错了（我第一反应也是怀疑提交/身份）。

顺带发现：clone 走代理时**会间歇性 502**，脚本却当成成功继续往下走。

## 修法
- `Invoke-Git` 真的 Push-Location 到 $Cwd，再 Pop 回去
- 加 `-MustSucceed`：失败即抛，**带上 git 原文**，不再静默
- `Publish-GhPages` 每一步都检查，不再盲目 `| Out-Null`
- clone/push 失败自动重试（代理 502 是暂时的）
"""
from pathlib import Path

PS = Path(__file__).resolve().parent.parent / "deploy-once.ps1"
s = PS.read_text(encoding="utf-8-sig")

# ① 替换 Invoke-Git
old_start = s.find("function Invoke-Git {")
old_end = s.find("function Publish-GhPages {")
assert 0 < old_start < old_end, "定位 Invoke-Git 失败"

NEW_INVOKE = '''function Invoke-Git {
    <#
      在指定目录里跑 git。

      ⚠ 之前这个函数收了 $Cwd 却**从不使用** —— git 一直在调用方的当前目录
      （也就是主仓库）里执行，于是 rm/add/commit/push 全打在主仓库上。
      现在真的切目录，并且切完切回。
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$GitArgs,
        [string]$Cwd = $PSScriptRoot,
        [switch]$MustSucceed
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Push-Location $Cwd
        try {
            $out = & git @GitArgs 2>&1
            $code = $LASTEXITCODE
        } finally {
            Pop-Location
        }
    } finally {
        $ErrorActionPreference = $prev
    }

    $txt = ($out | Out-String).Trim()
    if ($code -ne 0) {
        $script:LastGitOut = "git $($GitArgs -join ' ')   (cwd=$Cwd)`n$txt"
        if ($MustSucceed) {
            throw "git $($GitArgs -join ' ') 失败（cwd=$Cwd）：`n$txt"
        }
    }
    return @{ Code = $code; Out = $txt }
}

'''

s = s[:old_start] + NEW_INVOKE + s[old_end:]

# ② 重写 Publish-GhPages 主体：每步检查 + 代理 502 重试
pub_start = s.find("function Publish-GhPages {")
pub_end = s.find("$proxyProc  = $null")
assert 0 < pub_start < pub_end, "定位 Publish-GhPages 失败"

NEW_PUB = '''function Publish-GhPages {
    param([string]$Repo, [string]$Dist, [int]$Tries = 3)

    $global:LASTEXITCODE = 1
    if (-not (Test-Path (Join-Path $Dist 'index.html'))) {
        Write-Host "      [X] 构建产物缺少 index.html：$Dist"
        return
    }

    $tmp = Join-Path $env:TEMP ("dvi-gh-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null

        # ── clone：代理偶尔 502，必须重试，不能当成成功 ──
        $cloned = $false
        for ($i = 1; $i -le $Tries; $i++) {
            $probe = Invoke-Git @('ls-remote', '--heads', $Repo, 'gh-pages')
            if ($probe.Code -eq 0 -and $probe.Out -match 'refs/heads/gh-pages') {
                Write-Host "      [i] 克隆已有 gh-pages 分支（第 $i 次）..."
                $r = Invoke-Git @('clone', '--branch', 'gh-pages', '--single-branch', '--depth', '1', $Repo, $tmp) $PSScriptRoot
                if ($r.Code -eq 0) { $cloned = $true; break }
                Write-Host "      [!] 克隆失败：$($r.Out)" -ForegroundColor DarkGray
                Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
                New-Item -ItemType Directory -Path $tmp -Force | Out-Null
            } else {
                Write-Host "      [i] gh-pages 不存在，新建（第 $i 次）..."
                Invoke-Git @('init', '-q') $tmp -MustSucceed | Out-Null
                Invoke-Git @('config', 'core.autocrlf', 'false') $tmp -MustSucceed | Out-Null
                Invoke-Git @('remote', 'add', 'origin', $Repo) $tmp -MustSucceed | Out-Null
                # 新建分支时仓库还没有任何提交，**不能**跑 git rm ——
                # 会报 "pathspec '.' did not match any files" 并返回非零。
                Invoke-Git @('checkout', '-q', '--orphan', 'gh-pages') $tmp -MustSucceed | Out-Null
                $cloned = $true
                break
            }
            Write-Host "      [i] 3 秒后重试 ..." -ForegroundColor DarkGray
            Start-Sleep -Seconds 3
        }
        if (-not $cloned) { Write-Host "      [X] gh-pages 分支准备失败" -ForegroundColor Red; return }

        # ── 清空（仅克隆已有分支时需要）──
        if ((Invoke-Git @('rev-parse', '--verify', 'HEAD') $tmp).Code -eq 0) {
            Invoke-Git @('rm', '-rq', '--cached', '.') $tmp -MustSucceed | Out-Null
            Invoke-Git @('rm', '-rfq', '--ignore-unmatch', '.') $tmp -MustSucceed | Out-Null
        }

        Write-Host "      [i] 拷入构建产物 ..."
        Copy-Item -Path (Join-Path $Dist '*') -Destination $tmp -Recurse -Force

        # ── 提交：这两步**必须检查**，之前被 Out-Null 吞掉，
        #    结果 commit 失败了还继续 push，报错指向 push，排查方向全错 ──
        Invoke-Git @('add', '-A') $tmp -MustSucceed | Out-Null
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        $c = Invoke-Git @('commit', '-q', '-m', "deploy: $stamp") $tmp
        if ($c.Code -ne 0) {
            # 没有变更时 commit 会返回 1，不是错误
            if ($c.Out -match 'nothing to commit|working directory clean|无文件要提交') {
                Write-Host "      [i] 构建产物与线上完全一致，无需更新"
                $global:LASTEXITCODE = 0
                return
            }
            Write-Host "      [X] 提交失败：$($c.Out)" -ForegroundColor Red
            $global:LASTEXITCODE = 1
            return
        }

        # 提交后确认分支真的存在 —— 少了这步，报错会推迟到 push 才暴露
        $br = Invoke-Git @('rev-parse', '--verify', 'refs/heads/gh-pages') $tmp
        if ($br.Code -ne 0) { Write-Host "      [X] 提交后仍无 gh-pages 分支" -ForegroundColor Red; return }

        Write-Host "      [i] 推送到 gh-pages ..."
        $ok = $false
        for ($i = 1; $i -le $Tries; $i++) {
            $r = Invoke-Git @('push', 'origin', 'gh-pages') $tmp
            if ($r.Code -eq 0) { $ok = $true; break }
            Write-Host "      [!] 第 $i 次推送失败：$($r.Out)" -ForegroundColor DarkGray
            Start-Sleep -Seconds 3
        }
        if (-not $ok) { Write-Host "      [X] 推送失败（已重试 $Tries 次）" -ForegroundColor Red; return }
        $global:LASTEXITCODE = 0
    } catch {
        Write-Host "      [X] $($_.Exception.Message)" -ForegroundColor Red
        $global:LASTEXITCODE = 1
    } finally {
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }
}

'''

s = s[:pub_start] + NEW_PUB + s[pub_end:]
PS.write_text(s, encoding="utf-8-sig")
print("OK: Invoke-Git / Publish-GhPages 已重写")
