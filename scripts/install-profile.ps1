# install-profile.ps1 — 将 dsh-cache-cost-monitor 安装为 DSH profile 的 bundle 层
#
# 步骤：构建 → 冒烟测试 → pnpm 安装进 profile → 校验组合树。
# 安装后需要重启 DSH（`dsh web`）才会生效。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/install-profile.ps1
# 参数：
#   -ProfileName  目标 profile（默认 web）
#   -CheckoutDir  插件目录（默认本脚本所在目录的上级）
#   -SkipTests    跳过 npm test
#
# 回滚：dsh plugin --profile <name> remove dsh-cache-cost-monitor

param(
  [string]$ProfileName = 'web',
  [string]$CheckoutDir = '',
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
if ($CheckoutDir -eq '') { $CheckoutDir = Split-Path -Parent $PSScriptRoot }
$CheckoutDir = (Resolve-Path $CheckoutDir).Path
Write-Host "[install] 插件目录: $CheckoutDir"
Write-Host "[install] 目标 profile: $ProfileName"

# 1) 确保 pnpm 可用（DSH 的 dsh plugin 命令转发给 pnpm）
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host '[install] 未找到 pnpm，尝试通过 corepack 启用…'
  try {
    corepack prepare pnpm@latest --activate | Out-Null
    corepack enable | Out-Null
  } catch {
    Write-Host '[install] corepack 不可用，回退到 npm 全局安装 pnpm…'
    npm install -g pnpm | Out-Host
  }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw 'pnpm 仍不可用：请手动安装（corepack enable / npm i -g pnpm）后重试'
  }
}
Write-Host "[install] pnpm: $(pnpm --version)"

# 2) 安装依赖并构建
Push-Location $CheckoutDir
try {
  if (-not (Test-Path 'node_modules')) { npm install | Out-Host }
  npm run build | Out-Host
  if (-not $SkipTests) { npm test | Out-Host }
} finally {
  Pop-Location
}

# 3) 安装进 profile（绝对路径 spec，DSH 会把它加入 dsh.profile.bundles 层栈）
#    --config.node-linker=isolated：Windows 上 pnpm workspace 对绝对路径创建
#    junction 有 bug（把盘符路径当相对路径拼接），isolated linker 能正确创建
#    链接；其他平台加此参数亦无副作用。
dsh plugin --profile $ProfileName add $CheckoutDir --config.node-linker=isolated
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（exit=$LASTEXITCODE）" }

# 4) 校验组合树包含本插件行
$dump = dsh --profile $ProfileName --dump-config 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host $dump; throw '--dump-config 失败' }
if ($dump -match 'cache-cost-monitor') {
  Write-Host '[install] 校验通过：组合树已包含 cache-cost-monitor 行'
} else {
  Write-Host '[install] 警告：组合树中未找到 cache-cost-monitor 行，请检查 dsh.profile.bundles'
}

Write-Host ''
Write-Host '[install] 完成。重启 DSH（dsh web）后生效：'
Write-Host "  - 会话中可让 Agent 调用 cache_report 工具查看统计报表"
Write-Host '  - 每条助手消息末尾显示该轮 tokens 与人民币消耗'
Write-Host "  - 回滚：dsh plugin --profile $ProfileName remove dsh-cache-cost-monitor --config.node-linker=isolated"
