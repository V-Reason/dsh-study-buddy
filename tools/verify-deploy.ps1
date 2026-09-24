<#
.SYNOPSIS
  dsh-study-buddy 部署校验（只读）。

.DESCRIPTION
  交付形态自 DSH 0.1.7-rc.1 起变了：目录式预设被平台删除（提交 d1e22a7e24 / #4569），
  「学习伙伴」改为随包发布的**声明式预设**（`package.json` 的 `dsh.bundle.patch` →
  `presets/study.patch.yml`）。这一步的失效形态很隐蔽：**预设整行消失、18 个工具全没，
  但不报错**——所以本脚本把"看着改了其实没生效"的四个接缝都变成可执行检查：

    1. 插件产物：仓库 lib/index.js 的 SHA256 == <profile>\node_modules\dsh-study-buddy\lib\index.js
    2. 交付形态：已装包声明 dsh.bundle.patch → patch 文件存在且与仓库同哈希；
       profile 的 dsh.profile.bundles 含本包；patch 里 study 行**不得**含 vaultRoot
    3. 退场形态：%DSH_HOME%\.agent-presets\study 必须已删除（没有读者的目录会误导排查）
    4. vault 门禁：vaultRoot（环境变量 / <DSH_HOME>\study-buddy.json）与《笔记期望.md》

  只读：不写任何文件、不复制、不装依赖。退出码 0 = 全绿，1 = 有 FAIL，2 = 参数/环境问题。

.EXAMPLE
  pnpm run verify:deploy -- -Profile web
.EXAMPLE
  powershell -NoProfile -File tools/verify-deploy.ps1 -Profile web -RepoRoot . -VaultRoot 'D:\vault'
#>
[CmdletBinding()]
param(
  # DSH profile 名（插件装在 %DSH_HOME%\profiles\<name>\node_modules 下）
  [string]$Profile = 'web',
  # 插件仓库根（默认按脚本位置往上找一行）
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSCommandPath)),
  # DSH 主目录（默认 $env:DSH_HOME，退到 ~/.dsh）
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  # vault 根（给了就绕过自动解析，直接检查《笔记期望.md》）
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

# ── 0. 路径与清单 ────────────────────────────────────────────────────────────
$repoLib = Join-Path $RepoRoot 'lib\index.js'
$repoPatch = Join-Path $RepoRoot 'presets\study.patch.yml'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$installedDir = Join-Path $profileDir 'node_modules\dsh-study-buddy'
$installedLib = Join-Path $installedDir 'lib\index.js'
$installedManifestPath = Join-Path $installedDir 'package.json'
$profileManifestPath = Join-Path $profileDir 'package.json'

