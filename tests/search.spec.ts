import { describe, expect, test } from 'vitest'
import { indexNote, SearchIndex, tokenize, tokenizeQuery } from '../src/search.ts'
import type { WalkedFile } from '../src/vault.ts'

function file(rel: string, root = 'vault'): WalkedFile {
  return { path: `T:/vault/${rel}`, rel, root, mtimeMs: 1, ctimeMs: 1, size: 10 }
}

const LEGACY = `> 概念: 迭代器是一种设计模式, 任何类都可以成为迭代器, 其本质是一个指针
# 迭代器主要方法
- vector.begin() // 返回vector首个元素**本位**的迭代器
`

// 与 renderCard 产物一致的 v0.3.0 定稿格式：frontmatter 后首行为裸引用块定义
const CARD = `---
ID: 202608161430_ab12
标题: 透视投影矩阵的三步分解
领域: #图形学与渲染 #线性代数
来源: GAMES101 L04
状态: 草稿
---

> 透视投影矩阵可拆解为缩放、平移与齐次除三步

### 核心机制
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
    // 定稿格式的裸引用块定义可被索引（extractDefinition 回退分支）
    expect(card.definition).toBe('透视投影矩阵可拆解为缩放、平移与齐次除三步')
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

  test('indexNote 标记根与类型（card=有 ID，note=无 ID）', () => {
    const note = indexNote(file('CS/迭代器.md', '工作目录'), LEGACY)
    expect(note.root).toBe('工作目录')
    expect(note.kind).toBe('note')
    expect(note.fullRel).toBe('工作目录/CS/迭代器.md')
    const card = indexNote(file('计算机/图形学/透视投影矩阵.md', 'vault'), CARD)
    expect(card.kind).toBe('card')
    expect(card.fullRel).toBe('vault/计算机/图形学/透视投影矩阵.md')
  })

  test('多根检索：fullRel 带根标签、kind 过滤、按分数降序', () => {
    const index = new SearchIndex()
    index.rebuild([
      indexNote(file('计算机/图形学/透视投影矩阵.md', 'vault'), CARD),
      indexNote(file('图形学/投影矩阵草稿.md', '工作目录'), '> 概念: 投影矩阵草稿\n\n# 投影矩阵草稿\n正文\n'),
    ], true)
    const hits = index.search('投影矩阵')
    expect(hits.map((h) => h.kind)).toEqual(expect.arrayContaining(['card', 'note']))
    expect(hits.length).toBe(2)
    // 分数降序（同分兜底：卡片优先于旧笔记，且 fullRel 字典序）
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
    const noteHit = hits.find((h) => h.kind === 'note')!
    expect(noteHit.fullRel).toBe('工作目录/图形学/投影矩阵草稿.md')
    expect(index.search('投影矩阵', { kind: 'note' }).length).toBe(1)
    expect(index.search('投影矩阵', { kind: 'card' })[0].id).toBe('202608161430_ab12')
  })

  test('单根重建时 fullRel 不带根前缀（向后兼容展示）', () => {
    const index = new SearchIndex()
    index.rebuild([indexNote(file('计算机/图形学/透视投影矩阵.md'), CARD)])
    expect(index.search('投影矩阵')[0].fullRel).toBe('计算机/图形学/透视投影矩阵.md')
  })

  test('candidatesForRef 支持根限定路径与歧义', () => {
    const index = new SearchIndex()
    index.rebuild([
      indexNote(file('笔记/迭代器.md', 'vault'), LEGACY),
      indexNote(file('笔记/迭代器.md', '工作目录'), LEGACY),
    ], true)
    expect(index.candidatesForRef('工作目录/笔记/迭代器.md').map((c) => c.root)).toEqual(['工作目录'])
    expect(index.candidatesForRef('vault/笔记/迭代器.md').map((c) => c.root)).toEqual(['vault'])
    // 未限定路径跨根歧义：返回两个候选
    expect(index.candidatesForRef('笔记/迭代器.md').length).toBe(2)
    // 文件名唯一时也可命
    expect(index.candidatesForRef('迭代器.md').length).toBe(2)
  })
})
