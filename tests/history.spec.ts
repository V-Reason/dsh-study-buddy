import { describe, expect, test } from 'vitest'
import {
  checkDetails, errataBlock, extractHistory, formatHistory, insertHistoryBlock, stripHistory, versionBlock,
} from '../src/history.ts'
import { applyUpdate, renderCard, type CardInput } from '../src/card.ts'

const base: CardInput = {
  title: 'IBL 接入',
  domain: '图形学-光照模型',
  source: 'URP 文档',
  status: '已确认',
  definition: 'IBL 接入 = 环境侧喂数据 + shader 两行采样',
  content: [
    '### 核心思想',
    '环境侧喂数据、shader 两行采样。',
    '',
    '### 阶梯式解剖',
    '**第 1 层 · 直觉**：查表。',
    '',
    '### 关联卡片',
    '- 前置：`间接光`（202609092139_2c27）',
  ].join('\n'),
}

describe('history 版本块与历史折叠', () => {
  test('insertHistoryBlock：版本块插到「关联卡片」之前（P0-3）', () => {
    const raw = renderCard({ ...base, id: 'id1' })
    const next = insertHistoryBlock(raw, versionBlock('URP 14', '补充：smoothness 影响 mip。'))
    const order = ['### 阶梯式解剖', '### 版本更新', '### 关联卡片'].map((h) => next.indexOf(h))
    expect(order[0]).toBeLessThan(order[1])
    expect(order[1]).toBeLessThan(order[2])
    expect(next).toContain('- 前置：`间接光`')
    expect(next).not.toContain('\n\n\n')
  })

  test('insertHistoryBlock：无关联卡片小节时追加到末尾', () => {
    const raw = '> 定义\n\n### 核心思想\n内容'
    const next = insertHistoryBlock(raw, errataBlock('纠正原因：旧结论写反了。'))
    expect(next.endsWith('### 勘误\n纠正原因：旧结论写反了。')).toBe(true)
  })

  test('applyUpdate 的 append-version / errata 走同一插入位置（不再落在文件末尾）', () => {
    const raw = renderCard({ ...base, id: 'id1' })
    const versioned = applyUpdate(raw, 'id1', { mode: 'append-version', source: 'L16', changes: '补充内容' })
    expect(versioned.text.indexOf('### 版本更新')).toBeLessThan(versioned.text.indexOf('### 关联卡片'))
    const errata = applyUpdate(raw, 'id1', { mode: 'errata', changes: '纠正原因：X' })
    expect(errata.text.indexOf('### 勘误')).toBeLessThan(errata.text.indexOf('### 关联卡片'))
  })

  test('extractHistory：列出版本更新/勘误/历史折叠与行号', () => {
    const raw = [
      '---',
      'ID: x',
      '标题: T',
      '---',
      '',
      '> 定义',
      '',
      '### 核心思想',
      '内容',
      '',
      '### 版本更新（来源：L16）',
      '补充 A',
      '',
      '### 勘误',
      '纠正 B',
      '',
      '<details>',
      '<summary>历史版本（2026-09-01）</summary>',
      '',
      '旧正文',
      '',
      '</details>',
      '',
      '### 关联卡片',
      '- 前置：`A`（id1）',
    ].join('\n')
    const blocks = extractHistory(raw)
    expect(blocks.map((b) => b.kind)).toEqual(['version', 'errata', 'details'])
    expect(blocks[0].title).toContain('版本更新')
    expect(blocks[1].body).toContain('纠正 B')
    expect(blocks[2].title).toBe('历史版本（2026-09-01）')
    expect(blocks[2].body).toContain('旧正文')
    expect(blocks[2].line).toBeGreaterThan(blocks[1].line)
    const text = formatHistory(blocks)
    expect(text).toContain('[版本更新]')
    expect(text).toContain('[历史折叠]')
  })

  test('stripHistory：清除全部历史块并保留主线与关联', () => {
    const raw = [
      '> 定义',
      '',
      '### 核心思想',
      '内容',
      '',
      '### 版本更新（来源：L16）',
      '补充 A',
      '',
      '### 勘误',
      '纠正 B',
      '',
      '<details>',
      '<summary>历史版本（2026-09-01）</summary>',
      '',
      '旧正文',
      '',
      '</details>',
      '',
      '### 关联卡片',
      '- 前置：`A`（id1）',
    ].join('\n')
    const result = stripHistory(raw)
    expect(result.removed).toHaveLength(3)
    expect(result.warnings).toEqual([])
    expect(result.text).toContain('### 核心思想')
    expect(result.text).toContain('- 前置：`A`（id1）')
    expect(result.text).not.toContain('版本更新')
    expect(result.text).not.toContain('勘误')
    expect(result.text).not.toContain('<details>')
    expect(result.text).not.toContain('旧正文')
    expect(result.text).not.toContain('\n\n\n')
  })

  test('stripHistory：kinds 只清历史折叠时保留版本更新与勘误', () => {
    const raw = '### 核心思想\nx\n\n### 版本更新（来源：X）\ny\n\n<details>\n<summary>历史版本</summary>\n\nold\n\n</details>'
    const result = stripHistory(raw, { kinds: ['details'] })
    expect(result.text).toContain('### 版本更新（来源：X）')
    expect(result.text).not.toContain('<details>')
  })

  test('checkDetails：配对校验与未闭合行号', () => {
    expect(checkDetails('<details>\n<summary>a</summary>\n\nb\n\n</details>')).toMatchObject({ balanced: true, opens: 1, closes: 1 })
    expect(checkDetails('<details>\n没有闭合')).toMatchObject({ balanced: false, opens: 1, closes: 0, unclosed: [1] })
    expect(checkDetails('无折叠块')).toMatchObject({ balanced: true, opens: 0, closes: 0 })
  })

  test('stripHistory：未闭合折叠块给警告且不删除正文', () => {
    const raw = '### 核心思想\nx\n\n<details>\n<summary>历史版本</summary>\n\n没有闭合的旧正文'
    const result = stripHistory(raw)
    expect(result.warnings.join()).toContain('不配对')
    expect(result.text).toContain('没有闭合的旧正文')
  })

  test('无历史块时 strip 原样返回', () => {
    const raw = '### 核心思想\nx'
    const result = stripHistory(raw)
    expect(result.text).toBe(raw)
    expect(result.removed).toEqual([])
    expect(formatHistory([])).toContain('无历史块')
  })
})
