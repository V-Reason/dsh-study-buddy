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
  content: [
    '### 核心思想',
    '**一句话讲清**：先缩放后平移，最后齐次除，三步把透视世界变成矩形视口。',
    '**为什么**：透视投影的关键是 w 除，其余都是仿射铺垫。',
    '**记忆锚点**：先裁窗后贴到屏幕。',
    '',
    '### 阶梯式解剖',
    '**第 1 层 · 直觉**：近大远小 = 对 w 做除法。',
    '**第 2 层 · 机制**：矩阵乘法（见下）。',
    '**第 3 层 · 细节与推导**：齐次坐标代入后展开，第三行以 -1 填 w。',
    '**第 4 层 · 边界与反例**：w=0 对应无穷远点，透视除失效。',
    '',
    '### 实例走查',
    '输入 (0,0,1,1)：缩放 → 平移 → w 除 → 屏幕坐标。',
    '',
    '### 易错点',
    '- 忘记 w 归一化：四维坐标不能直接当三维用。',
    '',
    '### 自测题',
    '- **Q1**：平移为什么放进矩阵？ → 齐次坐标把平移变成线性变换。',
    '',
    '```hlsl\nfloat4x4 m;\n```',
  ].join('\n'),
  tags: ['线性代数'],
}

describe('card', () => {
  test('generateIdFormatAndUniqueness', () => {
    // 用本地时间构造，避免 CI（UTC）与开发机时区差异导致时间戳偏移
    const now = new Date(2026, 7, 16, 14, 30)
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

  test('validateCard 警告缺失的阶梯式解剖模板小节（不阻塞）', () => {
    // 少了 实例走查 / 易错点 / 自测题
    const partial = { ...base, content: '### 核心思想\n一句话。\n\n### 阶梯式解剖\n第 1 层。' }
    const result = validateCard(partial)
    expect(result.errors).toEqual([])
    const warnings = result.warnings.join()
    expect(warnings).toContain('"### 实例走查"')
    expect(warnings).toContain('"### 易错点"')
    expect(warnings).toContain('"### 自测题"')
    expect(warnings).not.toContain('"### 核心思想"')
    expect(warnings).not.toContain('"### 阶梯式解剖"')
    // 五小节齐全则不产生模板警告
    expect(validateCard(base).warnings.filter(w => w.includes('模板必需'))).toEqual([])
    // content 为空时已有 error，不再叠加模板警告
    expect(validateCard({ ...base, content: '' }).warnings.join()).not.toContain('模板必需')
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
      card: {
        ...base, title: '透视投影矩阵（修订版）', status: '已确认',
        definition: '修订后的三十字内定义', links: { prev: ['正交投影'], next: ['光栅化'] },
      },
    })
    expect(result.text).toContain('透视投影矩阵（修订版）')
    expect(result.text).toContain('历史版本')
    expect(result.text).toContain('透视投影矩阵可拆解') // 旧正文进折叠块
    expect(result.text).toContain('状态: 已确认')
    // replace 可重建关联卡片（links 透传渲染）
    expect(result.text).toContain('### 关联卡片')
    expect(result.text).toContain('- 前置：正交投影')
    expect(result.text).toContain('- 后续：光栅化')
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

  test('addLinkDedupesByIdAcrossTitleChanges', () => {
    const raw = '# 标题\n\n### 关联卡片\n- 后续：旧标题（202608161430_ab12）\n'
    // 目标卡标题已改，但 ID 相同：按 ID 判重，不重复添加
    const text = addLink(raw, 'next', '新标题（202608161430_ab12）', '202608161430_ab12')
    expect(text.match(/- 后续：/g)?.length).toBe(1)
    expect(text).toContain('旧标题（202608161430_ab12）')
  })

  test('addLinkFallsBackToLabelDedupWithoutId', () => {
    // 旧笔记无 ID：回退为按标签文本判重
    const raw = '# 标题\n\n### 关联卡片\n- 后续：旧笔记（计算机/图形学/旧.md）\n'
    const text = addLink(raw, 'next', '旧笔记（计算机/图形学/旧.md）')
    expect(text.match(/- 后续：/g)?.length).toBe(1)
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
