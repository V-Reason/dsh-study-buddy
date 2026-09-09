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
  addLink, applyUpdate, generateId, renderCard, renderMoc, resolveTemplate, stripMocDatePrefix, todayLocal, validateCard,
  type CardInput, type LinkKind, type MocEntry, type UpdatePayload,
} from './card.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { extractHistory, formatHistory, stripHistory, type HistoryKind } from './history.ts'
import { crossCardConflicts, executabilityOf, executabilitySummary, formatConflicts, formatTrend, qualityTrend } from './insight.ts'
import { formatBatch, formatReport, lintCard, ruleTitle, summarizeLint, type LintReport } from './lint.ts'
import {
  AUTO_PREFS_KEY, checkMemoryValue, findProgressSentences, formatAutoPrefs, formatMemory,
  normalizeAutoPrefsValue, normalizeMemoryKey, readMemory, writeMemory, type MemoryState,
} from './memory.ts'
import {
  MANDATE, OPENER_SECTION_NAME, OPENER_SECTION_ORDER,
  applyOpenerDecision, buildOpenerReminder, hasPriorUserMessage, shouldInjectOpener,
} from './opener.ts'
import { cardTitleOf, detectBrokenLinks, formatRenameReport, planRename, replaceCardTitle, rewriteCardLinks, rewriteWikilinks } from './rename.ts'
import { indexNote, SearchIndex, type IndexedCard, type SearchHit } from './search.ts'
import { readProgress, writeProgress, type ProgressState } from './state.ts'
import { buildToolDefs, type ToolDef } from './tools.ts'
import {
  atomicWrite, canonicalRootKey, cardDirFor, dedupeFiles, dedupeRoots, findSimilarDomainKeys, mocPathFor, resolveSearchRoots, sanitizeFilename, skipSetFor, uniqueCardPath, walkRoots, withinRoot,
  type SearchRoot, type VaultLayout,
} from './vault.ts'

