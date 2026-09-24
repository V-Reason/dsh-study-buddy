import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { scanEntryRows } from '../tools/verify-contract.mjs'

/**
 * 预设组合卫生：`presets/study.patch.yml` 必须能被当前 DSH 挂载。
 *
 * 两次踩过的坑，各钉一颗钉子：
 * - 2026-09（DSH 0.1.5，提交 40792330c0）：`@deepseek-ai/dsh-persona` 的 `text` 改名
 *   为必填 `prefix`，仓库与部署副本都还写 `text` → 切换「学习伙伴」直接报
 *   `invalid config: $.prefix missing required value`。文件坏在一行配置键上，
 *   编辑器里完全看不出来，没有编译期或运行期信号。
 * - 2026-09-24（DSH 0.1.7-rc.1，提交 d1e22a7e24 / #4569）：**目录式预设被删除**，
 *   `$DSH_HOME/.agent-presets/study/` 再没有读者 → 预设行消失、18 个工具全没。
 *   组合从此只能以「bundle patch 里的 @deepseek-ai/dsh-agent-preset 声明」交付。
 *
 * 这类漂移只能靠"能被解析的就别靠自觉"钉住：本文件对声明做**零依赖**的结构断言，
 * 扫描器与 `tools/verify-contract.mjs` 共用同一份实现（单一真相，别各写一份）。
 */

const ROOT = join(import.meta.dirname, '..')
const PRESET_DIR = join(ROOT, 'presets', 'study')
const DECLARATION = join(ROOT, 'presets', 'study.patch.yml')

/** 行 id 与模块名（扫描器只按缩进判定，见 scanEntryRows 的注释） */
interface Row {
  readonly id: string
  readonly indent: number
  readonly name: string
  readonly configKeys: string[]
  readonly line: number
}

