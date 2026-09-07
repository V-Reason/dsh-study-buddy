import { describe, expect, test } from 'vitest'
import {
  MANDATE, OPENER_SECTION_NAME, OPENER_SECTION_ORDER, REMINDER,
  applyOpenerDecision, buildOpenerReminder, hasPriorUserMessage, shouldInjectOpener,
} from '../src/opener.ts'

describe('opener 开场门禁纯逻辑', () => {
  test('shouldInjectOpener：仅首轮首步且无历史 user/message', () => {
    expect(shouldInjectOpener(1, 1, false)).toBe(true)
    expect(shouldInjectOpener(1, 2, false)).toBe(false)
    expect(shouldInjectOpener(2, 1, false)).toBe(false)
    expect(shouldInjectOpener(1, 1, true)).toBe(false)
  })

  test('hasPriorUserMessage：旧平台 session.events 数组（≤2026-08-27 兼容）', () => {
    expect(hasPriorUserMessage({})).toBe(false)
    expect(hasPriorUserMessage({ agent: { session: { events: [{ type: 'turn/start' }, { type: 'agent/inbox/spliced' }] } } })).toBe(false)
    expect(hasPriorUserMessage({ agent: { session: { events: [{ type: 'user/message' }] } } })).toBe(true)
    expect(hasPriorUserMessage({ agent: { session: { events: [] } } })).toBe(false)
    expect(hasPriorUserMessage({ agent: { session: undefined } })).toBe(false)
  })

  test('hasPriorUserMessage：新平台 session.snapshotEvents() 方法（≥0.1.3-alpha.1）', () => {
    expect(hasPriorUserMessage({ agent: { session: { snapshotEvents: () => [{ type: 'turn/start' }] } } })).toBe(false)
    expect(hasPriorUserMessage({ agent: { session: { snapshotEvents: () => [{ type: 'user/message' }, { type: 'turn/start' }] } } })).toBe(true)
    expect(hasPriorUserMessage({ agent: { session: { snapshotEvents: () => [] } } })).toBe(false)
    // 双形状同时存在：数组优先（与旧平台行为一致）
    expect(hasPriorUserMessage({
      agent: {
        session: {
          events: [{ type: 'user/message' }],
          snapshotEvents: () => [],
        },
      },
    })).toBe(true)
  })

  test('hasPriorUserMessage：两形状皆缺/方法不可用 → 保守 false（只多注入提醒）', () => {
    expect(hasPriorUserMessage({ agent: { session: {} } })).toBe(false)
    expect(hasPriorUserMessage({ agent: { session: { snapshotEvents: 'not-a-function' as unknown as () => Array<{ type?: string }> } } })).toBe(false)
    expect(hasPriorUserMessage({ agent: {} })).toBe(false)
  })

  test('buildOpenerReminder：形状与 dsh-llm createUserMessage 运行时一致', () => {
    const a = buildOpenerReminder('id-1')
    expect(a.id).toBe('id-1')
    expect(a.role).toBe('user')
    expect(a.content).toEqual([{ type: 'text', text: REMINDER }])
    expect(a.source).toEqual({ kind: 'plugin', plugin: 'dsh-study-buddy' })
  })

  test('buildOpenerReminder：默认 id 唯一且非空', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i += 1) {
      const id = buildOpenerReminder().id
      expect(id.length).toBeGreaterThan(0)
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  })

  test('applyOpenerDecision：enter 追加提醒且不改原对象，reject 原样返回', () => {
    const base: { kind: 'enter'; messages: Array<{ id: string }> } = { kind: 'enter', messages: [{ id: 'user-1' }] }
    const entered = applyOpenerDecision(base, { id: 'reminder-1' })
    expect(entered.messages).toHaveLength(2)
    expect(entered.messages[1]).toEqual({ id: 'reminder-1' })
    expect(base.messages).toHaveLength(1)

    const rejected = { kind: 'reject' as const }
    expect(applyOpenerDecision(rejected, { id: 'x' })).toBe(rejected)
  })

  test('常量一致性：段名/负序/文案都点名两个读取工具', () => {
    expect(OPENER_SECTION_NAME).toBe('study:memory-mandate')
    expect(OPENER_SECTION_ORDER).toBeLessThan(0)
    expect(MANDATE).toContain('study_memory(get)')
    expect(MANDATE).toContain('study_progress(get)')
    expect(REMINDER).toContain('study_memory(get)')
    expect(REMINDER).toContain('study_progress(get)')
  })
})
