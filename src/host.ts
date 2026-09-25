/**
 * 宿主适配层——本插件与 DSH 之间的**唯一**接触面。
 *
 * 为什么要单独一层：DSH 的内部改动**不会**以编译错误或本仓 `pnpm run check` 的形式暴露。
 * 两个实测案例：
 * - 0.1.7-rc.1（提交 d1e22a7e24 / #4569）删掉目录式预设 → 「学习伙伴」预设整行消失、
 *   18 个工具全部不见，但插件代码零改动、契约探针全绿（`$DSH_HOME/.agent-presets/`
 *   再没有任何读者）；
 * - 0.1.3-alpha.1 把 `session.events` 数组换成 `session.snapshotEvents()` → 旧读法抛错
 *   并被包装成"步骤级失败"，而不是退化成"少注入一次提醒"。
 *
 * 因此本层的三条规则：
 * 1. **只有本文件可以假设宿主形状**；其余模块只用这里返回的能力对象。
 * 2. **一律特性探测 + 降级**；唯一的 fail-loud 是工具注册（没有工具=没有功能）。
 * 3. 每个接触点都登记在 {@link HOST_CONTRACTS} 里（含"变了会怎样"），并由
 *    `tools/verify-contract.mjs` 对**活平台符号面**断言（含"不得再假设已删方法"的
 *    负向断言）。改这里 = 改契约表，两边必须同步。
 *
 * 可选兼容层：装了 `@dsh-plugin/dsh-loader` 时优先走它的稳定入口
 * （`ctx.dshLoader.services.get(name)`，见 https://github.com/dsh-plugins/dsh-loader ）。
 * 但它的覆盖面是 settings 白名单桥 / `httpServer→webServer` 别名 / 包名别名 /
 * `Session.events` 补丁，**不含** `tools.register`、`systemPrompt.section`、
 * `agent/pre-step` —— 所以本层的探测与降级才是主防线。dsh-loader 既不 import 也不
 * inject：inject 了但用户没装时，整行会永远停在 `pending`，工具静默不注册。
 * @module host
 */

/** 一个宿主契约点：`ref` 是平台源码坐标，`breaks` 是"变了之后本插件的失效形态"。 */
export interface HostContract {
  readonly key: string
  readonly ref: string
  readonly what: string
  readonly breaks: string
}

/**
 * 本插件依赖的全部宿主契约点（**单一真相**：排障说明与探针断言都从这里取）。
 *
 * `ref` 的行号只是"去平台源码核准"的入口，判定按形状、不按行号（行号会漂移）。
 * 探测全部落在 {@link resolveHost} / {@link sessionCwdOf} / {@link sessionEventsOf}。
 */
export const HOST_CONTRACTS: readonly HostContract[] = [
  {
    key: 'toolsRegister',
    ref: 'packages/core/tools/src/index.ts:1062',
    what: 'ctx.tools.register(def) → disposer；def 必须带 output { schema, render }',
    breaks: 'apply() 里注册工具时同步抛错 → 整行未激活（18 个工具全没）',
  },
  {
    key: 'systemPromptSection',
    ref: 'packages/core/system-prompt/src/index.ts:455',
    what: 'ctx.get("systemPrompt").section({ name, order, text }) → disposer（order 必须是有限数）',
    breaks: '开场门禁第一层（系统提示段）消失，只剩预步提醒',
  },
  {
    key: 'preStep',
    ref: 'packages/core/agent/src/runtime-types.ts:320',
    what: "ctx.on('agent/pre-step', (payload, next))，payload = { agent, messages, turn, step, signal }",
    breaks: '预步提醒不再注入（门禁降级为单层）',
  },
  {
    key: 'messageSourceKind',
    ref: 'packages/session/session-format-v3-to-v4/src/message-sources.ts:9',
    what: "注入消息的 source.kind 必须是非空字符串且 ≠ 'plugin'（生产者自有 kind；第三方插件用 plugin:<包名>，"
      + '见平台 llm/src/message.ts:103 的 MessageSourceMap 注释"there is no shared catch-all plugin kind"）',
    breaks: '预步提醒写盘被 encode 拒绝 → 整轮失败'
      + '（"本轮运行失败 format v4 message requires a producer-owned source kind"），用户消息也不落盘',
  },
  {
    key: 'sessionSnapshotEvents',
    ref: 'packages/core/session/src/index.ts:646',
    what: 'session.snapshotEvents() → readonly SessionEvent[]（旧形态 session.events 数组仍在探测范围内）',
    breaks: '开场门禁的"是否恢复会话"判定退化为 false（只多注入一次提醒，不阻断）',
  },
  {
    key: 'sessionHeaderCwd',
    ref: 'packages/core/agent/src/runtime-types.ts:168',
    what: 'payload.agent.session.header.cwd → string | undefined',
    breaks: 'includeSessionCwd 失效：会话工作目录的旧笔记不进检索',
  },
]

/** 预步监听器形状（`agent/pre-step` 是 waterfall：拿到下游决策后可改写） */
export type PreStepListener = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

/** 宿主 ctx 的最小形状：只声明本插件真的会读的入口 */
export interface HostContextLike {
  /** 工具注册表（宿主服务；唯一 fail-loud 的接触点） */
  tools?: { register: (def: unknown) => () => void }
  /** Cordis effect（持有注册的生命周期） */
  effect?: (callback: () => () => unknown, label?: string) => unknown
  /** Cordis 事件订阅（返回 disposer） */
  on?: (event: string, listener: PreStepListener) => () => void
  /** Cordis 服务读取（可选服务一律特性探测） */
  get?: (key: string) => unknown
}

