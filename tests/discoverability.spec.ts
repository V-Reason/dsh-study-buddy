import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { VaultStore } from '../src/index.ts'
import {
  auditDiscoverability, formatDiscoverability, wikilinkTargets, type DiscoverabilityNote,
} from '../src/discoverability.ts'

const notes: DiscoverabilityNote[] = [
  {
    rel: '图形学/光照/PBR.md',
    title: 'PBR',
    kind: 'block',
    sourceSection: '《图形学》第1章 光照 / 1.1节',
    body: '[[BRDF]]',
  },
  {
    rel: '图形学/光照/BRDF.md',
    title: 'BRDF',
    kind: 'legacy',
    sourceSection: null,
    body: '[[不存在]]',
  },
]

describe('笔记可发现性审计', () => {
  test('审计缺来源章节、缺微目录与断链', () => {
    const report = auditDiscoverability(notes, [], { path: '图形学' })

    expect(report.issues.map((i) => i.kind)).toEqual(expect.arrayContaining([
      'missing-source-section', 'missing-toc', 'broken-link',
    ]))
    const text = formatDiscoverability(report, 10)
    expect(text).toContain('缺来源章节')
    expect(text).toContain('缺微目录')
    expect(text).toContain('断链')
  })

  test('定向链接与已有微目录不算孤立', () => {
    const report = auditDiscoverability([
      { rel: 'a/甲.md', title: '甲', kind: 'block', sourceSection: '《X》第1章', body: '' },
      { rel: 'a/乙.md', title: '乙', kind: 'block', sourceSection: '《X》第1章', body: '[[甲]]' },
    ], ['a'], { path: 'a' })

    expect(report.issues.some((i) => i.kind === 'orphan' && i.rel === 'a/甲.md')).toBe(false)
  })

  test('代码块内链接与注释不参与解析；歧义目标单独报告', () => {
    expect(wikilinkTargets([
      '[[有效]]',
      '```',
      '[[代码块]]',
      '```',
      '<details><summary>历史</summary>',
      '[[折叠块]]',
      '</details>',
    ].join('\n'))).toEqual(['有效'])

    const report = auditDiscoverability([
      { rel: 'a/来源.md', title: '来源', kind: 'block', sourceSection: '《X》第1章', body: '[[同名]]' },
      { rel: 'a/同名.md', title: '同名', kind: 'block', sourceSection: '《X》第1章', body: '' },
      { rel: 'b/同名.md', title: '同名', kind: 'block', sourceSection: '《Y》第1章', body: '' },
    ], ['a', 'b'], { path: '.' })

    expect(report.issues.some((i) => i.kind === 'ambiguous-link')).toBe(true)
    expect(report.issues.filter((i) => i.kind === 'duplicate-title')).toHaveLength(2)
  })

  test('VaultStore 只审计明确目录，并拒绝隐式全库扫描', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'study-buddy-audit-'))
    try {
      const dir = join(vault, '主题')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, '存量.md'), [
        '---',
        'ID: 202611030900_ab12cd',
        '标题: 存量',
        '来源: 课程',
        '状态: 已确认',
        '---',
        '',
        '# 存量',
      ].join('\n'), 'utf8')
      const store = new VaultStore({ vaultRoot: vault, stateDir: '.study', fallbackDir: '未分类' })
      const report = await store.noteLibrary('audit', { path: '主题' })
      expect(report).toContain('缺微目录')
      expect(report).toContain('缺来源章节')
      await expect(store.noteLibrary('audit')).rejects.toThrow(`path='.'`)
    } finally {
      await rm(vault, { recursive: true, force: true })
    }
  })
})
