/**
 * 检索与索引：CJK 双字组 + 英文单词 token 化；字段加权打分；多根索引。
 *
 * 候选召回交给 Agent 做语义判断（插件负责召回，LLM 负责语义）。
 *
 * 2026-10 关键改动（架构选型 A4 / §5.2）：**索引不再常驻正文**。
 * 旧实现把全库正文留在 `IndexedCard.body` 里（1000 卡 × 4KB ≈ 4MB），文档式
 * 笔记单篇可达 10KB 级，这个模型会线性膨胀。现在索引只驻留元数据 + 倒排 token
 * 计数，snippet 只在**命中前 N 篇**时按路径现读——"共检索多少篇"不变，常驻内存
 * 与单次工具调用的读盘量都掉下来。
 * @module search
 */

import { parseFrontmatter, extractDefinition, firstHeading } from './frontmatter.ts'
import { compareText } from './order.ts'
import type { WalkedFile } from './vault.ts'
import { fileNameOf } from './vault.ts'

/** 文档类型三态（取代旧的 card/note 二元） */
export type NoteKind = 'block' | 'legacy' | 'note'

export interface IndexedCard {
  id: string | null
  title: string
  path: string
  rel: string
  /** 来源根标签（vault / 工作目录 / searchRoots 目录名） */
  root: string
  /** 该文件是否可写（只有 vault 内文件为 true；只读根永不写入，EXT-5） */
  writable: boolean
  /** 展示/寻址路径：多根时为 root/rel，单根时无前缀 */
  fullRel: string
  fileName: string
  /** 文档类型（三态由 ID 与来源章节共同决定） */
  kind: NoteKind
  /** frontmatter 领域首个标签（去 #） */
  domain: string | null
  /** frontmatter 领域全部标签（去 #） */
  tags: string[]
  status: string | null
  source: string | null
  /** 一句话定位（`简介`，旧卡的 `定义` 作别名） */
  definition: string | null
  /** 来源章节（覆盖度数据源；缺失 = 存量卡/旧笔记） */
  sourceSection: string | null
  /** 微目录排序键 */
  order: number | null
  /** 由相对路径顶层目录推断的领域（旧笔记用） */
  inferredDomain: string
  /** 字段 → token 计数 */
  titleTokens: Map<string, number>
  defTokens: Map<string, number>
  tagTokens: Map<string, number>
  bodyTokens: Map<string, number>
}

export interface SearchHit {
  id: string | null
  title: string
  domain: string | null
  tags: string[]
  status: string | null
  source: string | null
  definition: string | null
  sourceSection: string | null
  path: string
  rel: string
  root: string
  fullRel: string
  fileName: string
  kind: NoteKind
  inferredDomain: string
  score: number
  /** 命中片段（由调用方按需现读正文算出；未提供时为 null） */
  snippet: string | null
}

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]+/g
const WORD_RE = /[a-z0-9_]+/g

export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lowered = text.toLowerCase()
  for (const m of lowered.match(WORD_RE) ?? []) {
    if (m.length >= 2) tokens.push(m)
  }
  for (const run of lowered.match(CJK_RE) ?? []) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

/** 查询侧 token 化：短 CJK 词额外展开单字，提升召回 */
export function tokenizeQuery(text: string): string[] {
  const tokens = tokenize(text)
  const extra: string[] = []
  const lowered = text.toLowerCase()
  for (const run of lowered.match(CJK_RE) ?? []) {
    if (run.length > 1 && run.length <= 4) extra.push(...run.split(''))
  }
  return [...tokens, ...extra]
}

function countTokens(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const t of tokens) map.set(t, (map.get(t) ?? 0) + 1)
  return map
}

/** 文档类型判定：有 ID 且有来源章节 = 块；有 ID = 存量卡；无 ID = 旧笔记 */
export function kindOfNote(meta: { id?: string; sourceSection?: string } | null): NoteKind {
  if (!meta?.id) return 'note'
  return meta.sourceSection ? 'block' : 'legacy'
}

