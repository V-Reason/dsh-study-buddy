import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { apply } from '../src/index.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'study-buddy-apply-'))
  // apply 会打一行"vaultRoot ← 来源"的启动日志（排障用）：测试里静音，别淹掉断言输出
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

/**
 * 工具名集合（阶段 4b 定稿）：18 个——`note_*` 16 个 + `study_*` 2 个。
 * 一个工具一个动词，工具数取需求方定稿区间（16~18）的上限。
 */
const NOTE_TOOLS = [
  'note_library', 'note_expect_get', 'note_list', 'note_get', 'note_search', 'note_overview',
  'note_plan', 'note_write', 'note_update', 'note_toc', 'note_link', 'note_unlink',
  'note_rename', 'note_history', 'note_restore', 'note_lint',
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
  test('vaultRoot 等于工作目录时注册全部 18 个工具（launcher 以 vault 为 cwd 的部署回归）', () => {
    const prev = process.cwd()
    try {
      process.chdir(dir)
      const fake = fakeCtx()
      expect(() => apply(fake.ctx, { vaultRoot: dir })).not.toThrow()
      expect(fake.registered).toHaveLength(NOTE_TOOLS.length)
      expect(fake.registered).toEqual(expect.arrayContaining(NOTE_TOOLS))
    } finally {
      process.chdir(prev)
    }
  })

  test('vaultRoot 为文件系统根时抛错（fail-loud，不再静默）', () => {
    const fake = fakeCtx()
    expect(() => apply(fake.ctx, { vaultRoot: resolve('/') })).toThrow(/文件系统根/)
    expect(fake.registered).toHaveLength(0)
  })

  test('三种来源都没有 vaultRoot 时抛错，且错误里给出三种给法', () => {
    const fake = fakeCtx()
    // 空 DSH_HOME（没有 study-buddy.json）+ 清掉两个环境变量 ⇒ 只剩"缺配置"这一条路
    vi.stubEnv('DSH_HOME', dir)
    vi.stubEnv('DSH_STUDY_VAULT', '')
    vi.stubEnv('DSH_VAULT_ROOT', '')
    expect(() => apply(fake.ctx, undefined)).toThrow(/vault 根目录/)
    expect(() => apply(fake.ctx, undefined)).toThrow(/DSH_STUDY_VAULT/)
    expect(fake.registered).toHaveLength(0)
  })

  /**
   * 包内零绝对路径的部署形态：机器相关路径由环境变量 / 用户级 JSON 给，
   * 预设声明里只有机器无关的默认值（DSH 0.1.7 起声明随包发布，不能带作者本机路径）。
   */
  test('环境变量 DSH_STUDY_VAULT 顶替行 config，apply 照常注册 18 个工具', () => {
    const fake = fakeCtx()
    vi.stubEnv('DSH_STUDY_VAULT', dir)
    expect(() => apply(fake.ctx, undefined)).not.toThrow()
    expect(fake.registered).toHaveLength(NOTE_TOOLS.length)
    expect(fake.registered).toEqual(expect.arrayContaining(NOTE_TOOLS))
  })

  test('行 config 的 vaultRoot 覆盖环境变量（部署侧仍可精细指定）', () => {
    const other = mkdtempSync(join(tmpdir(), 'study-buddy-other-'))
    try {
      const fake = fakeCtx()
      vi.stubEnv('DSH_STUDY_VAULT', other)
      apply(fake.ctx, { vaultRoot: dir })
      expect(fake.registered).toHaveLength(NOTE_TOOLS.length)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
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
      if (calls === 2) throw new Error('duplicate note_search')
      return () => {}
    })
    expect(() => apply(fake.ctx, { vaultRoot: dir })).toThrow(/duplicate note_search/)
  })

  // N9：rulesOff 写错规则 id（或按旧版本配置写已删除的 id）必须 fail-loud，不能"以为关了其实没关"
  test('N9：lint.rulesOff 含未知规则 id 时抛错，并列出可用 id', () => {
    const fake = fakeCtx()
    expect(() => apply(fake.ctx, { vaultRoot: dir, lint: { rulesOff: ['nope-rule', 'typo-rule'] } }))
      .toThrow(/未识别的规则 id：nope-rule、typo-rule/)
    expect(fake.registered).toHaveLength(0)
    // 合法 id 正常挂载
    const ok = fakeCtx()
    expect(() => apply(ok.ctx, { vaultRoot: dir, lint: { rulesOff: ['session-residue'] } })).not.toThrow()
    expect(ok.registered).toHaveLength(NOTE_TOOLS.length)
  })

  // N6：maxWalkFiles 必须是正整数，否则回落默认值（配置写错不该让插件整体失败）
  test('N6：maxWalkFiles 非法值回落默认，合法值正常挂载', () => {
    const bad = fakeCtx()
    expect(() => apply(bad.ctx, { vaultRoot: dir, maxWalkFiles: -1 })).not.toThrow()
    const ok = fakeCtx()
    expect(() => apply(ok.ctx, { vaultRoot: dir, maxWalkFiles: 50 })).not.toThrow()
  })

  test('effect 卸载时注册的工具被移除（disposer 由 ctx.effect 持有）', () => {
    const fake = fakeCtx()
    apply(fake.ctx, { vaultRoot: dir })
    expect(fake.registered).toHaveLength(NOTE_TOOLS.length)
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
    expect(fake.registered).toHaveLength(NOTE_TOOLS.length)

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

    // ① 全新会话（无 user/message 事件）：注入提醒（新平台 snapshotEvents 形状）
    const entered = await listener!(
      { agent: { session: { snapshotEvents: () => [{ type: 'turn/start' }, { type: 'agent/inbox/spliced' }] } }, turn: 1, step: 1 },
      next,
    ) as { kind: 'enter'; messages: Array<{ id: string; source?: { plugin?: string } }> }
    expect(entered.messages).toHaveLength(2)
    expect(entered.messages[1].source).toEqual({ kind: 'plugin', plugin: 'dsh-study-buddy' })
    expect(entered.messages[1].id).not.toBe('user-1')

    // ①b 全新会话（旧平台 events 数组形状，向后兼容）
    const enteredLegacy = await listener!(
      { agent: { session: { events: [{ type: 'turn/start' }] } }, turn: 1, step: 1 },
      next,
    ) as { kind: 'enter'; messages: Array<{ id: string; source?: { plugin?: string } }> }
    expect(enteredLegacy.messages).toHaveLength(2)
    expect(enteredLegacy.messages[1].source).toEqual({ kind: 'plugin', plugin: 'dsh-study-buddy' })

    // ② 恢复会话（已有 user/message，新平台形状）：原样返回
    const restored = await listener!(
      { agent: { session: { snapshotEvents: () => [{ type: 'user/message' }] } }, turn: 1, step: 1 },
      next,
    )
    expect(restored).toBe(baseDecision)

    // ②b 恢复会话（旧平台 events 形状）：原样返回
    expect(await listener!(
      { agent: { session: { events: [{ type: 'user/message' }] } }, turn: 1, step: 1 },
      next,
    )).toBe(baseDecision)

    // ③ 后续轮/步：原样返回
    expect(await listener!({ agent: { session: { snapshotEvents: () => [] } }, turn: 1, step: 2 }, next)).toBe(baseDecision)
    expect(await listener!({ agent: { session: { snapshotEvents: () => [] } }, turn: 2, step: 1 }, next)).toBe(baseDecision)

    // ④ reject 决策：原样返回（reject 也走 next，无注入）
    const rejectNext = async () => ({ kind: 'reject' as const })
    expect(await listener!({ agent: { session: { snapshotEvents: () => [] } }, turn: 1, step: 1 }, rejectNext)).toEqual({ kind: 'reject' })

    // 卸载：段与监听器一起摘除
    for (const dispose of fake.runEffects()) dispose()
    expect(fake.sections).toHaveLength(0)
    expect(fake.listeners.has('agent/pre-step')).toBe(false)
  })

  test('无 systemPrompt/on 的环境静默跳过门禁，工具照常注册（不 fail-loud）', () => {
    const fake = fakeCtx()
    expect(() => apply(fake.ctx, { vaultRoot: dir })).not.toThrow()
    expect(fake.registered).toHaveLength(NOTE_TOOLS.length)
  })
})

