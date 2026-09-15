<#
.SYNOPSIS
  dsh-study-buddy 部署三要素校验（只读）。

.DESCRIPTION
  插件是 `file:` 依赖（pnpm 按内容拷贝）+ 预设是「复制到 %DSH_HOME% 后各机自行编辑」
  的部署形态，所以"仓库里改好了、跑的还是旧构建/旧预设"是常态（troubleshooting.md §二.2
  把它列为最容易走错的一步）。本脚本只读比对三件事：

    1. 插件产物：仓库 lib/index.js 的 SHA256 == <profile>\node_modules\dsh-study-buddy\lib\index.js
    2. 预设分叉：部署副本 agent.cordis.yml 的行/键集合 vs 仓库模板（vaultRoot 允许不同）
    3. 附带污染：退化技能目录、缺失的《笔记期望.md》、.dsh-module-fallback 里的展开项

  只读：不写任何文件、不复制、不装依赖。退出码 0 = 全绿，1 = 有 FAIL，2 = 参数/环境问题。

.EXAMPLE
  pnpm run verify:deploy -- -Profile web
.EXAMPLE
  powershell -NoProfile -File tools/verify-deploy.ps1 -Profile web -RepoRoot . -VaultRoot 'T:\杂七杂八\2.笔记\碎语札'
#>
[CmdletBinding()]
param(
  # DSH profile 名（插件装在 %DSH_HOME%\profiles\<name>\node_modules 下）
  [string]$Profile = 'web',
  # 插件仓库根（默认按脚本位置往上找一行）
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSCommandPath)),
  # DSH 主目录（默认 $env:DSH_HOME，退到 ~/.dsh）
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  # vault 根（给了就检查《笔记期望.md》；不给则从部署副本的 study 行 config 里读）
  [string]$VaultRoot = '',
  # 只报告不判定失败（用于"想先看看差多少"）
  [switch]$ReportOnly
)

$ErrorActionPreference = 'Stop'
$script:Fail = 0
$script:Warn = 0

function Write-Ok   { param([string]$Message) Write-Host "  OK   $Message" }
function Write-Bad  { param([string]$Message) $script:Fail++; Write-Host "  FAIL $Message" -ForegroundColor Red }
function Write-Warn { param([string]$Message) $script:Warn++; Write-Host "  WARN $Message" -ForegroundColor Yellow }
function Write-Info { param([string]$Message) Write-Host "  --   $Message" }

Write-Host "dsh-study-buddy 部署校验（只读）"
Write-Host "  仓库：$RepoRoot"
Write-Host "  DSH ：$DshHome (profile: $Profile)"
Write-Host ''

# ── 1. 插件产物一致性 ────────────────────────────────────────────────────────
Write-Host '[1/4] 插件产物（file: 依赖按内容拷贝，不比对就会"看着改了其实没生效"）'
$repoLib = Join-Path $RepoRoot 'lib\index.js'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$installedDir = Join-Path $profileDir 'node_modules\dsh-study-buddy'
$installedLib = Join-Path $installedDir 'lib\index.js'

if (-not (Test-Path -LiteralPath $repoLib)) {
  Write-Bad "仓库没有构建产物：$repoLib（先跑 pnpm run build）"
} elseif (-not (Test-Path -LiteralPath $installedLib)) {
  Write-Bad "profile 里没装插件：$installedLib（见用户指南 §3.3）"
} else {
  $repoHash = (Get-FileHash -LiteralPath $repoLib -Algorithm SHA256).Hash
  $instHash = (Get-FileHash -LiteralPath $installedLib -Algorithm SHA256).Hash
  if ($repoHash -eq $instHash) {
    Write-Ok "lib/index.js 哈希一致（$($repoHash.Substring(0,12))…）"
  } else {
    Write-Bad "lib/index.js 哈希不一致（仓库 $($repoHash.Substring(0,12))… / profile $($instHash.Substring(0,12))…）"
    Write-Info "修复：Remove-Item -Recurse -Force '$installedDir'; cd '$profileDir'; pnpm install（用户指南 §3.7）"
  }
}

