# ============================================================
#  DVI 利润网 · 一键部署（由「超级一键部署.bat」双击调用，也可直接跑）
#
#  为什么需要专门的网络处理：
#    本机用 Watt Toolkit(Steam++) 的「hosts 劫持 + 443 MITM」模式加速 GitHub，
#    hosts 把 github.com 指向 127.0.0.1:443。但 Git for Windows 的 libcurl
#    **不读 hosts 文件**（实测会直连真实 IP 然后超时），而把 git 直接指向
#    127.0.0.1:443 当代理也不行（Watt 对 CONNECT 请求返回 302，
#    它只处理被劫持的直连流量，不做隧道）。
#
#  本脚本的解法：
#    启动本地 HTTPS CONNECT 反代 scripts/local-github-proxy.mjs，
#    由它读 hosts 并把流量转给 Watt；git 只需认这个普通 HTTP 代理。
#    反代启动时会自检（SELFTEST_OK），通道不通时脚本立刻停下并给出提示：
#    **绝不空推，也绝不把「连不上」误报成「部署成功」。**
#
#  流程：[0]环境 -> [1]通道 -> [2]测试 -> [3]构建 -> [4]推 main -> [5]推 gh-pages
# ============================================================

param(
    [int]$ProxyPort = 7899,
    [int]$MaxAttempts = 3,
    [switch]$SkipBuild,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$Remote = 'https://github.com/Forever985/deepveinidle-economy.git'
$Site   = 'https://forever985.github.io/deepveinidle-economy/'
$PLog   = Join-Path $env:TEMP 'dvi-profit-proxy.log'
$WebDir = Join-Path $PSScriptRoot 'web'

# ── gh-pages 发布（原生实现，不依赖 bash / node）─────────────────
function Invoke-Git {
    param([string[]]$GitArgs, [string]$Cwd = $PSScriptRoot)
    $out = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
    $txt = ($out | Out-String).Trim()
    if ($code -ne 0) { $script:LastGitOut = "git $($GitArgs -join ' ')`n$txt" }
    return @{ Code = $code; Out = $txt }
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

# ── 运行日志 ──────────────────────────────────────────────────
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

$proxyProc  = $null
$proxyOwned = $false
$tmpCfg     = $null

$script:Stage = ''
$script:LastGitOut = ''

function Step([string]$t) {
    $script:Stage = $t
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor DarkCyan
    Write-Host " $t" -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor DarkCyan
}
function Ok([string]$m)   { Write-Host "  [OK] $m"   -ForegroundColor Green }
function Info([string]$m) { Write-Host "  [i]  $m"   -ForegroundColor DarkGray }
function Warn([string]$m) { Write-Host "  [!]  $m"   -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host "  [X]  $m"   -ForegroundColor Red }

function Test-PortOpen([int]$port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(500)
        if ($ok) { $c.EndConnect($iar) }
        $c.Close()
        return $ok
    } catch { return $false }
}

try {
    Write-Host ""
    Write-Host "  DVI 利润网 · 一键部署" -ForegroundColor White
    Write-Host "  仓库 : $Remote"
    Write-Host "  站点 : $Site"
    if ($LogLatest) { Write-Host "  日志 : $LogLatest" -ForegroundColor DarkGray }

    # ---------------------------------------------------------- [0/6] 环境
    Step "[0/6] 环境检查"
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "找不到 node，请先安装 Node.js 并加入 PATH" }
    if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { throw "找不到 git" }
    if (-not (Get-Command npm   -ErrorAction SilentlyContinue)) { throw "找不到 npm" }
    $proxyScript = Join-Path $PSScriptRoot 'scripts\local-github-proxy.mjs'
    if (-not (Test-Path $proxyScript)) { throw "缺少 scripts\local-github-proxy.mjs" }
    if (-not (Test-Path (Join-Path $WebDir 'package.json'))) { throw "缺少 web\package.json" }
    if (-not (Test-Path (Join-Path $WebDir 'node_modules'))) {
        throw "依赖还没装。请先执行：cd web; npm install"
    }
    Info ("node " + (node --version))
    Info (& git --version)
    Ok "环境就绪"

    # ---------------------------------------------------------- [1/6] 通道
    Step "[1/6] 准备网络通道"

    # 两条路，优先用系统代理 —— 那通常更稳、也更省事：
    #   A. 系统代理（Windows「设置 → 网络和 Internet → 代理」里配的那个）
    #   B. Watt Toolkit 的 hosts 劫持：需要自己起 CONNECT 反代把流量转给它
    $sysProxy = $null
    try {
        $ip = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
        if ($ip.ProxyEnable -eq 1 -and $ip.ProxyServer) {
            $raw = [string]$ip.ProxyServer
            # 可能是 "host:port" 或 "http=host:port;https=host:port"
            if ($raw -match '^\d+\.\d+\.\d+\.\d+:\d+$') { $sysProxy = $raw }
            elseif ($raw -match 'https?=([^;]+)')          { $sysProxy = $Matches[1] }
        }
    } catch { }

    if ($sysProxy) {
        Ok "检测到系统代理：$sysProxy —— 直接使用"
        $env:http_proxy  = "http://$sysProxy"
        $env:https_proxy = "http://$sysProxy"
        Info "若推送失败，可改用 Watt Toolkit 通道（-ProxyPort 参数）"
    } else {
        Info "未检测到系统代理，改走 Watt Toolkit 加速通道 ..."
    }

    $useProxy = $env:https_proxy

    if (-not $useProxy) {
        if (Test-PortOpen $ProxyPort) {
            Info "端口 $ProxyPort 已在监听，复用已有反代"
        } else {
            Info "启动本地反代 ..."
            if (Test-Path $PLog) { Remove-Item $PLog -Force -ErrorAction SilentlyContinue }
            $proxyProc = Start-Process -FilePath 'node' -ArgumentList @($proxyScript, "$ProxyPort") `
                -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput $PLog -RedirectStandardError "$PLog.err"
            $proxyOwned = $true
            $waited = 0
            while ($waited -lt 15 -and -not (Test-PortOpen $ProxyPort)) {
                Start-Sleep -Seconds 1
                $waited++
            }
            if (-not (Test-PortOpen $ProxyPort)) {
                if (Test-Path $PLog) { Get-Content $PLog -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "      $_" } }
                throw "反代启动超时（15 秒）"
            }
            Ok "反代已监听 127.0.0.1:$ProxyPort（等待 ${waited}s）"
        }

        if (Test-Path $PLog) {
            $logText = (Get-Content $PLog -Raw -ErrorAction SilentlyContinue)
            if ($logText -match 'SELFTEST_OK') { Ok "加速通道自检通过" }
            elseif ($logText -match 'SELFTEST_FAIL') {
                Warn "通道自检未通过 —— 请确认 Watt Toolkit 已开启且「GitHub 加速」已勾选"
            }
        }
        $env:http_proxy  = "http://127.0.0.1:$ProxyPort"
        $env:https_proxy = "http://127.0.0.1:$ProxyPort"
    }

    # 临时 git 配置：走本地反代 + 放行 Watt 自签证书 + 凭据 wincred + 大仓库 postBuffer
    $tmpCfg = Join-Path $env:TEMP ("dvi-deploy-" + [guid]::NewGuid().ToString('N') + ".cfg")
    & git config --file $tmpCfg http.proxy  $env:http_proxy
    & git config --file $tmpCfg https.proxy $env:https_proxy
    & git config --file $tmpCfg http.sslVerify  false
    & git config --file $tmpCfg https.sslVerify false
    & git config --file $tmpCfg credential.helper wincred
    & git config --file $tmpCfg http.postBuffer 524288000
    # 仓库目录属主可能不是当前用户，会让所有写操作以
    # "detected dubious ownership" 失败；在临时配置里放行，不动用户全局配置
    & git config --file $tmpCfg --add safe.directory '*'
    $gName  = & git config --global --get user.name  2>$null
    $gEmail = & git config --global --get user.email 2>$null
    if ($gName)  { & git config --file $tmpCfg user.name  $gName }
    if ($gEmail) { & git config --file $tmpCfg user.email $gEmail }
    $env:GIT_CONFIG_GLOBAL   = $tmpCfg
    $env:GIT_CONFIG_NOSYSTEM = '1'
    $env:GIT_TERMINAL_PROMPT = '0'

    Info "验证远程连通性 ..."
    & git ls-remote --heads $Remote *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "仍无法访问 GitHub。请检查：`n        - Watt Toolkit 是否已打开，且「网络加速 - GitHub」已勾选启用`n        - 或在 Watt Toolkit 中改用「系统代理」模式后重试"
    }
    Ok "GitHub 可达"

    # ---------------------------------------------------------- [2/6] 测试
    Step "[2/6] 跑计算层测试"
    Push-Location $WebDir
    & npm test
    $testExit = $LASTEXITCODE
    Pop-Location
    if ($testExit -ne 0) { throw "计算层测试未通过，已中止（未推送任何东西）" }
    Ok "测试通过"

    # ---------------------------------------------------------- [3/6] 生成数据 + 构建
    Step "[3/6] 生成游戏数据并构建 web"

    # 派生数据不入库（见 .gitignore），所以每次部署现生成。
    # 游戏数据没变时内容完全一样，git 也不会产生新提交。
    Push-Location $WebDir
    & "C:/Users/18405/.workbuddy/binaries/python/versions/3.13.12/python.exe" prepare-data.py
    $dataExit = $LASTEXITCODE
    Pop-Location
    if ($dataExit -ne 0) { throw "生成游戏数据失败，已中止（未推送任何东西）" }
    Ok "游戏数据已就绪"
    if ($SkipBuild) {
        Warn "已指定 -SkipBuild，跳过构建"
    } else {
        Push-Location $WebDir
        & npm run build
        $buildExit = $LASTEXITCODE
        Pop-Location
        if ($buildExit -ne 0) { throw "构建失败，已中止（未推送任何东西）" }
        if (-not (Test-Path (Join-Path $WebDir 'dist\index.html'))) {
            throw "构建完成但缺少 web\dist\index.html"
        }
        Ok "构建完成"
    }

    # ---------------------------------------------------------- [4/6] main
    Step "[4/6] 提交并推送源码到 main"
    $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
    Info "当前分支：$branch"
    $attempt = 0
    while ($true) {
        $attempt++
        & git add -A
        if ($LASTEXITCODE -ne 0) { throw "git add 失败" }

        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        & git commit --no-verify -m "deploy: $stamp" *> $null
        if ($LASTEXITCODE -eq 0) { Ok "已提交: deploy: $stamp" } else { Info "没有新的源码改动，跳过提交" }

        Info "推送 $branch（第 $attempt 次）..."
        # git 会把「进度/统计」写到 stderr。若让 PowerShell 把它当错误记录，
        # 配合 $ErrorActionPreference='Stop' 会在 push **成功**时误抛异常。
        # 所以这里临时降级错误策略，只用 $LASTEXITCODE 判定成败。
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $pushOut = & git push origin $branch 2>&1
        $pushExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEap

        if ($pushExit -eq 0) { Ok "$branch 推送完成"; break }
        $pushText = ($pushOut -join "`n")
        if ($pushText -match 'Everything up-to-date') { Ok "$branch 已是最新"; break }

        # 权限 / 认证类错误**重试没有意义**，立刻停下并说清原因。
        # 之前不明就重试 3 次，3 次都是同样的错，白等 6 秒还看不懂问题在哪。
        if ($pushText -match 'without .* scope|remote rejected|Permission denied|403|401|could not read Username|Authentication failed') {
            Write-Host "  [!] 推送被拒绝（权限/认证问题，重试无用）：" -ForegroundColor Yellow
            $pushOut | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
            throw @"
推送被 GitHub 拒绝 —— 原因如上。
最常见的是 Personal Access Token 缺某个 scope：
  · 要推 .github/workflows/ 里的文件 → token 需要 workflow scope
  · 仓库是私有的 → token 需要 repo scope
本机凭据管理：控制面板 → 凭据管理器 → git:https://github.com → 删掉旧条目，
下次推送时会重新弹出登录窗口，重新授权即可（勾上需要的 scope）。
"@
        }

        Warn "$branch 推送失败："
        $pushOut | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
        if ($attempt -ge $MaxAttempts) { throw "$branch 推送连续失败 $MaxAttempts 次，已中止" }
        Info "2 秒后重试 ..."
        Start-Sleep -Seconds 2
    }

    # ---------------------------------------------------------- [5/6] gh-pages
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

    # ---------------------------------------------------------- [6/6] 完成
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "  部署完成" -ForegroundColor Green
    Write-Host ""
    Write-Host "  站点地址：$Site" -ForegroundColor Green
    Write-Host "  提示：GitHub Pages 的 CDN 会缓存数十秒。若没看到更新，"
    Write-Host "        请按 Ctrl+F5 强制刷新，或等 1 分钟再试。"
    Write-Host "==========================================================" -ForegroundColor Green
    $exitCode = 0
}
catch {
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host "  部署失败 —— 未完成，请按上方提示排查" -ForegroundColor Red
    Write-Host ""
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
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
    if ($LogLatest) { Write-Host "  完整日志: $LogLatest" -ForegroundColor DarkGray }
    Write-Host "==========================================================" -ForegroundColor Red
    $exitCode = 1
}
finally {
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

    # 只关掉本脚本自己启动的反代，复用的不动
    if ($proxyOwned -and $proxyProc -and -not $proxyProc.HasExited) {
        Stop-Process -Id $proxyProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  [i]  已关闭本次启动的本地反代" -ForegroundColor DarkGray
    }
    if ($tmpCfg -and (Test-Path $tmpCfg)) { Remove-Item $tmpCfg -Force -ErrorAction SilentlyContinue }
    $env:GIT_CONFIG_GLOBAL   = $null
    $env:GIT_CONFIG_NOSYSTEM = $null
}

if (-not $NoPause) {
    Write-Host ""
    Read-Host "按回车键关闭窗口"
}
exit $exitCode