export function indexNote(file: WalkedFile, raw: string): IndexedCard {
  const parsed = parseFrontmatter(raw)
  const tags = parsed.meta?.domain
    ? parsed.meta.domain.split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean)
    : []
  const inferredDomain = file.rel.split(/[\\/]/)[0] || ''
  const title = parsed.meta?.title ?? firstHeading(parsed.body) ?? fileNameOf(file.path).replace(/\.md$/i, '')
  const definition = parsed.meta?.summary ?? extractDefinition(parsed.body)
  const root = file.root
  return {
    id: parsed.meta?.id ?? null,
    title,
    path: file.path,
    rel: file.rel,
    root,
    writable: file.writable === true,
    fullRel: `${root}/${file.rel.replace(/\\/g, '/')}`,
    fileName: fileNameOf(file.path),
    kind: kindOfNote(parsed.meta),
    domain: tags[0] ?? null,
    tags,
    status: parsed.meta?.status ?? null,
    source: parsed.meta?.source ?? null,
    definition,
    sourceSection: parsed.meta?.sourceSection ?? null,
    order: parsed.meta?.order ?? null,
    inferredDomain,
    titleTokens: countTokens(tokenize(title)),
    defTokens: countTokens(tokenize(definition ?? '')),
    tagTokens: countTokens(tokenize(tags.join(' '))),
    bodyTokens: countTokens(tokenize(parsed.body)),
  }
}

const SNIPPET_MAX = 100

/** 命中片段：在已读到的正文里找首个含查询 token 的行（调用方按需现读正文） */
export function snippetOf(body: string, queryTokens: string[]): string {
  const lines = String(body ?? '').split(/\r?\n/)
  const hit = lines.find((line) => {
    const lt = line.toLowerCase()
    return queryTokens.some((t) => lt.includes(t))
  })
  const text = hit ?? lines.find((l) => l.trim() !== '') ?? ''
  const trimmed = text.trim()
  return trimmed.length > SNIPPET_MAX ? `${trimmed.slice(0, SNIPPET_MAX)}…` : trimmed
}

export interface SearchOptions {
  domain?: string
  status?: string
  /** 只返回某一类文档 */
  kind?: NoteKind
  /** 只在该目录（vault 内相对路径）及其子目录下检索 */
  dirPath?: string
  limit?: number
}

/** 字段权重（标题 4 / 简介 3 / 领域 2 / 正文 1，沿用 2026-09 校准结果） */
const FIELD_WEIGHTS = { title: 4, definition: 3, tag: 2, body: 1 } as const
/** 单字 CJK token 的权重系数（命中几乎全库，降权避免噪声） */
const SINGLE_CHAR_FACTOR = 0.2

/** kind 排序权重：块优先于存量卡，存量卡优先于旧笔记 */
const KIND_RANK: Record<NoteKind, number> = { block: 0, legacy: 1, note: 2 }

export class SearchIndex {
  private cards: IndexedCard[] = []
  private inverted = new Map<string, number[]>()
  private titleInverted = new Map<string, number[]>()
  private defInverted = new Map<string, number[]>()
  private tagInverted = new Map<string, number[]>()
  private idIndex = new Map<string, IndexedCard>()
  private titleIndex = new Map<string, IndexedCard>()
  private rootSet = new Set<string>()

  rebuild(cards: IndexedCard[], multiRoot = false): void {
    this.cards = cards.map((c) => ({ ...c, fullRel: multiRoot ? c.fullRel : c.rel.replace(/\\/g, '/') }))
    this.inverted.clear()
    this.titleInverted.clear()
    this.defInverted.clear()
    this.tagInverted.clear()
    this.idIndex.clear()
    this.titleIndex.clear()
    this.rootSet.clear()
    this.cards.forEach((card, idx) => {
      for (const t of card.bodyTokens.keys()) this.push(this.inverted, t, idx)
      for (const t of card.titleTokens.keys()) this.push(this.titleInverted, t, idx)
      for (const t of card.defTokens.keys()) this.push(this.defInverted, t, idx)
      for (const t of card.tagTokens.keys()) this.push(this.tagInverted, t, idx)
      if (card.id && !this.idIndex.has(card.id)) this.idIndex.set(card.id, card)
      const titleKey = card.title.toLowerCase()
      if (!this.titleIndex.has(titleKey)) this.titleIndex.set(titleKey, card)
      this.rootSet.add(card.root)
    })
  }

  private push(map: Map<string, number[]>, token: string, idx: number): void {
    const list = map.get(token) ?? []
    list.push(idx)
    map.set(token, list)
  }

  get size(): number {
    return this.cards.length
  }