export type { ToolDef, ToolExecLike } from './tools.ts'
export { buildToolDefs } from './tools.ts'

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
  /** lint 口径（可选）：residueLevel=off/warn/error（默认 warn），rulesOff=禁用的规则 id 列表 */
  lint?: {
    residueLevel?: 'off' | 'warn' | 'error'
    rulesOff?: string[]
  }
}

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
    lint: config.lint,
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
    const mapped = this.layout.domainFolders?.[input.domain]
    // 模板：显式 > 按领域目录族/标题推断；推断结果写入 frontmatter（可选字段，旧卡不强迁）
    const resolved = resolveTemplate(input, { mappedFolder: mapped })
    const card: CardInput = { ...input, template: resolved.type }
    const result = validateCard(card, { mappedFolder: mapped })
    if (result.errors.length > 0) throw new Error(`卡片校验失败：${result.errors.join('；')}`)
    const warnings = [...result.warnings]
    const infoLines: string[] = []
    // 标题→文件名清洗可见性：非法字符/引号会被清洗，回显实际文件名
    const baseName = sanitizeFilename(input.title)
    if (baseName !== input.title.trim()) {
      warnings.push(`标题含非法字符/引号，已清洗为文件名「${baseName}」（实际文件名以"已写入"为准）`)
    }
    const id = generateId()
    const text = renderCard({ ...card, id })
    const dir = cardDirFor(this.layout, input.domain)
    const dirRel = dir.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, '/')
    // 领域键映射可见性：精确命中回显映射；未映射给出 fallback + 可用键列表 + 近似键建议
    const keys = Object.keys(this.layout.domainFolders ?? {})
    if (mapped) {
      infoLines.push(`领域映射：${input.domain} → ${dirRel}`)
      infoLines.push(`模板：${resolved.type}${input.template ? '（显式）' : '（按领域/标题推断，可用 template 覆盖）'}`)
    } else if (keys.length > 0) {
      const similar = findSimilarDomainKeys(input.domain, keys)
      const simText = similar.length > 0
        ? `。近似键建议：${similar.map((k) => `${k} → ${this.layout.domainFolders?.[k]}`).join('；')}（要用该键请用其精确写法，或把该键加入 domainFolders）`
        : ''
      warnings.push(
        `领域键 "${input.domain}" 未在 domainFolders 映射表中，已落 fallbackDir：${this.layout.fallbackDir}/${input.domain}`
        + `。可用键（前 12 个，共 ${keys.length} 个）：${keys.slice(0, 12).join('、')}${keys.length > 12 ? '…' : ''}${simText}`
        + '。完整键名表见 card-format 技能；若刚改过 preset 配置，需重启 DSH 后生效',
      )
    } else {
      warnings.push(`领域键 "${input.domain}" 未配置映射（domainFolders 为空），已落 fallbackDir：${this.layout.fallbackDir}/${input.domain}`)
      infoLines.push(`模板：${resolved.type}（按标题推断）`)
    }
    const file = await uniqueCardPath(dir, input.title, id)
    await atomicWrite(file, text)
    this.sig = null
    const rel = file.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, '/')
    const info = infoLines.length > 0 ? `\n${infoLines.join('\n')}` : ''
    const warn = warnings.length > 0 ? `\n提示：${warnings.join('；')}` : ''
    return { text: `已写入：${rel}\nID：${id}${info}${warn}\n\n${text}`, rel }
  }

  async update(id: string, payload: UpdatePayload): Promise<string> {
    const { card, raw } = await this.resolveCard(id)
    const mappedFolder = payload.card?.domain ? this.layout.domainFolders?.[payload.card.domain] : undefined
    const result = applyUpdate(raw, card.id ?? id, { ...payload, mappedFolder })
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
    const date = todayLocal()
    // title 只传主题名：自动剥离旧惯例带进的日期前缀（否则与工具自动日期产生双前缀），缺省「知识目录」
    const title = stripMocDatePrefix(opts.title ?? '') || '知识目录'
    const text = renderMoc(title, date, entries)
    const file = mocPathFor(this.layout, title, date)
    await atomicWrite(file, text)
    const rel = file.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, '/')
    return `MOC 已写入：${rel}（标题：${title}，日期：${date}）${skippedNotes.length ? `\n（旧笔记不收录：${skippedNotes.join('、')}）` : ''}\n\n${text}`
  }

  /** 单卡/批量质量体检（card_lint）+ 跨卡一致性 / 质量趋势 / 可执行性评级（P2） */
  async lint(opts: {
    ref?: string
    scope?: 'vault' | 'all'
    limit?: number
    rule?: string
    cross?: boolean
    trend?: boolean
    rating?: boolean
  }, call?: { sessionCwd?: string }): Promise<string> {
    const index = await this.refresh(call?.sessionCwd)
    const ctx = {
      knownDomains: Object.keys(this.layout.domainFolders ?? {}),
      residueLevel: this.layout.lint?.residueLevel,
      rulesOff: this.layout.lint?.rulesOff,
    }
    const reportOf = (raw: string, card: IndexedCard): LintReport => {
      const parsed = parseFrontmatter(raw)
      return lintCard({
        title: parsed.meta?.title ?? card.title,
        definition: card.definition ?? '',
        body: parsed.body,
        template: parsed.meta?.template,
        tags: card.tags,
      }, ctx)
    }
    if (opts.ref) {
      const { card, raw } = await this.resolveCard(opts.ref, call?.sessionCwd)
      const report = reportOf(raw, card)
      if (opts.rule) {
        const hits = report.findings.filter((f) => f.rule === opts.rule)
        const passed = report.passed[opts.rule]
        return `卡片：${report.title}  规则：${opts.rule}  ${passed ? '✓ 通过' : '✗/⚠ 未通过'}\n`
          + (hits.length > 0 ? hits.map((f) => `  ${f.message}${f.suggestion ? `\n    建议：${f.suggestion}` : ''}`).join('\n') : '  （该规则无发现）')
      }
      const body = parseFrontmatter(raw).body
      const rating = opts.rating === false ? '' : `\n  可执行性：${executabilityOf(body)}`
      return `${formatReport(report)}${rating}`
    }
    const cards = index.all().filter((c) => (opts.scope === 'all' ? true : c.id !== null))
    if (cards.length === 0) return '未找到可体检的卡片。'
    const reports: LintReport[] = []
    const titles: string[] = []
    const bodies: string[] = []
    const ids: Array<string | null> = []
    for (const card of cards) {
      let raw = ''
      try {
        raw = await fsp.readFile(card.path, 'utf8')
      } catch {
        continue
      }
      const report = reportOf(raw, card)
      reports.push(report)
      titles.push(card.fullRel)
      bodies.push(parseFrontmatter(raw).body)
      ids.push(card.id)
    }
    if (opts.rule) {
      const hit = reports.filter((r) => r.findings.some((f) => f.rule === opts.rule))
      const lines = [`规则 ${opts.rule}（${ruleTitle(opts.rule)}）：${hit.length}/${reports.length} 张卡命中`]
      for (const r of hit.slice(0, opts.limit ?? 20)) {
        for (const f of r.findings.filter((x) => x.rule === opts.rule)) lines.push(`  - ${r.title}：${f.message}`)
      }
      return lines.join('\n')
    }
    if (opts.cross) {
      const groups = crossCardConflicts(bodies.map((body, i) => ({ label: titles[i], body })))
      return formatConflicts(groups, opts.limit ?? 20)
    }
    if (opts.trend) {
      return formatTrend(qualityTrend(reports.map((report, i) => ({ id: ids[i], report }))))
    }
    const parts = [formatBatch(summarizeLint(reports, titles), opts.limit ?? 20)]
    if (opts.rating) {
      const summary = executabilitySummary(bodies.map((body) => ({ body })))
      parts.push(`可执行性分布：${summary.map((s) => `${s.rating} ${s.count} 张`).join('，')}`)
    }
    return parts.join('\n')
  }

  /** 版本更新 / 勘误 / 历史折叠块管理（card_history） */
  async history(ref: string, action: 'list' | 'strip', opts: { kinds?: HistoryKind[]; dryRun?: boolean } = {}, call?: { sessionCwd?: string }): Promise<string> {
    const { card, raw } = await this.resolveCard(ref, call?.sessionCwd)
    const parsed = parseFrontmatter(raw)
    const blocks = extractHistory(parsed.body)
    if (action === 'list') {
      return `卡片：${card.title}（${card.id ?? '旧笔记'}）历史块 ${blocks.length} 个\n${formatHistory(blocks)}`
    }
    if (action !== 'strip') throw new Error(`card_history 未知 action "${action}"（可用 list/strip）`)
    const result = stripHistory(parsed.body, { kinds: opts.kinds })
    if (opts.dryRun) {
      return `[dryRun] 卡片：${card.title}，将删除 ${result.removed.length} 个历史块：\n${formatHistory(result.removed)}${result.warnings.length ? `\n提示：${result.warnings.join('；')}` : ''}`
    }
    if (result.removed.length === 0) {
      return `卡片：${card.title} 无历史块可清除。${result.warnings.length ? `\n提示：${result.warnings.join('；')}` : ''}`
    }
    const head = raw.slice(0, raw.length - parsed.body.length)
    await atomicWrite(card.path, `${head}${result.text}\n`)
    this.sig = null
    const warn = result.warnings.length > 0 ? `\n提示：${result.warnings.join('；')}` : ''
    return `已清除：${card.rel.replace(/\\/g, '/')}（删除 ${result.removed.length} 个历史块）\n${formatHistory(result.removed)}${warn}`
  }

  /** 改标题并同步文件名 / 全库入链 / 断链检测（card_rename） */
  async rename(ref: string, newTitle: string, opts: { dryRun?: boolean; sessionCwd?: string } = {}): Promise<string> {
    const { card, raw } = await this.resolveCard(ref, opts.sessionCwd)
    if (card.id === null) {
      throw new Error(`"${card.title}" 是旧笔记（无 ID），不支持改名；请用 Obsidian 重命名，或用 card_update(replace) 原地升级为卡片`)
    }
    const title = String(newTitle ?? '').trim()
    if (!title) throw new Error('newTitle 不能为空')
    const oldTitle = cardTitleOf(raw) || card.title
    if (title === oldTitle) return `新标题与旧标题相同（${title}），无改动。`
    const index = await this.refresh(opts.sessionCwd)
    const clash = index.byTitle(title)
    if (clash && clash.id !== card.id) throw new Error(`已存在同名卡片 "${title}"（${clash.fullRel}），请换标题`)
    const plan = planRename({ fileName: card.fileName, oldTitle, newTitle: title })
    const rewritten = replaceCardTitle(raw, title)
    const selfRewrite = rewriteCardLinks(parseFrontmatter(rewritten).body, { oldTitle, newTitle: title, targetId: card.id ?? undefined })
    const selfText = `${rewritten.slice(0, rewritten.length - parseFrontmatter(rewritten).body.length)}${selfRewrite.text}`
    const changed: Array<{ rel: string; kind: string; changed: number; samples: string[] }> = [
      { rel: card.fullRel, kind: '本卡标题', changed: 1, samples: [`${oldTitle} → ${title}`] },
    ]
    if (selfRewrite.changed > 0) changed.push({ rel: card.fullRel, kind: '本卡关联卡片', changed: selfRewrite.changed, samples: selfRewrite.samples })
    // 全库扫描入链：只写 vault 内文件（searchRoots / 工作目录只读）
    const roots = this.rootsFor(opts.sessionCwd)
    const files = dedupeFiles(await walkRoots(roots, skipSetFor(this.layout.skipDirs)))
    const writes: Array<{ path: string; text: string }> = []
    const broken: ReturnType<typeof detectBrokenLinks> = []
    for (const file of files) {
      if (canonicalRootKey(file.path) === canonicalRootKey(card.path)) continue
      let content = ''
      try {
        content = await fsp.readFile(file.path, 'utf8')
      } catch {
        continue
      }
      const parsed = parseFrontmatter(content)
      const isCard = Boolean(parsed.meta?.id)
      const linkRewrite = rewriteCardLinks(parsed.body, { oldTitle, newTitle: title, targetId: card.id ?? undefined })
      let nextBody = linkRewrite.text
      let changedCount = linkRewrite.changed
      const samples = [...linkRewrite.samples]
      // MOC 用文件名建链：卡片文件内的 wikilink 同步（旧笔记按文件名寻址，不动）
      if (isCard) {
        const wiki = rewriteWikilinks(nextBody, plan.oldBase, plan.newBase)
        nextBody = wiki.text
        changedCount += wiki.changed
        samples.push(...wiki.samples)
      }
      if (changedCount === 0) continue
      const head = content.slice(0, content.length - parsed.body.length)
      const target = `${head}${nextBody}`
      if (file.root !== 'vault') {
        // 只读根：报告但不写
        changed.push({ rel: file.rel, kind: `只读根(${file.root}) 未写入`, changed: changedCount, samples })
        continue
      }
      if (opts.dryRun) {
        changed.push({ rel: file.rel.replace(/\\/g, '/'), kind: isCard ? '卡片入链' : '文档入链', changed: changedCount, samples })
        continue
      }
      writes.push({ path: file.path, text: target })
      changed.push({ rel: file.rel.replace(/\\/g, '/'), kind: isCard ? '卡片入链' : '文档入链', changed: changedCount, samples })
      broken.push(...detectBrokenLinks(nextBody, { oldTitle, oldId: card.id ?? undefined, newTitle: title }))
    }
    if (opts.dryRun) {
      return formatRenameReport({ id: card.id, oldTitle, newTitle: title, plan, filesChanged: changed, broken, dryRun: true })
    }
    await atomicWrite(card.path, `${selfText}\n`)
    for (const write of writes) await atomicWrite(write.path, write.text)
    let finalRel = card.rel.replace(/\\/g, '/')
    if (plan.renameFile) {
      const targetPath = join(card.path.slice(0, card.path.length - card.fileName.length), `${plan.newBase}.md`)
      if (canonicalRootKey(targetPath) !== canonicalRootKey(card.path)) {
        if (await this.fileExists(targetPath)) throw new Error(`目标文件名已存在：${plan.newBase}.md（请先处理同名文件）`)
        await atomicWrite(targetPath, `${selfText}\n`)
        await fsp.rm(card.path, { force: true })
        finalRel = targetPath.slice(this.layout.vaultRoot.length + 1).replace(/\\/g, '/')
      }
    }
    this.sig = null
    return `${formatRenameReport({ id: card.id, oldTitle, newTitle: title, plan, filesChanged: changed, broken, dryRun: false })}\n已写入：${finalRel}`
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
      // 彻底重来：清空全部记忆，包括自迭代开关（回到默认关闭）
      await writeMemory(file, { notes: {} })
      return '记忆已清空。'
    }
    const current = await readMemory(file)
    if (action === 'get') {
      if (fields.key !== undefined) {
        const key = String(fields.key).trim()
        if (key === AUTO_PREFS_KEY) return formatAutoPrefs(current.notes[AUTO_PREFS_KEY])
        const normalized = normalizeMemoryKey(key)
        const value = current.notes[normalized]
        return value !== undefined ? `${normalized}：${value}` : `（无此键：${normalized}）`
      }
      const text = formatMemory(current)
      // 进度单一来源：prefs.* 里出现"现学/正在学"类进度句 → 提示可能与 study_progress 过期不同步
      const stale = findProgressSentences(current.notes)
      if (stale.length === 0) return text
      const lines = stale.map((h) => `- ${h.key}：「${h.snippet}…」`)
      return `${text}\n\n⚠ 提示：上述记忆键含进度句，可能与 study_progress 不一致——进度位置以 study_progress 为准。建议把进度句迁移或标注为「历史快照」，偏好键只存偏好/惯例：\n${lines.join('\n')}`
    }
    if (action !== 'set' && action !== 'append' && action !== 'remove') {
      throw new Error(`study_memory 未知 action "${action}"（可用 get/set/append/remove/clear）`)
    }
    // 自迭代开关（保留控制键）：独占校验，不接受 append
    if (String(fields.key ?? '').trim() === AUTO_PREFS_KEY) {
      if (action === 'append') throw new Error('自迭代开关不支持 append；用 set 切换 on/off，或用 remove 删除（回到默认关闭）')
      if (action === 'remove') {
        if (!Object.prototype.hasOwnProperty.call(current.notes, AUTO_PREFS_KEY)) {
          return '（无此键：_autoPrefs，无需删除；当前为默认关闭）'
        }
        const next: MemoryState = { notes: { ...current.notes } }
        delete next.notes[AUTO_PREFS_KEY]
        await writeMemory(file, next)
        return '已关闭自迭代记忆（开关键已删除，回到默认关闭）。'
      }
      const value = normalizeAutoPrefsValue(fields.value ?? '')
      const next: MemoryState = { notes: { ...current.notes, [AUTO_PREFS_KEY]: value } }
      await writeMemory(file, next)
      return value === 'on'
        ? '已开启自迭代记忆：无需再说"请记住"，偏好/约定会自动写入 prefs.* 键（每次写入会在回复中标注）。'
        : '已关闭自迭代记忆：回到"记住…"手动模式。'
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
    return `已记忆 ${key}：${next.notes[key]}\n\n${formatMemory(next)}`
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