# ── 1. 插件产物一致性 ────────────────────────────────────────────────────────
Write-Host '[1/4] 插件产物（依赖按内容拷贝，不比对就会"看着改了其实没生效"）'
if (-not (Test-Path -LiteralPath $repoLib)) {
  Write-Bad "仓库没有构建产物：$repoLib（先跑 pnpm run build）"
} elseif (-not (Test-Path -LiteralPath $installedLib)) {
  Write-Bad "profile 里没装插件：$installedLib（见用户指南 §3）"
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

# ── 2. 交付形态（声明式预设 + bundle 选中） ───────────────────────────────────
Write-Host ''
Write-Host '[2/4] 交付形态（DSH 0.1.7 起预设只能由 bundle patch 声明；漏了它预设会静默消失）'
$patchPaths = @()
if (-not (Test-Path -LiteralPath $installedManifestPath)) {
  Write-Bad "已安装包没有 package.json：$installedManifestPath"
} else {
  $manifest = Get-Content -LiteralPath $installedManifestPath -Raw | ConvertFrom-Json
  $declared = $manifest.dsh.bundle.patch
  if (-not $declared) {
    Write-Bad "已安装包没有 dsh.bundle.patch —— 预设不会被声明（「学习伙伴」不会出现在名单里，且不报错）"
    Write-Info "修复：重新装包（dsh plugin --profile $Profile add dsh-study-buddy），或把仓库的 package.json 复制过去"
  } else {
    foreach ($file in @($declared)) {
      $relative = ($file -replace '^\./', '') -replace '/', '\'
      $patchPaths += (Join-Path $installedDir $relative)
    }
    $missing = @($patchPaths | Where-Object { -not (Test-Path -LiteralPath $_) })
    if ($missing.Count -gt 0) {
      Write-Bad "声明的 patch 文件不存在：$($missing -join '、')"
    } else {
      Write-Ok "dsh.bundle.patch 指向 $($patchPaths.Count) 个存在的文件：$($declared -join ' + ')"
    }
  }
}

if ((Test-Path -LiteralPath $repoPatch) -and ($patchPaths.Count -gt 0) -and (Test-Path -LiteralPath $patchPaths[0])) {
  $repoPatchHash = (Get-FileHash -LiteralPath $repoPatch -Algorithm SHA256).Hash
  $instPatchHash = (Get-FileHash -LiteralPath $patchPaths[0] -Algorithm SHA256).Hash
  if ($repoPatchHash -eq $instPatchHash) {
    Write-Ok "预设声明与仓库一致（$($repoPatchHash.Substring(0,12))…）"
  } else {
    Write-Bad "预设声明与仓库不一致（仓库 $($repoPatchHash.Substring(0,12))… / profile $($instPatchHash.Substring(0,12))…）"
    Write-Info "修复：Copy-Item '$repoPatch' '$($patchPaths[0])' -Force（改完让 preset 重新挂载：重启 DSH 或触发一次 profile patch 重载）"
  }
}

# study 行不得含 vaultRoot：机器相关路径不进包（契约探针也有同款断言）
if (Test-Path -LiteralPath $installedManifestPath) {
  $patchForScan = if ($patchPaths.Count -gt 0) { $patchPaths[0] } else { '' }
  if ($patchForScan -and (Test-Path -LiteralPath $patchForScan)) {
    $row = Select-String -LiteralPath $patchForScan -Pattern '^\s+vaultRoot:' | Select-Object -First 1
    if ($row) {
      Write-Bad "预设声明里出现了 vaultRoot（第 $($row.LineNumber) 行）—— 机器相关路径不该随包发布"
      Write-Info "改法：删掉这一行，把路径写到 `$env:DSH_STUDY_VAULT 或 <DSH_HOME>\study-buddy.json"
    } else {
      Write-Ok '预设声明不含 vaultRoot（机器相关路径出包）'
    }
  }
}

if (Test-Path -LiteralPath $profileManifestPath) {
  $profileManifest = Get-Content -LiteralPath $profileManifestPath -Raw | ConvertFrom-Json
  $bundles = @($profileManifest.dsh.profile.bundles)
  if ($bundles -contains 'dsh-study-buddy') {
    Write-Ok 'profile 的 dsh.profile.bundles 已选中本包'
  } else {
    Write-Bad "profile 的 dsh.profile.bundles 没有本包 —— 预设声明不会被应用（工具全没，且不报错）"
    Write-Info "修复：plugin_manager set_bundle target=dsh-study-buddy enabled=true（或 dsh plugin --profile $Profile add dsh-study-buddy）"
  }
} else {
  Write-Bad "找不到 profile 清单：$profileManifestPath"
}

# ── 3. 退场形态 + vault 门禁文件 ─────────────────────────────────────────────
Write-Host ''
Write-Host '[3/4] 退场形态与 vault（legacy 目录已无人读取；缺《笔记期望.md》则 note_write 一律拒绝）'
$legacy = Join-Path $DshHome '.agent-presets\study'
if (Test-Path -LiteralPath $legacy) {
  Write-Bad "legacy 预设目录还在：$legacy —— DSH 0.1.7 起没有任何读者，留着只会误导排查"
  Write-Info "修复：确认预设已按新形态挂载后 Remove-Item -Recurse -Force '$legacy'；同步清 vdsh.yaml 的 sync.allowlist"
} else {
  Write-Ok 'legacy 目录已清理（%DSH_HOME%\.agent-presets\study 不存在）'
}

$vaultSource = ''
if (-not $VaultRoot) {
  if ($env:DSH_STUDY_VAULT) { $VaultRoot = $env:DSH_STUDY_VAULT; $vaultSource = '环境变量 DSH_STUDY_VAULT' }
  elseif ($env:DSH_VAULT_ROOT) { $VaultRoot = $env:DSH_VAULT_ROOT; $vaultSource = '环境变量 DSH_VAULT_ROOT' }
  else {
    $userConfig = Join-Path $DshHome 'study-buddy.json'
    if (Test-Path -LiteralPath $userConfig) {
      try {
        $parsed = Get-Content -LiteralPath $userConfig -Raw | ConvertFrom-Json
        if ($parsed.vaultRoot) { $VaultRoot = $parsed.vaultRoot; $vaultSource = "用户级配置 $userConfig" }
      } catch {
        Write-Warn "用户级配置不是合法 JSON（插件会告警并忽略）：$userConfig"
      }
    }
  }
}
if (-not $VaultRoot) {
  Write-Warn '拿不到 vaultRoot（环境变量与 <DSH_HOME>\study-buddy.json 都没有）——跳过 vault 检查'
  Write-Info "插件挂载时同样会 fail-loud；给法：`$env:DSH_STUDY_VAULT，或 $DshHome\study-buddy.json 的 {`"vaultRoot`":`"...`"}"
} elseif ($VaultRoot -match '^<.*>$') {
  Write-Bad "vaultRoot 还是占位符：$VaultRoot（换成本机 vault 绝对路径）"
} elseif (-not (Test-Path -LiteralPath $VaultRoot)) {
  Write-Bad "vault 不存在：$VaultRoot（来源：$vaultSource）"
} else {
  Write-Ok "vault 存在（来源：$vaultSource）：$VaultRoot"
  $expect = Join-Path $VaultRoot '笔记期望.md'
  if (Test-Path -LiteralPath $expect) {
    Write-Ok '笔记期望.md 存在'
  } else {
    Write-Bad "缺《笔记期望.md》：$expect"
    Write-Info "修复：Copy-Item '$RepoRoot\presets\study\assets\笔记期望.md' '$expect'，再按你的写法改"
  }
  $stateDir = Join-Path $VaultRoot '.study'
  if (Test-Path -LiteralPath $stateDir) {
    Write-Ok '.study 状态目录在（进度/记忆/存档）'
  } else {
    Write-Info '.study 还没建（首次写入时自动创建，不是问题）'
  }
}

