/**
 * 配置解析：把「声明行 config / 用户级配置文件 / 环境变量」合成一份 `VaultLayout`。
 *
 * 为什么拆出来：vaultRoot 是**机器相关**的（每台机器一个 Obsidian vault），而包要
 * 开源、要能多机共用，所以机器路径不能写进包里（DSH 0.1.7 起预设声明随 bundle patch
 * 从包里发出去，写死在包里等于把作者的本机路径发布给所有人）。解析顺序（后者覆盖前者，
 * 逐键合并）：
 *
 * 1. 内置默认值；
 * 2. 用户级配置文件 `<DSH_HOME>/study-buddy.json`（键名与声明行 config 完全一致）；
 * 3. 环境变量 `DSH_STUDY_VAULT`（别名 `DSH_VAULT_ROOT`）——**只管 vaultRoot**；
 * 4. 声明行 `config.*`（部署覆盖仍然可用，最高优先级）。
 *
 * 三者都拿不到 vaultRoot → **挂载期 fail-loud**，错误里列出找过的三个位置；
 * 配置文件损坏/未知键只告警不阻断（退化不该让工具全没）。
 * @module config
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { EXPECT_FILE } from './dirs.ts'
import { ruleIds } from './lint.ts'
import { MAX_WALK_FILES, isFsRoot, type VaultLayout } from './vault.ts'

/**
 * 插件配置：`VaultLayout` 的"可省略默认值"视图（EXT-6：配置类型只有一份定义，
 * 不再三处同构搬运；新增配置项只改 vault.ts）。
 *
 * `vaultRoot` 在这里是**可选**：它可能来自环境变量或用户级配置文件（见文件头的三级
 * 来源），只有三级都拿不到时 `resolveLayout` 才 fail-loud。类型如实反映这一点，
 * 免得"类型说必填、运行期其实可省"这种自相矛盾再次误导排查。
 */
export interface StudyConfig extends Omit<VaultLayout, 'vaultRoot' | 'stateDir' | 'fallbackDir'> {
  /** Obsidian vault 根目录（机器相关；省略时按环境变量 → 用户级配置解析） */
  vaultRoot?: string
  /** 进度状态目录（相对 vaultRoot），默认 .study */
  stateDir?: string
  /** 未映射领域的落盘目录（相对 vaultRoot），默认 未分类 */
  fallbackDir?: string
}

/** 用户级配置文件名（位于 `<DSH_HOME>` 下；键名与声明行 config 一致） */
export const USER_CONFIG_FILENAME = 'study-buddy.json'
/** vaultRoot 的环境变量（推荐名；插件自有前缀，避免与 DSH 本体的变量抢名字） */
export const VAULT_ROOT_ENV = 'DSH_STUDY_VAULT'
/** vaultRoot 的环境变量别名（兼容早期草稿里写的 DSH_VAULT_ROOT） */
export const VAULT_ROOT_ENV_ALIAS = 'DSH_VAULT_ROOT'

/**
 * `resolveLayout` 认得的所有配置键（唯一来源）。
 *
 * 分开维护的原因：逐键取值 + 兜底读不出"哪些键我不认"，而**不认的键是静默陷阱**——
 * 声明行里留着 `mocDir` 这类已退场键（v0.9 → v1.0 删掉的两个键之一）时，插件照常
 * 挂载、功能正常，配置却"以为配了其实没配"。本轮 DSH 升级排查就是被这种漂移咬了一次。
 */
export const KNOWN_CONFIG_KEYS: readonly string[] = [
  'vaultRoot', 'expectFile', 'planTtlHours', 'stateDir', 'fallbackDir',
  'domainFolders', 'skipDirs', 'searchRoots', 'includeSessionCwd', 'linkIntoNotes',
  'lint', 'indexTtlMs', 'maxWalkFiles',
]

/** 预设行 config / 用户级 JSON 里插件不认识的键（已退场键 / 拼写错误），按出现顺序返回 */
export function unknownConfigKeys(config: StudyConfig | undefined): string[] {
  if (!config || typeof config !== 'object') return []
  const known = new Set<string>(KNOWN_CONFIG_KEYS)
  return Object.keys(config).filter((key) => !known.has(key))
}

