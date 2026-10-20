import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { LOOP_PROMPT_VARIABLES, scanEntryRows, scanPromptVariables } from '../tools/verify-contract.mjs'

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

/**
 * 解析声明 patch 里 `compaction-basic` 的 `modelPolicies`（缩进块，缩进回落即结束）。
 *
 * 为什么单独解析：`modelPolicies[].model` 必须是**目录里真实存在**的 model id——
 * compaction-basic 按精确 `provider` + `model` 匹配策略，`resolveConfig` 只校验形状/
 * 类型，**没有成员检查**，所以写错 id 不会报错、也不会告警，那条策略只是静默失效
 * （`deepseek-v4-flash` 就这么躺了一个版本）。
 * @param yaml - 声明 patch 全文
 * @returns 各条策略的 provider / model
 */
function parseModelPolicies(yaml: string): { providers: string[]; models: string[] } {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*modelPolicies:\s*$/.test(line))
  if (start === -1) throw new Error('presets/study.patch.yml 缺少 modelPolicies')
  const indent = lines[start].match(/^\s*/)![0].length
  const providers: string[] = []
  const models: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    if (line.match(/^\s*/)![0].length <= indent) break
    const provider = /^\s*(?:-\s*)?provider:\s*(\S+)\s*$/.exec(line)
    if (provider) {
      providers.push(provider[1].replace(/^['"]|['"]$/g, ''))
      continue
    }
    const model = /^\s*(?:-\s*)?model:\s*(\S+)\s*$/.exec(line)
    if (model) models.push(model[1].replace(/^['"]|['"]$/g, ''))
  }
  return { providers, models }
}

/**
 * 复核过的 `modelPolicies` 目标（DSH 0.1.7-rc.1 与 0.2.0-rc.1 一致）。
 *
 * 来源：平台 `packages/llm/llm-deepseek/src/models.ts` 的 `DEFAULT_MODELS`
 * （`deepseek-flash` / `deepseek-v4-pro`）；provider 路由名 `deepseek-official`
 * 来自 `packages/llm/llm-deepseek-api-key/src/index.ts` 的 `PROVIDER`。
 * 平台加/改模型 id 时这里会红——那时先对着平台 HEAD 核一遍再改，别只改断言。
 */
const REVIEWED_MODEL_IDS = ['deepseek-flash', 'deepseek-v4-pro']
const REVIEWED_PROVIDER = 'deepseek-official'

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

  // 0.2.1-rc.2（上游提交 79bd3d8d）删除了 loop 的 `cwd` 提示词变量，只注册 provider/model。
  // persona 模板是 strict 插值：残留 {{cwd}} 会在首个模型请求前抛 unknown prompt variable。
  test('persona 模板只引用 loop 注册的变量（{{cwd}} 已在 0.2.1 退场）', () => {
    const variables = scanPromptVariables(text)
    expect(variables, 'persona 应保留 loop 注册的模型事实').toContain('model')
    expect(variables, '{{cwd}} 会在首个请求前让 prompt assembly 抛错').not.toContain('cwd')
    for (const variable of variables) {
      expect(LOOP_PROMPT_VARIABLES, `模板引用了 loop 未注册的变量 {{${variable}}}`).toContain(variable)
    }
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

  // 2026-09 复核发现的死值：`modelPolicies[0].model: deepseek-v4-flash` 在 0.1.7-rc.1 与
  // 0.2.0-rc.1 的目录里都不存在（目录是 deepseek-flash / deepseek-v4-pro），而
  // compaction-basic 没有成员检查 → 那条策略静默失效、不报错也不告警。
  test('compaction-basic 的 modelPolicies 指向真实存在的 model id 与 provider 路由', () => {
    const { providers, models } = parseModelPolicies(text)
    expect(models.length, 'modelPolicies 至少要有一条策略').toBeGreaterThan(0)
    expect(models.length, '每条策略都应有 provider 与 model').toBe(providers.length)
    for (const [index, model] of models.entries()) {
      expect(
        REVIEWED_MODEL_IDS,
        `modelPolicies[${index}].model=${model} 不在复核过的目录里（DSH 默认目录见 `
        + 'packages/llm/llm-deepseek/src/models.ts）；写错的策略不报错、只是静默不生效',
      ).toContain(model)
    }
    for (const [index, provider] of providers.entries()) {
      expect(REVIEWED_PROVIDER, `modelPolicies[${index}].provider=${provider} 不是复核过的路由名`).toBe(provider)
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
