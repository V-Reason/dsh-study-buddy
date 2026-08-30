import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { apply } from '../src/index.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'study-buddy-apply-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const CARD_TOOLS = [
  'card_search', 'card_get', 'card_id', 'card_create', 'card_update', 'card_link', 'card_moc',
  'study_progress', 'study_memory',
]

interface FakeCtx {
  registered: string[]
  ctx: {
    tools?: { register(def: { name: string }): () => void }
    effect?(callback: () => () => unknown): unknown
  }
  /** 执行 apply 注册的所有 effect 回调，返回各自 disposer。 */
  runEffects(): Array<() => void>
}

function fakeCtx(register?: (def: { name: string }) => () => void): FakeCtx {
  const registered: string[] = []
  const effectCallbacks: Array<() => () => unknown> = []
  const makeRegister = register ?? ((def: { name: string }): () => void => {
    registered.push(def.name)
    return () => {
      const at = registered.indexOf(def.name)
      if (at >= 0) registered.splice(at, 1)
    }
  })
  return {
    registered,
    ctx: {
      tools: { register: makeRegister },
      effect(callback: () => () => unknown): unknown {
        effectCallbacks.push(callback)
        return () => {}
      },
    },
    runEffects: () => effectCallbacks.map(callback => callback() as () => void),
  }
}

describe('apply（fail-loud 与 vaultRoot==cwd 回归）', () => {
  test('vaultRoot 等于工作目录时注册全部 9 个工具（launcher 以 vault 为 cwd 的部署回归）', () => {
    const prev = process.cwd()
    try {
      process.chdir(dir)
      const fake = fakeCtx()
      expect(() => apply(fake.ctx, { vaultRoot: dir })).not.toThrow()
      expect(fake.registered).toHaveLength(CARD_TOOLS.length)
      expect(fake.registered).toEqual(expect.arrayContaining(CARD_TOOLS))
    } finally {
      process.chdir(prev)
    }
  })

  test('vaultRoot 为文件系统根时抛错（fail-loud，不再静默）', () => {
    const fake = fakeCtx()
    expect(() => apply(fake.ctx, { vaultRoot: resolve('/') })).toThrow(/文件系统根/)
    expect(fake.registered).toHaveLength(0)
  })

  test('vaultRoot 缺失时抛错', () => {
    const fake = fakeCtx()
    expect(() => apply(fake.ctx, undefined)).toThrow(/vaultRoot/)
    expect(fake.registered).toHaveLength(0)
  })

  test('ctx.tools 不可用时抛错（不再静默 return）', () => {
    const fake = fakeCtx()
    const broken = { ...fake.ctx, tools: undefined }
    expect(() => apply(broken, { vaultRoot: dir })).toThrow(/register/)
    expect(fake.registered).toHaveLength(0)
  })

  test('单个工具注册失败时立即抛错', () => {
    let calls = 0
    const fake = fakeCtx(() => {
      calls += 1
      if (calls === 2) throw new Error('duplicate card_search')
      return () => {}
    })
    expect(() => apply(fake.ctx, { vaultRoot: dir })).toThrow(/duplicate card_search/)
  })

  test('effect 卸载时注册的工具被移除（disposer 由 ctx.effect 持有）', () => {
    const fake = fakeCtx()
    apply(fake.ctx, { vaultRoot: dir })
    expect(fake.registered).toHaveLength(CARD_TOOLS.length)
    for (const dispose of fake.runEffects()) dispose()
    expect(fake.registered).toHaveLength(0)
  })
})

