import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * 预设组合卫生：`presets/study/agent.cordis.yml` 必须能被当前 DSH 挂载。
 *
 * 背景（2026-09）：DSH 0.1.5 的提交 40792330c0 把 `@deepseek-ai/dsh-persona` 的
 * 配置键 `text` 改名为必填的 `prefix`（并把旧 `deployment:persona` 段拆成
 * `persona-prefix` / `persona-suffix`）。仓库与部署副本都还写着 `text`，切换
 * 「学习伙伴」直接报 `invalid config: $.prefix missing required value`——文件坏在
 * 一行配置键上，编辑器里完全看不出来，没有编译期或运行期信号。
 *
 * 这类漂移只能靠"能被解析的就别靠自觉"钉住：本文件对预设做**零依赖**的结构断言
 * （不引入 YAML 解析器，沿用 `tests/skills.spec.ts` 的缩进扫描风格）。
 */

const ROOT = join(import.meta.dirname, '..')
const PRESET_DIR = join(ROOT, 'presets', 'study')
const COMPOSITION = join(PRESET_DIR, 'agent.cordis.yml')

/** 组合文件里一行顶层行（`- id: xxx`）的起始位置。 */
const ROW_START = /^-\s/
/** 行内的一级配置键（4 空格缩进，跳过注释行）。 */
const CONFIG_KEY = /^ {4}([A-Za-z_][A-Za-z0-9_]*):/

interface Row {
  readonly id: string
  /** 行内所有非注释行，含 `id`/`name`/`config` 与 config 的键值行。 */
  readonly lines: string[]
}

/** 按 `- ` 顶层行切分组合文件，得到每行的 id 与原始行集合。 */
function rows(text: string): Row[] {
  const out: Row[] = []
  for (const line of text.split(/\r?\n/)) {
    if (ROW_START.test(line)) {
      const id = /^-\s*id:\s*(\S+)/.exec(line)?.[1]
      expect(id, `顶层行缺少 id：${line}`).toBeTruthy()
      out.push({ id: id as string, lines: [line] })
      continue
    }
    const current = out.at(-1)
    if (current) (current.lines as string[]).push(line)
  }
  return out
}

/** 一行内**生效**（非注释）的 key: value 行。 */
function activeLines(row: Row): string[] {
  return row.lines.filter((line) => !line.trimStart().startsWith('#'))
}

/** 一行 config 块里生效的一级键名，按出现顺序。 */
function configKeys(row: Row): string[] {
  const keys: string[] = []
  for (const line of activeLines(row)) {
    const m = CONFIG_KEY.exec(line)
    if (m) keys.push(m[1])
  }
  return keys
}

describe('presets/study 组合卫生', () => {
  const text = readFileSync(COMPOSITION, 'utf8')
  const parsed = rows(text)

  test('每一行都声明 id 与模块名，且 id 唯一', () => {
    expect(parsed.length).toBeGreaterThan(5)
    const ids = parsed.map((row) => row.id)
    expect(new Set(ids).size, `id 重复：${ids.join(', ')}`).toBe(ids.length)
    for (const row of parsed) {
      const name = /^ {2}name:\s*(\S+)/.exec(activeLines(row).find((l) => /^ {2}name:/.test(l)) ?? '')
      expect(name?.[1], `行 ${row.id} 缺少模块名`).toBeTruthy()
    }
  })

  // 本次故障的钉子：persona 行只能用 `prefix`（DSH 0.1.5 起），写 `text` 必挂载失败。
  test('persona 行使用当前 DSH 的 `prefix` 键，且不含已删除的 `text` 键', () => {
    const persona = parsed.find((row) => row.id === 'persona')
    expect(persona, '组合缺少 persona 行').toBeTruthy()

    const lines = activeLines(persona as Row)
    const name = lines.find((line) => /^ {2}name:/.test(line))
    expect(name, 'persona 行的模块名').toBe("  name: '@deepseek-ai/dsh-persona'")

    expect(lines.some((line) => /^ {4}text:/.test(line)), 'persona 行仍有已删除的 `text` 键（应改为 prefix）').toBe(false)
    expect(configKeys(persona as Row)).toEqual(['prefix'])
  })

  test('preset.yml 声明显示名与描述（缺了会在预设列表里显示裸目录名）', () => {
    const meta = readFileSync(join(PRESET_DIR, 'preset.yml'), 'utf8')
    expect(/^name:\s*\S+/m.test(meta), 'preset.yml 缺少 name').toBe(true)
    expect(/^description:\s*\S+/m.test(meta), 'preset.yml 缺少 description').toBe(true)
  })

  // 阶段 6：插件行 config 键收敛（删 mocDir/templateHints，加 expectFile/planTtlHours）
  test('study 插件行的 config 键与插件 schema 一致', () => {
    const study = parsed.find((row) => row.id === 'study')
    expect(study, '组合缺少 study 插件行').toBeTruthy()
    const keys = configKeys(study as Row)
    // 退场的键：写进 preset 也不会生效，留着就是"以为配了其实没配"
    expect(keys, 'mocDir 已随 card_moc 退场').not.toContain('mocDir')
    expect(keys, 'templateHints 已随三型模板退场').not.toContain('templateHints')
    // 新增的键
    expect(keys).toContain('expectFile')
    expect(keys).toContain('planTtlHours')
    // 语义未变的键仍在
    for (const key of ['vaultRoot', 'stateDir', 'fallbackDir', 'skipDirs', 'includeSessionCwd', 'searchRoots', 'linkIntoNotes', 'domainFolders']) {
      expect(keys, `config 缺少 ${key}`).toContain(key)
    }
  })

  test('persona 不再教模型用卡片时代的工具（note_* 才是指令面）', () => {
    const text = readFileSync(COMPOSITION, 'utf8')
    for (const gone of ['card_create', 'card_update', 'card_link', 'card_moc', 'card_lint', 'card_history', 'card_rename', 'card_search', 'card_get', 'card_id']) {
      expect(text, `persona/config 仍提到已退场的 ${gone}`).not.toContain(gone)
    }
    for (const tool of ['note_write', 'note_plan', 'note_expect_get', 'note_toc', 'note_overview']) {
      expect(text, `persona 应写明 ${tool}`).toContain(tool)
    }
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
