import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { buildToolDefs } from '../src/tools.ts'
import { apply } from '../src/index.ts'

/**
 * 宿主契约（仓库侧自测）。
 *
 * 与 `tools/verify-contract.mjs` 的分工：本文件零平台依赖、任何机器任何 CI 都能跑，
 * 管"仓库自己有没有漂"（工具面、output 契约、apply 接线形状）；脚本那侧多管一层
 * "仓库 ↔ 真实 DSH 安装"（import 真平台的 ToolRuntime / Session / SystemPrompt 断言
 * 方法仍在），但只有在装了 DSH 的机器上才有增量。
 *
 * 背景：平台与插件之间的契约变更不会以编译错误的形式暴露——`build.mjs` 把
 * `@deepseek-ai/*` 全部 external，源码又零运行时导入，所以 `pnpm run check`
 * 曾经对"output 契约变了""工具名被删了"这类事故完全无感。
 */

/** 阶段的工具面（v1.0）：一个工具一个动词，全部 `note_*` / `study_*` */
const TOOLS = [
  'note_library', 'note_expect_get', 'note_list', 'note_get', 'note_search', 'note_overview',
  'note_plan', 'note_write', 'note_update', 'note_toc', 'note_link', 'note_unlink',
  'note_rename', 'note_history', 'note_restore', 'note_lint', 'study_progress', 'study_memory',
] as const

/** 宿主 `tools.register` 认识的字段（`ToolDefinition`，多写的字段会被静默忽略） */
const DEF_FIELDS = ['name', 'description', 'parameters', 'output', 'isConcurrencySafe', 'execute']

let vault: string

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), 'study-buddy-contract-'))
})

afterAll(async () => {
  await rm(vault, { recursive: true, force: true })
})

describe('工具面契约', () => {
  const defs = buildToolDefs({} as never)

  test('工具集合与仓库约定逐字一致（退场工具会让 persona 教模型调不存在的工具）', () => {
    expect(defs.map((def) => def.name).sort()).toEqual([...TOOLS].sort())
  })

  test('每个工具只声明宿主认识的字段', () => {
    for (const def of defs) {
      expect(Object.keys(def).filter((key) => !DEF_FIELDS.includes(key)), `${def.name} 有多余字段`).toEqual([])
    }
  })

  test('output 契约：schema.type=string，render 返回 text 块', () => {
    for (const def of defs) {
      expect(def.output.schema.type, `${def.name} output.schema.type`).toBe('string')
      expect(def.output.render({}, 'x'), `${def.name} render`).toEqual([{ type: 'text', text: 'x' }])
    }
  })

  test('描述与参数表非空（schema 是提示词资产，空描述等于没有契约）', () => {
    for (const def of defs) {
      expect(String(def.description).length, `${def.name} description`).toBeGreaterThan(10)
      expect(typeof def.parameters, `${def.name} parameters`).toBe('object')
    }
  })

  test('工具定义可无损 JSON 序列化（注册表会快照参数与输出）', () => {
    expect(() => JSON.stringify(defs)).not.toThrow()
    expect(JSON.stringify(defs).length).toBeGreaterThan(1000)
  })
})

describe('apply 接线契约', () => {
  /** 最小假 ctx：只实现 apply 真的会用的四个入口 */
  function harness() {
    const registered = new Map<string, unknown>()
    const sections: Array<Record<string, unknown>> = []
    const listeners = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
    const effects: Array<() => () => unknown> = []
    return {
      registered,
      sections,
      listeners,
      effects,
      ctx: {
        tools: {
          register(def: { name: string }) {
            if (registered.has(def.name)) throw new Error(`duplicate ${def.name}`)
            registered.set(def.name, def)
            return () => registered.delete(def.name)
          },
        },
        effect(callback: () => () => unknown) {
          effects.push(callback)
          return () => {}
        },
        get(key: string) {
          if (key !== 'systemPrompt') return undefined
          return {
            section(entry: Record<string, unknown>) {
              sections.push(entry)
              return () => {}
            },
          }
        },
        on(event: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
          listeners.set(event, listener)
          return () => listeners.delete(event)
        },
      },
    }
  }

  test('注册 18 个工具，effect 卸载后零残留（生命周期可逆）', () => {
    const fake = harness()
    apply(fake.ctx as never, { vaultRoot: vault })
    expect([...fake.registered.keys()].sort()).toEqual([...TOOLS].sort())
    for (const callback of fake.effects) callback()()
    expect(fake.registered.size).toBe(0)
  })

  test('系统提示段：名字 / 负序 / 文案（开场门禁第一层）', () => {
    const fake = harness()
    apply(fake.ctx as never, { vaultRoot: vault })
    expect(fake.sections).toHaveLength(1)
    const entry = fake.sections[0]
    expect(entry.name).toBe('study:memory-mandate')
    expect(Number(entry.order)).toBeLessThan(0)
    expect(Number.isFinite(Number(entry.order))).toBe(true)
    expect(String(entry.text)).toContain('study_memory(get)')
  })

  test('预步监听：只在首轮首步且历史无 user/message 时注入', async () => {
    const fake = harness()
    apply(fake.ctx as never, { vaultRoot: vault })
    const listener = fake.listeners.get('agent/pre-step')
    expect(typeof listener).toBe('function')
    const base = { kind: 'enter', messages: [{ id: 'user-1' }] }
    const next = async () => base
    const payload = (events: unknown[], turn = 1, step = 1) => ({
      agent: { session: { snapshotEvents: () => events } }, turn, step,
    })

    const injected = await listener!(payload([{ type: 'turn/start' }]), next) as { messages: unknown[] }
    expect(injected.messages).toHaveLength(2)
    // v1.1.1 事故回归：注入消息的来源必须满足平台 v4 写盘准入
    // （`kind` 非空且 ≠ 'plugin'，且不再带退场的 `plugin` 包装字段）
    const source = (injected.messages[1] as { source: { kind?: unknown } }).source
    expect(typeof source.kind).toBe('string')
    expect(String(source.kind).length).toBeGreaterThan(0)
    expect(source.kind).not.toBe('plugin')
    expect(Object.hasOwn(source, 'plugin')).toBe(false)
    expect(await listener!(payload([{ type: 'user/message' }]), next)).toBe(base)
    expect(await listener!(payload([], 1, 2), next)).toBe(base)
    expect(await listener!(payload([], 2, 1), next)).toBe(base)
  })

  test('宿主降级：载荷无 session / snapshotEvents 抛错，都不逸出异常', async () => {
    const fake = harness()
    apply(fake.ctx as never, { vaultRoot: vault })
    const listener = fake.listeners.get('agent/pre-step')!
    const base = { kind: 'enter', messages: [] }
    const next = async () => base
    // 旧平台形状已被移除（troubleshooting.md 记的就是这一类）：缺 API 时保守注入一次
    await expect(listener({ agent: { session: {} }, turn: 1, step: 1 }, next)).resolves.toBeDefined()
    // 宿主 API 抛错必须被吞掉：从 pre-step 逸出会变成步骤级失败（最坏首步直接失败）
    await expect(listener({
      agent: { session: { snapshotEvents() { throw new Error('宿主 API 变了') } } },
      turn: 1, step: 1,
    }, next)).resolves.toBeDefined()
  })
})
