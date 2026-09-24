import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  KNOWN_CONFIG_KEYS, USER_CONFIG_FILENAME, VAULT_ROOT_ENV, VAULT_ROOT_ENV_ALIAS,
  dshHome, resolveLayout, unknownConfigKeys, userConfigPath, type ReadTextFile,
} from '../src/config.ts'

/**
 * 配置来源链：`声明行 config > 环境变量 > <DSH_HOME>/study-buddy.json`。
 *
 * 为什么单测这一层：vaultRoot 是**机器相关**路径，包要开源就必须把它赶出包（DSH 0.1.7
 * 起预设声明随 bundle patch 发布）。这条链是"包内零绝对路径"与"每台机器都能跑"的
 * 接缝，接缝错了的表现是"挂载失败"或更糟的"静默写进别的目录"，两种都不该靠现场试。
 * 单测注入 env/readFile：不碰真实文件系统、不受本机 `DSH_STUDY_VAULT` 影响。
 */

const HOME = join(tmpdir(), 'study-buddy-dsh-home')
const VAULT = join(tmpdir(), 'study-buddy-vault')
const CONFIG_PATH = userConfigPath({ DSH_HOME: HOME })

/** 造一个只认固定几条路径的读文件替身（其余一律 ENOENT） */
function readerOf(files: Record<string, string>): ReadTextFile {
  return (path) => {
    if (Object.prototype.hasOwnProperty.call(files, path)) return files[path]
    const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
    error.code = 'ENOENT'
    throw error
  }
}

/** 空环境：只给 DSH_HOME，且明确清掉两个 vault 环境变量 */
function envOf(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { DSH_HOME: HOME, [VAULT_ROOT_ENV]: '', [VAULT_ROOT_ENV_ALIAS]: '', ...extra }
}

