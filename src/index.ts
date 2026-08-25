/**
 * dsh-study-buddy 插件入口。
 *
 * 设计：preset 行挂载（`name: dsh-study-buddy`），工具注册进 preset 的
 * 工具作用域层，不污染其他 agent。插件不发布 Cordis 服务——每次 apply
 * 创建独立 VaultStore 实例（索引缓存在实例内，不跨挂载共享），
 * 因此不需要 isolate realm。
 *
 * vault 读写全部走 node:fs 直写（插件是可信 preset 代码，不经沙箱 fs）：
 * 用户在会话里永远拿不到 vault 的沙箱 fs 权限，只能通过本插件的工具操作。
 * @module index
 */

import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  addLink, applyUpdate, generateId, renderCard, renderMoc, validateCard, VALID_STATUS,
  type CardInput, type LinkKind, type MocEntry, type UpdatePayload,
} from './card.ts'
import { checkMemoryValue, formatMemory, normalizeMemoryKey, readMemory, writeMemory, type MemoryState } from './memory.ts'
import { indexNote, SearchIndex, type IndexedCard, type SearchHit } from './search.ts'
import { readProgress, writeProgress, type ProgressState } from './state.ts'
import {
  atomicWrite, canonicalRootKey, cardDirFor, dedupeFiles, dedupeRoots, mocPathFor, resolveSearchRoots, skipSetFor, uniqueCardPath, walkRoots, withinRoot,
  type SearchRoot, type VaultLayout,
} from './vault.ts'

export const name = 'study-buddy'
export const inject = ['tools']

export interface StudyConfig {
  /** Obsidian vault 根目录（绝对路径） */
  vaultRoot: string
  /** 进度状态目录（相对 vaultRoot），默认 .study */
  stateDir?: string
  /** 未映射领域的落盘目录（相对 vaultRoot），默认 未分类 */
  fallbackDir?: string
  /** MOC 知识目录落盘位置（相对 vaultRoot），默认 目录 */
  mocDir?: string
  /** 领域键 → 落盘目录（相对 vaultRoot），支持多个键别名映射同一目录 */
  domainFolders?: Record<string, string>
  /** 额外跳过扫描的目录名（相对 vaultRoot 的顶层目录名；内置已跳过 .obsidian/.trash/.study/.git/node_modules） */
  skipDirs?: string[]
  /** 额外检索根（绝对路径，或相对 vaultRoot 的路径）：旧笔记库，只读；不存在即挂载失败（fail-loud） */
  searchRoots?: string[]
  /** 是否把会话工作目录（工具调用方会话 cwd）纳入检索，默认 false */
  includeSessionCwd?: boolean
  /** 是否允许把关联写入无 ID 的旧笔记，默认 false（旧笔记不碰不动；只写卡片侧） */
  linkIntoNotes?: boolean
}

interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: { type: string }
    render: (_args: unknown, value: string) => Array<{ type: string; text: string }>
  }
  isConcurrencySafe?: () => boolean
  /** exec 由 DSH 工具注册表注入：调用方会话信息（agent.session.header.cwd） */
  execute: (args: Record<string, unknown>, exec?: ToolExecLike) => Promise<string> | string
}

/** 工具方会话信息的最小结构类型（不引入 @deepseek-ai 类型，保持构建 external） */
interface ToolExecLike {
  agent?: { session?: { header?: { cwd?: string } } }
}

interface PluginContext {
  tools?: { register: (def: ToolDef) => () => void }
  effect?: (callback: () => () => unknown, label?: string) => unknown
}

const renderText = (_args: unknown, value: string) => [{ type: 'text', text: value }]
const output = { schema: { type: 'string' as const }, render: renderText }