# ── 2. 预设分叉 ──────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '[2/4] 预设（部署副本 vs 仓库模板；vaultRoot 允许不同，其余应一致）'
$repoPreset = Join-Path $RepoRoot 'presets\study\agent.cordis.yml'
$deployPreset = Join-Path $DshHome ".agent-presets\study\agent.cordis.yml"

# 零依赖解析：行 = `- id: xxx`，行内模块名 = `  name:`，config 一级键 = 4 空格缩进
function Get-Rows {
  param([string]$Path)
  $rows = [ordered]@{}
  $current = $null
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    if ($line -match '^-\s*id:\s*(\S+)') {
      $current = $Matches[1]
      $rows[$current] = @{ Name = ''; Keys = @() }
      continue
    }
    if ($null -eq $current) { continue }
    if ($line -match '^\s*#') { continue }
    if ($line -match '^ {2}name:\s*(\S+)') { $rows[$current].Name = $Matches[1].Trim("'", '"'); continue }
    if ($line -match '^ {4}([A-Za-z_][A-Za-z0-9_]*):') { $rows[$current].Keys += $Matches[1] }
  }
  return $rows
}

if (-not (Test-Path -LiteralPath $repoPreset)) {
  Write-Bad "仓库模板缺失：$repoPreset"
} elseif (-not (Test-Path -LiteralPath $deployPreset)) {
  Write-Bad "部署副本缺失：$deployPreset（见用户指南 §3.4）"
} else {
  $rowsRepo = Get-Rows -Path $repoPreset
  $rowsDeploy = Get-Rows -Path $deployPreset
  $missingRows = @($rowsRepo.Keys | Where-Object { -not $rowsDeploy.Contains($_) })
  $extraRows = @($rowsDeploy.Keys | Where-Object { -not $rowsRepo.Contains($_) })
  if ($missingRows.Count -eq 0 -and $extraRows.Count -eq 0) {
    Write-Ok "行集合一致（$($rowsRepo.Count) 行）"
  } else {
    Write-Bad "行集合不一致：缺 [$($missingRows -join '、')]；多 [$($extraRows -join '、')]"
  }

  if ($rowsDeploy.Contains('study')) {
    $keysRepo = @($rowsRepo['study'].Keys)
    $keysDeploy = @($rowsDeploy['study'].Keys)
    $unknown = @($keysDeploy | Where-Object { $_ -notin $keysRepo })
    $absent = @($keysRepo | Where-Object { $_ -notin $keysDeploy })
    if ($unknown.Count -eq 0 -and $absent.Count -eq 0) {
      Write-Ok "study 行 config 键一致（$($keysRepo.Count) 个）"
    } else {
      if ($unknown.Count -gt 0) {
        Write-Bad "study 行含模板已删/不认的键：$($unknown -join '、')（留在配置里 = 以为配了其实没配）"
      }
      if ($absent.Count -gt 0) {
        Write-Warn "study 行缺模板里的键：$($absent -join '、')（走插件默认值；若是有意省略可忽略）"
      }
    }
    if ($rowsDeploy['study'].Name -ne $rowsRepo['study'].Name) {
      Write-Bad "study 行的模块名不一致：部署 $($rowsDeploy['study'].Name) / 模板 $($rowsRepo['study'].Name)"
    }
    if (-not $VaultRoot) {
      $line = Select-String -LiteralPath $deployPreset -Pattern "^\s+vaultRoot:\s*'?([^']+)'?" | Select-Object -First 1
      if ($line) { $VaultRoot = $line.Matches[0].Groups[1].Value.Trim() }
    }
  } else {
    Write-Bad "部署副本没有 study 插件行"
  }

  # 技能目录集合（退化的 card-format 这类会在这里露出来）
  $skillsRepo = Join-Path $RepoRoot 'presets\study\skills'
  $skillsDeploy = Join-Path $DshHome '.agent-presets\study\skills'
  if ((Test-Path -LiteralPath $skillsRepo) -and (Test-Path -LiteralPath $skillsDeploy)) {
    $namesRepo = @(Get-ChildItem -LiteralPath $skillsRepo -Directory | Select-Object -ExpandProperty Name)
    $namesDeploy = @(Get-ChildItem -LiteralPath $skillsDeploy -Directory | Select-Object -ExpandProperty Name)
    $ghost = @($namesDeploy | Where-Object { $_ -notin $namesRepo })
    $gone = @($namesRepo | Where-Object { $_ -notin $namesDeploy })
    if ($ghost.Count -eq 0 -and $gone.Count -eq 0) {
      Write-Ok "技能目录一致（$($namesRepo.Count) 个）"
    } else {
      if ($ghost.Count -gt 0) { Write-Bad "部署副本有仓库已删的技能目录：$($ghost -join '、')" }
      if ($gone.Count -gt 0) { Write-Bad "部署副本缺技能目录：$($gone -join '、')" }
    }
  }
}

