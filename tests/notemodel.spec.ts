import { describe, expect, test } from 'vitest'
import {
  blankOutBlocks, codeFenceLanguages, findSection, inlineText, makeLineOf,
  insertBlockBefore, matchesTitle, renderSections, splitSections,
} from '../src/notemodel.ts'

const BODY = [
  '> 一句话定位',
  '',
  '### 核心思想',
  '讲清 + 为什么 + 锚点',
  '',
  '### 阶梯式解剖（第 1 层 → 第 4 层）',
  '**第 1 层 · 直觉**：直觉',
  '',
  '### 实例走查',
  '数值代入',
  '',
  '### 关联',
  '- 前置：[[A]]',
].join('\n')

describe('notemodel 段落模型', () => {
  test('splitSections 切出 lead 与小节，正文不含标题行', () => {
    const { lead, sections } = splitSections(BODY)
    expect(lead).toBe('> 一句话定位')
    expect(sections.map((s) => s.title)).toEqual(['核心思想', '阶梯式解剖（第 1 层 → 第 4 层）', '实例走查', '关联'])
    expect(sections[0].body).toBe('讲清 + 为什么 + 锚点')
    expect(sections[0].level).toBe(3)
    expect(sections[3].body).toBe('- 前置：[[A]]')
  })

  test('renderSections 往返等价（空行归一化后逐字一致）', () => {
    const { lead, sections } = splitSections(BODY)
    expect(renderSections(lead, sections)).toBe(BODY)
  })

  test('matchesTitle 兼容括号后缀变体，但不误吞同前缀词', () => {
    expect(matchesTitle('阶梯式解剖', '阶梯式解剖')).toBe(true)
    expect(matchesTitle('阶梯式解剖（第 1 层 → 第 4 层）', '阶梯式解剖')).toBe(true)
    expect(matchesTitle('核心思想（直击）', '核心思想')).toBe(true)
    expect(matchesTitle('主干线：一句话', '主干线')).toBe(true)
    expect(matchesTitle('阶梯式解剖学', '阶梯式解剖')).toBe(false)
    expect(matchesTitle('', '核心思想')).toBe(false)
  })

  test('findSection 定位一致', () => {
    const { sections } = splitSections(BODY)
    expect(findSection(sections, '实例走查')?.body).toBe('数值代入')
    expect(findSection(sections, '阶梯式解剖')?.title).toBe('阶梯式解剖（第 1 层 → 第 4 层）')
    expect(findSection(sections, '排障判据')).toBeUndefined()
  })

  test('inlineText 只折换行、不压空格（SEC-1 渲染兜底 + N12）', () => {
    expect(inlineText('A\n---\n注入: x')).toBe('A --- 注入: x')
    expect(inlineText('  前后空白  ')).toBe('前后空白')
    expect(inlineText(undefined)).toBe('')
    // 跨行折叠（含空行）只产生一个空格
    expect(inlineText('a\n\n  \nb')).toBe('a b')
    // N12：连续空格是合法输入，不得静默改写
    expect(inlineText('C++  STL')).toBe('C++  STL')
    expect(inlineText('C++  STL\n下一行')).toBe('C++  STL 下一行')
  })

  test('makeLineOf 下标 → 行号（1 基，含边界）', () => {
    const text = 'a\nbb\n\nccc'
    const lineOf = makeLineOf(text)
    expect(lineOf(0)).toBe(1)
    expect(lineOf(2)).toBe(2)
    expect(lineOf(5)).toBe(3)
    expect(lineOf(6)).toBe(4)
    expect(lineOf(999)).toBe(4)
  })

  test('insertBlockBefore：插到「关联」之前，不破坏前后空行', () => {
    const text = insertBlockBefore(BODY, '### 补充（来源：X）\n补充内容')
    expect(text.indexOf('### 补充')).toBeGreaterThan(text.indexOf('### 实例走查'))
    expect(text.indexOf('### 补充')).toBeLessThan(text.indexOf('### 关联'))
    expect(text).toContain('- 前置：[[A]]')
    expect(text).not.toContain('\n\n\n')
  })

  test('insertBlockBefore：无「关联」小节时追加到末尾', () => {
    const raw = '> 定位\n\n### 核心思想\n内容'
    const text = insertBlockBefore(raw, '### 补充\n补充内容')
    expect(text.endsWith('### 补充\n补充内容')).toBe(true)
    expect(text).toContain('### 核心思想\n内容')
  })

  test('codeFenceLanguages 取语言标注（空串 = 未标）', () => {
    expect(codeFenceLanguages('```hlsl\nx\n```\n```\ny\n```')).toEqual(['hlsl', ''])
  })

  test('blankOutBlocks 抹掉代码块与 details（保留行号）', () => {
    const raw = [
      '正文 A',
      '```hlsl',
      'float4 x; // 你的 shader',
      '```',
      '正文 B',
      '<details>',
      '历史版本 你的工程',
      '</details>',
      '正文 C',
    ].join('\n')
    const out = blankOutBlocks(raw)
    expect(out.split('\n')).toHaveLength(9)
    expect(out).toContain('正文 A')
    expect(out).toContain('正文 B')
    expect(out).toContain('正文 C')
    expect(out).not.toContain('你的 shader')
    expect(out).not.toContain('你的工程')
  })
})