function normalizeConfig(config: StudyConfig | undefined): VaultLayout {
  if (!config?.vaultRoot || !String(config.vaultRoot).trim()) {
    throw new Error('dsh-study-buddy 需要 config.vaultRoot（Obsidian vault 根目录）')
  }
  const vaultRoot = resolve(String(config.vaultRoot))
  // 注意：不再拒绝 vaultRoot === 工作目录。launcher 通常以 vault 目录为 cwd
  // 启动 DSH，vault 即工作目录是受支持的部署形态（曾因此误伤导致 9 个工具
  // 静默不注册）。只保留"文件系统根"这一真正危险的落盘目标。
  if (vaultRoot === resolve('/')) {
    throw new Error(`vaultRoot 不能是文件系统根：${vaultRoot}`)
  }
  return {
    vaultRoot,
    stateDir: String(config.stateDir ?? '.study').trim() || '.study',
    fallbackDir: String(config.fallbackDir ?? '未分类').trim() || '未分类',
    mocDir: String(config.mocDir ?? '目录').trim() || '目录',
    domainFolders: config.domainFolders ?? {},
    skipDirs: Array.isArray(config.skipDirs) ? config.skipDirs.map(String) : [],
    searchRoots: Array.isArray(config.searchRoots) ? config.searchRoots.map(String) : [],
    includeSessionCwd: config.includeSessionCwd === true,
    linkIntoNotes: config.linkIntoNotes === true,
  }
}

function sessionCwdOf(exec?: ToolExecLike): string | undefined {
  const cwd = exec?.agent?.session?.header?.cwd
  return cwd && String(cwd).trim() ? String(cwd) : undefined
}

/** 引用解析：按路径/文件名取唯一候选；多个候选报歧义（提示根限定路径） */
function byUniqueRef(index: SearchIndex, ref: string): IndexedCard | undefined {
  const candidates = index.candidatesForRef(ref)
  if (candidates.length === 0) return undefined
  if (candidates.length > 1) {
    throw new Error(`路径歧义："${ref}" 命中多篇（${candidates.map((c) => c.fullRel).join('、')}），请用根限定路径（如 "vault/xxx.md"）`)
  }
  return candidates[0]
}

function fmtHits(hits: SearchHit[]): string {
  const lines = hits.map((h) => {
    const id = h.id ? ` [${h.id}]` : ''
    const meta = [
      h.domain ? `领域: ${h.domain}` : `目录: ${h.inferredDomain}`,
      h.status ? `状态: ${h.status}` : '',
      h.source ? `来源: ${h.source}` : '',
    ].filter(Boolean).join('，')
    const def = h.definition ? `- 定义：${h.definition.length > 40 ? `${h.definition.slice(0, 40)}…` : h.definition}` : ''
    return [
      `### ${h.title}${id}`,
      `- 类型：${h.kind === 'card' ? '卡片' : '旧笔记'}`,
      `- 路径：${h.fullRel}`,
      meta ? `- ${meta}` : '',
      def,
      `- 片段：${h.snippet}`,
    ].filter(Boolean).join('\n')
  })
  return lines.join('\n\n')
}

export class VaultStore {
  private index: SearchIndex | null = null
  private sig: string | null = null
  private extraRoots: SearchRoot[] = []

  constructor(private readonly layout: VaultLayout) {
    // fail-loud：searchRoots 配置错误在挂载时立即可见（而不是首次搜索才暴露）
    this.extraRoots = resolveSearchRoots(layout.vaultRoot, layout.searchRoots)
  }

  private stateFile(): string {
    const p = join(this.layout.vaultRoot, this.layout.stateDir, 'progress.json')
    if (!withinRoot(this.layout.vaultRoot, p)) throw new Error('进度文件路径越界')
    return p
  }

  private memoryFile(): string {
    const p = join(this.layout.vaultRoot, this.layout.stateDir, 'memory.json')
    if (!withinRoot(this.layout.vaultRoot, p)) throw new Error('记忆文件路径越界')
    return p
  }

  private async assertVault(): Promise<void> {
    try {
      const st = await fsp.stat(this.layout.vaultRoot)
      if (!st.isDirectory()) throw new Error()
    } catch {
      throw new Error(`vault 根目录不存在或不可读：${this.layout.vaultRoot}（检查 preset 行 config.vaultRoot）`)
    }
  }

