import { describe, expect, test } from 'vitest'
import { indexNote, SearchIndex, tokenize, tokenizeQuery } from '../src/search.ts'
import type { WalkedFile } from '../src/vault.ts'

function file(rel: string): WalkedFile {
  return { path: `T:/vault/${rel}`, rel, mtimeMs: 1, size: 10 }
}

const LEGACY = `> 概念: 迭代器是一种设计模式, 任何类都可以成为迭代器, 其本质是一个指针
# 迭代器主要方法
- vector.begin() // 返回vector首个元素**本位**的迭代器
`

const CARD = `---
ID: 202608161430_ab12
标题: 透视投影矩阵的三步分解
领域: #图形学与渲染 #线性代数
来源: GAMES101 L04
状态: 草稿
---

### 定义（一句话总结）
> 透视投影矩阵可拆解为缩放、平移与齐次除三步

### 核心内容
投影矩阵的平移部分只在第三行……
`

describe('tokenize', () => {
  test('cjkBigrams', () => {
    const tokens = tokenize('投影矩阵')
    expect(tokens).toContain('投影')
    expect(tokens).toContain('影矩')
    expect(tokens).toContain('矩阵')
  })

  test('asciiWords', () => {
    const tokens = tokenize('vector.begin() vector')
    expect(tokens).toContain('vector')
    expect(tokens).toContain('begin')
  })

  test('queryExpandsShortCjkRuns', () => {
    const tokens = tokenizeQuery('矩阵')
    expect(tokens).toContain('矩')
    expect(tokens).toContain('阵')
  })
})

describe('SearchIndex', () => {
  test('indexLegacyNoteWithoutFrontmatter', () => {
    const card = indexNote(file('计算机/编程/C++/基础C++/迭代器 iterator _cpp.md'), LEGACY)
    expect(card.id).toBeNull()
    expect(card.title).toBe('迭代器主要方法')
    expect(card.definition).toBe('迭代器是一种设计模式, 任何类都可以成为迭代器, 其本质是一个指针')
    expect(card.inferredDomain).toBe('计算机')
    expect(card.domain).toBeNull()
  })

  test('indexCardWithFrontmatter', () => {
    const card = indexNote(file('计算机/图形学/透视投影矩阵.md'), CARD)
    expect(card.id).toBe('202608161430_ab12')
    expect(card.title).toBe('透视投影矩阵的三步分解')
    expect(card.domain).toBe('图形学与渲染')
    expect(card.tags).toEqual(['图形学与渲染', '线性代数'])
    expect(card.status).toBe('草稿')
  })

  test('searchFindsLegacyByConcept', () => {
    const index = new SearchIndex()
    index.rebuild([
      indexNote(file('计算机/编程/C++/基础C++/迭代器 iterator _cpp.md'), LEGACY),
      indexNote(file('计算机/图形学/透视投影矩阵.md'), CARD),
    ])
    const hits = index.search('迭代器')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].title).toBe('迭代器主要方法')

    const proj = index.search('投影矩阵')
    expect(proj[0].id).toBe('202608161430_ab12')
  })

  test('searchFiltersByDomainAndStatus', () => {
    const index = new SearchIndex()
    index.rebuild([indexNote(file('计算机/图形学/透视投影矩阵.md'), CARD)])
    expect(index.search('矩阵', { status: '已确认' }).length).toBe(0)
    expect(index.search('矩阵', { status: '草稿' }).length).toBe(1)
    expect(index.search('矩阵', { domain: '图形学与渲染' }).length).toBe(1)
    expect(index.search('矩阵', { domain: '数据结构与算法' }).length).toBe(0)
  })

  test('searchReturnsNoHitsForUnknown', () => {
    const index = new SearchIndex()
    index.rebuild([indexNote(file('计算机/图形学/透视投影矩阵.md'), CARD)])
    expect(index.search('红黑树旋转').length).toBe(0)
  })

  test('byRelNormalizesSeparators', () => {
    const index = new SearchIndex()
    index.rebuild([indexNote(file('计算机/图形学/透视投影矩阵.md'), CARD)])
    expect(index.byRel('计算机/图形学/透视投影矩阵.md')?.id).toBe('202608161430_ab12')
    expect(index.byRel('透视投影矩阵.md')?.id).toBe('202608161430_ab12')
  })
})