/** 工具执行的宿主上下文（`execute(args, exec)` 的第二个参数） */
export interface ToolExecLike {
  agent?: { session?: { header?: { cwd?: string } } }
}

/** 会话形状：新平台 `snapshotEvents()`、旧平台 `events` 数组（两者都在探测范围内） */
export interface SessionLike {
  events?: Array<{ type?: string }>
  snapshotEvents?: () => Array<{ type?: string }>
  header?: { cwd?: string }
}

/** 系统提示段注册入口（`ctx.get('systemPrompt')`；只有 `section` 是函数时才算能力可用） */
export interface SystemPromptLike {
  section: (entry: { name: string; order: number; text: string }) => () => void
}

/** dsh-loader 稳定入口（可选安装；只探测，不 import、不 inject） */
interface DshLoaderLike {
  services?: { get?: (name: string) => unknown }
}

/** 探测结果：能力对象 + 取用途径（`viaDshLoader` 回显在启动日志，排障用） */
export interface HostCapabilities {
  /** true = 至少有一个服务是经 dsh-loader 稳定入口拿到的 */
  readonly viaDshLoader: boolean
  readonly tools?: { register: (def: unknown) => () => void }
  readonly systemPrompt?: SystemPromptLike
  readonly on?: (event: string, listener: PreStepListener) => () => void
}

/** 一个服务的取用结果：值 + 是否来自 dsh-loader 的稳定入口 */
interface ServiceLookup {
  readonly value: unknown
  readonly viaDshLoader: boolean
}

/**
 * 取一个服务：dsh-loader 稳定入口优先，否则直接读 Cordis 服务。
 *
 * 两条路径都能拿到时用 dsh-loader 的那份（它是 DSH 内部改名的吸收层），但**不**把
 * dsh-loader 当必需——没装时行为与从前完全一致。dsh-loader 自己探测失败也不抛：
 * 退到直接服务，不让可选的兼容层拖垮插件。
 * @param ctx - 宿主上下文（可为 undefined；测试里常传空）
 * @param name - Cordis 服务名（如 `tools` / `systemPrompt`）
 * @returns 服务实例与其来源（调用方必须按能力缺失降级）
 */
function serviceOf(ctx: HostContextLike | undefined, name: string): ServiceLookup {
  const loader = ctx?.get?.('dshLoader') as DshLoaderLike | undefined
  const getter = loader?.services?.get
  if (typeof getter === 'function') {
    try {
      const viaLoader = getter.call(loader?.services, name)
      if (viaLoader !== undefined) return { value: viaLoader, viaDshLoader: true }
    } catch {
      // 可选层内部出错：静默退到直接服务
    }
  }
  return { value: ctx?.get?.(name), viaDshLoader: false }
}

/**
 * 特性探测宿主能力。**永不抛错**：任一环节缺失都只让对应能力变 undefined。
 * @param ctx - Cordis 上下文（preset 行的 `apply(ctx, config)` 第一个参数）
 * @returns 能力对象（`tools` 缺失时调用方必须 fail-loud，见 index.ts）
 */
export function resolveHost(ctx: HostContextLike | undefined): HostCapabilities {
  // 工具注册表：稳定入口 → Cordis 服务 → ctx.tools 属性（Cordis 也会把服务挂成属性）
  const looked = serviceOf(ctx, 'tools')
  const toolsService = (looked.value ?? ctx?.tools) as { register?: unknown } | undefined
  const tools = typeof toolsService?.register === 'function'
    ? (toolsService as { register: (def: unknown) => () => void })
    : undefined
  const promptLookup = serviceOf(ctx, 'systemPrompt')
  const prompt = promptLookup.value as { section?: unknown } | undefined
  const systemPrompt = typeof prompt?.section === 'function' ? (prompt as SystemPromptLike) : undefined
  const on = typeof ctx?.on === 'function' ? ctx.on.bind(ctx) : undefined
  return {
    viaDshLoader: looked.viaDshLoader || promptLookup.viaDshLoader,
    ...(tools === undefined ? {} : { tools }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(on === undefined ? {} : { on }),
  }
}

/**
 * 调用方会话的工作目录（`includeSessionCwd` 的输入）。
 * @param exec - 工具执行的宿主上下文
 * @returns 去空白后的绝对路径，或 undefined（调用方据此跳过该检索根）
 */
export function sessionCwdOf(exec?: ToolExecLike): string | undefined {
  const cwd = exec?.agent?.session?.header?.cwd
  return cwd && String(cwd).trim() ? String(cwd) : undefined
}

/**
 * 会话事件快照（自动门禁的"是否恢复会话"判定输入）。
 *
 * 双形状探测 + **绝不逸出异常**：`snapshotEvents()` 是宿主 API，跨版本可能抛错，
 * 而从 pre-step 处理器逸出的异常会被包装成步骤级失败——比"少注入一次提醒"坏得多。
 * @param session - payload.agent.session（形状未知，只读探测）
 * @returns 事件数组，或 undefined（两者皆缺/抛错 → 调用方按"保守 false"处理）
 */
export function sessionEventsOf(session: SessionLike | undefined): Array<{ type?: string }> | undefined {
  try {
    if (Array.isArray(session?.events)) return session?.events
    if (typeof session?.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents()
      return Array.isArray(snapshot) ? snapshot : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}