describe('resolveLayout（配置来源链）', () => {
  test('三者都缺 vaultRoot 时 fail-loud，且错误里列出三种给法', () => {
    expect(() => resolveLayout(undefined, { env: envOf(), readFile: readerOf({}) }))
      .toThrow(/vault 根目录/)
    expect(() => resolveLayout(undefined, { env: envOf(), readFile: readerOf({}) }))
      .toThrow(new RegExp(`${VAULT_ROOT_ENV}.*${USER_CONFIG_FILENAME}`))
  })

  test('声明行 config 是最低需要：给了它就不看文件/环境变量', () => {
    const result = resolveLayout({ vaultRoot: VAULT }, {
      env: envOf({ [VAULT_ROOT_ENV]: join(tmpdir(), 'env-vault') }),
      readFile: readerOf({ [CONFIG_PATH]: JSON.stringify({ vaultRoot: join(tmpdir(), 'file-vault') }) }),
    })
    expect(result.layout.vaultRoot).toBe(resolve(VAULT))
    expect(result.vaultRootFrom).toBe('声明行 config.vaultRoot')
  })

  test('环境变量优先于用户级文件（推荐名 + 别名都认）', () => {
    const files = { [CONFIG_PATH]: JSON.stringify({ vaultRoot: join(tmpdir(), 'file-vault') }) }
    const primary = resolveLayout(undefined, { env: envOf({ [VAULT_ROOT_ENV]: VAULT }), readFile: readerOf(files) })
    expect(primary.layout.vaultRoot).toBe(resolve(VAULT))
    expect(primary.vaultRootFrom).toBe(`环境变量 ${VAULT_ROOT_ENV}`)

    const alias = resolveLayout(undefined, {
      env: envOf({ [VAULT_ROOT_ENV_ALIAS]: VAULT }),
      readFile: readerOf(files),
    })
    expect(alias.layout.vaultRoot).toBe(resolve(VAULT))
    expect(alias.vaultRootFrom).toBe(`环境变量 ${VAULT_ROOT_ENV_ALIAS}`)
  })

  test('三者都不给时退到用户级文件，并把来源回显成文件路径', () => {
    const result = resolveLayout(undefined, {
      env: envOf(),
      readFile: readerOf({ [CONFIG_PATH]: JSON.stringify({ vaultRoot: VAULT, skipDirs: ['资源'] }) }),
    })
    expect(result.layout.vaultRoot).toBe(resolve(VAULT))
    expect(result.layout.skipDirs).toEqual(['资源'])
    expect(result.vaultRootFrom).toBe(`文件 ${CONFIG_PATH}`)
    expect(result.warnings).toEqual([])
  })

  test('逐键合并：声明行覆盖文件的同名键，未覆盖的键仍来自文件', () => {
    const result = resolveLayout({ stateDir: '.myself' }, {
      env: envOf(),
      readFile: readerOf({
        [CONFIG_PATH]: JSON.stringify({ vaultRoot: VAULT, stateDir: '.study', fallbackDir: '未分类x', planTtlHours: 48 }),
      }),
    })
    expect(result.layout.stateDir).toBe('.myself')
    expect(result.layout.fallbackDir).toBe('未分类x')
    expect(result.layout.planTtlHours).toBe(48)
  })

  test('用户级配置不是合法 JSON / 顶层不是对象 / 含未知键 → 告警但不阻断', () => {
    const broken = resolveLayout({ vaultRoot: VAULT }, {
      env: envOf(),
      readFile: readerOf({ [CONFIG_PATH]: '{ 这不是 JSON' }),
    })
    expect(broken.warnings.join('\n')).toContain('不是合法 JSON')
    expect(broken.layout.vaultRoot).toBe(resolve(VAULT))

    const notObject = resolveLayout({ vaultRoot: VAULT }, {
      env: envOf(),
      readFile: readerOf({ [CONFIG_PATH]: '["x"]' }),
    })
    expect(notObject.warnings.join('\n')).toContain('顶层必须是对象')

    const unknown = resolveLayout({ vaultRoot: VAULT, mocDir: '旧键' }, {
      env: envOf(),
      readFile: readerOf({ [CONFIG_PATH]: JSON.stringify({ vaultRoot: VAULT, templateHints: {} }) }),
    })
    expect(unknown.warnings.join('\n')).toContain('用户级配置含插件不认识的键：templateHints')
    expect(unknown.warnings.join('\n')).toContain('声明行 config 含插件不认识的键：mocDir')
  })

  test('配置文件读不出来时：非 ENOENT 记告警，vaultRoot 仍可来自声明行', () => {
    const denied: ReadTextFile = () => {
      const error = new Error('EACCES') as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    }
    const result = resolveLayout({ vaultRoot: VAULT }, { env: envOf(), readFile: denied })
    expect(result.layout.vaultRoot).toBe(resolve(VAULT))
    expect(result.warnings.join('\n')).toContain('用户级配置读不出来（EACCES）')
  })

  test('文件给到文件系统根也拒绝（fail-loud）', () => {
    expect(() => resolveLayout(undefined, {
      env: envOf(),
      readFile: readerOf({ [CONFIG_PATH]: JSON.stringify({ vaultRoot: resolve('/') }) }),
    })).toThrow(/文件系统根/)
  })

  test('lint.rulesOff 的未知 id 照样 fail-loud（来源不影响校验）', () => {
    expect(() => resolveLayout({ vaultRoot: VAULT, lint: { rulesOff: ['no-such-rule'] } }, { env: envOf(), readFile: readerOf({}) }))
      .toThrow(/未识别的规则 id/)
    const ok = resolveLayout({ vaultRoot: VAULT, lint: { rulesOff: [] } }, { env: envOf(), readFile: readerOf({}) })
    expect(ok.layout.vaultRoot).toBe(resolve(VAULT))
  })

  test('默认值兜底不受来源影响', () => {
    const result = resolveLayout({ vaultRoot: VAULT }, { env: envOf(), readFile: readerOf({}) })
    expect(result.layout.stateDir).toBe('.study')
    expect(result.layout.fallbackDir).toBe('未分类')
    expect(result.layout.planTtlHours).toBe(24)
    expect(result.layout.expectFile).toBe('笔记期望.md')
    expect(result.layout.indexTtlMs).toBe(2000)
    expect(result.layout.includeSessionCwd).toBe(false)
    expect(result.layout.linkIntoNotes).toBe(false)
    expect(result.layout.maxWalkFiles).toBeGreaterThanOrEqual(1)
  })
})

describe('配置键表与路径口径', () => {
  test('unknownConfigKeys 只放行已知键（含 vaultRoot）', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('vaultRoot')
    expect(unknownConfigKeys({ vaultRoot: VAULT, mocDir: 'x', templateHints: {} })).toEqual(['mocDir', 'templateHints'])
    expect(unknownConfigKeys(undefined)).toEqual([])
  })

  test('DSH_HOME 优先，缺省退到 ~/.dsh（与 tools/verify-deploy.ps1 同口径）', () => {
    expect(dshHome({ DSH_HOME: HOME })).toBe(resolve(HOME))
    expect(dshHome({ DSH_HOME: '   ' })).toBe(join(homedir(), '.dsh'))
    expect(dshHome({})).toBe(join(homedir(), '.dsh'))
    expect(userConfigPath({ DSH_HOME: HOME })).toBe(join(resolve(HOME), USER_CONFIG_FILENAME))
  })
})
