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