# ── 3. vault 门禁文件 ────────────────────────────────────────────────────────
Write-Host ''
Write-Host '[3/4] vault（硬门禁第一环：缺《笔记期望.md》则 note_write 一律拒绝）'
if (-not $VaultRoot) {
  Write-Warn '拿不到 vaultRoot（部署副本里没读到），跳过 vault 检查'
} elseif ($VaultRoot -match '^<.*>$') {
  # 重铺模板时最容易犯的错：把占位符原样抄回来（挂载会直接失败）
  Write-Bad "部署副本的 vaultRoot 还是占位符：$VaultRoot（换成本机 vault 绝对路径，见用户指南 §3.5）"
} elseif (-not (Test-Path -LiteralPath $VaultRoot)) {
  Write-Bad "vault 不存在：$VaultRoot"
} else {
  Write-Ok "vault 存在：$VaultRoot"
  $expect = Join-Path $VaultRoot '笔记期望.md'
  if (Test-Path -LiteralPath $expect) {
    Write-Ok '笔记期望.md 存在'
  } else {
    Write-Bad "缺《笔记期望.md》：$expect"
    Write-Info "修复：Copy-Item '$RepoRoot\presets\study\assets\笔记期望.md' '$expect'，再按你的写法改"
  }
  $stateDir = Join-Path $VaultRoot '.study'
  if (Test-Path -LiteralPath $stateDir) {
    Write-Ok ".study 状态目录在（进度/记忆/存档）"
  } else {
    Write-Info '.study 还没建（首次写入时自动创建，不是问题）'
  }
}

# ── 4. 解析回退目录污染 ──────────────────────────────────────────────────────
Write-Host ''
Write-Host '[4/4] 解析回退目录（git 同步会把 junction 展开成真实目录）'
$fallback = Join-Path $profileDir '.dsh-module-fallback\node_modules'
if (-not (Test-Path -LiteralPath $fallback)) {
  Write-Ok '没有 .dsh-module-fallback（正常）'
} else {
  $polluted = @(Get-ChildItem -LiteralPath $fallback -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'dsh-study-buddy|@deepseek-ai' })
  if ($polluted.Count -eq 0) {
    Write-Ok '回退目录里没有插件/平台的展开项'
  } else {
    Write-Warn "回退目录里有 $($polluted.Count) 项：$($polluted.Name -join '、')"
    Write-Info '启动报 "exists and is not a symlink or dsh-managed module proxy" 时删掉这些条目，DSH 会重建'
  }
}

# ── 结论 ─────────────────────────────────────────────────────────────────────
Write-Host ''
if ($script:Fail -eq 0) {
  Write-Host "✓ 部署三要素一致（$script:Warn 条警告）" -ForegroundColor Green
  exit 0
}
if ($ReportOnly) {
  Write-Host "报告模式：$script:Fail 条 FAIL / $script:Warn 条 WARN（-ReportOnly 不返回非零）" -ForegroundColor Yellow
  exit 0
}
Write-Host "✗ $script:Fail 条 FAIL / $script:Warn 条 WARN" -ForegroundColor Red
exit 1
