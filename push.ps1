# 注册好 GitHub 之后，跑这个把仓库推上去。
#
# 用法：
#     pwsh -File push.ps1 -User 你的GitHub用户名
#
# 第一次推送会弹浏览器让你登录 GitHub，或者要你贴一个 token，按提示走就行。

param(
  [Parameter(Mandatory = $true)]
  [string]$User,

  [string]$Repo = 'dsh-project-flow'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ---- 1. 校验用户名格式（GitHub 只允许字母数字和连字符，不能有中文/空格） ----
if ($User -notmatch '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$') {
  throw "用户名 '$User' 格式不对。GitHub 用户名只能由英文字母、数字和连字符组成，最长 39 位，不能以连字符开头或结尾。"
}

$repoUrl = "https://github.com/$User/$Repo"
Write-Host "仓库：$User/$Repo" -ForegroundColor Cyan

# ---- 2. 替换三种占位符写法 ----
$utf8 = New-Object System.Text.UTF8Encoding($false)

$files = @(
  'package.json'
  'README.md'
  'docs/LAUNCH.md'
  'docs/MOMENTS.md'
  'docs/USAGE.md'
  'docs/DETAIL.md'
)

$changed = @()
foreach ($rel in $files) {
  $p = Join-Path $PSScriptRoot $rel
  if (-not (Test-Path $p)) { continue }

  $text = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
  $orig = $text

  $text = $text -replace '\[GITHUB_USERNAME\]', $User
  $text = $text -replace '\[仓库地址\]', $repoUrl
  $text = $text -replace '<你的 GitHub 名>', $User

  if ($text -ne $orig) {
    [System.IO.File]::WriteAllText($p, $text, $utf8)
    $changed += $rel
  }
}

if ($changed.Count -gt 0) {
  Write-Host "已替换占位符：" -ForegroundColor Green
  $changed | ForEach-Object { Write-Host "  $_" }
} else {
  Write-Host "没有发现占位符，可能已经替换过了。" -ForegroundColor Yellow
}

# ---- 3. 检查还有没有漏网的（排除本脚本自身，它必然含有占位符字样） ----
$left = & git grep -l -E 'GITHUB_USERNAME|\[仓库地址\]|<你的 GitHub 名>' -- . ':(exclude)push.ps1' 2>$null
if ($left) {
  Write-Host "警告：以下文件仍然有占位符，请手动检查：" -ForegroundColor Yellow
  $left | ForEach-Object { Write-Host "  $_" }
}

# ---- 4. 提交替换结果 ----
& git add -A
$staged = & git diff --cached --name-only
if ($staged) {
  $msg = "把占位符替换成实际地址 $User/$Repo"
  & git commit -m $msg | Out-Null
  Write-Host "已提交：$msg" -ForegroundColor Green
}

# ---- 5. 配置 remote 并推送 ----
$url = "$repoUrl.git"

$existing = & git remote get-url origin 2>$null
if ($existing) {
  & git remote set-url origin $url
  Write-Host "已更新 origin -> $url"
} else {
  & git remote add origin $url
  Write-Host "已添加 origin -> $url"
}

Write-Host ""
Write-Host "开始推送……第一次会要求登录 GitHub。" -ForegroundColor Cyan
& git push -u origin main

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host " 推送完成" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "接下来还有两件事要你手动做（都很快）："
Write-Host ""
Write-Host "1) 给仓库加 topic，市场收录要求必须有 dsh-plugin"
Write-Host "   打开 $repoUrl"
Write-Host "   右边 About 那一栏有个齿轮，点开，在 Topics 里填：dsh-plugin"
Write-Host ""
Write-Host "2) 建议配 SSH 免密，免得每次推送都要 token"
Write-Host "   ssh-keygen -t ed25519 -C `"你的邮箱`""
Write-Host "   然后把 ~/.ssh/id_ed25519.pub 的内容贴到 https://github.com/settings/keys"
Write-Host ""
Write-Host "注意：市场收录要求仓库创建满 24 小时。今天推上去，明天再提 PR。"
