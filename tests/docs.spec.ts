import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * 文档卫生：相对链接 / 锚点有效 + 版本基线一致。
 *
 * 2026-09 文档清理时发现 8 处**锚点漂移**（标题改名后链接失效，编辑器里看不出来）与
 * 3 处版本基线过期（v0.3.0 / v0.8.0）。这类漂移没有编译期或运行期信号，
 * 用一条测试钉住：**能被解析的东西就别靠自觉**（见 `docs/README.md` §三）。
 */

const ROOT = join(import.meta.dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'coverage'])

function collectMarkdown(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) collectMarkdown(p, out)
    else if (entry.name.endsWith('.md')) out.push(p)
  }
  return out
}

/** GitHub slugger 等价实现：去代码反引号、去标点、每个空格转一个 `-` */
function slug(text: string): string {
  return text
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\p{M}\p{Pc}\s-]/gu, '')
    .replace(/ /g, '-')
}

function anchorsOf(file: string): Set<string> {
  const set = new Set<string>()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) set.add(slug(m[2]))
  }
  return set
}

describe('文档卫生（链接 / 锚点 / 版本基线）', () => {
  const files = collectMarkdown(ROOT)
  const anchors = new Map(files.map((f) => [f, anchorsOf(f)]))

  test('所有 Markdown 的相对链接与锚点都可解析', () => {
    expect(files.length).toBeGreaterThan(20)
    const problems: string[] = []
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
          const target = m[2]
          if (/^(https?:|mailto:)/.test(target)) continue
          const [pathPart, anchor] = target.split('#')
          const label = m[1] || target
          const where = `${relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}`
          if (!pathPart) {
            if (anchor && !anchors.get(file)?.has(anchor)) problems.push(`${where} 同文件锚点不存在 #${anchor}（${label}）`)
            continue
          }
          const targetFile = resolve(dirname(file), decodeURIComponent(pathPart))
          try {
            statSync(targetFile)
          } catch {
            problems.push(`${where} 文件不存在 → ${pathPart}（${label}）`)
            continue
          }
          if (anchor) {
            const set = anchors.get(targetFile)
            if (set && !set.has(anchor)) problems.push(`${where} 目标锚点不存在 → ${pathPart}#${anchor}（${label}）`)
          }
        }
      })
    }
    expect(problems, `发现 ${problems.length} 处失效链接/锚点`).toEqual([])
  })

  test('现行文档头部的版本基线与 package.json 一致', () => {
    const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
    const expected = `v${version}`
    const mustDeclare = [
      'README.md',
      'docs/README.md',
      'docs/用户使用指南.md',
      'docs/设计文档.md',
      'docs/技术文档.md',
      'docs/经验文档.md',
      'docs/更新记录.md',
      'docs/archive/审查修复记录.md',
      'docs/check/prompt-verify-all-features.md',
    ]
    for (const rel of mustDeclare) {
      const head = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/).slice(0, 12).join('\n')
      expect(head, `${rel} 头部缺少 ${expected} 版本基线`).toContain(expected)
    }
    // 两个 manifest 必须同版本（发布前的最后一刀）
    const plugin = JSON.parse(readFileSync(join(ROOT, 'dsh.plugin.json'), 'utf8')) as { version: string }
    expect(plugin.version).toBe(version)
  })

  /**
   * 数字守恒：文档里的模块数 / 测试文件数 / 项数曾经三处不一致（README 253、用户指南 251、真值 252）——
   * 都是"代码改了文档没改"，而这类漂移没有编译期信号。这里改成**现算比对**：
   * 数字只在 `技术文档.md` §2/§8 出现，值从 `src/`、`tests/` 现场数出来（静态计数已验证与 vitest 收集数一致）。
   */
  test('文档里的模块数 / 测试文件数 / 项数 == 从 src/ 与 tests/ 现算的值', () => {
    const srcFiles = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.ts'))
    const specFiles = readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.spec.ts'))
    /** 一个测试文件里的用例数：顶层 `test(` / `it(` 调用 */
    const casesOf = (file: string): number =>
      (readFileSync(join(ROOT, 'tests', file), 'utf8').match(/^\s*(?:test|it)\(/gm) ?? []).length
    const byFile = new Map(specFiles.map((f) => [f, casesOf(f)]))
    const totalCases = [...byFile.values()].reduce((a, b) => a + b, 0)

    const tech = readFileSync(join(ROOT, 'docs/技术文档.md'), 'utf8')
    const design = readFileSync(join(ROOT, 'docs/设计文档.md'), 'utf8')

    // 1) 模块数：两处标题 + 每个模块名都要出现在模块地图/边界表里
    const techMap = /## 2\. 模块地图（(\d+) 个）/.exec(tech)
    const designMap = /### 5\.2 模块边界（(\d+) 个）/.exec(design)
    expect(techMap, '技术文档 §2 标题格式变了（应形如 "## 2. 模块地图（N 个）"）').not.toBeNull()
    expect(designMap, '设计文档 §5.2 标题格式变了（应形如 "### 5.2 模块边界（N 个）"）').not.toBeNull()
    expect(Number(techMap?.[1]), '技术文档 §2 的模块数与 src/ 实际文件数不符').toBe(srcFiles.length)
    expect(Number(designMap?.[1]), '设计文档 §5.2 的模块数与 src/ 实际文件数不符').toBe(srcFiles.length)
    for (const file of srcFiles) {
      expect(tech, `技术文档的模块地图缺 ${file}`).toContain(file)
      expect(design, `设计文档的模块边界表缺 ${file}`).toContain(file)
    }

    // 2) 测试布局：标题的「N 文件 / M 项」= 实际文件数 / 各项之和；每行声明的项数 = 该行文件里 test() 的个数
    const layout = /## 8\. 测试布局（(\d+) 文件 \/ (\d+) 项）/.exec(tech)
    expect(layout, '技术文档 §8 标题格式变了（应形如 "## 8. 测试布局（N 文件 / M 项）"）').not.toBeNull()
    expect(Number(layout?.[1]), '技术文档 §8 的测试文件数与 tests/ 实际不符').toBe(specFiles.length)
    expect(Number(layout?.[2]), '技术文档 §8 的项数与测试文件里的用例总数不符').toBe(totalCases)

    const section = tech.slice(tech.indexOf('## 8. 测试布局'))
    const listed: string[] = []
    const rowProblems: string[] = []
    for (const line of section.split(/\r?\n/)) {
      if (!line.startsWith('| `tests/')) continue
      const cells = line.split('|').map((c) => c.trim())
      const names = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/^tests\//, ''))
      const declared = Number(cells[2].replace(/[^0-9]/g, ''))
      const actual = names.reduce((sum, n) => sum + (byFile.get(n) ?? Number.NaN), 0)
      if (actual !== declared) rowProblems.push(`${names.join(' + ')}：文档写 ${declared} 项，实际 ${actual} 项`)
      listed.push(...names)
    }
    expect(rowProblems, `测试布局表有 ${rowProblems.length} 行项数不符`).toEqual([])
    expect(specFiles.filter((f) => !listed.includes(f)), '这些测试文件没登记进技术文档 §8').toEqual([])
    expect(listed.filter((n) => !byFile.has(n)), '技术文档 §8 登记了不存在的测试文件').toEqual([])

    // 3) 两份 manifest 的 description 不能停留在旧口径（v0.9 的"卡片库/MOC"）
    for (const [name, desc] of [
      ['package.json', (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { description?: string }).description],
      ['dsh.plugin.json', (JSON.parse(readFileSync(join(ROOT, 'dsh.plugin.json'), 'utf8')) as { description?: string }).description],
    ] as const) {
      expect(desc, `${name} 缺少 description`).toBeTruthy()
      expect(desc, `${name} 的 description 仍是旧口径（卡片/MOC）`).not.toMatch(/卡片|MOC/)
      expect(desc, `${name} 的 description 应说明是文档式笔记`).toContain('笔记')
    }
  })
})
