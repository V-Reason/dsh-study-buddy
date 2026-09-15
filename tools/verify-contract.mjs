#!/usr/bin/env node
/**
 * 契约校验：本插件与「本机 DSH」之间的平台契约断言。
 *
 * 为什么需要它（见 troubleshooting.md §六）：平台与插件之间的契约变更**不会以
 * 编译错误的形式暴露**——2026-09-15 的 DSH 更新就把 Typert strict codec 的
 * `schema` 换成了 `create()`，另一个插件整行未激活，而本仓库的 `pnpm run check`
 * （typecheck + vitest）永远绿：源码零 `@deepseek-ai/*` 运行时导入，也没有任何
 * 断言真的去碰宿主。
 *
 * 本脚本把「插件实际用到的 4 个宿主契约点」（见下方 CONTRACTS）变成可执行断言，
 * 外加一层"平台符号探针"：能定位到 DSH 安装就直接 import 平台包，断言被用到的
 * 方法仍在；定位不到就**跳过**（CI 在 ubuntu 上没有 DSH，不能因此变红）。
 *
 * 只读：不写仓库、不写 vault、不在 profile 里装任何东西。
 * 用法：
 *   node tools/verify-contract.mjs
 *   node tools/verify-contract.mjs --self-test   # 额外跑负向对照（改坏一个断言必须报错）
 *   node tools/verify-contract.mjs --verbose
 * @module tools/verify-contract
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const VERBOSE = process.argv.includes('--verbose')
const SELF_TEST = process.argv.includes('--self-test')
/** 仓库根（Windows 盘符路径也正确：用 fileURLToPath 而不是手撕 pathname） */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LIB = join(ROOT, 'lib', 'index.js')

/**
 * 插件依赖的宿主契约点：每条都是"平台文件:行号 + 期望形状 + 变了会怎样"。
 * 行号来自 T:\deepseek-harness 工作树 HEAD（`dsh-v0.1.6-alpha.1` + 5 提交）。
 * 行号漂移不影响判定（断言按形状，不按行号），它是给你去平台源码核对用的。
 */
const CONTRACTS = {
  toolsRegister: {
    ref: 'packages/core/tools/src/index.ts:1043',
    what: 'ctx.tools.register(def) → disposer；def 必须有 output { schema, render }',
    breaks: 'apply() 里注册工具时同步抛错 → 整行未激活（18 个工具全没）',
  },
  sessionSnapshotEvents: {
    ref: 'packages/core/session/src/index.ts:646',
    what: 'session.snapshotEvents() → readonly SessionEvent[]',
    breaks: '开场门禁的"是否恢复会话"判定退化为 false（只多注入一次提醒，不阻断）',
  },
  preStep: {
    ref: 'packages/core/agent/src/runtime-types.ts:320',
    what: "ctx.on('agent/pre-step', (payload, next))，payload = { agent, messages, turn, step, signal }",
    breaks: '预步提醒不再注入（系统提示段仍在，门禁降级为单层）',
  },
  sessionHeaderCwd: {
    ref: 'packages/core/agent/src/runtime-types.ts:168',
    what: 'payload.agent.session.header.cwd → string | undefined',
    breaks: 'includeSessionCwd 失效：会话工作目录的旧笔记不进检索',
  },
  systemPromptSection: {
    ref: 'packages/core/system-prompt/src/index.ts:455',
    what: 'ctx.get("systemPrompt").section({ name, order, text }) → disposer（order 必须是有限数）',
    breaks: '系统提示段注册失败 → 开场门禁第一层消失',
  },
}

/** 判定预算 */
let passed = 0
const failures = []

function ok(label, detail) {
  passed += 1
  if (VERBOSE) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}

function bad(contract, message) {
  const info = CONTRACTS[contract]
  failures.push({ contract, message, info })
}

/**
 * 断言形状：回调**抛错**才算失败，返回 `{ note }` 表示通过（note 只用于回显）。
 *
 * 刻意不用「返回字符串=通过」那种宽松约定：契约校验的回调里常见分支是
 * "读到不对的东西 → return 一段中文诊断"，一旦把字符串当通过，**诊断本身会
 * 被算成绿灯**（本脚本的负向对照真的抓出过这个洞，别改回去）。
 */
