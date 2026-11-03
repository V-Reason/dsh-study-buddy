import { describe, expect, test } from 'vitest'
import {
  normalizeStudyMode,
  parseModeWindowDays,
  resolveStudyMode,
  type StudyModeOverride,
} from '../src/studyMode.ts'

const NOW = new Date('2026-11-03T00:00:00.000Z')

describe('study mode policy', () => {
  test.each([
    [{ hasRelatedNote: false }, 'full', 'no-note'],
    [{ hasRelatedNote: true }, 'full', 'no-contact'],
    [{ hasRelatedNote: true, lastContactAt: '2026-10-04T00:00:00.000Z' }, 'quick', 'recent'],
    [{ hasRelatedNote: true, lastContactAt: '2026-10-03T00:00:00.000Z' }, 'full', 'stale'],
    [{ hasRelatedNote: false, override: 'quick' as const }, 'quick', 'override'],
  ] as const)('按证据和边界选择模式 %#', (input, mode, reason) => {
    expect(resolveStudyMode({ ...input, now: NOW })).toMatchObject({ mode, reason })
  })

  test('无效接触时间保守进入详细模式', () => {
    expect(resolveStudyMode({
      hasRelatedNote: true,
      lastContactAt: 'not-a-date',
      now: NOW,
    })).toMatchObject({ mode: 'full', reason: 'no-contact', ageDays: null })
  })

  test('详细模式覆盖优先于任何证据', () => {
    expect(resolveStudyMode({
      hasRelatedNote: true,
      lastContactAt: '2026-11-02T00:00:00.000Z',
      override: 'full',
      now: NOW,
    })).toEqual({ mode: 'full', reason: 'override', ageDays: 1 })
  })

  test('未来接触时间按刚学习过处理', () => {
    expect(resolveStudyMode({
      hasRelatedNote: true,
      lastContactAt: '2026-11-04T00:00:00.000Z',
      now: NOW,
    })).toEqual({ mode: 'quick', reason: 'recent', ageDays: 0 })
  })

  test.each([
    ['auto', 'auto'],
    ['quick', 'quick'],
    ['full', 'full'],
    ['QUICK', 'quick'],
    [undefined, 'auto'],
  ] as const)('归一化模式覆盖 %s', (input, expected) => {
    expect(normalizeStudyMode(input)).toBe(expected)
  })

  test.each([
    ['- [设置] 快节奏复习窗口：14 天', 14],
    ['- [设置] 快节奏复习窗口: 90 天', 90],
    ['没有设置项', 30],
    ['- [设置] 快节奏复习窗口：0 天', 30],
    ['- [设置] 快节奏复习窗口：4000 天', 30],
  ])('解析复习窗口：%s', (text, expected) => {
    expect(parseModeWindowDays(text)).toBe(expected)
  })

  test('自定义窗口参与模式判断', () => {
    expect(resolveStudyMode({
      hasRelatedNote: true,
      lastContactAt: '2026-10-19T00:00:00.000Z',
      windowDays: 14,
      now: NOW,
    })).toMatchObject({ mode: 'full', reason: 'stale' })
  })

  test.each([
    [{ hasRelatedNote: false, intent: 'direct', scope: 'single' }, 'quick', 'direct'],
    [{ hasRelatedNote: true, lastContactAt: '2026-11-02T00:00:00.000Z', intent: 'learn' }, 'full', 'intent'],
    [{ hasRelatedNote: true, lastContactAt: '2026-11-02T00:00:00.000Z', intent: 'compare', scope: 'system' }, 'full', 'intent'],
    [{ hasRelatedNote: true, lastContactAt: '2026-11-02T00:00:00.000Z', intent: 'refresh' }, 'quick', 'recent'],
    [{ hasRelatedNote: true, intent: 'refresh' }, 'full', 'no-contact'],
  ] as const)('意图驱动模式 %#', (input, mode, reason) => {
    expect(resolveStudyMode({ ...input, now: NOW })).toMatchObject({ mode, reason })
  })

  test('归一化覆盖类型保持稳定', () => {
    const value: StudyModeOverride = normalizeStudyMode('full')
    expect(value).toBe('full')
  })
})
