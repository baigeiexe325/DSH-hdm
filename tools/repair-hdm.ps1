# 一键恢复启动安全版 profile patch（不含 HDM 行），用于插件导致 Web 启动失败时自救。
# 用法：pwsh -File "<仓库路径>/tools/repair-hdm.ps1" [-ProfilePatch <profile 的 cordis.patch.yml 路径>]
param(
  [string]$ProfilePatch = ""
)
$ErrorActionPreference = "Stop"

if (-not $ProfilePatch) {
  # 默认取当前用户 desktop profile 的 patch；可用 -ProfilePatch 覆盖
  $ProfilePatch = Join-Path $env:USERPROFILE ".dsh\profiles\desktop\cordis.patch.yml"
}

$safe = Join-Path $PSScriptRoot "safe-cordis.patch.yml"
$backup = "$ProfilePatch.before-repair-" + (Get-Date -Format "yyyyMMdd-HHmmss")

if (-not (Test-Path $safe)) {
  throw "缺少 safe-cordis.patch.yml，无法恢复"
}
if (-not (Test-Path $ProfilePatch)) {
  throw "找不到 profile patch：$ProfilePatch（可用 -ProfilePatch 指定）"
}

Copy-Item $ProfilePatch $backup -Force
Copy-Item $safe $ProfilePatch -Force
Write-Output "已备份当前配置: $backup"
Write-Output "已恢复启动安全版 patch（不含 HDM 行）: $ProfilePatch"
Write-Output "请重启 DeepSeek Harness；HDM 的 host 插件可随时通过重新插入 hdm 行恢复。"