describe('presets/study.patch.yml 声明卫生', () => {
  const text = readFileSync(DECLARATION, 'utf8')
  const rows = scanEntryRows(text) as Row[]
  const declaration = rows.find((row) => row.id === 'preset-study')

  test('目录式预设已退场：只有声明 patch，没有 agent.cordis.yml / preset.yml', () => {
    expect(existsSync(join(PRESET_DIR, 'agent.cordis.yml')), 'agent.cordis.yml 已被删除，别捡回来（没有读者）').toBe(false)
    expect(existsSync(join(PRESET_DIR, 'preset.yml')), 'preset.yml 已被删除，显示名/描述进声明 config').toBe(false)
    expect(existsSync(DECLARATION), 'presets/study.patch.yml 是唯一的组合来源').toBe(true)
  })

  test('声明行是 preset-study（@deepseek-ai/dsh-agent-preset）且带 id/name/description/order', () => {
    expect(declaration, '缺少 id: preset-study 的声明行').toBeTruthy()
    expect(declaration?.name, '声明行模块名').toBe('@deepseek-ai/dsh-agent-preset')
    // 声明自身的 config 键在「声明行缩进 + 4」（与 scanEntryRows 的口径一致）
    const configIndent = (declaration?.indent ?? 0) + 4
    const lines = text.split(/\r?\n/)
    const keys = lines
      .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
      .filter((line) => line.match(/^\s*/)?.[0].length === configIndent)
      .map((line) => /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line.trim())?.[1])
      .filter(Boolean)
    for (const key of ['id', 'name', 'description', 'order', 'plugins']) {
      expect(keys, `声明缺 ${key}`).toContain(key)
    }
  })

  test('每一行都声明 id 与模块名，且 id 全局唯一', () => {
    expect(rows.length).toBeGreaterThan(10)
    const ids = rows.map((row) => row.id)
    expect(new Set(ids).size, `id 重复：${ids.join(', ')}`).toBe(ids.length)
    for (const row of rows) {
      expect(row.name, `行 ${row.id}（第 ${row.line} 行）缺少模块名`).toBeTruthy()
    }
  })

  // 本次故障的钉子：persona 行只能用 `prefix`（DSH 0.1.5 起），写 `text` 必挂载失败。
  test('persona 行使用当前 DSH 的 `prefix` 键，且不含已删除的 `text` 键', () => {
    const persona = rows.find((row) => row.id === 'persona')
    expect(persona, '组合缺少 persona 行').toBeTruthy()
    expect(persona?.name, 'persona 行的模块名').toBe('@deepseek-ai/dsh-persona')
    expect(persona?.configKeys, 'persona 行仍有已删除的 `text` 键（应改为 prefix）').not.toContain('text')
    expect(persona?.configKeys).toEqual(['prefix'])
  })

  // 阶段 6：插件行 config 键收敛（删 mocDir/templateHints，加 expectFile/planTtlHours）
  test('study 插件行的 config 键与插件 schema 一致，且不含机器相关路径', () => {
    const study = rows.find((row) => row.id === 'study')
    expect(study, '组合缺少 study 插件行').toBeTruthy()
    expect(study?.name, 'study 行必须挂载本包').toBe('dsh-study-buddy')
    const keys = study?.configKeys ?? []
    // 退场的键：写进预设也不会生效，留着就是"以为配了其实没配"
    expect(keys, 'mocDir 已随 card_moc 退场').not.toContain('mocDir')
    expect(keys, 'templateHints 已随三型模板退场').not.toContain('templateHints')
    // 机器相关：vaultRoot 出包，改由环境变量 / 用户级 JSON / 部署侧覆盖解析
    expect(keys, 'vaultRoot 是机器相关路径，不能写进随包发布的声明').not.toContain('vaultRoot')
    // 新增的键
    expect(keys).toContain('expectFile')
    expect(keys).toContain('planTtlHours')
    // 语义未变的键仍在
    for (const key of ['stateDir', 'fallbackDir', 'skipDirs', 'includeSessionCwd', 'searchRoots', 'linkIntoNotes', 'domainFolders']) {
      expect(keys, `config 缺少 ${key}`).toContain(key)
    }
  })

  test('persona 不再教模型用卡片时代的工具（note_* 才是指令面）', () => {
    for (const gone of ['card_create', 'card_update', 'card_link', 'card_moc', 'card_lint', 'card_history', 'card_rename', 'card_search', 'card_get', 'card_id']) {
      expect(text, `persona/config 仍提到已退场的 ${gone}`).not.toContain(gone)
    }
    for (const tool of ['note_write', 'note_plan', 'note_expect_get', 'note_toc', 'note_overview']) {
      expect(text, `persona 应写明 ${tool}`).toContain(tool)
    }
  })

  test('技能资产从已安装包解析（不再锚定预设目录）', () => {
    const skills = rows.find((row) => row.id === 'skill-filesystem')
    expect(skills, '组合缺少 skill-filesystem 行').toBeTruthy()
    expect(text, 'customSkillDirs 必须从包内解析（baseUrl 锚点已随目录式预设消失）').toContain('createRequire(baseUrl)')
    expect(text).toContain("'presets', 'study', 'skills'")
  })

  // 阶段 6：默认期望模板要能被工具真的读出来、且检查项语法可解析
  test('presets/study/assets/笔记期望.md 存在且检查项语法可解析', async () => {
    const { parseExpectRules } = await import('../src/lint.ts')
    const template = readFileSync(join(PRESET_DIR, 'assets', '笔记期望.md'), 'utf8')
    const rules = parseExpectRules(template)
    expect(rules.length, '模板里应给出可检查项的样例').toBeGreaterThan(0)
    expect(rules.some((r) => r.mode === 'forbid')).toBe(true)
    // 模板不得把卡片时代的写法当成要求写回去（否则热配置会把旧约束又带回来）
    expect(template).not.toContain('分型')
    expect(template).not.toContain('必填小节')
    expect(template).not.toContain('≤60 字')
    // 期望文件本身就是"唯一写法来源"，模板要写清这一点
    expect(template).toContain('唯一来源')
  })
})
