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
})
