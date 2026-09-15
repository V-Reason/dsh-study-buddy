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
  addLink, applyUpdate, generateId, renderCard, renderMoc, stripMocDatePrefix, todayLocal, validateCard,
  type CardInput, type LinkKind, type MocEntry, type UpdatePayload,
} from './card.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { extractHistory, formatHistory, stripHistory, type HistoryKind } from './history.ts'
import { inverseKind } from './note.ts'
import { formatBatch, formatReport, lintNote, ruleIds, ruleTitle, summarizeLint, type LintReport } from './lint.ts'
import {
  AUTO_PREFS_KEY, checkMemoryValue, findProgressSentences, formatAutoPrefs, formatMemory,
  normalizeAutoPrefsValue, normalizeMemoryKey, readMemory, writeMemory, type MemoryState,
} from './memory.ts'
import {
  MANDATE, OPENER_SECTION_NAME, OPENER_SECTION_ORDER,
  applyOpenerDecision, buildOpenerReminder, hasPriorUserMessage, shouldInjectOpener,
} from './opener.ts'
import {
  cardTitleOf, detectBrokenLinks, formatRenameReport, planRename, replaceCardTitle, rewriteCardLinks, rewriteWikilinks,
  type BrokenLinkHit, type RenamePlan,
} from './rename.ts'
import { indexNote, SearchIndex, snippetOf, type IndexedCard, type NoteKind, type SearchHit } from './search.ts'
import { readProgress, writeProgress, type ProgressState } from './state.ts'
import { buildToolDefs, type ToolDef } from './tools.ts'
import {
  atomicWrite, canonicalRootKey, cardDirFor, dedupeFiles, dedupeRoots, findSimilarDomainKeys, isFsRoot, MAX_WALK_FILES,
  mocPathFor, readNoteSource, resolveSearchRoots, sanitizeFilename, skipSetFor, uniqueNotePath, walkRoots, withinRoot,
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
export interface StudyConfig extends Omit<VaultLayout, 'stateDir' | 'fallbackDir' | 'mocDir'> {
  /** 进度状态目录（相对 vaultRoot），默认 .study */
  stateDir?: string
  /** 未映射领域的落盘目录（相对 vaultRoot），默认 未分类 */
  fallbackDir?: string
  /** MOC 知识目录落盘位置（相对 vaultRoot），默认 目录 */
  mocDir?: string
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
    mocDir: String(config.mocDir ?? '目录').trim() || '目录',
    domainFolders: config.domainFolders ?? {},
    skipDirs: Array.isArray(config.skipDirs) ? config.skipDirs.map(String) : [],
    searchRoots: Array.isArray(config.searchRoots) ? config.searchRoots.map(String) : [],
    includeSessionCwd: config.includeSessionCwd === true,
    linkIntoNotes: config.linkIntoNotes === true,
    lint: config.lint,
    indexTtlMs: Number.isFinite(Number(config.indexTtlMs)) && Number(config.indexTtlMs) >= 0 ? Number(config.indexTtlMs) : 2000,
    maxWalkFiles: Number.isFinite(maxWalkFiles) && maxWalkFiles >= 1 ? Math.floor(maxWalkFiles) : MAX_WALK_FILES,
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
   * 标题 → 卡片摘要：`card_create` 的同名提示用 O(1) 查询（N2）。
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

  /**
   * 建笔记。第三参保留与其他工具一致的 `call` 形状（tools.ts 统一传 `sessionCwd`），
   * 但建笔记本身**不再读索引**（N2），因此会话 cwd 对它没有影响。
   *
   * 2026-10：模板推断与模板校验已删除（需求 R6）；写法由《笔记期望.md》决定。
   * 阶段 4 会把本方法替换为"带门禁与规划凭据"的 `note_write` 路径。
   */
  async create(input: CardInput, _call?: { sessionCwd?: string }): Promise<{ text: string; rel: string }> {
    await this.assertVault()
    const domain = String(input.domain ?? '')
    const mapped = this.layout.domainFolders?.[domain]
    const result = validateCard(input)
    if (result.errors.length > 0) throw new Error(`笔记校验失败：${result.errors.join('；')}`)
    const warnings = [...result.warnings]
    const infoLines: string[] = []
    // 同名标题检测（BIZ-8）：不阻断（故意建多篇同名笔记是允许的），但要显著提示。
    // 用 titleHints 做 O(1) 查询（N2）：绝不为一条提示触发全库重扫；代价是
    // 本次进程从未建立过索引时提示缺席（提示不是门禁，跑过一次读工具即恢复）。
    const titleKey = String(input.title ?? '').trim().toLowerCase()
    const clash = this.titleHints.get(titleKey)
    if (clash && clash.id !== null) {
      warnings.unshift(`已存在同名笔记「${clash.title}」（${clash.fullRel}，ID：${clash.id}）：建议 card_update 增量更新而非新建`)
    }
    // 标题→文件名清洗可见性：非法字符/引号会被清洗，回显实际文件名
    const baseName = sanitizeFilename(String(input.title ?? ''))
    if (baseName !== String(input.title ?? '').trim()) {
      warnings.push(`标题含非法字符/引号，已清洗为文件名「${baseName}」（实际文件名以"已写入"为准）`)
    }
    const id = generateId()
    const text = renderCard({ ...input, id })
    const dir = cardDirFor(this.layout, domain)
    const dirRel = dir.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, '/')
    // 领域键映射可见性：精确命中回显映射；未映射给出 fallback + 可用键列表 + 近似键建议
    const keys = Object.keys(this.layout.domainFolders ?? {})
    if (mapped) {
      infoLines.push(`领域映射：${domain} → ${dirRel}`)
    } else if (keys.length > 0) {
      const similar = findSimilarDomainKeys(domain, keys)
      const simText = similar.length > 0
        ? `。近似键建议：${similar.map((k) => `${k} → ${this.layout.domainFolders?.[k]}`).join('；')}（要用该键请用其精确写法，或把该键加入 domainFolders）`
        : ''
      warnings.push(
        `领域键 "${domain}" 未在 domainFolders 映射表中，已落 fallbackDir：${this.layout.fallbackDir}/${domain}`
        + `。可用键（前 12 个，共 ${keys.length} 个）：${keys.slice(0, 12).join('、')}${keys.length > 12 ? '…' : ''}${simText}`
        + '。完整键名表见 note-format 技能；若刚改过 preset 配置，需重启 DSH 后生效',
      )
    } else {
      warnings.push(`领域键 "${domain}" 未配置映射（domainFolders 为空），已落 fallbackDir：${this.layout.fallbackDir}/${domain}`)
    }
    const file = await uniqueNotePath(dir, String(input.title ?? ''), id)
    await atomicWrite(file, text)
    this.invalidate()
    const rel = file.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, '/')
    this.rememberTitle(String(input.title ?? ''), this.displayRel(rel), id)
    const info = infoLines.length > 0 ? `\n${infoLines.join('\n')}` : ''
    const warn = warnings.length > 0 ? `\n提示：${warnings.join('；')}` : ''
    return { text: `已写入：${rel}\nID：${id}${info}${warn}\n\n${text}`, rel }
  }

  async update(id: string, payload: UpdatePayload, call?: { sessionCwd?: string }): Promise<string> {
    const { card, raw } = await this.resolveCard(id, call?.sessionCwd)
    this.assertWritable(card)
    const result = applyUpdate(raw, card.id ?? id, payload)
    await atomicWrite(card.path, result.text)
    this.invalidate()
    // replace 模式可以改标题（N2）：同步标题缓存，否则同名提示会指向旧标题
    if (payload.mode === 'replace' && payload.card?.title) {
      this.rememberTitle(String(payload.card.title), this.displayRel(card.rel), card.id ?? id, card.title)
    }
    const rel = card.rel.replace(/\\/g, '/')
    const warn = result.warnings.length > 0 ? `\n提示：${result.warnings.join('；')}` : ''
    return `已更新：${rel}\nID：${card.id ?? id}${warn}\n\n${result.text}`
  }

  async link(fromId: string, toId: string, kind: LinkKind, call?: { sessionCwd?: string }): Promise<string> {
    const from = await this.resolveCard(fromId, call?.sessionCwd)
    const to = await this.resolveCard(toId, call?.sessionCwd)
    // 自关联没有意义（BIZ-11a）：同一文件互为前置/后续只会产生无意义自环
    if (canonicalRootKey(from.card.path) === canonicalRootKey(to.card.path)) {
      return `无需自关联：「${from.card.title}」与目标是同一篇文档（${from.card.fullRel}）。`
    }
    const labelOf = (c: typeof from) => (c.card.id ? `${c.card.title}（${c.card.id}）` : `${c.card.title}（${c.card.fullRel}）`)
    const allowNoteWrite = this.layout.linkIntoNotes === true
    const reverseKind: LinkKind = inverseKind(kind)
    if (from.card.id === null && to.card.id === null && !allowNoteWrite) {
      throw new Error(
        '两侧都是旧笔记（无 ID）：默认不写入旧笔记。请开启 config.linkIntoNotes 由插件双向写入，'
        + '或在 Obsidian 中用 [[ ]] 内链手动连接。',
      )
    }
    const noteSkipped: string[] = []
    // ── 规划（不落盘）：只读根在**任何写入之前**就拒绝（N1）──
    // 旧实现先写 from 再在 to 里 assertWritable，结果是"报错但已写盘"的单向入链，
    // 正是 BIZ-2 要消灭的形态。
    const plans: Array<{ path: string; next: string; before: string; label: string }> = []
    const planSide = (side: typeof from, sideKind: LinkKind, targetLabel: string): void => {
      if (side.card.id === null && !allowNoteWrite) {
        noteSkipped.push(labelOf(side))
        return
      }
      const next = addLink(side.raw, sideKind, targetLabel)
      if (next === side.raw) return
      this.assertWritable(side.card)
      plans.push({ path: side.card.path, next, before: side.raw, label: labelOf(side) })
    }
    planSide(from, kind, labelOf(to))
    planSide(to, reverseKind, labelOf(from))
    // ── 提交：任一侧失败按写前内容逆序回滚（与 rename 同口径）──
    const written: string[] = []
    const done: Array<{ path: string; before: string }> = []
    try {
      for (const plan of plans) {
        await atomicWrite(plan.path, plan.next)
        done.push({ path: plan.path, before: plan.before })
        written.push(plan.label)
      }
    } catch (error) {
      const failed: string[] = []
      for (const d of [...done].reverse()) {
        try {
          await atomicWrite(d.path, d.before)
        } catch {
          failed.push(d.path)
        }
      }
      this.invalidate()
      const note = failed.length > 0 ? `；⚠ 回滚失败：${failed.join('、')}（请检查这些文件）` : ''
      throw new Error(`建立关联失败并已回滚：${(error as Error).message}${note}`)
    }
    this.invalidate()
    const map: Record<LinkKind, string> = { prev: '前置知识', next: '后续延伸', sibling: '同主题兄弟' }
    const basis = `已建立关联：${labelOf(from)} ←${map[kind]}→ ${labelOf(to)}`
    if (noteSkipped.length > 0) {
      return `${basis}（单侧写入；未修改旧笔记：${noteSkipped.join('、')}。开启 config.linkIntoNotes 可双向写入，或用 Obsidian 内链）`
    }
    return written.length > 0 ? `${basis}（新增 ${written.length} 侧关联行）` : `${basis}（两侧关联行均已存在，无改动）`
  }

  /** 解析 MOC 引用清单（纯查询，不落盘）：未解析到的与旧笔记分开报告 */
  private collectMocEntries(index: SearchIndex, opts: { cardIds: string[]; domain?: string }): {
    entries: MocEntry[]
    missing: string[]
    skippedNotes: string[]
  } {
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
    return { entries, missing, skippedNotes }
  }

  async moc(opts: { title?: string; cardIds: string[]; domain?: string }, call?: { sessionCwd?: string }): Promise<string> {
    let index = await this.ensureIndex(call?.sessionCwd)
    let collected = this.collectMocEntries(index, opts)
    if (collected.missing.length > 0 && this.servedFromCache) {
      // 引用可能指向 TTL 窗口内刚外部新建的卡（N3）：强制重扫一次再判"缺失"
      index = await this.ensureIndex(call?.sessionCwd, { force: true })
      collected = this.collectMocEntries(index, opts)
    }
    const { entries, missing, skippedNotes } = collected
    if (entries.length === 0) {
      throw new Error(`MOC 没有可收录的卡片（未解析到任何目标卡片${missing.length ? `，缺失：${missing.join('、')}` : ''}${skippedNotes.length ? `；跳过的旧笔记：${skippedNotes.join('、')}` : ''}）`)
    }
    const date = todayLocal()
    // title 只传主题名：自动剥离旧惯例带进的日期前缀（否则与工具自动日期产生双前缀），缺省「知识目录」
    const title = stripMocDatePrefix(opts.title ?? '') || '知识目录'
    const text = renderMoc(title, date, entries)
    const file = mocPathFor(this.layout, title, date)
    await atomicWrite(file, text)
    this.invalidate()
    const rel = file.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, '/')
    return `MOC 已写入：${rel}（标题：${title}，日期：${date}）${skippedNotes.length ? `\n（旧笔记不收录：${skippedNotes.join('、')}）` : ''}\n\n${text}${this.noteSkips()}`
  }

  private lintCtx(): { residueLevel?: 'off' | 'warn' | 'error'; rulesOff?: string[] } {
    return {
      residueLevel: this.layout.lint?.residueLevel,
      rulesOff: this.layout.lint?.rulesOff,
    }
  }

  /** 文档类型判定（三态）：有 ID 且有来源章节 = 块；有 ID = 存量卡；无 ID = 旧笔记 */
  private kindOf(card: { id: string | null; sourceSection: string | null }): LintReport['kind'] {
    if (!card.id) return 'note'
    return card.sourceSection ? 'block' : 'legacy'
  }

  /** 单篇报告：用刚从磁盘读到的原文（保证是最新版） */
  private reportOfRaw(raw: string, card: IndexedCard): LintReport {
    const parsed = parseFrontmatter(raw)
    return lintNote({
      title: parsed.meta?.title ?? card.title,
      summary: parsed.meta?.summary ?? card.definition ?? '',
      body: parsed.body,
    }, { ...this.lintCtx(), kind: this.kindOf(card) })
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
    }, { ...this.lintCtx(), kind: this.kindOf(card) })
  }

  /**
   * 质量体检（card_lint）。
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
    const report = this.reportOfRaw(raw, card)
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

  /** 版本更新 / 勘误 / 历史折叠块管理（card_history） */
  async history(ref: string, action: 'list' | 'strip', opts: { kinds?: HistoryKind[]; dryRun?: boolean } = {}, call?: { sessionCwd?: string }): Promise<string> {
    if (action !== 'list' && action !== 'strip') throw new Error(`card_history 未知 action "${action}"（可用 list/strip）`)
    const { card, raw } = await this.resolveCard(ref, call?.sessionCwd)
    const parsed = parseFrontmatter(raw)
    const blocks = extractHistory(parsed.body)
    if (action === 'list') {
      return `卡片：${card.title}（${card.id ?? '旧笔记'}）历史块 ${blocks.length} 个\n${formatHistory(blocks)}`
    }
    const result = stripHistory(parsed.body, { kinds: opts.kinds })
    if (opts.dryRun) {
      return `[dryRun] 卡片：${card.title}，将删除 ${result.removed.length} 个历史块（行号为删除前的位置）：\n${formatHistory(result.removed)}${result.warnings.length ? `\n提示：${result.warnings.join('；')}` : ''}`
    }
    if (result.removed.length === 0) {
      return `卡片：${card.title} 无历史块可清除。${result.warnings.length ? `\n提示：${result.warnings.join('；')}` : ''}`
    }
    this.assertWritable(card)
    const head = raw.slice(0, raw.length - parsed.body.length)
    await atomicWrite(card.path, `${head}${result.text}\n`)
    this.invalidate()
    const warn = result.warnings.length > 0 ? `\n提示：${result.warnings.join('；')}` : ''
    return `已清除：${card.rel.replace(/\\/g, '/')}（删除 ${result.removed.length} 个历史块；行号为删除前的位置）\n${formatHistory(result.removed)}${warn}`
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
      throw new Error(`"${card.title}" 是旧笔记（无 ID），不支持改名；请用 Obsidian 重命名，或用 card_update(replace) 原地升级为卡片`)
    }
    this.assertWritable(card)
    const title = String(newTitle ?? '').trim()
    if (!title) throw new Error('newTitle 不能为空')
    if (/[\r\n]/.test(title)) throw new Error('newTitle 不能包含换行（会让 frontmatter 被截断）')
    const oldTitle = cardTitleOf(raw) || card.title
    if (title === oldTitle) throw new SameTitleError(`新标题与旧标题相同（${title}），无改动。`)
    const index = await this.ensureIndex(sessionCwd)
    const clash = index.byTitle(title)
    if (clash && clash.id !== card.id) throw new Error(`已存在同名卡片 "${title}"（${clash.fullRel}），请换标题`)
    const plan = planRename({ fileName: card.fileName, oldTitle, newTitle: title })
    const rewritten = replaceCardTitle(raw, title)
    const selfRewrite = rewriteCardLinks(parseFrontmatter(rewritten).body, { oldTitle, newTitle: title, targetId: card.id ?? undefined })
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
      const linkRewrite = rewriteCardLinks(otherBody, { oldTitle, newTitle: title, targetId: card.id ?? undefined })
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
      const fresh = rewriteCardLinks(parsed.body, { oldTitle, newTitle: title, targetId: card.id ?? undefined })
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