# 技能资产随包发：比对仓库与已安装副本的目录集合
$skillsRepo = Join-Path $RepoRoot 'presets\study\skills'
$skillsInstalled = Join-Path $installedDir 'presets\study\skills'
if ((Test-Path -LiteralPath $skillsRepo) -and (Test-Path -LiteralPath $skillsInstalled)) {
  $namesRepo = @(Get-ChildItem -LiteralPath $skillsRepo -Directory | Select-Object -ExpandProperty Name)
  $namesInstalled = @(Get-ChildItem -LiteralPath $skillsInstalled -Directory | Select-Object -ExpandProperty Name)
  $ghost = @($namesInstalled | Where-Object { $_ -notin $namesRepo })
  $gone = @($namesRepo | Where-Object { $_ -notin $namesInstalled })
  if ($ghost.Count -eq 0 -and $gone.Count -eq 0) {
    Write-Ok "技能目录一致（$($namesRepo.Count) 个，随包发）"
  } else {
    if ($ghost.Count -gt 0) { Write-Bad "已安装副本有仓库已删的技能目录：$($ghost -join '、')" }
    if ($gone.Count -gt 0) { Write-Bad "已安装副本缺技能目录：$($gone -join '、')" }
  }
} elseif (Test-Path -LiteralPath $installedDir) {
  Write-Bad "技能目录缺失：$skillsInstalled（预设的 customSkillDirs 指着它）"
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
  Write-Host "✓ 部署四要素一致（$script:Warn 条警告）" -ForegroundColor Green
  exit 0
}
if ($ReportOnly) {
  Write-Host "报告模式：$script:Fail 条 FAIL / $script:Warn 条 WARN（-ReportOnly 不返回非零）" -ForegroundColor Yellow
  exit 0
}
Write-Host "✗ $script:Fail 条 FAIL / $script:Warn 条 WARN" -ForegroundColor Red
exit 1
