import { describe, expect, test } from 'vitest'
import {
  addLink, applyUpdate, generateId, renderCard, renderMoc, validateCard,
  type CardInput,
} from '../src/card.ts'

const base: CardInput = {
  title: '透视投影矩阵的三步分解',
  domain: '图形学与渲染',
  source: 'GAMES101 L04',
  status: '草稿',
  definition: '透视投影矩阵可拆解为缩放、平移与齐次除三步',
  content: '推导正文\n\n```hlsl\nfloat4x4 m;\n```',
  tags: ['线性代数'],
}

describe('card', () => {
  test('generateIdFormatAndUniqueness', () => {
    const now = new Date('2026-08-16T14:30:00+08:00')
    const ids = new Set(Array.from({ length: 20 }, () => generateId(now)))
    expect(ids.size).toBe(20)
    for (const id of ids) {
      expect(id).toMatch(/^202608161430_[0-9a-f]{4}$/)
    }
  })

  test('validateCard', () => {
    expect(validateCard(base).errors).toEqual([])
    expect(validateCard(base).warnings).toEqual([])

    const bad = { ...base, status: '奇怪状态' }
    expect(validateCard(bad).errors.join()).toContain('status')

    const longDef = { ...base, definition: '这'.repeat(31) }
    expect(validateCard(longDef).warnings.join()).toContain('30')

    const missing = { ...base, content: '' }
    expect(validateCard(missing).errors.join()).toContain('content')
  })

  test('renderCardMatchesFinalFormat', () => {
    const text = renderCard({ ...base, id: '202608161430_ab12', links: { prev: ['正交投影'] } })
    expect(text).toContain('ID: 202608161430_ab12')
    expect(text).toContain('领域: #图形学与渲染 #线性代数')
    // frontmatter 后空一行，定义是裸引用块
    expect(text).toContain('状态: 草稿\n---\n\n> 透视投影矩阵可拆解')
    // 无固定"核心内容"包裹标题、无尾部标签行
    expect(text).not.toContain('### 核心内容')
    expect(text).not.toContain('#Doing')
    expect(text).toContain('### 关联卡片')
    expect(text).toContain('- 前置：正交投影')
  })

  test('applyUpdateAppendVersionKeepsOldContent', () => {
    const raw = renderCard({ ...base, id: '202608161430_ab12' })
    const result = applyUpdate(raw, '202608161430_ab12', {
      mode: 'append-version',
      source: 'GAMES101 L05',
      changes: '补充：除法的 w 分量来自视图空间深度。',
    })
    expect(result.text).toContain('透视投影矩阵可拆解')
    expect(result.text).toContain('### 版本更新（来源：GAMES101 L05）')
    expect(result.text).toContain('除法的 w 分量来自视图空间深度')
  })

  test('applyUpdateErrataKeepsOldConclusion', () => {
    const raw = renderCard({ ...base, id: 'x' })
    const result = applyUpdate(raw, 'x', {
      mode: 'errata',
      changes: '纠正原因：旧结论把缩放与平移顺序写反了。\n正确顺序：先缩放后平移。',
    })
    expect(result.text).toContain('### 勘误')
    expect(result.text).toContain('纠正原因')
    expect(result.text).toContain('透视投影矩阵可拆解') // 旧内容保留
  })

  test('applyUpdateReplaceKeepsHistoryBlock', () => {
    const raw = renderCard({ ...base, id: 'y' })
    const result = applyUpdate(raw, 'y', {
      mode: 'replace',
      card: { ...base, title: '透视投影矩阵（修订版）', status: '已确认', definition: '修订后的三十字内定义' },
    })
    expect(result.text).toContain('透视投影矩阵（修订版）')
    expect(result.text).toContain('历史版本')
    expect(result.text).toContain('透视投影矩阵可拆解') // 旧正文进折叠块
    expect(result.text).toContain('状态: 已确认')
  })

  test('applyUpdateReplaceRejectsInvalidCard', () => {
    const raw = renderCard({ ...base, id: 'z' })
    expect(() => applyUpdate(raw, 'z', {
      mode: 'replace',
      card: { ...base, title: '' },
    })).toThrow('校验失败')
  })

  test('applyUpdateRejectsUnknownMode', () => {
    expect(() => applyUpdate('raw', 'id', { mode: 'boom' as never })).toThrow('未知更新模式')
  })

  test('addLinkCreatesSectionWhenAbsent', () => {
    const raw = '# 标题\n正文'
    const text = addLink(raw, 'prev', '前置卡片（id1）')
    expect(text).toContain('### 关联卡片')
    expect(text).toContain('- 前置：前置卡片（id1）')
    expect(text).toContain('正文')
  })

  test('addLinkAppendsUnderExistingSection', () => {
    const raw = '# 标题\n\n### 关联卡片\n- 前置：旧卡片\n\n正文尾'
    const text = addLink(raw, 'next', '延伸卡片（id2）')
    const idxNext = text.indexOf('- 后续：延伸卡片（id2）')
    const idxOld = text.indexOf('- 前置：旧卡片')
    expect(idxNext).toBeGreaterThan(-1)
    expect(idxNext).toBeLessThan(idxOld)
    expect(text).toContain('正文尾')
  })

  test('addLinkSkipsExistingTarget', () => {
    const raw = '# 标题\n- 前置：已有（id3）'
    const text = addLink(raw, 'prev', '已有（id3）')
    expect(text.match(/已有（id3）/g)?.length).toBe(1)
  })

  test('addLinkPreservesFrontmatter', () => {
    const raw = `---\nID: 202608161430_ab12\n标题: 投影矩阵\n---\n\n> 定义\n`
    const text = addLink(raw, 'prev', '前置（x）')
    expect(text).toContain('---\nID: 202608161430_ab12')
    expect(text).toContain('### 关联卡片')
    expect(text).toContain('- 前置：前置（x）')
    expect(text).toContain('> 定义')
  })

  test('renderMocGroupsByDomain', () => {
    const text = renderMoc('知识目录', '2026-08-16', [
      { id: 'a', title: '投影矩阵', domain: '图形学与渲染', fileName: '投影矩阵.md' },
      { id: 'b', title: '红黑树插入', domain: '数据结构与算法', fileName: '红黑树.md' },
    ])
    expect(text).toContain('## 图形学与渲染')
    expect(text).toContain('- [[投影矩阵]]（a）')
    expect(text).toContain('## 数据结构与算法')
    expect(text).toContain('- [[红黑树]]（b）· 红黑树插入')
  })
})
