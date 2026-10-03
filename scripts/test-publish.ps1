$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Get-Content (Join-Path $root 'deploy-once.ps1') -Raw -Encoding UTF8

$start = $src.IndexOf('function Invoke-Git {')
$end = $src.IndexOf('$proxyProc  = $null')
if ($start -lt 0 -or $end -lt 0) { Write-Host 'FAIL: 找不到函数块'; exit 1 }
Invoke-Expression $src.Substring($start, $end - $start)
Write-Host 'OK  函数已载入'

$bare = Join-Path $env:TEMP ('dvi-bare-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
& git init -q --bare $bare
$remote = $bare -replace '\\', '/'
Write-Host "OK  裸仓库 $remote"

# 造一个「远程已有 gh-pages」，迫使代码走 clone 分支
$seed = Join-Path $env:TEMP ('dvi-seed-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path $seed -Force | Out-Null
Push-Location $seed
& git init -q
& git checkout -q --orphan gh-pages
Set-Content -Path index.html -Value '<html>old</html>' -Encoding UTF8
& git add -A | Out-Null
& git -c user.name=t -c user.email=t@t commit -q -m seed
& git remote add origin $remote
& git push -q origin gh-pages
Pop-Location
Write-Host 'OK  远程已有 gh-pages'

$dist = Join-Path $env:TEMP ('dvi-dist-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path (Join-Path $dist 'assets') -Force | Out-Null
Set-Content -Path (Join-Path $dist 'index.html') -Value '<html>new</html>' -Encoding UTF8
Set-Content -Path (Join-Path $dist 'assets\app.js') -Value 'console.log(1)' -Encoding UTF8
Write-Host 'OK  假 dist 已就绪'

Write-Host ''
Write-Host '---- 执行 Publish-GhPages ----'
Publish-GhPages -Repo $remote -Dist $dist
$code = $LASTEXITCODE
Write-Host "---- 退出码 $code ----"
Write-Host ''

$ok = $true
$verify = Join-Path $env:TEMP ('dvi-v-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
& git clone -q --branch gh-pages --single-branch $remote $verify 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'FAIL  克隆不回来'
    $ok = $false
}
else {
    Push-Location $verify
    $idx = Get-Content index.html -Raw
    $files = & git ls-files
    Write-Host "  远程文件: $($files -join ', ')"
    if ($idx -match 'new') { Write-Host '  OK  index.html 已是新内容' }
    else { Write-Host '  FAIL  index.html 还是旧内容'; $ok = $false }
    if ($files -contains 'assets/app.js') { Write-Host '  OK  子目录文件已发布' }
    else { Write-Host '  FAIL  子目录文件丢了'; $ok = $false }
    Pop-Location
}

Push-Location $root
$dirty = & git status --short
Pop-Location
if ([string]::IsNullOrWhiteSpace(($dirty -join ''))) { Write-Host '  OK  主仓库工作区干净' }
else {
    Write-Host '  FAIL  主仓库被改动了'
    Write-Host ($dirty -join [Environment]::NewLine)
    $ok = $false
}

foreach ($d in @($bare, $seed, $dist, $verify)) {
    if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue }
}

if ($code -eq 0 -and $ok) { Write-Host ''; Write-Host 'RESULT: PASS'; exit 0 }
Write-Host ''
Write-Host "RESULT: FAIL (code=$code)"
exit 1