/** DSH 主目录：`DSH_HOME` 优先，退到 `~/.dsh`（与 tools/verify-deploy.ps1 同口径） */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME?.trim()
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** 用户级配置文件的绝对路径 */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), USER_CONFIG_FILENAME)
}

/** 解析结果：布局 + 来源回显 + 不致命的问题（调用方负责打印） */
export interface LayoutResolution {
  readonly layout: VaultLayout
  /** vaultRoot 的最终来源（`行 config` / `环境变量 DSH_STUDY_VAULT` / `文件 <路径>`） */
  readonly vaultRootFrom: string
  /** 用户级配置文件路径（日志与报错都用它，便于照抄） */
  readonly userConfigPath: string
  /** 不阻断挂载的告警（未知键、配置文件损坏等），调用方打印到启动日志 */
  readonly warnings: string[]
}

/** 读文件的最小接口（默认 node:fs.readFileSync；测试注入替身，不碰真实文件系统） */
export type ReadTextFile = (path: string) => string

const defaultReadFile: ReadTextFile = (path) => readFileSync(path, 'utf8')

/** 读用户级配置文件：不存在/损坏/不是对象 → 告警 + 空配置（绝不阻断） */
function readUserConfig(path: string, readFile: ReadTextFile): { config: StudyConfig; warnings: string[] } {
  let raw: string
  try {
    raw = readFile(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { config: {}, warnings: [] }
    return { config: {}, warnings: [`用户级配置读不出来（${code ?? '未知错误'}）：${path}`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { config: {}, warnings: [`用户级配置不是合法 JSON（已忽略）：${path}`] }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: {}, warnings: [`用户级配置顶层必须是对象（已忽略）：${path}`] }
  }
  return { config: parsed as StudyConfig, warnings: [] }
}

/** 环境变量里的 vaultRoot（推荐名优先，别名兜底） */
function vaultRootFromEnv(env: NodeJS.ProcessEnv): { value?: string; from?: string } {
  const primary = env[VAULT_ROOT_ENV]?.trim()
  if (primary) return { value: primary, from: `环境变量 ${VAULT_ROOT_ENV}` }
  const alias = env[VAULT_ROOT_ENV_ALIAS]?.trim()
  if (alias) return { value: alias, from: `环境变量 ${VAULT_ROOT_ENV_ALIAS}` }
  return {}
}

/** `resolveLayout` 的可注入依赖（测试用；生产走默认值） */
export interface ResolveOptions {
  env?: NodeJS.ProcessEnv
  readFile?: ReadTextFile
}

/**
 * 合成 `VaultLayout`。**只在这里做配置校验**：未知 lint 规则 id 与 vaultRoot 缺失
 * 都会抛错（fail-loud），其余一律给默认值或告警。
 * @param config - 声明行 config（可省略：全部走文件/环境变量）
 * @param options - 环境变量与文件读取替身（测试注入）
 * @returns 布局、来源回显、告警；配置致命错误时抛错（由 apply 转成挂载失败）
 */
export function resolveLayout(config: StudyConfig | undefined, options: ResolveOptions = {}): LayoutResolution {
  const env = options.env ?? process.env
  const readFile = options.readFile ?? defaultReadFile
  const file = userConfigPath(env)
  const warnings: string[] = []

  const user = readUserConfig(file, readFile)
  warnings.push(...user.warnings)
  // 未知键一次列全（按出现顺序）：一行告警比 N 行更好读，也让"少了哪个键"一眼可见
  const userUnknown = unknownConfigKeys(user.config)
  if (userUnknown.length > 0) {
    warnings.push(
      `用户级配置含插件不认识的键：${userUnknown.join('、')}（已忽略；已知键见 presets/study.patch.yml 的 study 行）`,
    )
  }
  const rowUnknown = unknownConfigKeys(config)
  if (rowUnknown.length > 0) {
    warnings.push(
      `声明行 config 含插件不认识的键：${rowUnknown.join('、')}（已忽略；已知键见 presets/study.patch.yml 的 study 行）`,
    )
  }

  // 逐键合并：声明行 > 用户级文件（vaultRoot 另行按"行 > 环境变量 > 文件"解析）
  const merged: StudyConfig = { ...user.config, ...(config ?? {}) }
  const fromEnv = vaultRootFromEnv(env)
  const rowVault = config?.vaultRoot !== undefined && String(config.vaultRoot).trim() ? String(config.vaultRoot) : undefined
  const fileVault = user.config.vaultRoot !== undefined && String(user.config.vaultRoot).trim()
    ? String(user.config.vaultRoot)
    : undefined
  const vaultRootRaw = rowVault ?? fromEnv.value ?? fileVault
  const vaultRootFrom = rowVault !== undefined
    ? '声明行 config.vaultRoot'
    : fromEnv.from ?? (fileVault !== undefined ? `文件 ${file}` : '（未提供）')

  if (vaultRootRaw === undefined) {
    throw new Error(
      'dsh-study-buddy 需要 vault 根目录，三种给法任选一种（按优先级）：'
      + `① 声明行 presets/study.patch.yml 的 study 行 config.vaultRoot；`
      + `② 环境变量 ${VAULT_ROOT_ENV}（别名 ${VAULT_ROOT_ENV_ALIAS}）；`
      + `③ 用户级配置 ${file} 的 {"vaultRoot":"<你的 Obsidian vault 绝对路径>"}。`
      + '三者都没有 ⇒ 无法挂载（故意 fail-loud：静默用错目录会把笔记写进别处）。',
    )
  }
  const vaultRoot = resolve(vaultRootRaw)
  // 注意：不拒绝 vaultRoot === 工作目录。launcher 通常以 vault 目录为 cwd 启动 DSH，
  // vault 即工作目录是受支持的部署形态（曾因此误伤导致 9 个工具静默不注册）。
  // 只保留"文件系统根"这一真正危险的落盘目标。
  if (isFsRoot(vaultRoot)) {
    throw new Error(`vaultRoot 不能是文件系统根：${vaultRoot}`)
  }
  // lint.rulesOff 里的未知 id 是"以为关了其实没关"的静默陷阱（N9）：挂载期直接报错
  const rulesOff = merged.lint?.rulesOff
  if (Array.isArray(rulesOff) && rulesOff.length > 0) {
    const known = new Set(ruleIds())
    const unknown = rulesOff.map(String).filter((id) => !known.has(id))
    if (unknown.length > 0) {
      throw new Error(
        `lint.rulesOff 含未识别的规则 id：${unknown.join('、')}（可用：${ruleIds().join('、')}）`,
      )
    }
  }
  const maxWalkFiles = Number(merged.maxWalkFiles)
  const layout: VaultLayout = {
    vaultRoot,
    stateDir: String(merged.stateDir ?? '.study').trim() || '.study',
    fallbackDir: String(merged.fallbackDir ?? '未分类').trim() || '未分类',
    domainFolders: merged.domainFolders ?? {},
    skipDirs: Array.isArray(merged.skipDirs) ? merged.skipDirs.map(String) : [],
    searchRoots: Array.isArray(merged.searchRoots) ? merged.searchRoots.map(String) : [],
    includeSessionCwd: merged.includeSessionCwd === true,
    linkIntoNotes: merged.linkIntoNotes === true,
    lint: merged.lint,
    indexTtlMs: Number.isFinite(Number(merged.indexTtlMs)) && Number(merged.indexTtlMs) >= 0 ? Number(merged.indexTtlMs) : 2000,
    maxWalkFiles: Number.isFinite(maxWalkFiles) && maxWalkFiles >= 1 ? Math.floor(maxWalkFiles) : MAX_WALK_FILES,
    planTtlHours: Number.isFinite(Number(merged.planTtlHours)) && Number(merged.planTtlHours) > 0
      ? Number(merged.planTtlHours)
      : 24,
    expectFile: String(merged.expectFile ?? '').trim() || EXPECT_FILE,
  }
  return { layout, vaultRootFrom, userConfigPath: file, warnings }
}
