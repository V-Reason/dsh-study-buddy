import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * 校验 presets/study/skills/ 下的技能文件：
 * 对齐 harness（@deepseek-ai/dsh-skill-filesystem）的解析规则——
 * 文件须以 `---` 开头、frontmatter 含非空 name/description、正文非空；
 * 另加本仓库约定：技能名与目录名一致、全局唯一。
 */

const SKILLS_DIR = join(import.meta.dirname, '..', 'presets', 'study', 'skills')

interface ParsedSkill {
  name: string
  description: string
  body: string
}

function parseSkill(raw: string): ParsedSkill | null {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return null
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (!m) return null
  const fields = new Map<string, string>()
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
  }
  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  const body = raw.slice(m[0].length).trim()
  return { name, description, body }
}

function listSkills(): { dir: string; skill: ParsedSkill }[] {
  const out: { dir: string; skill: ParsedSkill }[] = []
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(SKILLS_DIR, entry.name, 'SKILL.md')
    const raw = readFileSync(file, 'utf8')
    const skill = parseSkill(raw)
    if (!skill) throw new Error(`${file} 缺少合法 frontmatter（须以 --- 开头且含 name/description）`)
    out.push({ dir: entry.name, skill })
  }
  return out
}

describe('study preset skills', () => {
  test('每个技能目录都有合法 frontmatter（name/description 非空、正文非空）', () => {
    const skills = listSkills()
    expect(skills.length).toBeGreaterThanOrEqual(5)
    for (const { dir, skill } of skills) {
      expect(skill.name, `${dir}/SKILL.md name`).not.toBe('')
      expect(skill.description, `${dir}/SKILL.md description`).not.toBe('')
      expect(skill.body, `${dir}/SKILL.md body`).not.toBe('')
    }
  })

  test('技能名与目录名一致且全局唯一', () => {
    const skills = listSkills()
    const names = skills.map(({ dir, skill }) => [dir, skill.name] as const)
    for (const [dir, name] of names) {
      expect(name, `${dir} 的 frontmatter name 应与目录名一致`).toBe(dir)
    }
    const unique = new Set(names.map(([, name]) => name))
    expect(unique.size).toBe(names.length)
  })

  test('技能集合恰为 5 个既有技能 + file-reading', () => {
    const names = listSkills().map(({ skill }) => skill.name).sort()
    expect(names).toEqual(
      ['card-format', 'domain-adaptation', 'file-reading', 'incremental-update', 'study-loop'].sort(),
    )
  })

  test('file-reading 技能含已验证的工具链要点', () => {
    const skill = listSkills().find(({ dir }) => dir === 'file-reading')
    expect(skill).toBeDefined()
    const body = skill!.skill.body
    expect(body).toContain('read_image')
    expect(body).toContain('python -X utf8')
    expect(body).toContain('pptx')
    // 铁律：读取 ≠ 讲解
    expect(body).toContain('读取 ≠ 讲解')
  })
})
