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
import { basename, dirname, join, resolve } from 'node:path'
/** 笔记契约的唯一来源（阶段 6 起 card.ts / history.ts / moc.ts 已删除） */
import {
  LINK_LABELS, applyUpdate as applyNoteUpdate, generateId, inverseKind, renderNote, validateBlock,
  type BlockInput, type BlockLinks, type LinkKind,
} from './note.ts'
import { addLink, removeLink } from './links.ts'
import {
  EXPECT_FILE, TOC_FILE, DirIndex, dirOfRel, dirPathFor, expectPathFor, listDir, nestHint, normRel,
} from './dirs.ts'
import { checkWrite, formatPlanProposal, type GateInput } from './gate.ts'
import {
  DEFAULT_PLAN_TTL_HOURS, abandonPlan, buildPlanRecord, consumePlanItem, isPlanExpired, planFileFor, readPlan, writePlan,
} from './planstore.ts'
import { archiveBody, archiveThenWrite, listArchives, readArchive } from './archive.ts'
import { markExpectRead, readSession, sessionFileFor, signatureOf, writeSession, type SessionState } from './store.ts'
import { formatOverview, summarizeOverview } from './overview.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { formatBatch, formatReport, lintNote, parseExpectRules, ruleIds, ruleTitle, summarizeLint, type ExpectRule, type LintReport } from './lint.ts'
import {
  AUTO_PREFS_KEY, checkMemoryValue, findProgressSentences, formatAutoPrefs, formatMemory,
  normalizeAutoPrefsValue, normalizeMemoryKey, readMemory, writeMemory, type MemoryState,
} from './memory.ts'
import {
  MANDATE, OPENER_SECTION_NAME, OPENER_SECTION_ORDER,
  applyOpenerDecision, buildOpenerReminder, hasPriorUserMessage, shouldInjectOpener,
} from './opener.ts'
import {
  detectBrokenLinks, formatRenameReport, noteTitleOf, planRename, replaceNoteTitle, rewriteLinkLines, rewriteWikilinks,
  type BrokenLinkHit, type RenamePlan,
} from './links.ts'
import { indexNote, SearchIndex, snippetOf, type IndexedCard, type NoteKind, type SearchHit } from './search.ts'
import { readProgress, writeProgress, type ProgressState } from './state.ts'
import { buildToolDefs, type ToolDef } from './tools.ts'
import {
  atomicWrite, canonicalRootKey, dedupeFiles, dedupeRoots, ensureDir, isFsRoot, MAX_WALK_FILES,
  readNoteSource, resolveSearchRoots, skipSetFor, walkRoots, withinRoot,
  type SearchRoot, type VaultLayout,
} from './vault.ts'

export type { ToolDef, ToolExecLike } from './tools.ts'
export { buildToolDefs } from './tools.ts'

export const name = 'study-buddy'
export const inject = ['tools']

/**
 * 插件配置：`VaultLayout` 的"可省略默认值"视图（EXT-6：配置类型只有一份定义，
 * 不再三处同构搬运；新增配置项只改 vault.ts）。
 */
export interface StudyConfig extends Omit<VaultLayout, 'stateDir' | 'fallbackDir'> {
  /** 进度状态目录（相对 vaultRoot），默认 .study */
  stateDir?: string
  /** 未映射领域的落盘目录（相对 vaultRoot），默认 未分类 */
  fallbackDir?: string
}

/** 进度队列长度上限（BIZ-11f：无上限会长成 progress.json 里的巨型数组） */
const MAX_PROGRESS_ITEMS = 50
const MAX_PROGRESS_ITEM_CHARS = 200