describe('apply（开场门禁接线）', () => {
  interface FullCtx {
    registered: string[]
    sections: Array<Record<string, unknown>>
    listeners: Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>
    runEffects(): Array<() => void>
    ctx: {
      tools: { register(def: { name: string }): () => void }
      effect(callback: () => () => unknown): unknown
      get(key: string): unknown
      on(event: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    }
  }

  function fullCtx(): FullCtx {
    const registered: string[] = []
    const sections: Array<Record<string, unknown>> = []
    const listeners = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
    const effectCallbacks: Array<() => () => unknown> = []
    const ctx = {
      tools: {
        register(def: { name: string }): () => void {
          registered.push(def.name)
          return () => {
            const at = registered.indexOf(def.name)
            if (at >= 0) registered.splice(at, 1)
          }
        },
      },
      effect(callback: () => () => unknown): unknown {
        effectCallbacks.push(callback)
        return () => {}
      },
      get(key: string): unknown {
        if (key !== 'systemPrompt') return undefined
        return {
          section(entry: Record<string, unknown>): () => void {
            sections.push(entry)
            return () => {
              const at = sections.indexOf(entry)
              if (at >= 0) sections.splice(at, 1)
            }
          },
        }
      },
      on(event: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void {
        listeners.set(event, listener)
        return () => {
          listeners.delete(event)
        }
      },
    }
    return {
      registered,
      sections,
      listeners,
      runEffects: () => effectCallbacks.map(callback => callback() as () => void),
      ctx,
    }
  }

  test('注册系统提示段与 pre-step 监听器，effect 卸载即摘除；注入/跳过分支正确', async () => {
    const fake = fullCtx()
    apply(fake.ctx, { vaultRoot: dir })
    expect(fake.registered).toHaveLength(CARD_TOOLS.length)

    // 系统提示段：名字与负序
    expect(fake.sections).toHaveLength(1)
    expect(fake.sections[0].name).toBe('study:memory-mandate')
    expect(Number(fake.sections[0].order)).toBeLessThan(0)
    expect(String(fake.sections[0].text)).toContain('study_memory(get)')

    // pre-step 监听器已注册
    const listener = fake.listeners.get('agent/pre-step')
    expect(listener).toBeDefined()

    const baseDecision = { kind: 'enter' as const, messages: [{ id: 'user-1', role: 'user' }] }
    const next = async () => baseDecision

    // ① 全新会话（无 user/message 事件）：注入提醒
    const entered = await listener!(
      { agent: { session: { events: [{ type: 'turn/start' }, { type: 'agent/inbox/spliced' }] } }, turn: 1, step: 1 },
      next,
    ) as { kind: 'enter'; messages: Array<{ id: string; source?: { plugin?: string } }> }
    expect(entered.messages).toHaveLength(2)
    expect(entered.messages[1].source).toEqual({ kind: 'plugin', plugin: 'dsh-study-buddy' })
    expect(entered.messages[1].id).not.toBe('user-1')

    // ② 恢复会话（已有 user/message）：原样返回
    const restored = await listener!(
      { agent: { session: { events: [{ type: 'user/message' }] } }, turn: 1, step: 1 },
      next,
    )
    expect(restored).toBe(baseDecision)

    // ③ 后续轮/步：原样返回
    expect(await listener!({ agent: { session: { events: [] } }, turn: 1, step: 2 }, next)).toBe(baseDecision)
    expect(await listener!({ agent: { session: { events: [] } }, turn: 2, step: 1 }, next)).toBe(baseDecision)

    // ④ reject 决策：原样返回（reject 也走 next，无注入）
    const rejectNext = async () => ({ kind: 'reject' as const })
    expect(await listener!({ agent: { session: { events: [] } }, turn: 1, step: 1 }, rejectNext)).toEqual({ kind: 'reject' })

    // 卸载：段与监听器一起摘除
    for (const dispose of fake.runEffects()) dispose()
    expect(fake.sections).toHaveLength(0)
    expect(fake.listeners.has('agent/pre-step')).toBe(false)
  })

  test('无 systemPrompt/on 的环境静默跳过门禁，工具照常注册（不 fail-loud）', () => {
    const fake = fakeCtx()
    expect(() => apply(fake.ctx, { vaultRoot: dir })).not.toThrow()
    expect(fake.registered).toHaveLength(CARD_TOOLS.length)
  })
})
