import { describe, expect, test } from 'vitest'
import {
  crossCardConflicts, dateOfCardId, executabilityOf, executabilitySummary, extractFacts, formatConflicts,
  formatTrend, isoWeek, qualityTrend,
} from '../src/insight.ts'
import { lintCard, type LintReport } from '../src/lint.ts'

const CARD_A = [
  '### 核心思想',
  '圆周率取 3.14 就够。',
  '',
  '### 阶梯式解剖',
  '| 常量 | 取值 | 用途 |',
  '| :-- | :-- | :-- |',
  '| 圆周率 π | 3.14 | 面积计算 |',
  '| 重力加速度 g | 9.8 | 物理模拟 |',
  '',
  '### 实例走查',
  '$mip = \\log_2(r)$',
  '',
  '```hlsl',
  'float3 c;',
  '```',
  '',
  '### 验证实验',
  '1. 改 r：mip 变 → 生效。',
  '2. 关环境光：暗部塌黑 → 数据源确认。',
  '3. 换探针：反射变 → 通道通。',
  '',
  '### 排障判据',
  '| 症状 | 判据 | 修复 |',
  '| :-- | :-- | :-- |',
  '| 平色 | 无探针 | 加探针 |',
].join('\n')

const CARD_B = [
  '### 阶梯式解剖',
  '| 常量 | 取值 | 备注 |',
  '| :-- | :-- | :-- |',
  '| 圆周率 π | 3.1416 | 高精度 |',
  '| 重力加速度 g | 9.8 | 同值不算冲突 |',
].join('\n')

function reportOf(body: string, id?: string): LintReport {
  return lintCard({ title: id ?? 'T', definition: '短定义', body, template: '工程型' })
}

describe('insight 跨卡洞察（P2）', () => {
  test('extractFacts：表格首两列 + 公式赋值', () => {
    const facts = extractFacts('A', CARD_A)
    const keys = facts.map((f) => f.key)
    expect(keys).toContain('圆周率 π')
    expect(keys).toContain('重力加速度 g')
    expect(facts.some((f) => f.value === '3.14')).toBe(true)
    // 公式左侧符号
    expect(facts.some((f) => f.key.includes('mip'))).toBe(true)
    // 排障判据的表头列不参与（白名单）
    expect(facts.some((f) => f.key === '症状')).toBe(false)
    expect(facts.every((f) => f.line > 0 && f.section !== '')).toBe(true)
  })

  test('crossCardConflicts：同键不同值报冲突，同值不报', () => {
    const groups = crossCardConflicts([
      { label: 'A', body: CARD_A },
      { label: 'B', body: CARD_B },
    ])
    expect(groups.map((g) => g.key)).toEqual(['圆周率 π'])
    expect(groups[0].variants.map((v) => v.value).sort()).toEqual(['3.14', '3.1416'])
    expect(groups[0].cards).toBe(2)
    const text = formatConflicts(groups)
    expect(text).toContain('圆周率 π')
    expect(text).toContain('3.1416')
    expect(formatConflicts([])).toContain('未发现')
  })

  test('dateOfCardId / isoWeek 解析与归周', () => {
    expect(dateOfCardId('202609092139_92d2')).toBe('2026-09-09')
    expect(dateOfCardId('bad')).toBeNull()
    expect(dateOfCardId(null)).toBeNull()
    expect(isoWeek('2026-09-09')).toBe('2026-W37')
    expect(isoWeek('2026-01-01')).toBe('2026-W01')
    expect(isoWeek('bad')).toBeNull()
  })

  test('qualityTrend：按周聚合均分与短板', () => {
    const buckets = qualityTrend([
      { id: '202609071200_aaaa', report: reportOf(CARD_A, 'A') },
      { id: '202609081200_bbbb', report: reportOf(CARD_B, 'B') },
      { id: '202609151200_cccc', report: reportOf(CARD_A, 'C') },
    ])
    expect(buckets).toHaveLength(2)
    expect(buckets[0].week).toBe('2026-W37')
    expect(buckets[0].cards).toBe(2)
    expect(buckets[0].averageScore).toBeGreaterThan(0)
    expect(buckets[1].week).toBe('2026-W38')
    const text = formatTrend(buckets)
    expect(text).toContain('2026-W37')
    expect(text).toContain('趋势：')
    expect(formatTrend([])).toContain('质量趋势：')
  })

  test('executabilityOf / executabilitySummary：能跑 / 能查 / 只能读', () => {
    expect(executabilityOf(CARD_A)).toBe('能跑')
    expect(executabilityOf('### 排障判据\n| 症状 | 判据 | 修复 |')).toBe('能查')
    expect(executabilityOf('### 对比表\n| A | B |')).toBe('能查')
    expect(executabilityOf('### 核心思想\n只有文字。')).toBe('只能读')
    const summary = executabilitySummary([{ body: CARD_A }, { body: '### 核心思想\nx' }])
    expect(summary).toEqual([{ rating: '能跑', count: 1 }, { rating: '只能读', count: 1 }])
  })
})
