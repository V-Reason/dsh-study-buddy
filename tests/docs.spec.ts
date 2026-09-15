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
})