  /** 当前会话的检索根：vault 优先，随后配置的 searchRoots，最后（可选）会话工作目录 */
  private rootsFor(sessionCwd?: string): SearchRoot[] {
    const roots: SearchRoot[] = [{ path: this.layout.vaultRoot, label: 'vault' }, ...this.extraRoots]
    const cwd = sessionCwd && sessionCwd.trim() ? String(sessionCwd).trim() : undefined
    if (this.layout.includeSessionCwd && cwd) {
      // 文件系统根是真正的危险目标（会整盘递归扫描），跳过并保持 vault/searchRoots 可用
      if (canonicalRootKey(cwd) !== canonicalRootKey(resolve('/'))) {
        roots.push({ path: resolve(cwd), label: '工作目录' })
      }
    }
    // 去重：cwd == vaultRoot / cwd 在 vault 内 / searchRoots 被覆盖时只保留贡献新文件的根
    return dedupeRoots(roots)
  }

  /** 目录签名（含各根文件 mtime/ctime/size 与 cwd）变化才重建索引（Obsidian 外部编辑后仍能查到最新内容） */
  private async refresh(sessionCwd?: string): Promise<SearchIndex> {
    await this.assertVault()
    const roots = this.rootsFor(sessionCwd)
    const walked = await walkRoots(roots, skipSetFor(this.layout.skipDirs))
    // 嵌套根（如 vault ⊆ cwd）会重复扫到同一文件：按规范化路径去重，vault 标签优先
    const files = dedupeFiles(walked)
    const sig = `${sessionCwd ?? ''}\n` + files.map((f) => `${f.root}|${f.rel}|${f.mtimeMs}|${f.ctimeMs}|${f.size}`).join('\n')
    if (this.index && sig === this.sig) return this.index
    const cards: IndexedCard[] = []
    for (const f of files) {
      try {
        const raw = await fsp.readFile(f.path, 'utf8')
        cards.push(indexNote(f, raw))
      } catch {
        // 读取失败（锁定/删除）：跳过该文件
      }
    }
    this.index = new SearchIndex()
    this.index.rebuild(cards, roots.length > 1)
    this.sig = sig
    return this.index
  }

  private async resolveCard(ref: string, sessionCwd?: string): Promise<{ card: IndexedCard; raw: string }> {
    const index = await this.refresh(sessionCwd)
    const card = index.byId(ref) ?? index.byTitle(ref) ?? byUniqueRef(index, ref)
    if (!card) {
      throw new Error(`找不到卡片 "${ref}"（可传 ID、标题、根限定路径 如 "工作目录/子目录/笔记.md"、相对路径或文件名）`)
    }
    const raw = await fsp.readFile(card.path, 'utf8')
    return { card, raw }
  }

  async search(query: string, opts: { domain?: string; status?: string; kind?: 'card' | 'note'; limit?: number } = {}, call?: { sessionCwd?: string }): Promise<string> {
    const index = await this.refresh(call?.sessionCwd)
    const hits = index.search(query, opts)
    if (hits.length === 0) {
      return `未命中（共检索 ${index.size} 篇${this.indexScopes(index)}）。可换词再试；新概念直接进入讲解，归档时新建卡片。`
    }
    return `命中 ${hits.length}（共 ${index.size} 篇${this.indexScopes(index)}）：\n\n${fmtHits(hits)}`
  }

  private indexScopes(index: SearchIndex): string {
    const roots = new Set(index.all().map((c) => c.root))
    return roots.size > 0 ? `，来源：${[...roots].join(' / ')}` : ''
  }

  async get(ref: string, call?: { sessionCwd?: string }): Promise<string> {
    const { card, raw } = await this.resolveCard(ref, call?.sessionCwd)
    return `路径：${card.fullRel}\n\n${raw}`
  }