interface PluginContext {
  tools?: { register: (def: ToolDef) => () => void }
  effect?: (callback: () => () => unknown, label?: string) => unknown
  /** Cordis 事件订阅（预步门禁用；返回 disposer） */
  on?: (event: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => () => void
  /** Cordis 服务读取（systemPrompt 用；可选服务一律特性探测） */
  get?: (key: string) => unknown
}

/**
 * `normalizeConfig` 认得的所有配置键（唯一来源）。
 *
 * 分开维护的原因：`normalizeConfig` 逐键取值 + 兜底，读不出"哪些键我不认"；
 * 而**不认的键是静默陷阱**——预设行里留着 `mocDir` 这类已退场键（v0.9 → v1.0
 * 删掉的两个键之一）时，插件照常挂载、功能正常，配置却"以为配了其实没配"。
 * 本轮 DSH 升级排查就是被这种漂移咬了一次（部署副本的 `mocDir`）。
 */
const KNOWN_CONFIG_KEYS: readonly string[] = [
  'vaultRoot', 'expectFile', 'planTtlHours', 'stateDir', 'fallbackDir',
  'domainFolders', 'skipDirs', 'searchRoots', 'includeSessionCwd', 'linkIntoNotes',
  'lint', 'indexTtlMs', 'maxWalkFiles',
]

/** 预设行 config 里插件不认识的键（已退场键 / 拼写错误），按出现顺序返回 */
function unknownConfigKeys(config: StudyConfig | undefined): string[] {
  if (!config || typeof config !== 'object') return []
  const known = new Set<string>(KNOWN_CONFIG_KEYS)
  return Object.keys(config).filter((key) => !known.has(key))
}

function normalizeConfig(config: StudyConfig | undefined): VaultLayout {
  if (!config?.vaultRoot || !String(config.vaultRoot).trim()) {
    throw new Error('dsh-study-buddy 需要 config.vaultRoot（Obsidian vault 根目录）')
  }
  const vaultRoot = resolve(String(config.vaultRoot))
  // 注意：不再拒绝 vaultRoot === 工作目录。launcher 通常以 vault 目录为 cwd
  // 启动 DSH，vault 即工作目录是受支持的部署形态（曾因此误伤导致 9 个工具
  // 静默不注册）。只保留"文件系统根"这一真正危险的落盘目标。
  if (isFsRoot(vaultRoot)) {
    throw new Error(`vaultRoot 不能是文件系统根：${vaultRoot}`)
  }
  // lint.rulesOff 里的未知 id 是"以为关了其实没关"的静默陷阱（N9）：挂载期直接报错
  const rulesOff = config.lint?.rulesOff
  if (Array.isArray(rulesOff) && rulesOff.length > 0) {
    const known = new Set(ruleIds())
    const unknown = rulesOff.map(String).filter((id) => !known.has(id))
    if (unknown.length > 0) {
      throw new Error(
        `lint.rulesOff 含未识别的规则 id：${unknown.join('、')}（可用：${ruleIds().join('、')}）`,
      )
    }
  }
  const maxWalkFiles = Number(config.maxWalkFiles)
  return {
    vaultRoot,
    stateDir: String(config.stateDir ?? '.study').trim() || '.study',
    fallbackDir: String(config.fallbackDir ?? '未分类').trim() || '未分类',
    domainFolders: config.domainFolders ?? {},
    skipDirs: Array.isArray(config.skipDirs) ? config.skipDirs.map(String) : [],
    searchRoots: Array.isArray(config.searchRoots) ? config.searchRoots.map(String) : [],
    includeSessionCwd: config.includeSessionCwd === true,
    linkIntoNotes: config.linkIntoNotes === true,
    lint: config.lint,
    indexTtlMs: Number.isFinite(Number(config.indexTtlMs)) && Number(config.indexTtlMs) >= 0 ? Number(config.indexTtlMs) : 2000,
    maxWalkFiles: Number.isFinite(maxWalkFiles) && maxWalkFiles >= 1 ? Math.floor(maxWalkFiles) : MAX_WALK_FILES,
    planTtlHours: Number.isFinite(Number(config.planTtlHours)) && Number(config.planTtlHours) > 0
      ? Number(config.planTtlHours)
      : 24,
    expectFile: String(config.expectFile ?? '').trim() || EXPECT_FILE,
  }
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

const KIND_LABEL: Record<string, string> = { block: '块', legacy: '存量卡', note: '旧笔记' }

function fmtHits(hits: SearchHit[]): string {
  const lines = hits.map((h) => {
    const id = h.id ? ` [${h.id}]` : ''
    const meta = [
      h.domain ? `领域: ${h.domain}` : `目录: ${h.inferredDomain}`,
      h.status ? `状态: ${h.status}` : '',
      h.source ? `来源: ${h.source}` : '',
      h.sourceSection ? `来源章节: ${h.sourceSection}` : '',
    ].filter(Boolean).join('，')
    const def = h.definition ? `- 简介：${h.definition.length > 60 ? `${h.definition.slice(0, 60)}…` : h.definition}` : ''
    return [
      `### ${h.title}${id}`,
      `- 类型：${KIND_LABEL[h.kind] ?? h.kind}`,
      `- 路径：${h.fullRel}`,
      meta ? `- ${meta}` : '',
      def,
      h.snippet ? `- 片段：${h.snippet}` : '',
    ].filter(Boolean).join('\n')
  })
  return lines.join('\n\n')
}

/** 进度队列字段校验（BIZ-11f：条数与单条长度都要设上限） */
function normalizeQueue(items: string[], label: string): string[] {
  if (items.length > MAX_PROGRESS_ITEMS) {
    throw new Error(`${label} 最多 ${MAX_PROGRESS_ITEMS} 条（当前 ${items.length} 条），请先清理或归档`)
  }
  for (const item of items) {
    if (String(item).length > MAX_PROGRESS_ITEM_CHARS) {
      throw new Error(`${label} 单条最长 ${MAX_PROGRESS_ITEM_CHARS} 字（当前 ${String(item).length} 字），请精简`)
    }
  }
  return items.map(String)
}

/** `note_list` 的一行：标题 + 类型 + 来源章节 + 简介 */
function fmtListFile(f: { title: string; fileName: string; kind: string; sourceSection: string | null; summary: string | null }): string {
  const kind = KIND_LABEL[f.kind] ?? f.kind
  const section = f.sourceSection ? `（${f.sourceSection}）` : ''
  const summary = f.summary ? ` —— ${f.summary}` : ''
  return `${f.title} · ${kind}${section}${summary}`
}

/** `note_overview` 用的目录遍历结果（只读 frontmatter 头，不读正文） */
interface WalkedNote {
  rel: string
  title: string
  kind: string
  sourceSection: string | null
}

/** 递归遍历主题目录下的笔记（默认 4 层，够覆盖"资料/章/节/块"） */
async function walkNotes(vaultRoot: string, dir: string, depth = 4): Promise<WalkedNote[]> {
  const out: WalkedNote[] = []
  let listing
  try {
    listing = await listDir(vaultRoot, dir)
  } catch {
    return out
  }
  for (const f of listing.files) {
    out.push({ rel: f.rel, title: f.title, kind: f.kind, sourceSection: f.sourceSection })
  }
  if (depth <= 1) return out
  for (const sub of listing.subdirs) out.push(...await walkNotes(vaultRoot, sub, depth - 1))
  return out
}

/** 改名动作（先规划后提交，BIZ-2） */
interface RenameChange {
  rel: string
  kind: string
  changed: number
  samples: string[]
}

interface RenameAction {
  id: string
  card: IndexedCard
  oldTitle: string
  title: string
  plan: RenamePlan
  /** 本卡改写后的完整文本（含末尾换行） */
  selfText: string
  /** 需要写入的其它文件 */
  writes: Array<{ path: string; text: string }>
  changed: RenameChange[]
  broken: BrokenLinkHit[]
  /** 需要落盘的新文件路径（null = 不改文件名） */
  targetPath: string | null
}

/** 新旧标题相同：不是错误，只是"无改动"，由 rename() 转成正常返回 */
class SameTitleError extends Error {}

export class VaultStore {
  private index: SearchIndex | null = null
  private sig: string | null = null
  private lastScanMs = 0
  private lastScanCwd = ''
  /** 上一次索引/扫描跳过的项（读取失败、安全阀截断等），在工具返回文本回显（BIZ-7） */
  private skipped: Array<{ path: string; reason: string }> = []
  private extraRoots: SearchRoot[] = []
  /**
   * 标题 → 笔记摘要：写入时的同名提示用 O(1) 查询（N2）。
   * 旧实现为了一条提示调用 `ensureIndex`，让每次建卡都全库重扫。
   * 索引重建时整体填充，写入（create/replace/rename）后增量维护。
   */
  private titleHints = new Map<string, { title: string; fullRel: string; id: string | null }>()
  /** 上一次 `ensureIndex` 是否命中 TTL 缓存（命中时未命中/找不到的查询要强制重扫一次，N3） */
  private servedFromCache = false
  /** 上一次索引是否多根（决定展示路径是否带 `vault/` 前缀） */
  private lastMultiRoot = false

  constructor(private readonly layout: VaultLayout) {
    // fail-loud：searchRoots 配置错误在挂载时立即可见（而不是首次搜索才暴露）
    // 额外根默认只读；linkIntoNotes 开启时允许写入（与"旧笔记不碰不动"的默认口径相反）
    this.extraRoots = resolveSearchRoots(layout.vaultRoot, layout.searchRoots, layout.linkIntoNotes === true)
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

  /** 当前会话的检索根：vault（可写）优先，随后配置的 searchRoots，最后（可选）会话工作目录（只读） */
  private rootsFor(sessionCwd?: string): SearchRoot[] {
    const roots: SearchRoot[] = [{ path: this.layout.vaultRoot, label: 'vault', writable: true }, ...this.extraRoots]
    const cwd = sessionCwd && sessionCwd.trim() ? String(sessionCwd).trim() : undefined
    // 文件系统根是真正的危险目标（会整盘递归扫描）：用真正的根判定，而不是
    // `resolve('/')`（在 Windows 上只等于当前盘根，跨盘符 cwd 会漏拦，SEC-2）
    if (this.layout.includeSessionCwd && cwd && !isFsRoot(cwd)) {
      roots.push({ path: resolve(cwd), label: '工作目录', writable: this.layout.linkIntoNotes === true })
    }
    // 去重：cwd == vaultRoot / cwd 在 vault 内 / searchRoots 被覆盖时只保留贡献新文件的根
    return dedupeRoots(roots)
  }

  /**
   * 跳过的项回显（BIZ-7：报告数字必须与"实际处理了哪些文件"一致）。
   * 按**原因**分组（N5）：跳过对象可能是目录（深度超限）或截断的根，
   * 旧实现只留路径、原因一律写成"读取失败/无权限"，会把用户引向错误方向。
   */
  private noteSkips(): string {
    if (this.skipped.length === 0) return ''
    const byReason = new Map<string, string[]>()
    for (const entry of this.skipped) {
      const list = byReason.get(entry.reason) ?? []
      list.push(entry.path)
      byReason.set(entry.reason, list)
    }
    const parts = [...byReason.entries()].map(([reason, paths]) => {
      const head = paths.slice(0, 3).join('、')
      return `${reason}（${paths.length} 项：${head}${paths.length > 3 ? ' 等' : ''}）`
    })
    return `\n⚠ 跳过 ${this.skipped.length} 项未完整处理：${parts.join('；')}`
  }

  /** 展示路径：多根时带 `vault/` 前缀，与索引 `fullRel` 口径一致（N2） */
  private displayRel(rel: string): string {
    const clean = rel.replace(/\\/g, '/')
    return this.lastMultiRoot ? `vault/${clean}` : clean
  }

  /** 维护标题缓存（N2）：只在旧键确实指向本卡时删除，避免误伤同名卡 */
  private rememberTitle(title: string, fullRel: string, id: string | null, previousTitle?: string): void {
    const text = String(title ?? '').trim()
    if (!text) return
    const key = text.toLowerCase()
    if (previousTitle) {
      const oldKey = String(previousTitle).trim().toLowerCase()
      if (oldKey && oldKey !== key) {
        const entry = this.titleHints.get(oldKey)
        if (entry && entry.id === id) this.titleHints.delete(oldKey)
      }
    }
    this.titleHints.set(key, { title: text, fullRel, id })
  }

  /** 写缓存失效：任何写操作之后必须调用 */
  private invalidate(): void {
    this.sig = null
    this.lastScanMs = 0
  }

  /**
   * 取索引（必要时重建）。**名实相符**（CPLX-6）：每次调用都可能 `walk` 全库并
   * `stat` 每个文件；受 `config.indexTtlMs`（默认 2000ms）保护——TTL 内且会话
   * cwd 未变时直接复用缓存。写操作会显式失效；**未命中/找不到卡片的路径**用
   * `{ force: true }` 重扫一次（N3：TTL 窗口内也要看得见外部编辑）。
   */
  private async ensureIndex(sessionCwd?: string, opts: { force?: boolean } = {}): Promise<SearchIndex> {
    await this.assertVault()
    const cwdKey = sessionCwd ?? ''
    const ttl = this.layout.indexTtlMs ?? 2000
    this.servedFromCache = false
    if (!opts.force && this.index && this.sig !== null && cwdKey === this.lastScanCwd && ttl > 0 && Date.now() - this.lastScanMs < ttl) {
      this.servedFromCache = true
      return this.index
    }
    const roots = this.rootsFor(sessionCwd)
    const skipped: Array<{ path: string; reason: string }> = []
    const walked = await walkRoots(
      roots,
      skipSetFor(this.layout.skipDirs),
      (entry) => skipped.push(entry),
      this.layout.maxWalkFiles ?? MAX_WALK_FILES,
    )
    // 嵌套根（如 vault ⊆ cwd）会重复扫到同一文件：按规范化路径去重，vault 标签优先
    const files = dedupeFiles(walked)
    const sig = `${cwdKey}\n` + files.map((f) => `${f.root}|${f.rel}|${f.mtimeMs}|${f.ctimeMs}|${f.size}`).join('\n')
    if (this.index && sig === this.sig) {
      this.lastScanMs = Date.now()
      // cwd 同步回写：否则同一会话 cwd 永远命不中 TTL 缓存，每次调用都白扫一趟全库
      this.lastScanCwd = cwdKey
      this.skipped = skipped
      return this.index
    }
    const cards: IndexedCard[] = []
    for (const f of files) {
      try {
        // 4a：读盘量不退化，但索引**不再保存正文**（只留倒排 token），见架构选型 A4
        const { raw } = await readNoteSource(f.path)
        cards.push(indexNote(f, raw))
      } catch (error) {
        // 读取失败（锁定/删除）：计入 skipped 并回显，不再静默（BIZ-7）
        skipped.push({ path: f.path, reason: `文件读取失败（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）` })
      }
    }
    const multiRoot = roots.length > 1
    this.index = new SearchIndex()
    this.index.rebuild(cards, multiRoot)
    this.lastMultiRoot = multiRoot
    // 标题缓存整体重建（N2）：与 titleIndex 同语义（同名首见优先）
    this.titleHints.clear()
    for (const c of this.index.all()) {
      const key = c.title.trim().toLowerCase()
      if (key && !this.titleHints.has(key)) this.titleHints.set(key, { title: c.title, fullRel: c.fullRel, id: c.id })
    }
    this.sig = sig
    this.lastScanMs = Date.now()
    this.lastScanCwd = cwdKey
    this.skipped = skipped
    return this.index
  }

  /** 写操作前的可写性校验（EXT-5：可写性策略上移到根定义，不再散落各处） */
  private assertWritable(card: IndexedCard): void {
    if (card.writable) return
    throw new Error(`"${card.fullRel}" 位于只读检索根（${card.root}）：本插件只写 vault 内的文件`)
  }

  private async resolveCard(ref: string, sessionCwd?: string): Promise<{ card: IndexedCard; raw: string }> {
    const lookup = (index: SearchIndex): IndexedCard | undefined => index.byId(ref) ?? index.byTitle(ref) ?? byUniqueRef(index, ref)
    let index = await this.ensureIndex(sessionCwd)
    let card = lookup(index)
    if (!card && this.servedFromCache) {
      // TTL 窗口内可能刚被外部新建/改名（N3）：强制重扫一次再判"找不到卡片"
      index = await this.ensureIndex(sessionCwd, { force: true })
      card = lookup(index)
    }
    if (!card) {
      throw new Error(`找不到卡片 "${ref}"（可传 ID、标题、根限定路径 如 "工作目录/子目录/笔记.md"、相对路径或文件名）`)
    }
    const raw = await fsp.readFile(card.path, 'utf8')
    return { card, raw }
  }

  async search(query: string, opts: { domain?: string; status?: string; kind?: NoteKind; dirPath?: string; limit?: number } = {}, call?: { sessionCwd?: string }): Promise<string> {
    let index = await this.ensureIndex(call?.sessionCwd)
    let hits = index.search(query, opts)
    if (hits.length === 0 && this.servedFromCache) {
      // 未命中且上次走了缓存：强制重扫一次，避免"刚写进 vault 就搜不到"（N3）
      index = await this.ensureIndex(call?.sessionCwd, { force: true })
      hits = index.search(query, opts)
    }
    if (hits.length === 0) {
      return `未命中（共检索 ${index.size} 篇${this.indexScopes(index)}）。可换词再试；新概念直接进入讲解，归档时新建笔记。${this.noteSkips()}`
    }
    // snippet 只在命中前 N 篇时现读正文（PERF-6：旧实现对全部命中算 snippet 再丢弃）
    const tokens = SearchIndex.queryTokens(query)
    hits = await Promise.all(hits.map(async (hit) => {
      try {
        const body = parseFrontmatter(await fsp.readFile(hit.path, 'utf8')).body
        return { ...hit, snippet: snippetOf(body, tokens) }
      } catch {
        return hit
      }
    }))
    return `命中 ${hits.length}（共 ${index.size} 篇${this.indexScopes(index)}）：\n\n${fmtHits(hits)}${this.noteSkips()}`
  }

  private indexScopes(index: SearchIndex): string {
    const roots = index.roots()
    return roots.length > 0 ? `，来源：${roots.join(' / ')}` : ''
  }

  async get(ref: string, call?: { sessionCwd?: string }): Promise<string> {
    const { card, raw } = await this.resolveCard(ref, call?.sessionCwd)
    return `路径：${card.fullRel}\n\n${raw}`
  }



  private lintCtx(): { residueLevel?: 'off' | 'warn' | 'error'; rulesOff?: string[] } {
    return {
      residueLevel: this.layout.lint?.residueLevel,
      rulesOff: this.layout.lint?.rulesOff,
    }
  }

  /**
   * 从《笔记期望.md》解析出的检查项（`- [检查] 禁止/必须 …`）。
   *
   * 这一步让"检查什么"也走热配置：期望文件里没写规则时，`expect-rule` 会明确
   * 列为"未执行"而不是假装通过（N7）。
   */
  private async expectRules(): Promise<ExpectRule[]> {
    try {
      const raw = await fsp.readFile(this.expectPath(), 'utf8')
      return parseExpectRules(raw)
    } catch {
      return []
    }
  }

  /** 文档类型判定（三态）：有 ID 且有来源章节 = 块；有 ID = 存量卡；无 ID = 旧笔记 */
  private kindOf(card: { id: string | null; sourceSection: string | null }): LintReport['kind'] {
    if (!card.id) return 'note'
    return card.sourceSection ? 'block' : 'legacy'
  }

  /** 单篇报告：用刚从磁盘读到的原文（保证是最新版） */
  private async reportOfRaw(raw: string, card: IndexedCard): Promise<LintReport> {
    const parsed = parseFrontmatter(raw)
    return lintNote({
      title: parsed.meta?.title ?? card.title,
      summary: parsed.meta?.summary ?? card.definition ?? '',
      body: parsed.body,
    }, { ...this.lintCtx(), kind: this.kindOf(card), expectRules: await this.expectRules() })
  }

  /**
   * 批量报告：正文按需现读（A4 之后索引不再持有正文）。
   *
   * 代价是批量体检要逐篇读盘——这是"索引不常驻正文"的必然交换：内存从
   * 全库正文降到倒排表，而批量体检本来就是低频重操作。
   */
  private async reportOfIndexed(card: IndexedCard): Promise<LintReport> {
    let body = ''
    try {
      body = parseFrontmatter(await fsp.readFile(card.path, 'utf8')).body
    } catch (error) {
      this.skipped.push({ path: card.path, reason: `文件读取失败（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）` })
    }
    return lintNote({
      title: card.title,
      summary: card.definition ?? '',
      body,
    }, { ...this.lintCtx(), kind: this.kindOf(card), expectRules: await this.expectRules() })
  }

  /**
   * 质量体检（note_lint）。
   *
   * 2026-10：跨卡一致性 / 质量趋势 / 可执行性评级三个分析开关随模板与 100 分制一起
   * 退场（架构选型 A9 / §6.4）——它们的输入（模板、分值）已不存在。
   */
  async lint(opts: {
    ref?: string
    scope?: 'vault' | 'all'
    limit?: number
    rule?: string
  }, call?: { sessionCwd?: string }): Promise<string> {
    return opts.ref ? this.lintOne(opts, call) : this.lintBatch(opts, call)
  }

  private async lintOne(opts: { ref?: string; rule?: string }, call?: { sessionCwd?: string }): Promise<string> {
    const { card, raw } = await this.resolveCard(opts.ref ?? '', call?.sessionCwd)
    const report = await this.reportOfRaw(raw, card)
    if (opts.rule) {
      const hits = report.findings.filter((f) => f.rule === opts.rule)
      // 规则"跑过没有"要同时看 passed 与 findings：新报告里 `passed` 只收录**零发现**的
      // 规则，有发现的规则不在其中——只查 passed 会把"未通过"误报成"未启用"（本分支的坑）。
      const ran = report.passed[opts.rule] === true || hits.length > 0
      if (!ran) {
        return `笔记：${report.title}  规则：${opts.rule}  未启用或不适用于此类文档（检查 config.lint.rulesOff）`
      }
      return `笔记：${report.title}  规则：${opts.rule}  ${hits.length === 0 ? '✓ 通过' : '✗/⚠ 未通过'}\n`
        + (hits.length > 0 ? hits.map((f) => `  ${f.message}${f.suggestion ? `\n    建议：${f.suggestion}` : ''}`).join('\n') : '  （该规则无发现）')
    }
    return `${formatReport(report)}${this.noteSkips()}`
  }

  private async lintBatch(opts: {
    scope?: 'vault' | 'all'
    limit?: number
    rule?: string
  }, call?: { sessionCwd?: string }): Promise<string> {
    const index = await this.ensureIndex(call?.sessionCwd)
    // 默认只体检"块 + 存量卡"（有 ID）；scope='all' 才带上旧笔记
    const cards = index.all().filter((c) => (opts.scope === 'all' ? true : c.id !== null))
    if (cards.length === 0) return '未找到可体检的笔记。'
    const reports: LintReport[] = await Promise.all(cards.map((card) => this.reportOfIndexed(card)))
    if (opts.rule) {
      const hit = reports.filter((r) => r.findings.some((f) => f.rule === opts.rule))
      const lines = [`规则 ${opts.rule}（${ruleTitle(opts.rule)}）：${hit.length}/${reports.length} 篇命中`]
      for (const r of hit.slice(0, opts.limit ?? 20)) {
        for (const f of r.findings.filter((x) => x.rule === opts.rule)) lines.push(`  - ${r.title}：${f.message}`)
      }
      return lines.join('\n') + this.noteSkips()
    }
    return `${formatBatch(summarizeLint(reports), opts.limit ?? 20)}${this.noteSkips()}`
  }

  /**
   * 改名：**先算出全部改动并做完冲突校验，再落盘**（BIZ-2），
   * 落盘失败按已写文件逆序回滚。入链扫描用索引正文预筛（PERF-5）。
   */
  async rename(ref: string, newTitle: string, opts: { dryRun?: boolean; sessionCwd?: string } = {}): Promise<string> {
    let plan: RenameAction
    try {
      plan = await this.planRenameAction(ref, newTitle, opts.sessionCwd)
    } catch (error) {
      if (error instanceof SameTitleError) return error.message
      throw error
    }
    if (opts.dryRun) {
      return formatRenameReport({
        id: plan.id,
        oldTitle: plan.oldTitle,
        newTitle: plan.title,
        plan: plan.plan,
        filesChanged: plan.changed,
        broken: plan.broken,
        dryRun: true,
      })
    }
    return this.commitRename(plan)
  }

  private async planRenameAction(ref: string, newTitle: string, sessionCwd?: string): Promise<RenameAction> {
    // 改名是写操作：强制重扫索引，避免 TTL 窗口内拿到过期正文
    this.invalidate()
    const { card, raw } = await this.resolveCard(ref, sessionCwd)
    if (card.id === null) {
      throw new Error(`"${card.title}" 是旧笔记（无 ID），不支持改名；请用 Obsidian 重命名，或用 note_update(replace) 原地升级为块`)
    }
    this.assertWritable(card)
    const title = String(newTitle ?? '').trim()
    if (!title) throw new Error('newTitle 不能为空')
    if (/[\r\n]/.test(title)) throw new Error('newTitle 不能包含换行（会让 frontmatter 被截断）')
    const oldTitle = noteTitleOf(raw) || card.title
    if (title === oldTitle) throw new SameTitleError(`新标题与旧标题相同（${title}），无改动。`)
    const index = await this.ensureIndex(sessionCwd)
    const clash = index.byTitle(title)
    if (clash && clash.id !== card.id) throw new Error(`已存在同名卡片 "${title}"（${clash.fullRel}），请换标题`)
    const plan = planRename({ fileName: card.fileName, oldTitle, newTitle: title })
    const rewritten = replaceNoteTitle(raw, title)
    const selfRewrite = rewriteLinkLines(parseFrontmatter(rewritten).body, { oldTitle, newTitle: title, targetId: card.id ?? undefined })
    const selfText = `${rewritten.slice(0, rewritten.length - parseFrontmatter(rewritten).body.length)}${selfRewrite.text}`
    // 断链检测对象是**本卡改写后的正文**（BIZ-10：旧实现检测的是别人文件）
    const broken: BrokenLinkHit[] = detectBrokenLinks(selfRewrite.text, { oldTitle, oldId: card.id ?? undefined, newTitle: title })
    const changed: RenameChange[] = [{ rel: card.fullRel, kind: '本卡标题', changed: 1, samples: [`${oldTitle} → ${title}`] }]
    if (selfRewrite.changed > 0) {
      changed.push({ rel: card.fullRel, kind: '本卡关联卡片', changed: selfRewrite.changed, samples: selfRewrite.samples })
    }
    const writes: Array<{ path: string; text: string }> = []
    const needles = [oldTitle, plan.oldBase, card.id].filter(Boolean) as string[]
    for (const other of index.all()) {
      if (canonicalRootKey(other.path) === canonicalRootKey(card.path)) continue
      // 预筛说明：A4 之后索引不再持有正文，无法再用"正文不含待改字面量就跳过"。
      // 改为**不预筛**（索引里仍有的元数据不足以判断 wikilink 的目标名）——改名的
      // 正确性优先于省几次读盘，且只有真的改动了（freshChanged > 0）才会进写入计划。
      let otherBody = ''
      try {
        otherBody = parseFrontmatter(await fsp.readFile(other.path, 'utf8')).body
      } catch (error) {
        this.skipped.push({ path: other.path, reason: `文件读取失败（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）` })
        continue
      }
      void needles
      const linkRewrite = rewriteLinkLines(otherBody, { oldTitle, newTitle: title, targetId: card.id ?? undefined })
      let nextBody = linkRewrite.text
      let changedCount = linkRewrite.changed
      const samples = [...linkRewrite.samples]
      if (other.id !== null) {
        const wiki = rewriteWikilinks(nextBody, plan.oldBase, plan.newBase)
        nextBody = wiki.text
        changedCount += wiki.changed
        samples.push(...wiki.samples)
      }
      // 断链检测对该文件**总是**执行（BIZ-10）：裸标题入链不会被 rewriteCardLinks 改写，
      // 但正是"改名后仍指向旧标题"的断链，必须在报告里出现
      const brokenHere = detectBrokenLinks(nextBody, { oldTitle, oldId: card.id ?? undefined, newTitle: title, checkFormat: false })
      if (!other.writable) {
        // 只读根：报告但不读盘、不写入（EXT-5 / PERF-5）
        if (changedCount > 0) changed.push({ rel: other.fullRel, kind: `只读根(${other.root}) 未写入`, changed: changedCount, samples })
        broken.push(...brokenHere)
        continue
      }
      // 读盘兜底：索引正文可能落后于磁盘，写入前重算一次
      let content = ''
      try {
        content = await fsp.readFile(other.path, 'utf8')
      } catch (error) {
        // 必须 push（而不是替换）：跳过清单属于上面那次 ensureIndex 产出的索引代，
        // 这里是"同一代索引里又一次读盘失败"，清空会丢掉扫描阶段已上报的跳过项（BIZ-7）
        this.skipped.push({ path: other.path, reason: `文件读取失败（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）` })
        continue
      }
      const parsed = parseFrontmatter(content)
      const fresh = rewriteLinkLines(parsed.body, { oldTitle, newTitle: title, targetId: card.id ?? undefined })
      let freshBody = fresh.text
      let freshChanged = fresh.changed
      const freshSamples = [...fresh.samples]
      if (other.id !== null) {
        const wiki = rewriteWikilinks(freshBody, plan.oldBase, plan.newBase)
        freshBody = wiki.text
        freshChanged += wiki.changed
        freshSamples.push(...wiki.samples)
      }
      broken.push(...detectBrokenLinks(freshBody, { oldTitle, oldId: card.id ?? undefined, newTitle: title, checkFormat: false }))
      if (freshChanged === 0) continue
      const fileHead = content.slice(0, content.length - parsed.body.length)
      writes.push({ path: other.path, text: `${fileHead}${freshBody}` })
      changed.push({ rel: other.fullRel, kind: other.id !== null ? '笔记入链' : '旧笔记入链', changed: freshChanged, samples: freshSamples })
    }
    // ── 全部冲突校验前置（BIZ-2）：任何写入之前完成 ──
    let targetPath: string | null = null
    if (plan.renameFile) {
      const candidate = join(card.path.slice(0, card.path.length - card.fileName.length), `${plan.newBase}.md`)
      if (canonicalRootKey(candidate) !== canonicalRootKey(card.path)) {
        if (await this.fileExists(candidate)) {
          throw new Error(`目标文件名已存在：${plan.newBase}.md（请先处理同名文件）；未做任何写入`)
        }
        targetPath = candidate
      }
    }
    return { id: card.id, card, oldTitle, title, plan, selfText: `${selfText}\n`, writes, changed, broken, targetPath }
  }

  /** 提交改名：写本卡 → 写全库入链 → 改文件名；任一失败按已写文件回滚 */
  private async commitRename(action: RenameAction): Promise<string> {
    const notes: string[] = []
    const targets: Array<{ path: string; text: string }> = [
      { path: action.card.path, text: action.selfText },
      ...action.writes,
    ]
    const backups: Array<{ path: string; content: string | null }> = []
    const written: string[] = []
    try {
      for (const target of targets) {
        let before: string | null = null
        try {
          before = await fsp.readFile(target.path, 'utf8')
        } catch {
          before = null
        }
        backups.push({ path: target.path, content: before })
        await atomicWrite(target.path, target.text)
        written.push(target.path)
      }
    } catch (error) {
      // 回滚：把已写文件恢复成写前内容（读失败的新建文件则删除）
      for (const backup of [...backups].reverse()) {
        try {
          if (backup.content === null) await fsp.rm(backup.path, { force: true })
          else await atomicWrite(backup.path, backup.content)
        } catch {
          notes.push(`⚠ 回滚失败：${backup.path}（请检查该文件）`)
        }
      }
      this.invalidate()
      throw new Error(`改名失败并已回滚：${(error as Error).message}`)
    }
    let finalRel = action.card.rel.replace(/\\/g, '/')
    if (action.targetPath) {
      try {
        await atomicWrite(action.targetPath, action.selfText)
        await fsp.rm(action.card.path, { force: true })
        finalRel = action.targetPath.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, '/')
      } catch (error) {
        // 改名阶段失败：清掉可能已写的新文件，并把已写文件全部恢复原状
        await fsp.rm(action.targetPath, { force: true }).catch(() => {})
        for (const backup of [...backups].reverse()) {
          try {
            if (backup.content !== null) await atomicWrite(backup.path, backup.content)
          } catch {
            notes.push(`⚠ 回滚失败：${backup.path}（请检查该文件）`)
          }
        }
        this.invalidate()
        throw new Error(`改名失败并已回滚：${(error as Error).message}`)
      }
    }
    this.invalidate()
    // 标题缓存换键（N2）：旧标题 → 新标题，避免同名提示指向已改名的卡
    this.rememberTitle(action.title, this.displayRel(finalRel), action.id, action.oldTitle)
    const report = formatRenameReport({
      id: action.id,
      oldTitle: action.oldTitle,
      newTitle: action.title,
      plan: action.plan,
      filesChanged: action.changed,
      broken: action.broken,
      dryRun: false,
      notes,
    })
    return `${report}\n已写入：${finalRel}${this.noteSkips()}`
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fsp.access(path)
      return true
    } catch {
      return false
    }
  }

  // ── 文档式笔记工具（阶段 4b）────────────────────────────────────────────
  // 设计要点（架构选型 §5 / §6）：门禁在**工具侧**强制，状态落 `.study/`
  // （磁盘唯一真相的延伸）；每条失败都带修复步骤，避免把用户永久锁在门外。

  /** `session.json` 的绝对路径（门禁状态文件） */
  private sessionFile(): string {
    return sessionFileFor(this.layout.vaultRoot, this.layout.stateDir)
  }

  /** 读会话门禁状态（`session.json`；损坏回空态，不阻断） */
  private async sessionState(): Promise<SessionState> {
    return readSession(this.sessionFile())
  }

  /** 期望文件名（配置 `expectFile`，默认 `笔记期望.md`） */
  private expectFileName(): string {
    return this.layout.expectFile ?? EXPECT_FILE
  }

  /** 《笔记期望.md》的绝对路径（文件名由配置 `expectFile` 决定） */
  private expectPath(): string {
    return expectPathFor(this.layout.vaultRoot, this.expectFileName())
  }

  /** 当前《笔记期望.md》的文件签名（`null` = 文件不存在） */
  private async expectSignature(): Promise<string | null> {
    return signatureOf(this.expectPath())
  }

  /** 组装门禁输入（三连校验共用） */
  private async gateInput(): Promise<GateInput> {
    return {
      vaultRoot: this.layout.vaultRoot,
      stateDir: this.layout.stateDir,
      session: await this.sessionState(),
      expectSignature: await this.expectSignature(),
      planTtlHours: this.layout.planTtlHours,
    }
  }

  /** `note_library`：库状态与期望文件自检（硬门禁的第一环） */
  async noteLibrary(action: string): Promise<string> {
    if (action !== 'check') throw new Error(`note_library 未知 action "${action}"（当前只支持 check）`)
    await this.assertVault()
    const signature = await this.expectSignature()
    const session = await this.sessionState()
    const index = await this.ensureIndex()
    const blocks = index.all().filter((c) => c.kind === 'block').length
    const legacy = index.all().filter((c) => c.kind === 'legacy').length
    const notes = index.all().filter((c) => c.kind === 'note').length
    const lines = [
      `## 笔记库状态`,
      '',
      `- vault 根：${this.layout.vaultRoot}（可读可写）`,
      `- 状态目录：${this.layout.stateDir}/（进度、记忆、规划、存档；删掉不丢笔记）`,
      `- 笔记：块 ${blocks} 篇、存量卡 ${legacy} 篇、旧笔记 ${notes} 篇`,
      `- 领域快捷方式：${Object.keys(this.layout.domainFolders ?? {}).length} 个（落盘目录以规划确认为准）`,
      '',
      signature === null
        ? `⚠ 笔记期望文件不存在：${this.expectFileName()}（应在 vault 根）——请先把 presets/study/assets/笔记期望.md 复制到 vault 根并改成你的写法，否则无法写入`
        : session.expect?.signature === signature
          ? `- 笔记期望：已读（${this.expectFileName()}）`
          : `⚠ 笔记期望尚未读取（或已更新）：请调用 note_expect_get 读取后再写入`,
      session.activePlanId ? `- 待消费规划：${session.activePlanId}` : '- 待消费规划：无',
      this.noteSkips(),
    ]
    return lines.filter((l) => l !== '').join('\n')
  }

  /** `note_expect_get`：读期望全文并**标记已读**（门禁开门动作） */
  async noteExpectGet(): Promise<string> {
    await this.assertVault()
    const expectPath = this.expectPath()
    let raw: string
    try {
      raw = await fsp.readFile(expectPath, 'utf8')
    } catch {
      throw new Error(
        `${this.expectFileName()} 不存在（期望路径：${expectPath}）——请先把 presets/study/assets/笔记期望.md 复制到 vault 根并改成你的写法。`
        + '笔记写法只从这份文件来，代码里没有内建模板。',
      )
    }
    const signature = await signatureOf(expectPath)
    if (signature) await markExpectRead(this.sessionFile(), { signature, rel: EXPECT_FILE })
    return `已读取笔记期望：${this.expectFileName()}（${raw.split(/\r?\n/).length} 行）\n\n${raw}`
  }

  /**
   * `note_list`：逐层导航（子目录 + 该层笔记；**不读正文**，只读 frontmatter 头）。
   *
   * 两个刻意的口径：
   * - 目录计数与"有无微目录"都按**子树累加**（父级只放章节标题时，其下几层才是块）；
   * - vault 根的《笔记期望.md》不是笔记，不列出来（否则每次导航都多一行噪声）。
   */
  async noteList(opts: { path?: string; depth?: number } = {}): Promise<string> {
    await this.assertVault()
    const dir = normRel(opts.path ?? '')
    const depth = Math.max(1, Math.min(Number(opts.depth) || 2, 4))
    const index = await this.ensureIndex()
    const lines: string[] = [`## ${dir || '（vault 根）'}`]
    const dirIndex = this.dirIndexFor(index)
    const listing = await listDir(this.layout.vaultRoot, dir)
    for (const sub of listing.subdirs) {
      const stat = dirIndex.countAt(sub)
      const parts = [
        stat.blocks > 0 ? `块 ${stat.blocks}` : '',
        stat.legacy > 0 ? `存量卡 ${stat.legacy}` : '',
        stat.notes > 0 ? `旧笔记 ${stat.notes}` : '',
      ].filter(Boolean).join('、')
      // 子树里任何一层有微目录都算"有入口"（父级目录本身通常只放章节标题）
      const warn = dirIndex.hasTocIn(sub) ? '' : '  ⚠ 缺微目录'
      lines.push(`- 📁 ${sub}/（${parts || '空'}）${warn}`)
      if (depth > 1) {
        const nested = await listDir(this.layout.vaultRoot, sub)
        for (const n of nested.subdirs) lines.push(`  - 📁 ${n}/`)
        for (const f of nested.files) lines.push(`  - ${fmtListFile(f)}`)
      }
    }
    for (const f of listing.files) {
      if (f.fileName === EXPECT_FILE) continue
      lines.push(`- ${fmtListFile(f)}`)
    }
    if (listing.subdirs.length === 0 && listing.files.filter((f) => f.fileName !== EXPECT_FILE).length === 0) lines.push('（空目录）')
    lines.push('', nestHint(dir) || '提示：进入某主题目录后，微目录.md 是该主题的导航入口。')
    return lines.filter((l) => l !== '').join('\n') + this.noteSkips()
  }

  /** 由索引构建目录索引（A6：重建时整体构建，写入后增量维护） */
  private dirIndexFor(index: SearchIndex): DirIndex {
    const dirIndex = new DirIndex()
    for (const card of index.all()) {
      if (card.root !== 'vault') continue
      dirIndex.add(card.rel, card.kind)
    }
    return dirIndex
  }

  /** `note_overview`：主题块清单 + 按来源章节的覆盖情况 */
  /** `note_overview`：主题块清单 + 按来源章节的覆盖情况（聚合在 overview.ts，纯函数） */
  async noteOverview(opts: { path?: string; material?: string } = {}): Promise<string> {
    await this.assertVault()
    const base = normRel(opts.path ?? '')
    const files = await walkNotes(this.layout.vaultRoot, base)
    const result = summarizeOverview(files, { material: opts.material })
    return `${formatOverview(result, { scope: base || '整个库' })}${this.noteSkips()}`
  }

  /**
   * `note_plan`：文件夹规划提案与确认（提案只在对话里，不落盘，需求 R11）。
   *
   * 三个动作共用 `rootPath` 入参（`create` 传规划根，`confirm` / `abandon` 传 planId）：
   * 工具 schema 的必填集合因此不必随动作变化，模型也能只靠提案回显完成后续动作。
   * **确认才置位 `confirmed`**——门禁的第二环由 `action=confirm` 打开，且有效期从
   * 确认时刻重新起算（搁置过久的提案要先重新提案，不把有效期变成"提案起算"）。
   */
  async notePlan(args: {
    action?: string
    rootPath?: string
    items?: Array<{ title?: string; path?: string; sourceSection?: string; order?: number }>
    material?: string
    notes?: string
  }): Promise<string> {
    await this.assertVault()
    const action = args.action ?? 'create'
    if (action === 'abandon') {
      const planId = String(args.rootPath ?? '').trim()
      if (!planId) throw new Error('note_plan(action=abandon) 需要把 rootPath 传成要放弃的 planId')
      await abandonPlan(planFileFor(this.layout.vaultRoot, planId, this.layout.stateDir))
      const session = await this.sessionState()
      if (session.activePlanId === planId) await writeSession(this.sessionFile(), { ...session, activePlanId: undefined })
      return `已放弃规划：${planId}`
    }
    if (action === 'confirm') {
      const planId = String(args.rootPath ?? '').trim()
      if (!planId) throw new Error('note_plan(action=confirm) 需要把 rootPath 传成要确认的 planId')
      // 常见误用是把规划根目录当成 planId 传进来：先给一句可自我纠正的话，不让它落到"id 非法"的泛化报错
      if (dirOfRel(planId) !== '') {
        throw new Error(`规划 id 非法："${planId}" 看着像目录——请把 note_plan 返回的 planId（形如 202610241430_ab12cd）原样传入`)
      }
      const file = planFileFor(this.layout.vaultRoot, planId, this.layout.stateDir)
      const record = await readPlan(file)
      if (!record) throw new Error(`规划不存在或已损坏：${planId}——请重新调用 note_plan 提案`)
      if (record.confirmed) {
        return `规划已确认（planId：${planId}），直接 note_write 逐个落盘即可。`
      }
      const ttl = this.layout.planTtlHours ?? DEFAULT_PLAN_TTL_HOURS
      if (isPlanExpired(record, ttl)) {
        const created = Date.parse(record.createdAt)
        const at = Number.isFinite(created) ? new Date(created).toLocaleString('zh-CN') : record.createdAt
        // 过期即拒绝且**不改任何状态**：否则"过期确认"与"有效期从确认时刻起算"会自相矛盾
        throw new Error(
          `规划已过期（提案于 ${at}，超过 ${ttl} 小时未确认，planId：${planId}）——请重新调用 note_plan 提案并确认`,
        )
      }
      const now = new Date()
      // 用户确认是凭据生效的时刻：有效期从这里重新起算，否则搁置过久的提案会在确认后立刻失效
      record.confirmed = true
      record.confirmedAt = now.toISOString()
      record.createdAt = now.toISOString()
      await writePlan(file, record)
      const session = await this.sessionState()
      await writeSession(this.sessionFile(), { ...session, activePlanId: planId })
      const remaining = record.items.map((it) => it.title)
      return [
        `已确认规划（planId：${planId}）`,
        `- 规划根：${record.rootPath || '（vault 根）'}`,
        `- 待落块 ${remaining.length} 项：${remaining.join('、')}`,
        `- 有效期自确认时刻起算：${ttl} 小时`,
        '',
        '现在可以用该 planId 调 note_write 逐个落盘；结构要改就重新 note_plan 提案（会得到新的 planId）。',
      ].join('\n')
    }
    if (action !== 'create') throw new Error(`note_plan 未知 action "${action}"（可用 create / confirm / abandon）`)
    const rootPath = normRel(args.rootPath ?? '')
    const items = (args.items ?? []).map((it) => ({
      title: String(it.title ?? '').trim(),
      path: normRel(it.path ?? ''),
      ...(it.sourceSection ? { sourceSection: String(it.sourceSection) } : {}),
      ...(typeof it.order === 'number' ? { order: it.order } : {}),
    }))
    if (items.length === 0) {
      throw new Error('note_plan 需要 items（至少一个待落块：{ title, path }）；path 是 vault 内相对路径（含文件名）')
    }
    const record = buildPlanRecord({ rootPath, items, material: args.material, notes: args.notes })
    const file = planFileFor(this.layout.vaultRoot, record.planId, this.layout.stateDir)
    // 复用判断：规划里已存在的目录（只读探测，不创建——"没确认的东西不落盘"）
    const reused: string[] = []
    for (const dir of [...new Set(items.map((it) => dirOfRel(it.path)))]) {
      try {
        await fsp.access(dirPathFor(this.layout.vaultRoot, dir))
        reused.push(dir)
      } catch {
        // 目录不存在：算新建
      }
    }
    await writePlan(file, record)
    const session = await this.sessionState()
    await writeSession(this.sessionFile(), { ...session, activePlanId: record.planId })
    const proposal = formatPlanProposal(record, { reusedDirs: reused })
    return `${proposal}\n\n（planId：${record.planId}；**用户拍板后**先 note_plan({ action: "confirm", rootPath: "${record.planId}" }) 确认，再逐个 note_write 落盘）`
  }

  /** `note_write`：落一个块（硬门禁三连校验 + 规划消费记账） */
  async noteWrite(input: {
    planId: string
    title: string
    source: string
    content: string
    path: string
    domain?: string
    status?: string
    sourceSection?: string
    order?: number
    summary?: string
    tags?: string[]
    links?: BlockLinks
    dryRun?: boolean
  }): Promise<string> {
    await this.assertVault()
    const targetRel = normRel(input.path)
    if (!targetRel.endsWith('.md')) throw new Error(`path 必须是 vault 内的 .md 相对路径，收到：${input.path}`)
    const gate = await checkWrite({ ...(await this.gateInput()), targetRel })
    if (!gate.ok) throw new Error(`写入被门禁拒绝：${gate.reason}`)
    const file = planFileFor(this.layout.vaultRoot, input.planId, this.layout.stateDir)
    const plan = await readPlan(file)
    if (!plan || plan.planId !== input.planId) throw new Error(`规划不存在：${input.planId}——请先 note_plan 提案并确认`)
    const planned = plan.items.find((it) => it.title === input.title)
    if (!planned) throw new Error(`"${input.title}" 不在本次规划内——请重新规划（note_plan）`)
    const blockInput: BlockInput = {
      title: input.title,
      source: input.source,
      content: input.content,
      domain: input.domain,
      status: input.status,
      sourceSection: input.sourceSection ?? planned.sourceSection,
      order: input.order ?? planned.order,
      summary: input.summary,
      tags: input.tags,
      links: input.links,
    }
    const result = validateBlock(blockInput)
    if (result.errors.length > 0) throw new Error(`笔记校验失败：${result.errors.join('；')}`)
    const abs = resolve(this.layout.vaultRoot, targetRel)
    if (!withinRoot(this.layout.vaultRoot, abs)) throw new Error(`落盘路径越界：${targetRel}`)
    const exists = await fsp.access(abs).then(() => true).catch(() => false)
    if (exists) throw new Error(`目标已存在：${targetRel}——如需改写请用 note_update，避免覆盖`)
    if (input.dryRun) {
      return `[dryRun] 将写入：${targetRel}（规划 ${input.planId}；未落盘）\n\n${renderNote({ ...blockInput, id: '（dryRun）' })}`
    }
    const consumed = await consumePlanItem(file, input.title, targetRel, { ttlHours: this.layout.planTtlHours })
    if (!consumed.ok) throw new Error(`写入被拒绝：${consumed.reason}`)
    const id = generateId()
    const text = renderNote({ ...blockInput, id })
    await atomicWrite(abs, text)
    this.invalidate()
    const dir = dirOfRel(targetRel)
    const dirIndex = this.dirIndexFor(await this.ensureIndex())
    const needToc = dir !== '' && !dirIndex.statOf(dir).hasToc
    const warn = result.warnings.length > 0 ? `\n提示：${result.warnings.join('；')}` : ''
    const tocLine = needToc ? `\n⚠ 该目录还没有微目录：请调用 note_toc({ dir: "${dir}" }) 生成，否则导航入口缺失` : ''
    return `已写入：${targetRel}\nID：${id}\n规划：${input.planId}（剩余 ${plan.items.length - plan.consumed.length - 1} 项）${warn}${tocLine}\n\n${text}`
  }

  /** `note_update`：append（补充）/ replace（替换，先存档）/ move（迁目录） */
  async noteUpdate(args: {
    ref: string
    action: string
    changes?: string
    section?: string
    newContent?: string
    summary?: string
    targetPath?: string
    sourceSection?: string
    dryRun?: boolean
  }, call?: { sessionCwd?: string }): Promise<string> {
    const action = String(args.action ?? '')
    if (!['append', 'replace', 'move', 'definition'].includes(action)) {
      throw new Error(`note_update 未知 action "${action}"（可用 append / replace / move / definition）`)
    }
    const { card, raw } = await this.resolveCard(args.ref, call?.sessionCwd)
    this.assertWritable(card)
    if (action === 'append') {
      const result = applyNoteUpdate(raw, card.id ?? args.ref, { action: 'append', changes: args.changes, section: args.section })
      await atomicWrite(card.path, result.text)
      this.invalidate()
      return `已更新：${card.rel}（补充${args.section ? `到「${args.section}」` : '到末尾'}）\n\n${result.text}`
    }
    if (action === 'definition') {
      const result = applyNoteUpdate(raw, card.id ?? args.ref, { action: 'definition', summary: args.summary })
      await atomicWrite(card.path, result.text)
      this.invalidate()
      return `已更新：${card.rel}（仅替换一句话定位）\n\n${result.text}`
    }
    if (action === 'move') {
      const targetRel = normRel(args.targetPath ?? '')
      if (!targetRel.endsWith('.md')) throw new Error(`move 需要 targetPath（vault 内 .md 相对路径）`)
      const abs = resolve(this.layout.vaultRoot, targetRel)
      if (!withinRoot(this.layout.vaultRoot, abs)) throw new Error(`目标路径越界：${targetRel}`)
      const busy = await fsp.access(abs).then(() => true).catch(() => false)
      if (busy) throw new Error(`目标已存在：${targetRel}`)
      if (args.dryRun) return `[dryRun] 将移动：${card.rel} → ${targetRel}（未落盘）`
      await ensureDir(dirname(abs))
      await atomicWrite(abs, raw)
      await fsp.rm(card.path, { force: true })
      this.invalidate()
      return `已移动：${card.rel} → ${targetRel}\n提示：若该主题目录还没有微目录，请调用 note_toc 生成`
    }
    // replace：先存档、后写正文（需求 N1 的关键不变量）
    if (!args.newContent?.trim()) throw new Error('replace 需要 newContent（新正文）')
    if (args.dryRun) {
      return `[dryRun] 将替换：${card.rel}（旧正文会先存档到 ${this.layout.stateDir}/archive/${card.id ?? 'legacy'}/）`
    }
    const blockInput: BlockInput = {
      title: card.title,
      source: card.source ?? '',
      content: args.newContent,
      domain: card.domain ?? undefined,
      status: card.status ?? undefined,
      sourceSection: args.sourceSection ?? card.sourceSection ?? undefined,
      order: card.order ?? undefined,
      summary: args.summary ?? card.definition ?? undefined,
    }
    const result = validateBlock(blockInput)
    if (result.errors.length > 0) throw new Error(`替换内容校验失败：${result.errors.join('；')}`)
    const entry = await archiveThenWrite({
      vaultRoot: this.layout.vaultRoot,
      stateDir: this.layout.stateDir,
      fromId: card.id ?? 'legacy',
      oldRel: card.rel,
      title: card.title,
      reason: 'replace 替换正文',
      oldContent: raw,
      write: async () => { await atomicWrite(card.path, renderNote({ ...blockInput, id: card.id ?? generateId() })) },
    })
    this.invalidate()
    return `已更新：${card.rel}\n旧正文已存档：${this.layout.stateDir}/archive/${card.id ?? 'legacy'}/${entry.id}.md（note_history 可查看、note_restore 可恢复）\n\n${renderNote({ ...blockInput, id: card.id ?? '' })}`
  }

  /** `note_history`：列出/读取某篇笔记的历史存档 */
  async noteHistory(ref: string, opts: { action?: string; archiveId?: string } = {}, call?: { sessionCwd?: string }): Promise<string> {
    const { card } = await this.resolveCard(ref, call?.sessionCwd)
    const action = opts.action ?? 'list'
    const entries = await listArchives(this.layout.vaultRoot, card.id ?? 'legacy', this.layout.stateDir)
    if (action === 'read') {
      if (!opts.archiveId) throw new Error('note_history(action=read) 需要 archiveId（先用 action=list 查看）')
      const found = await readArchive(this.layout.vaultRoot, card.id ?? 'legacy', opts.archiveId, this.layout.stateDir)
      if (!found) throw new Error(`存档不存在：${opts.archiveId}`)
      return `${found.raw}`
    }
    if (action !== 'list') throw new Error(`note_history 未知 action "${action}"（可用 list / read）`)
    if (entries.length === 0) return `笔记：${card.title} 没有历史存档（替换正文时才会产生）。`
    const lines = [`## ${card.title} 的历史存档（${entries.length} 份，新→旧）`]
    for (const e of entries) {
      lines.push(`- ${e.id}｜${e.meta.archivedAt || '—'}｜${e.meta.reason || '未注明原因'}｜原路径 ${e.meta.oldRel || '—'}`)
    }
    lines.push('', '用 note_history({ ref, action: "read", archiveId }) 看全文；用 note_restore 恢复。')
    return lines.join('\n')
  }

  /** `note_restore`：恢复某份存档（当前正文先转入存档，绝不丢内容） */
  async noteRestore(ref: string, opts: { archiveId?: string; dryRun?: boolean } = {}, call?: { sessionCwd?: string }): Promise<string> {
    const { card, raw } = await this.resolveCard(ref, call?.sessionCwd)
    this.assertWritable(card)
    const id = card.id ?? 'legacy'
    const entries = await listArchives(this.layout.vaultRoot, id, this.layout.stateDir)
    if (entries.length === 0) throw new Error(`笔记：${card.title} 没有历史存档可恢复`)
    const archiveId = opts.archiveId ?? entries[0].id
    const found = await readArchive(this.layout.vaultRoot, id, archiveId, this.layout.stateDir)
    if (!found) throw new Error(`存档不存在：${archiveId}（先用 note_history(action=list) 查看）`)
    const restored = archiveBody(found.raw)
    if (!restored.trim()) throw new Error(`存档内容为空：${archiveId}`)
    if (opts.dryRun) {
      return `[dryRun] 将把 ${card.rel} 恢复为存档 ${archiveId}（${found.entry.meta.archivedAt}）：\n\n${restored}`
    }
    const entry = await archiveThenWrite({
      vaultRoot: this.layout.vaultRoot,
      stateDir: this.layout.stateDir,
      fromId: id,
      oldRel: card.rel,
      title: card.title,
      reason: `恢复存档 ${archiveId} 前的当前版本`,
      oldContent: raw,
      write: async () => { await atomicWrite(card.path, restored.endsWith('\n') ? restored : `${restored}\n`) },
    })
    this.invalidate()
    return `已恢复：${card.rel} ← 存档 ${archiveId}\n恢复前的版本已存档：${entry.id}（可再恢复回来）\n\n${restored}`
  }

  /** `note_toc`：生成/刷新某目录的微目录（只重写生成段，用户手写段保留） */
  async noteToc(dir: string, opts: { dryRun?: boolean; title?: string } = {}): Promise<string> {
    await this.assertVault()
    const norm = normRel(dir)
    if (norm === '') throw new Error('note_toc 需要 dir（要生成微目录的主题目录，vault 内相对路径）')
    const listing = await listDir(this.layout.vaultRoot, norm)
    const blocks = listing.files.filter((f) => f.kind !== 'note')
    if (blocks.length === 0) throw new Error(`目录里没有带 ID 的笔记，无法生成微目录：${norm}`)
    const tocPath = join(dirPathFor(this.layout.vaultRoot, norm), TOC_FILE)
    let custom = ''
    try {
      const existing = await fsp.readFile(tocPath, 'utf8')
      const m = /<!--\s*note_toc:begin\s*-->([\s\S]*?)<!--\s*note_toc:end\s*-->/.exec(existing)
      const before = existing.split(/<!--\s*note_toc:begin\s*-->/)[0]
      custom = before.replace(/^#.*$/m, '').trim()
      if (!m) custom = before.trim()
    } catch {
      // 首次生成
    }
    const lines: string[] = [`# ${opts.title ?? basename(norm)}`, '']
    if (custom) lines.push(custom, '')
    lines.push('<!-- note_toc:begin -->')
    blocks.forEach((f, i) => {
      const summary = f.summary ? ` —— ${f.summary}` : ''
      const section = f.sourceSection ? `（${f.sourceSection.split('/').pop()?.trim() ?? ''}）` : ''
      lines.push(`${i + 1}. [[${f.fileName.replace(/\.md$/i, '')}]]${section}${summary}`)
    })
    lines.push('<!-- note_toc:end -->', '')
    const text = lines.join('\n')
    if (opts.dryRun) return `[dryRun] 将写入 ${norm}/${TOC_FILE}（收录 ${blocks.length} 块）：\n\n${text}`
    await atomicWrite(tocPath, text)
    this.invalidate()
    return `已生成：${norm}/${TOC_FILE}（收录 ${blocks.length} 块）\n\n${text}`
  }

  /** `note_link` / `note_unlink`：wikilink 关联的双向增删（先校验后写盘） */
  async noteLink(fromRef: string, toRef: string, kind: LinkKind, remove = false, call?: { sessionCwd?: string }): Promise<string> {
    if (!['prev', 'next', 'sibling'].includes(kind)) {
      throw new Error(`kind 只接受 prev/next/sibling，收到 "${String(kind)}"`)
    }
    const from = await this.resolveCard(fromRef, call?.sessionCwd)
    const to = await this.resolveCard(toRef, call?.sessionCwd)
    if (canonicalRootKey(from.card.path) === canonicalRootKey(to.card.path)) {
      return `无需自关联：「${from.card.title}」与目标是同一篇笔记（${from.card.fullRel}）。`
    }
    const labelOf = (title: string, fileName: string) => fileName.replace(/\.md$/i, '') || title
    const target = labelOf(to.card.title, to.card.fileName)
    const reverse = inverseKind(kind)
    const apply = (raw: string, k: LinkKind, label: string): string => (
      remove ? removeLink(raw, label) : addLink(raw, k, label)
    )    // ── 先规划、后提交（N1：只读根在**任何写入之前**就拒绝，不留半写盘）──
    const plans: Array<{ path: string; next: string; before: string; label: string }> = []
    for (const [side, k, label] of [
      [from, kind, target] as const,
      [to, reverse, labelOf(from.card.title, from.card.fileName)] as const,
    ]) {
      if (side.card.id === null && this.layout.linkIntoNotes !== true) continue
      const next = apply(side.raw, k, label)
      if (next === side.raw) continue
      this.assertWritable(side.card)
      plans.push({ path: side.card.path, next, before: side.raw, label: side.card.fullRel })
    }
    if (plans.length === 0) {
      return `无改动：${remove ? '关联不存在或' : '关联已存在'}（${from.card.title} ↔ ${to.card.title}）`
    }
    const done: Array<{ path: string; before: string }> = []
    try {
      for (const plan of plans) {
        await atomicWrite(plan.path, plan.next)
        done.push({ path: plan.path, before: plan.before })
      }
    } catch (error) {
      for (const d of [...done].reverse()) await atomicWrite(d.path, d.before).catch(() => {})
      this.invalidate()
      throw new Error(`${remove ? '移除' : '建立'}关联失败并已回滚：${(error as Error).message}`)
    }
    this.invalidate()
    return `${remove ? '已移除关联' : '已建立关联'}：${from.card.title} ←${LINK_LABELS[kind]}→ ${to.card.title}（改动 ${plans.length} 侧：${plans.map((p) => p.label).join('、')}）`
  }

  async progress(action: string, fields: {
    material?: string
    section?: string
    pendingQuestions?: string[]
    touchedCardIds?: string[]
  }): Promise<string> {
    if (!['get', 'set', 'clear'].includes(action)) {
      throw new Error(`study_progress 未知 action "${action}"（可用 get/set/clear）`)
    }
    const file = this.stateFile()
    await this.assertVault()
    if (action === 'clear') {
      await writeProgress(file, {})
      return '学习进度已清空。'
    }
    const current = await readProgress(file)
    if (action === 'get') return fmtProgress(current)
    const next: ProgressState = { ...current }
    if (fields.material !== undefined) next.currentMaterial = String(fields.material).trim()
    if (fields.section !== undefined) next.currentSection = String(fields.section).trim()
    if (fields.pendingQuestions !== undefined) next.pendingQuestions = normalizeQueue(fields.pendingQuestions, 'pendingQuestions')
    if (fields.touchedCardIds !== undefined) next.touchedCardIds = normalizeQueue(fields.touchedCardIds, 'touchedCardIds')
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

  /** `study_memory get`：单键或全量（含进度句过期提示） */
  private memoryGet(state: MemoryState, key?: string): string {
    if (key !== undefined) {
      const k = String(key).trim()
      if (k === AUTO_PREFS_KEY) return formatAutoPrefs(state.notes[AUTO_PREFS_KEY])
      const normalized = normalizeMemoryKey(k)
      const value = state.notes[normalized]
      return value !== undefined ? `${normalized}：${value}` : `（无此键：${normalized}）`
    }
    const text = formatMemory(state)
    // 进度单一来源：prefs.* 里出现"现学/正在学"类进度句 → 提示可能与 study_progress 过期不同步
    const stale = findProgressSentences(state.notes)
    if (stale.length === 0) return text
    const lines = stale.map((h) => `- ${h.key}：「${h.snippet}…」`)
    return `${text}\n\n⚠ 提示：上述记忆键含进度句，可能与 study_progress 不一致——进度位置以 study_progress 为准。建议把进度句迁移或标注为「历史快照」，偏好键只存偏好/惯例：\n${lines.join('\n')}`
  }

  /** `_autoPrefs` 控制键：只接受 set / remove（不接受 append） */
  private async setControlKey(file: string, state: MemoryState, action: string, rawValue?: string): Promise<string> {
    if (action === 'append') throw new Error('自迭代开关不支持 append；用 set 切换 on/off，或用 remove 删除（回到默认关闭）')
    if (action === 'remove') {
      if (!Object.prototype.hasOwnProperty.call(state.notes, AUTO_PREFS_KEY)) {
        return '（无此键：_autoPrefs，无需删除；当前为默认关闭）'
      }
      const next: MemoryState = { notes: { ...state.notes } }
      delete next.notes[AUTO_PREFS_KEY]
      await writeMemory(file, next)
      return '已关闭自迭代记忆（开关键已删除，回到默认关闭）。'
    }
    const value = normalizeAutoPrefsValue(rawValue ?? '')
    await writeMemory(file, { notes: { ...state.notes, [AUTO_PREFS_KEY]: value } })
    return value === 'on'
      ? '已开启自迭代记忆：无需再说"请记住"，偏好/约定会自动写入 prefs.* 键（每次写入会在回复中标注）。'
      : '已关闭自迭代记忆：回到"记住…"手动模式。'
  }

  /** 普通键：set / append / remove */
  private async writeNote(file: string, state: MemoryState, action: string, key: string, rawValue?: string): Promise<string> {
    const next: MemoryState = { notes: { ...state.notes } }
    if (action === 'remove') {
      if (!Object.prototype.hasOwnProperty.call(next.notes, key)) return `（无此键：${key}，无需删除）`
      delete next.notes[key]
      await writeMemory(file, next)
      return `已删除记忆：${key}`
    }
    const value = checkMemoryValue(rawValue ?? '')
    next.notes[key] = action === 'append' && next.notes[key] !== undefined
      ? checkMemoryValue(`${next.notes[key]}\n${value}`)
      : value
    await writeMemory(file, next)
    return `已记忆 ${key}：${next.notes[key]}\n\n${formatMemory(next)}`
  }

  async memory(action: string, fields: { key?: string; value?: string }): Promise<string> {
    if (!['get', 'set', 'append', 'remove', 'clear'].includes(action)) {
      throw new Error(`study_memory 未知 action "${action}"（可用 get/set/append/remove/clear）`)
    }
    const file = this.memoryFile()
    // BIZ-11g：vaultRoot 写错时不得静默在错误路径创建 .study/memory.json
    await this.assertVault()
    if (action === 'clear') {
      // 彻底重来：清空全部记忆，包括自迭代开关（回到默认关闭）
      await writeMemory(file, { notes: {} })
      return '记忆已清空。'
    }
    const current = await readMemory(file)
    if (action === 'get') return this.memoryGet(current, fields.key)
    if (String(fields.key ?? '').trim() === AUTO_PREFS_KEY) {
      return this.setControlKey(file, current, action, fields.value)
    }
    return this.writeNote(file, current, action, normalizeMemoryKey(fields.key ?? ''), fields.value)
  }
}

function fmtProgress(state: ProgressState): string {
  const pos = [state.currentMaterial || '（未开始）', state.currentSection || ''].filter(Boolean).join(' / ')
  const q = state.pendingQuestions?.length ? state.pendingQuestions.join('；') : '无'
  const c = state.touchedCardIds?.length ? state.touchedCardIds.join('、') : '无'
  return `位置：${pos}\n追问：${q}\n卡片：${c}`
}

export function apply(ctx: PluginContext, config?: StudyConfig): void {
  // fail-quiet 的一处例外：不认识的配置键只告警，不抛错。
  // 抛错会让"配置里多了个历史键"这种退化把整行挂载掉（工具全没、功能全失），
  // 代价远大于收益；告警则让它在启动日志里直接可见。
  const unknown = unknownConfigKeys(config)
  if (unknown.length > 0) {
    console.error(
      `[dsh-study-buddy] 预设行 config 含插件不认识的键：${unknown.join('、')}`
      + `（已退场键或拼写错误；已知键见 presets/study/agent.cordis.yml。这些键会被忽略，但留在配置里=以为配了其实没配）`,
    )
  }
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

  // ── 开场门禁（需求 3）：系统提示段 + 预步提醒，双层强制「首条消息先读记忆再办事」。
  // 一律特性探测：宿主任何一环缺失都不影响工具注册（fail-loud 只针对工具与配置）。
  const systemPrompt = typeof (ctx as PluginContext | undefined)?.get === 'function'
    ? (ctx as PluginContext).get?.('systemPrompt') as { section?: (entry: unknown) => () => void } | undefined
    : undefined
  if (typeof systemPrompt?.section === 'function') {
    const disposeSection = systemPrompt.section({
      name: OPENER_SECTION_NAME,
      order: OPENER_SECTION_ORDER,
      text: MANDATE,
    })
    if (typeof disposeSection === 'function') disposers.push(disposeSection)
  }
  const on = (ctx as PluginContext | undefined)?.on
  if (typeof on === 'function') {
    const disposeListener = on(
      'agent/pre-step',
      async (payload: unknown, next: () => Promise<unknown>): Promise<unknown> => {
        const downstream = await next()
        const p = payload as {
          turn?: unknown
          step?: unknown
          agent?: { session?: { events?: Array<{ type?: string }> } }
        }
        const turn = Number(p?.turn)
        const step = Number(p?.step)
        if (!shouldInjectOpener(turn, step, hasPriorUserMessage(p))) return downstream
        const decision = downstream as { kind?: string; messages?: unknown[] }
        if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return downstream
        return applyOpenerDecision(decision as { kind: 'enter'; messages: unknown[] }, buildOpenerReminder())
      },
    )
    disposers.push(disposeListener)
  }

  // 注册随 preset 作用域注销；disposer 由 ctx.effect 持有（ctx 无 effect 时
  // 退化为不持有——standing 挂载生命周期即进程生命周期，无泄漏）。
  ctx?.effect?.(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-study-buddy tools')
}