async function check(label, contract, fn) {
  try {
    const result = await fn()
    if (result?.ok === false) bad(contract, `${label}：${result.message}`)
    else ok(label, result?.note)
  } catch (error) {
    bad(contract, `${label}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 假 ctx：只实现插件真的会用的四个入口，记录每次副作用以便断言可逆性 */
function fakeContext() {
  const registered = new Map()
  const sections = []
  const listeners = new Map()
  const effects = []
  return {
    registered,
    sections,
    listeners,
    effects,
    ctx: {
      tools: {
        register(def) {
          if (registered.has(def.name)) throw new Error(`duplicate tool ${def.name}`)
          registered.set(def.name, def)
          return () => registered.delete(def.name)
        },
      },
      effect(callback) {
        effects.push(callback)
        return () => {}
      },
      get(key) {
        if (key !== 'systemPrompt') return undefined
        return {
          section(entry) {
            sections.push(entry)
            return () => {
              const at = sections.indexOf(entry)
              if (at >= 0) sections.splice(at, 1)
            }
          },
        }
      },
      on(event, listener) {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
    },
  }
}

/** 解析本机 DSH：优先 $DSH_HOME，退到 ~/.dsh；profile 目录按实际存在的挑 */
function locatePlatformModules() {
  const homes = [process.env.DSH_HOME, process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh') : undefined,
    process.env.HOME ? join(process.env.HOME, '.dsh') : undefined].filter(Boolean)
  for (const home of homes) {
    const profiles = join(home, 'profiles')
    if (!existsSync(profiles)) continue
    // profile 自己的 node_modules 优先（平台包按 profile 装），再退到共享布局
    const candidates = [...['web', 'tui', 'headless'].map((name) => join(profiles, name, 'node_modules')), join(profiles, 'node_modules')]
    for (const dir of candidates) {
      if (existsSync(join(dir, '@deepseek-ai'))) return dir
    }
  }
  return undefined
}

/**
 * 按 profile 的 node_modules 解析平台包的 ESM 入口。
 *
 * `import('@deepseek-ai/dsh-tools')` 在本脚本里解析不到（脚本位于插件仓库，
 * 不在 profile 的解析链上），所以用 createRequire 从 profile 目录里解析
 * package.json，再按 `exports['.']` 取入口文件——就是在跑 DSH 本体时用的那份。
 */
async function tryImport(specifier, base) {
  const manifestPath = join(base, specifier, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    const require = createRequire(join(base, 'noop.cjs'))
    const manifest = require(manifestPath)
    const dot = manifest.exports?.['.'] ?? manifest.exports
    const entry = typeof dot === 'string'
      ? dot
      : dot?.import?.default ?? dot?.import ?? dot?.default ?? manifest.module ?? manifest.main
    if (typeof entry !== 'string') return undefined
    return await import(pathToFileURL(join(base, specifier, entry)).href)
  } catch {
    return undefined
  }
}

async function probePlatform(log) {
  const base = locatePlatformModules()
  if (base === undefined) {
    log('⏭ 平台符号探针：未找到 DSH 安装（$DSH_HOME/profiles/*/node_modules）——本机跑不到这层，跳过')
    return
  }
  log(`平台符号探针（${base}）`)
  const modules = {}
  for (const specifier of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-system-prompt']) {
    modules[specifier] = await tryImport(specifier, base)
    if (modules[specifier] === undefined) log(`  ⏭ ${specifier} 未安装，跳过其断言`)
  }

  const tools = modules['@deepseek-ai/dsh-tools']
  if (tools !== undefined) {
    await check('工具运行时导出且 register 仍是方法', 'toolsRegister', () => {
      const runtime = tools.ToolRuntime ?? tools.default
      if (typeof runtime !== 'function') return { ok: false, message: `未导出 ToolRuntime（导出：${Object.keys(tools).join(',')}）` }
      if (typeof runtime.prototype?.register !== 'function') return { ok: false, message: 'ToolRuntime.prototype.register 不是函数' }
      return { note: `ToolRuntime.prototype.register ✓（${CONTRACTS.toolsRegister.ref}）` }
    })
  }

  const session = modules['@deepseek-ai/dsh-session']
  if (session !== undefined) {
    await check('Session.snapshotEvents 仍在', 'sessionSnapshotEvents', () => {
      const ctor = session.Session ?? session.default
      if (typeof ctor?.prototype?.snapshotEvents !== 'function') {
        return { ok: false, message: 'Session.prototype.snapshotEvents 不存在（开场门禁降级，需改读平台新 API）' }
      }
      return { note: `Session.prototype.snapshotEvents ✓（${CONTRACTS.sessionSnapshotEvents.ref}）` }
    })
    await check('Session 实例可读 header.cwd', 'sessionHeaderCwd', () => {
      // header 是构造期必填字段：用最小合法 header 真造一个 Session，
      // 验证 `payload.agent.session.header.cwd` 这条读取路径没变形状。
      const ctor = session.Session ?? session.default
      const sessionId = session.SessionId?.('contract-probe') ?? 'contract-probe'
      const instance = ctor.create(sessionId, [], {
        version: session.SESSION_FORMAT_VERSION,
        id: sessionId,
        createdAt: Date.now(),
        isSeeded: false,
        cwd: 'T:\\probe',
      })
      const cwd = instance?.header?.cwd
      if (cwd !== 'T:\\probe') return { ok: false, message: `session.header.cwd 读到 ${JSON.stringify(cwd)}` }
      return { note: `session.header.cwd ✓（${CONTRACTS.sessionHeaderCwd.ref}）` }
    })
  }

  const prompt = modules['@deepseek-ai/dsh-system-prompt']
  if (prompt !== undefined) {
    await check('SystemPrompt.section 仍是方法', 'systemPromptSection', () => {
      const ctor = prompt.SystemPrompt ?? prompt.default
      if (typeof ctor?.prototype?.section !== 'function') {
        return { ok: false, message: 'SystemPrompt.prototype.section 不是函数' }
      }
      return { note: `SystemPrompt.prototype.section ✓（${CONTRACTS.systemPromptSection.ref}）` }
    })
  }
}

/** 载入 lib/index.js 并跑全部断言；被 --self-test 复用（可注入损坏的产物） */
export async function runChecks(log, load = async () => import(pathToFileURL(LIB).href)) {
  const mod = await load()

  log(`产物出口（${LIB}）`)
  await check('apply 是函数、inject 声明 tools', 'toolsRegister', () => {
    if (typeof mod.apply !== 'function') return { ok: false, message: 'lib/index.js 没有导出 apply' }
    if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) {
      return { ok: false, message: `inject 声明异常：${JSON.stringify(mod.inject)}` }
    }
    return { note: `inject=${JSON.stringify(mod.inject)}` }
  })

  const tempVault = await mkdtemp(join(tmpdir(), 'study-buddy-contract-'))
  try {
    const expected = [
      'note_library', 'note_expect_get', 'note_list', 'note_get', 'note_search', 'note_overview',
      'note_plan', 'note_write', 'note_update', 'note_toc', 'note_link', 'note_unlink',
      'note_rename', 'note_history', 'note_restore', 'note_lint', 'study_progress', 'study_memory',
    ]

    log('工具面（18 个 note_* / study_*）')
    await check('工具数量与名字与仓库约定一致', 'toolsRegister', () => {
      const defs = mod.buildToolDefs({})
      const names = defs.map((def) => def.name)
      const missing = expected.filter((name) => !names.includes(name))
      const extra = names.filter((name) => !expected.includes(name))
      if (missing.length > 0 || extra.length > 0) {
        return {
          ok: false,
          message: `缺失 ${missing.join('、') || '无'}；多出 ${extra.join('、') || '无'}`
            + '（退场工具会让 persona 教模型调不存在的工具）',
        }
      }
      return { note: `${names.length} 个` }
    })

    await check('每个工具只声明宿主认识的字段', 'toolsRegister', () => {
      const allowed = new Set(['name', 'description', 'parameters', 'output', 'isConcurrencySafe', 'execute'])
      const offenders = []
      for (const def of mod.buildToolDefs({})) {
        const unknown = Object.keys(def).filter((key) => !allowed.has(key))
        if (unknown.length > 0) offenders.push(`${def.name}: ${unknown.join('、')}`)
      }
      if (offenders.length > 0) return { ok: false, message: `多余字段：${offenders.join('；')}` }
      return { note: '无多余字段' }
    })

    await check('output 契约（schema.type=string + render→text 块）', 'toolsRegister', () => {
      for (const def of mod.buildToolDefs({})) {
        const { schema, render } = def.output ?? {}
        if (schema?.type !== 'string') return { ok: false, message: `${def.name}: output.schema.type=${JSON.stringify(schema?.type)}（应 'string'）` }
        if (typeof render !== 'function') return { ok: false, message: `${def.name}: output.render 不是函数` }
        const rendered = render({}, 'x')
        if (!Array.isArray(rendered) || rendered[0]?.type !== 'text' || rendered[0]?.text !== 'x') {
          return { ok: false, message: `${def.name}: render 返回 ${JSON.stringify(rendered)}（应 [{type:'text',text}]）` }
        }
      }
      return { note: '18 个工具全部符合' }
    })

    await check('工具定义可无损 JSON 序列化（注册表会快照参数与输出）', 'toolsRegister', () => {
      for (const def of mod.buildToolDefs({})) {
        if (JSON.stringify(def) === undefined) return { ok: false, message: `${def.name} 无法 JSON 序列化` }
      }
      return { note: 'ok' }
    })

    log('宿主接线（apply → 注册 / 系统提示段 / 预步监听）')
    await check('apply 注册 18 个工具且 effect 卸载后全部注销', 'toolsRegister', () => {
      const fake = fakeContext()
      mod.apply(fake.ctx, { vaultRoot: tempVault })
      if (fake.registered.size !== expected.length) {
        return { ok: false, message: `注册了 ${fake.registered.size} 个（应 ${expected.length}）` }
      }
      for (const callback of fake.effects) callback()()
      if (fake.registered.size !== 0) return { ok: false, message: 'effect 执行后仍有残留注册（生命周期不可逆）' }
      return { note: '注册 18 / 注销 18' }
    })

    await check('系统提示段条目形状（name/order 有限数/text）', 'systemPromptSection', () => {
      const fake = fakeContext()
      mod.apply(fake.ctx, { vaultRoot: tempVault })
      if (fake.sections.length !== 1) return { ok: false, message: `注册了 ${fake.sections.length} 个提示段（应 1）` }
      const entry = fake.sections[0]
      if (typeof entry.name !== 'string' || !Number.isFinite(Number(entry.order)) || typeof entry.text !== 'string') {
        return { ok: false, message: `条目形状异常：${JSON.stringify({ name: entry.name, order: entry.order })}` }
      }
      return { note: `${entry.name} order=${entry.order}` }
    })

    await check('agent/pre-step：注入 / 恢复会话 / reject / 非首步 四条分支', 'preStep', async () => {
      const fake = fakeContext()
      mod.apply(fake.ctx, { vaultRoot: tempVault })
      const listener = fake.listeners.get('agent/pre-step')
      if (typeof listener !== 'function') return { ok: false, message: '未注册 agent/pre-step 监听器' }
      const base = { kind: 'enter', messages: [{ id: 'user-1', role: 'user' }] }
      const next = async () => base
      const payload = (events, turn = 1, step = 1) => ({ agent: { session: { snapshotEvents: () => events } }, turn, step })

      const injected = await listener(payload([{ type: 'turn/start' }]), next)
      if (injected.messages?.length !== 2) return { ok: false, message: '全新会话未注入提醒（应 2 条消息）' }
      const restored = await listener(payload([{ type: 'user/message' }]), next)
      if (restored !== base) return { ok: false, message: '已有 user/message 的会话被重复注入' }
      const laterStep = await listener(payload([], 1, 2), next)
      if (laterStep !== base) return { ok: false, message: '非首步被注入' }
      const rejected = await listener(payload([]), async () => ({ kind: 'reject' }))
      if (rejected.kind !== 'reject') return { ok: false, message: 'reject 决策被改写' }
      return { note: '4/4 分支正确' }
    })

    await check('旧平台形状（session.events 数组）已消失时只多注入一次，不抛错', 'sessionSnapshotEvents', async () => {
      const fake = fakeContext()
      mod.apply(fake.ctx, { vaultRoot: tempVault })
      const listener = fake.listeners.get('agent/pre-step')
      const base = { kind: 'enter', messages: [] }
      const bare = await listener({ agent: { session: {} }, turn: 1, step: 1 }, async () => base)
      if (bare === undefined) return { ok: false, message: '载荷缺 snapshotEvents 时返回了 undefined（应原样透传）' }
      const throwing = await listener({
        agent: { session: { snapshotEvents() { throw new Error('宿主 API 变了') } } },
        turn: 1, step: 1,
      }, async () => base)
      if (throwing === undefined) return { ok: false, message: 'snapshotEvents 抛错时逸出了异常（会变成步骤级失败）' }
      return { note: '两条降级路径都安全' }
    })
  } finally {
    await rm(tempVault, { recursive: true, force: true })
  }
}

/** 负向对照（troubleshooting.md §六）：断言必须真的会失败 */
async function selfTest() {
  const log = VERBOSE ? console.log : () => {}
  log('负向对照（把断言改坏，必须报错）')
  const real = await import(pathToFileURL(LIB).href)
  const cases = [
    {
      name: '删掉一个工具 → 工具面断言报错',
      mutate: (mod) => ({ ...mod, buildToolDefs: () => mod.buildToolDefs({}).slice(1) }),
    },
    {
      name: '把 output.schema.type 改成 object → output 断言报错',
      mutate: (mod) => ({
        ...mod,
        buildToolDefs: (store) => mod.buildToolDefs(store).map((def, index) => (
          index === 0 ? { ...def, output: { ...def.output, schema: { type: 'object' } } } : def
        )),
      }),
    },
    {
      name: 'apply 不注册工具 → 接线断言报错',
      mutate: (mod) => ({ ...mod, apply: () => {} }),
    },
    {
      name: 'apply 抛错 → 接线断言报错（整行未激活形态）',
      mutate: (mod) => ({ ...mod, apply: () => { throw new Error('strict codec has no create() factory') } }),
    },
  ]

  let caught = 0
  for (const item of cases) {
    // 每次都从零开始：把负向对照的断言结果收进临时数组，判断"有没有真的报错"
    const collected = []
    const sink = (line) => collected.push(line)
    const before = failures.length
    try {
      await runChecks(sink, async () => item.mutate(real))
    } catch {
      // 断言之外的意外异常也算"被抓住"
    }
    const added = failures.length - before
    failures.length = before // 负向对照的失败不计入正式退出码
    if (added > 0) {
      caught += 1
      if (VERBOSE) console.log(`  ✓ ${item.name}（${added} 条断言报错）`)
    } else {
      failures.push({
        contract: 'toolsRegister',
        message: `负向对照未报错：${item.name}——校验脚本已失去意义（两边一起改错也不会被发现）`,
      })
    }
  }
  return caught === cases.length
}

async function main() {
  const log = console.log
  log('dsh-study-buddy 契约校验（只读）\n')
  log('── 契约断言 ──')
  await runChecks(log)
  await probePlatform(log)
  /** 正式断言数（负向对照会重置 passed，最后要报的是这一轮的） */
  const contractPassed = passed

  let selfTestOk = false
  if (SELF_TEST) {
    log('── 负向对照（把断言改坏，必须报错）──')
    selfTestOk = await selfTest()
  }

  log('')
  if (failures.length === 0) {
    log(`✓ 全部通过（${contractPassed} 条契约断言${SELF_TEST && selfTestOk ? ' + 负向对照全部命中' : ''}）`)
    return 0
  }
  for (const failure of failures) {
    console.error(`✗ [${failure.contract}] ${failure.message}`)
    if (failure.info) {
      console.error(`    契约点：${failure.info.ref} — ${failure.info.what}`)
      console.error(`    失效后果：${failure.info.breaks}`)
    }
  }
  console.error(`\n✗ ${failures.length} 条断言失败（通过 ${contractPassed} 条）`)
  console.error('  下一步：对照上面的「契约点」去 DSH 工作树 HEAD 读现行定义，'
    + '或直接跑 node tools/verify-contract.mjs --verbose 看全部断言。')
  return 1
}

// 作为脚本直接运行时才执行（被 import 时只暴露 runChecks）
if (process.argv[1] !== undefined
  && fileURLToPath(pathToFileURL(process.argv[1])) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