  async create(input: CardInput): Promise<{ text: string; rel: string }> {
    await this.assertVault()
    const result = validateCard(input)
    if (result.errors.length > 0) throw new Error(`卡片校验失败：${result.errors.join('；')}`)
    const id = generateId()
    const text = renderCard({ ...input, id })
    const dir = cardDirFor(this.layout, input.domain)
    const file = await uniqueCardPath(dir, input.title, id)
    await atomicWrite(file, text)
    this.sig = null
    const rel = file.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, '/')
    const warn = result.warnings.length > 0 ? `\n提示：${result.warnings.join('；')}` : ''
    return { text: `已写入：${rel}\nID：${id}${warn}\n\n${text}`, rel }
  }

  async update(id: string, payload: UpdatePayload): Promise<string> {
    const { card, raw } = await this.resolveCard(id)
    const result = applyUpdate(raw, card.id ?? id, payload)
    await atomicWrite(card.path, result.text)
    this.sig = null
    const rel = card.rel.replace(/\\/g, '/')
    const warn = result.warnings.length > 0 ? `\n提示：${result.warnings.join('；')}` : ''
    return `已更新：${rel}\nID：${card.id ?? id}${warn}\n\n${result.text}`
  }

  async link(fromId: string, toId: string, kind: LinkKind, call?: { sessionCwd?: string }): Promise<string> {
    const from = await this.resolveCard(fromId, call?.sessionCwd)
    const to = await this.resolveCard(toId, call?.sessionCwd)
    const labelOf = (c: typeof from) => (c.card.id ? `${c.card.title}（${c.card.id}）` : `${c.card.title}（${c.card.fullRel}）`)
    const allowNoteWrite = this.layout.linkIntoNotes === true
    const reverseKind: LinkKind = kind === 'prev' ? 'next' : kind === 'next' ? 'prev' : 'conflict'
    const noteSkipped: string[] = []
    const written: string[] = []
    // 每一侧：卡片总是写入；旧笔记仅在 linkIntoNotes 时写入（默认不碰旧笔记）
    const applySide = async (
      side: typeof from, sideKind: LinkKind, targetLabel: string, targetId: string | null,
    ): Promise<void> => {
      if (side.card.id === null && !allowNoteWrite) {
        noteSkipped.push(labelOf(side))
        return
      }
      const next = addLink(side.raw, sideKind, targetLabel, targetId ?? undefined)
      if (next !== side.raw) {
        await atomicWrite(side.card.path, next)
        written.push(labelOf(side))
      }
    }
    if (from.card.id === null && to.card.id === null && !allowNoteWrite) {
      throw new Error(
        '两侧都是旧笔记（无 ID）：默认不写入旧笔记。请开启 config.linkIntoNotes 由插件双向写入，'
        + '或在 Obsidian 中用 [[ ]] 内链手动连接。',
      )
    }
    await applySide(from, kind, labelOf(to), to.card.id)
    await applySide(to, reverseKind, labelOf(from), from.card.id)
    this.sig = null
    const map: Record<LinkKind, string> = { prev: '前置知识', next: '后续延伸', conflict: '冲突/易混淆' }
    const basis = `已建立关联：${labelOf(from)} ←${map[kind]}→ ${labelOf(to)}`
    if (noteSkipped.length > 0) {
      return `${basis}（单侧写入；未修改旧笔记：${noteSkipped.join('、')}。开启 config.linkIntoNotes 可双向写入，或用 Obsidian 内链）`
    }
    return written.length > 0 ? `${basis}（已写入 ${written.length} 侧）` : `${basis}（关联已存在，无改动）`
  }

  async moc(opts: { title?: string; cardIds: string[]; domain?: string }, call?: { sessionCwd?: string }): Promise<string> {
    const index = await this.refresh(call?.sessionCwd)
    const entries: MocEntry[] = []
    const missing: string[] = []
    const skippedNotes: string[] = []
    for (const ref of opts.cardIds) {
      const card = (index.byId(ref) ?? index.byTitle(ref)) ?? byUniqueRef(index, ref)
      if (!card) {
        missing.push(ref)
        continue
      }
      if (card.id === null) {
        // MOC 是卡片知识目录；旧笔记不收录（提示但不算缺失）
        skippedNotes.push(card.fullRel)
        continue
      }
      const domain = card.domain ?? card.inferredDomain
      if (opts.domain && domain !== opts.domain) continue
      entries.push({ id: card.id, title: card.title, domain, fileName: card.fileName })
    }
    if (entries.length === 0) {
      throw new Error(`MOC 没有可收录的卡片（未解析到任何目标卡片${missing.length ? `，缺失：${missing.join('、')}` : ''}${skippedNotes.length ? `；跳过的旧笔记：${skippedNotes.join('、')}` : ''}）`)
    }
    const date = new Date().toISOString().slice(0, 10)
    const title = opts.title?.trim() || `知识目录_${date}`
    const text = renderMoc(title, date, entries)
    const file = mocPathFor(this.layout, title, date)
    await atomicWrite(file, text)
    const rel = file.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, '/')
    return `MOC 已写入：${rel}${skippedNotes.length ? `\n（旧笔记不收录：${skippedNotes.join('、')}）` : ''}\n\n${text}`
  }

  async progress(action: string, fields: {
    material?: string
    section?: string
    pendingQuestions?: string[]
    touchedCardIds?: string[]
  }): Promise<string> {
    const file = this.stateFile()
    if (action === 'clear') {
      await writeProgress(file, {})
      return '学习进度已清空。'
    }
    const current = await readProgress(file)
    if (action === 'get') return fmtProgress(current)
    if (action !== 'set') throw new Error(`study_progress 未知 action "${action}"（可用 get/set/clear）`)
    const next: ProgressState = { ...current }
    if (fields.material !== undefined) next.currentMaterial = String(fields.material).trim()
    if (fields.section !== undefined) next.currentSection = String(fields.section).trim()
    if (fields.pendingQuestions !== undefined) next.pendingQuestions = fields.pendingQuestions
    if (fields.touchedCardIds !== undefined) next.touchedCardIds = fields.touchedCardIds
    if (
      fields.material === undefined && fields.section === undefined
      && fields.pendingQuestions === undefined && fields.touchedCardIds === undefined
    ) {
      // set 无任何字段：不产生无效写（不 bump updatedAt），直接返回当前状态
      return fmtProgress(current)
    }
    await writeProgress(file, next)
    return fmtProgress(next)
  }

  async memory(action: string, fields: { key?: string; value?: string }): Promise<string> {
    const file = this.memoryFile()
    if (action === 'clear') {
      await writeMemory(file, { notes: {} })
      return '记忆已清空。'
    }
    const current = await readMemory(file)
    if (action === 'get') {
      if (fields.key !== undefined) {
        const key = normalizeMemoryKey(fields.key)
        const value = current.notes[key]
        return value !== undefined ? `${key}：${value}` : `（无此键：${key}）`
      }
      return formatMemory(current)
    }
    if (action !== 'set' && action !== 'append' && action !== 'remove') {
      throw new Error(`study_memory 未知 action "${action}"（可用 get/set/append/remove/clear）`)
    }
    const key = normalizeMemoryKey(fields.key ?? '')
    const next: MemoryState = { notes: { ...current.notes } }
    if (action === 'remove') {
      if (!Object.prototype.hasOwnProperty.call(next.notes, key)) {
        return `（无此键：${key}，无需删除）`
      }
      delete next.notes[key]
      await writeMemory(file, next)
      return `已删除记忆：${key}`
    }
    const value = checkMemoryValue(fields.value ?? '')
    if (action === 'append' && next.notes[key] !== undefined) {
      next.notes[key] = checkMemoryValue(`${next.notes[key]}\n${value}`)
    } else {
      next.notes[key] = value
    }
    await writeMemory(file, next)
    return `已记忆 ${key}：${value}\n\n${formatMemory(next)}`
  }
}