  /** 只读视图（CPLX-6：不再泄露内部数组引用） */
  all(): readonly IndexedCard[] {
    return this.cards
  }

  /** 已索引的来源根标签集合（拼「来源：…」用，避免每次 O(n) 扫描） */
  roots(): string[] {
    return [...this.rootSet]
  }

  byId(id: string): IndexedCard | undefined {
    return this.idIndex.get(id)
  }

  byTitle(title: string): IndexedCard | undefined {
    return this.titleIndex.get(String(title).toLowerCase())
  }

  /** 某目录（vault 内相对路径）及其子目录下的文件；`''` = 整库 */
  underDir(dir: string): IndexedCard[] {
    const base = String(dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!base) return [...this.cards]
    return this.cards.filter((c) => {
      const rel = c.rel.replace(/\\/g, '/')
      return rel.startsWith(`${base}/`)
    })
  }

  /**
   * 按引用串找候选：优先完整展示路径（root/rel，多根时）、各根内 rel，最后（仅当引用是纯文件名时）按文件名。
   * 返回全部候选（0/1/多个），由调用方决定唯一或报歧义。
   */
  candidatesForRef(ref: string): IndexedCard[] {
    const q = ref.replace(/\\/g, '/')
    const pureName = !q.includes('/')
    const wanted = q.toLowerCase()
    return this.cards.filter((c) => {
      const cRel = c.rel.replace(/\\/g, '/')
      const cFull = `${c.root}/${cRel}`
      if (cFull === q || cRel === q || c.fullRel === q) return true
      return pureName && c.fileName.toLowerCase() === wanted
    })
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const tokens = tokenizeQuery(query)
    const scores = new Map<number, number>()
    const bump = (idx: number, delta: number): void => { scores.set(idx, (scores.get(idx) ?? 0) + delta) }
    for (const t of tokens) {
      const factor = t.length === 1 ? SINGLE_CHAR_FACTOR : 1
      for (const idx of this.titleInverted.get(t) ?? []) bump(idx, FIELD_WEIGHTS.title * factor)
      for (const idx of this.defInverted.get(t) ?? []) bump(idx, FIELD_WEIGHTS.definition * factor)
      for (const idx of this.tagInverted.get(t) ?? []) bump(idx, FIELD_WEIGHTS.tag * factor)
      for (const idx of this.inverted.get(t) ?? []) bump(idx, FIELD_WEIGHTS.body * factor)
    }
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 50) : 5
    const base = opts.dirPath ? opts.dirPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : ''
    const ranked: Array<{ idx: number; score: number }> = []
    for (const [idx, score] of scores) {
      if (score <= 0) continue
      const card = this.cards[idx]
      if (opts.domain && card.domain !== opts.domain && card.inferredDomain !== opts.domain) continue
      if (opts.status && card.status !== opts.status) continue
      if (opts.kind && card.kind !== opts.kind) continue
      if (base && !card.rel.replace(/\\/g, '/').startsWith(`${base}/`)) continue
      ranked.push({ idx, score })
    }
    ranked.sort((a, b) => {
      const scoreDiff = b.score - a.score
      if (scoreDiff !== 0) return scoreDiff
      const ca = this.cards[a.idx]
      const cb = this.cards[b.idx]
      if (ca.kind !== cb.kind) return KIND_RANK[ca.kind] - KIND_RANK[cb.kind]
      return compareText(ca.fullRel, cb.fullRel)
    })
    // 先排序截断，再只对入选结果算 snippet（snippet 需要正文，由调用方传入 bodyOf）
    return ranked.slice(0, limit).map(({ idx, score }) => this.toHit(this.cards[idx], score))
  }

  /** 命中列表的查询 token（算 snippet 用；与 `search` 内同一口径） */
  static queryTokens(query: string): string[] {
    return tokenizeQuery(query)
  }

  private toHit(card: IndexedCard, score: number): SearchHit {
    return {
      id: card.id,
      title: card.title,
      domain: card.domain,
      tags: card.tags,
      status: card.status,
      source: card.source,
      definition: card.definition,
      sourceSection: card.sourceSection,
      path: card.path,
      rel: card.rel,
      root: card.root,
      fullRel: card.fullRel,
      fileName: card.fileName,
      kind: card.kind,
      inferredDomain: card.inferredDomain,
      score,
      snippet: null,
    }
  }
}