/**
 * 配置键漂移告警：预设行里留着已退场键（v1.0 删了 `mocDir` / `templateHints`）
 * 或拼错键时，插件照常挂载——但必须在启动日志里点名，否则"以为配了其实没配"
 * 会一直静默。本轮 DSH 升级排查就是被部署副本的 `mocDir` 咬到的。
 */
describe('apply（配置键漂移告警，fail-quiet 而不 fail-loud）', () => {
  /** 拦截 console.error 并只保留本插件前缀的行（apply 内部还打印别的） */
  function errorSpy(): string[] {
    const seen: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      seen.push(args.map(String).join(' '))
    })
    return seen
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('含已退场键时：工具照常注册 18 个，并点名该键', () => {
    const seen = errorSpy()
    const fake = fakeCtx()
    expect(() => apply(fake.ctx, { vaultRoot: dir, mocDir: '目录' } as never)).not.toThrow()
    expect(fake.registered).toHaveLength(NOTE_TOOLS.length)
    const warned = seen.filter((line) => line.includes('不认识的键'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('mocDir')
  })

  test('多个未知键按出现顺序一次列全', () => {
    const seen = errorSpy()
    const fake = fakeCtx()
    apply(fake.ctx, { vaultRoot: dir, mocDir: '目录', templateHints: {} } as never)
    const warned = seen.filter((line) => line.includes('不认识的键'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('mocDir、templateHints')
  })

  test('全部是合法键时不告警（含仓库预设用到的每一个键）', () => {
    const seen = errorSpy()
    const fake = fakeCtx()
    apply(fake.ctx, {
      vaultRoot: dir,
      expectFile: '笔记期望.md',
      planTtlHours: 24,
      stateDir: '.study',
      fallbackDir: '未分类',
      domainFolders: { 算法: '计算机/编程/数据结构与算法' },
      skipDirs: ['资源'],
      searchRoots: [],
      includeSessionCwd: true,
      linkIntoNotes: false,
      lint: { rulesOff: ['session-residue'] },
      indexTtlMs: 2000,
      maxWalkFiles: 20000,
    })
    expect(fake.registered).toHaveLength(NOTE_TOOLS.length)
    expect(seen.filter((line) => line.includes('不认识的键'))).toHaveLength(0)
  })
})