function fmtProgress(state: ProgressState): string {
  const pos = [state.currentMaterial || '（未开始）', state.currentSection || ''].filter(Boolean).join(' / ')
  const q = state.pendingQuestions?.length ? state.pendingQuestions.join('；') : '无'
  const c = state.touchedCardIds?.length ? state.touchedCardIds.join('、') : '无'
  return `位置：${pos}\n追问：${q}\n卡片：${c}`
}

export function buildToolDefs(store: VaultStore): ToolDef[] {
  return [
    {
      name: 'card_search',
      description:
        '全库检索 vault 卡片与旧笔记（含配置 searchRoots 与工作目录旧笔记——旧笔记=无 ID 的 .md）。'
        + '摄入新资料、引用旧卡、增量更新判断前必查重叠。'
        + '返回候选的标题/ID/类型（卡片或旧笔记）/路径/领域/状态/来源/定义/片段；召回由插件做，语义判断由你完成。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词（概念/术语/标题片段）' },
          domain: { type: 'string', description: '领域过滤（如 图形学）' },
          status: { type: 'string', description: '状态过滤：草稿/已确认/需更新' },
          kind: { type: 'string', enum: ['card', 'note'], description: '类型过滤：card=卡片，note=旧笔记' },
          limit: { type: 'number', description: '返回条数，默认 5' },
        },
        required: ['query'],
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args, exec) => store.search(String(args.query ?? ''), {
        domain: args.domain ? String(args.domain) : undefined,
        status: args.status ? String(args.status) : undefined,
        kind: args.kind === 'card' || args.kind === 'note' ? args.kind : undefined,
        limit: Number(args.limit) > 0 ? Number(args.limit) : undefined,
      }, { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'card_get',
      description: '按 ID、标题、根限定路径（如 "工作目录/子目录/笔记.md"）、相对路径或文件名读取一篇文档的完整原文（卡片或旧笔记）。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '卡片 ID、标题或路径/文件名（跨根路径歧义时用"根/相对路径"）' },
        },
        required: ['ref'],
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args, exec) => store.get(String(args.ref ?? ''), { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'card_id',
      description: '生成卡片 ID（YYYYMMDDHHmm_随机4位）。',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: '数量，默认 1，上限 20' },
        },
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args) => {
        const n = Math.min(Math.max(1, Math.trunc(Number(args?.count) || 1)), 20)
        return Array.from({ length: n }, () => generateId()).join('\n')
      },
    },
    {
      name: 'card_create',
      description:
        '把一张原子卡片写入 vault 对应分类目录（领域→目录映射；未映射落"未分类"）。知识即卡片：与旧笔记同库。'
        + '自动生成唯一 ID、写 frontmatter（ID/标题/领域/来源/状态）；正文=裸引用块定义+自由 ### 小节+关联卡片（前置/后续/易混淆），格式见 card-format 技能。返回整卡。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '概念名称，如"光线与表面的两种交互：散射与吸收"' },
          domain: { type: 'string', description: '领域键，决定落盘目录' },
          tags: { type: 'array', items: { type: 'string' }, description: '额外中文领域标签' },
          source: { type: 'string', description: '资料名称' },
          status: { type: 'string', enum: [...VALID_STATUS], description: '草稿/已确认/需更新' },
          definition: { type: 'string', description: '一句话定义 ≤30 字' },
          content: {
            type: 'string',
            description: '正文 Markdown（### 小节/表格；公式块级 LaTeX 编号；代码标语言）',
          },
          links: {
            type: 'object',
            description: '关联卡片（可预格式化，如"`漫反射模型`（Lambert）"）',
            properties: {
              prev: { type: 'array', items: { type: 'string' }, description: '前置' },
              next: { type: 'array', items: { type: 'string' }, description: '后续' },
              conflict: { type: 'array', items: { type: 'string' }, description: '易混淆' },
            },
          },
        },
        required: ['title', 'domain', 'source', 'status', 'definition', 'content'],
      },
      output,
      execute: (args) => store.create({
        title: String(args.title ?? ''),
        domain: String(args.domain ?? ''),
        source: String(args.source ?? ''),
        status: String(args.status ?? ''),
        definition: String(args.definition ?? ''),
        content: String(args.content ?? ''),
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        links: (args.links && typeof args.links === 'object'
          ? {
            prev: Array.isArray((args.links as Record<string, unknown>).prev) ? ((args.links as Record<string, unknown>).prev as unknown[]).map(String) : undefined,
            next: Array.isArray((args.links as Record<string, unknown>).next) ? ((args.links as Record<string, unknown>).next as unknown[]).map(String) : undefined,
            conflict: Array.isArray((args.links as Record<string, unknown>).conflict) ? ((args.links as Record<string, unknown>).conflict as unknown[]).map(String) : undefined,
          }
          : undefined),
      }).then((r) => r.text),
    },
    {
      name: 'card_update',
      description:
        '增量更新：append-version=尾部加"版本更新（来源）"（补充不推翻旧结论）；errata=保留旧内容加"勘误"（changes 含纠正原因）；'
        + 'replace=整卡替换（旧版入历史折叠块，可传 links 重建关联卡片）。先给用户新旧对比、确认后才调用；决定权在用户。返回整卡。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '卡片 ID/标题/路径' },
          mode: { type: 'string', description: 'append-version/errata/replace' },
          changes: { type: 'string', description: 'append/errata 的追加内容' },
          source: { type: 'string', description: '版本更新来源（append-version 用）' },
          title: { type: 'string', description: 'replace：新标题' },
          domain: { type: 'string', description: 'replace：领域键' },
          tags: { type: 'array', items: { type: 'string' }, description: 'replace：额外领域标签' },
          status: { type: 'string', enum: [...VALID_STATUS], description: 'replace：草稿/已确认/需更新' },
          definition: { type: 'string', description: 'replace：一句话定义 ≤30 字' },
          content: { type: 'string', description: 'replace：新正文 Markdown' },
          links: {
            type: 'object',
            description: 'replace：新关联卡片（可选；不传则新卡无关联小节，旧关联留在历史折叠块）',
            properties: {
              prev: { type: 'array', items: { type: 'string' }, description: '前置' },
              next: { type: 'array', items: { type: 'string' }, description: '后续' },
              conflict: { type: 'array', items: { type: 'string' }, description: '易混淆' },
            },
          },
        },
        required: ['id', 'mode'],
      },
      output,
      execute: (args) => {
        const mode = String(args.mode ?? '')
        const payload: UpdatePayload = { mode: mode as UpdatePayload['mode'] }
        if (mode === 'append-version' || mode === 'errata') {
          payload.changes = args.changes ? String(args.changes) : undefined
          if (mode === 'append-version' && args.source) payload.source = String(args.source)
        }
        if (mode === 'replace') {
          payload.card = {
            title: String(args.title ?? ''),
            domain: String(args.domain ?? ''),
            source: String(args.source ?? ''),
            status: String(args.status ?? ''),
            definition: String(args.definition ?? ''),
            content: String(args.content ?? ''),
            tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
            links: (args.links && typeof args.links === 'object'
              ? {
                prev: Array.isArray((args.links as Record<string, unknown>).prev) ? ((args.links as Record<string, unknown>).prev as unknown[]).map(String) : undefined,
                next: Array.isArray((args.links as Record<string, unknown>).next) ? ((args.links as Record<string, unknown>).next as unknown[]).map(String) : undefined,
                conflict: Array.isArray((args.links as Record<string, unknown>).conflict) ? ((args.links as Record<string, unknown>).conflict as unknown[]).map(String) : undefined,
              }
              : undefined),
          }
        }
        return store.update(String(args.id ?? ''), payload)
      },
    },
    {
      name: 'card_link',
      description:
        '维护两篇文档的关联（前置/后续/易混淆），双向写入卡片侧。'
        + '无 ID 的旧笔记默认不写入（旧笔记不碰不动）：卡片↔旧笔记只写卡片侧；旧笔记↔旧笔记需 config.linkIntoNotes 开启。',
      parameters: {
        type: 'object',
        properties: {
          fromId: { type: 'string', description: '卡片 ID/标题/路径（旧笔记用"工作目录/相对路径"）' },
          toId: { type: 'string', description: '卡片 ID/标题/路径' },
          kind: { type: 'string', description: 'prev=toId 是 fromId 的前置 / next=后续 / conflict=易混淆' },
        },
        required: ['fromId', 'toId', 'kind'],
      },
      output,
      execute: (args, exec) => {
        const kind = String(args.kind ?? '') as LinkKind
        if (!['prev', 'next', 'conflict'].includes(kind)) throw new Error('kind 必须是 prev / next / conflict')
        return store.link(String(args.fromId ?? ''), String(args.toId ?? ''), kind, { sessionCwd: sessionCwdOf(exec) })
      },
    },
    {
      name: 'card_moc',
      description:
        '生成 MOC（领域分组 + Obsidian wikilink）写入"目录"目录并返回文本。归档收尾时用：传本次涉及的卡片 ID。'
        + '只收录有 ID 的卡片，旧笔记自动跳过。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'MOC 标题（默认 知识目录_日期）' },
          cardIds: { type: 'array', items: { type: 'string' }, description: '本次涉及的卡片 ID/标题' },
          domain: { type: 'string', description: '可选：只收录该领域' },
        },
        required: ['cardIds'],
      },
      output,
      execute: (args, exec) => store.moc({
        title: args.title ? String(args.title) : undefined,
        cardIds: Array.isArray(args.cardIds) ? args.cardIds.map(String) : [],
        domain: args.domain ? String(args.domain) : undefined,
      }, { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'study_progress',
      description:
        '读写学习进度（持久，跨会话有效）：资料/小节/未答追问/触及卡片。'
        + '"接着讲"前 get；小节推进 set；归档（整理笔记）前检查 pendingQuestions。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'get/set/clear' },
          material: { type: 'string', description: 'set：资料名' },
          section: { type: 'string', description: 'set：小节' },
          pendingQuestions: { type: 'array', items: { type: 'string' }, description: 'set：追问队列（整体替换）' },
          touchedCardIds: { type: 'array', items: { type: 'string' }, description: 'set：触及卡片 ID（整体替换）' },
        },
        required: ['action'],
      },
      output,
      execute: (args) => store.progress(String(args.action ?? 'get'), {
        material: args.material ? String(args.material) : undefined,
        section: args.section ? String(args.section) : undefined,
        pendingQuestions: Array.isArray(args.pendingQuestions) ? args.pendingQuestions.map(String) : undefined,
        touchedCardIds: Array.isArray(args.touchedCardIds) ? args.touchedCardIds.map(String) : undefined,
      }),
    },
    {
      name: 'study_memory',
      description:
        '读写跨会话记忆（vault .study/memory.json，持久有效，重启不丢）：键值笔记。'
        + '新会话开场先 get（配合 study_progress(get) 给衔接提示）；用户偏好/约定存 prefs；'
        + '告一段落或归档时 set lastSummary=本次小结。清空进度（study_progress clear）不影响记忆。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'get（key 可选，默认全量）/set/append/remove/clear' },
          key: { type: 'string', description: '记忆键名（≤64 字符；lastSummary=上次小结，置顶显示）' },
          value: { type: 'string', description: 'set/append：记忆内容（≤4000 字符）' },
        },
        required: ['action'],
      },
      output,
      execute: (args) => store.memory(String(args.action ?? 'get'), {
        key: args.key !== undefined && args.key !== null ? String(args.key) : undefined,
        value: args.value !== undefined && args.value !== null ? String(args.value) : undefined,
      }),
    },
  ]
}

