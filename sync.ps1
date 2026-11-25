# 把源码目录同步到 profile 的 node_modules 副本，然后热重载插件。
#
# 这个插件是以 `file:D:\dsh-plugins\dsh-project-flow` 登记进 profile 的，但 pnpm
# 落地时把文件复制了一份到 profiles\<profile>\node_modules\dsh-project-flow，
# 不是软链。所以只改源码目录不会生效，必须同步过去。
#
# 用法：  pwsh -File sync.ps1
#         pwsh -File sync.ps1 -Profile desktop

param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$Source = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

$home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$target = Join-Path $home_ "profiles\$Profile\node_modules\dsh-project-flow"

if (-not (Test-Path $target)) {
  throw "找不到已安装的副本：$target`n先在插件管理器里装一次，或确认 profile 名对不对。"
}

Write-Host "源：  $Source"
Write-Host "目标：$target"

foreach ($file in @('index.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'README.md')) {
  $from = Join-Path $Source $file
  if (Test-Path $from) { Copy-Item $from (Join-Path $target $file) -Force }
}
foreach ($dir in @('locale', 'docs')) {
  $from = Join-Path $Source $dir
  if (Test-Path $from) {
    $to = Join-Path $target $dir
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    Copy-Item (Join-Path $from '*') $to -Force
  }
}

$same = (Get-FileHash (Join-Path $Source 'index.js')).Hash -eq (Get-FileHash (Join-Path $target 'index.js')).Hash
if (-not $same) { throw 'index.js 校验和不一致，同步没成功。' }

Write-Host '已同步，校验通过。' -ForegroundColor Green
Write-Host '生效方式：到插件管理器把 project-flow 关掉再打开（会重新加载模块）。'
Write-Host 'locale / docs 的改动同步过去就生效，不用重载；index.js 的改动必须重载。'
