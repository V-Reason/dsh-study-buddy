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

  test('技能集合恰为 6 个既有技能', () => {
    const names = listSkills().map(({ skill }) => skill.name).sort()
    expect(names).toEqual(
      ['card-format', 'domain-adaptation', 'file-reading', 'incremental-update', 'memory-auto', 'study-loop'].sort(),
    )
  })

  test('memory-auto 技能含自迭代要点', () => {
    const skill = listSkills().find(({ dir }) => dir === 'memory-auto')
    expect(skill).toBeDefined()
    const body = skill!.skill.body
    expect(body).toContain('prefs.')
    expect(body).toContain('已自动记入偏好')
    expect(body).toContain('_autoPrefs')
  })

  test('card-format 技能含通用骨架必填小节与四层序号规则', () => {
    const skill = listSkills().find(({ dir }) => dir === 'card-format')
    expect(skill).toBeDefined()
    const body = skill!.skill.body
    for (const section of ['核心思想', '主干线', '阶梯式解剖', '实例走查', '易错点', '自测题']) {
      expect(body, `card-format 应包含小节：${section}`).toContain(section)
    }
    // 2026-09 新增的四个小节
    for (const section of ['重入点', '前置检查', '验证实验', '排障判据']) {
      expect(body, `card-format 应包含新增小节：${section}`).toContain(section)
    }
    expect(body).toContain('第 1 层 · 直觉')
    expect(body).toContain('4~6')
    expect(body).toContain('存量旧卡')
    // 分型与反堆砌三规则
    expect(body).toContain('理论型')
    expect(body).toContain('工程型')
    expect(body).toContain('对比型')
    expect(body).toContain('主干线唯一')
    expect(body).toContain('删除测试')
    expect(body).toContain('前置检查')
  })

  test('card-format 技能：取消正文字数、保留定义硬限、三问自检', () => {
    const body = listSkills().find(({ dir }) => dir === 'card-format')!.skill.body
    expect(body).toContain('≤60 字硬上限')
    expect(body).toContain('不设上下限')
    // 旧的暗示性字数约束必须已删除
    expect(body).not.toContain('≥~400 字')
    expect(body).not.toContain('600~1500')
    expect(body).not.toContain('≥~500 字')
    // 完备性三问
    expect(body).toContain('信息完备性')
  })

  test('card-format 技能含定义长度终局规则与完整领域键名表', () => {
    const body = listSkills().find(({ dir }) => dir === 'card-format')!.skill.body
    // 定义长度：≤60 硬上限（工具硬拒，见 card.ts）；31~60 放行口径在 persona
    expect(body).toContain('≤60 字硬上限')
    expect(body).toContain('检索契约')
    // 键名表：含易错键"图形学-动画特效"（无"与"）与映射目录
    expect(body).toContain('图形学-动画特效')
    expect(body).toContain('动画与特效')
    expect(body).toContain('近似')
  })

  test('card-format 技能含卡片维护三件套（lint/history/rename）与版本块位置口径', () => {
    const body = listSkills().find(({ dir }) => dir === 'card-format')!.skill.body
    expect(body).toContain('card_lint')
    expect(body).toContain('card_history')
    expect(body).toContain('card_rename')
    expect(body).toContain('关联卡片')
    expect(body).toContain('标题或 ID 任一命中')
  })

  test('domain-adaptation 技能覆盖数学/数值分析条目', () => {
    const body = listSkills().find(({ dir }) => dir === 'domain-adaptation')!.skill.body
    expect(body).toContain('数学/数值分析')
    expect(body).toContain('数值稳定性')
    expect(body).toContain('收敛')
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

  test('file-reading 技能含内嵌图片提取要点（pdf/pptx/docx）', () => {
    const skill = listSkills().find(({ dir }) => dir === 'file-reading')
    expect(skill).toBeDefined()
    const body = skill!.skill.body
    // PDF：含图页检测与渲染
    expect(body).toContain('get_image_info')
    expect(body).toContain('get_pixmap')
    // PPTX：图片 shape 与 zipfile 兜底
    expect(body).toContain('PICTURE')
    expect(body).toContain('ppt/media')
    // DOCX：media 提取
    expect(body).toContain('word/media')
    // 报告模板与失败链
    expect(body).toContain('图片：')
    expect(body).toContain('需转换')
    expect(body).toContain('不假装理解')
  })

  test('file-reading 技能：pymupdf 化、>10 页硬约束与 get_toc 定位', () => {
    const body = listSkills().find(({ dir }) => dir === 'file-reading')!.skill.body
    expect(body).toContain('import pymupdf')
    expect(body).not.toContain('import fitz,')
    expect(body).toContain('单次调用页数上限 10 页')
    expect(body).toContain('必须分次调用')
    expect(body).toContain('get_toc')
    expect(body).toContain('文本层噪声')
  })
})