export function apply(ctx: PluginContext, config?: StudyConfig): void {
  let store: VaultStore
  try {
    store = new VaultStore(normalizeConfig(config))
  } catch (error) {
    console.error(`[dsh-study-buddy] ${(error as Error).message}`)
    // fail-loud：静默 return 曾让"行已挂载、工具全无"的故障潜伏数天。
    // 抛错会让 preset 挂载失败（agent-preset-invalid），原因立即可见。
    throw error
  }
  const tools = ctx?.tools
  if (typeof tools?.register !== 'function') {
    console.error('[dsh-study-buddy] tools 注册表不可用，插件未挂载工具')
    throw new Error('dsh-study-buddy: ctx.tools.register 不可用，无法注册卡片工具')
  }
  const disposers: Array<() => void> = []
  try {
    for (const def of buildToolDefs(store)) {
      disposers.push(tools.register(def))
    }
  } catch (error) {
    // 半途失败：先卸掉已注册的工具再抛，避免残留无主注册
    for (const dispose of disposers) dispose()
    console.error(`[dsh-study-buddy] 工具注册失败：${(error as Error).message}`)
    throw error
  }
  // 注册随 preset 作用域注销；disposer 由 ctx.effect 持有（ctx 无 effect 时
  // 退化为不持有——standing 挂载生命周期即进程生命周期，无泄漏）。
  ctx?.effect?.(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-study-buddy tools')
}
