/**
 * 检索与索引：CJK 双字组 + 英文单词 token 化；字段加权打分；
 * 候选召回交给 Agent 做语义判断（插件负责召回，LLM 负责语义）。
 * @module search
 */

import { parseFrontmatter, extractDefinition, firstHeading } from './frontmatter.ts'
import type { WalkedFile } from './vault.ts'
import { fileNameOf } from './vault.ts'

export interface IndexedCard {
  id: string | null
  title: string
  path: string
  rel: string
  fileName: string
  /** frontmatter 领域首个标签（去 #） */
  domain: string | null
  /** frontmatter 领域全部标签（去 #） */
  tags: string[]
  status: string | null
  source: string | null
  definition: string | null
  /** 由相对路径顶层目录推断的领域（旧笔记用） */
  inferredDomain: string
  /** 字段 → token 计数 */
  titleTokens: Map<string, number>
  defTokens: Map<string, number>
  tagTokens: Map<string, number>
  bodyTokens: Map<string, number>
  /** 正文（snippet 与全文检索用） */
  body: string
}

export interface SearchHit {
  id: string | null
  title: string
  domain: string | null
  tags: string[]
  status: string | null
  source: string | null
  definition: string | null
  path: string
  rel: string
  fileName: string
  inferredDomain: string
  score: number
  snippet: string
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

export function indexNote(file: WalkedFile, raw: string): IndexedCard {
  const parsed = parseFrontmatter(raw)
  const tags = parsed.meta?.domain
    ? parsed.meta.domain.split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean)
    : []
  const inferredDomain = file.rel.split(/[\\/]/)[0] || ''
  const title = parsed.meta?.title ?? firstHeading(parsed.body) ?? fileNameOf(file.path).replace(/\.md$/i, '')
  const definition = parsed.meta ? extractDefinition(parsed.body) : (extractDefinition(parsed.body) ?? null)
  return {
    id: parsed.meta?.id ?? null,
    title,
    path: file.path,
    rel: file.rel,
    fileName: fileNameOf(file.path),
    domain: tags[0] ?? null,
    tags,
    status: parsed.meta?.status ?? null,
    source: parsed.meta?.source ?? null,
    definition,
    inferredDomain,
    titleTokens: countTokens(tokenize(title)),
    defTokens: countTokens(tokenize(definition ?? '')),
    tagTokens: countTokens(tokenize(tags.join(' '))),
    bodyTokens: countTokens(tokenize(parsed.body)),
    body: parsed.body,
  }
}

const SNIPPET_MAX = 160

function snippetOf(card: IndexedCard, queryTokens: string[]): string {
  const lines = card.body.split(/\r?\n/)
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
  limit?: number
}

export class SearchIndex {
  private cards: IndexedCard[] = []
  private inverted = new Map<string, number[]>()
  private titleInverted = new Map<string, number[]>()
  private defInverted = new Map<string, number[]>()
  private tagInverted = new Map<string, number[]>()

  rebuild(cards: IndexedCard[]): void {
    this.cards = cards
    this.inverted.clear()
    this.titleInverted.clear()
    this.defInverted.clear()
    this.tagInverted.clear()
    cards.forEach((card, idx) => {
      for (const t of card.bodyTokens.keys()) this.push(this.inverted, t, idx)
      for (const t of card.titleTokens.keys()) this.push(this.titleInverted, t, idx)
      for (const t of card.defTokens.keys()) this.push(this.defInverted, t, idx)
      for (const t of card.tagTokens.keys()) this.push(this.tagInverted, t, idx)
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

  all(): IndexedCard[] {
    return this.cards
  }

  byId(id: string): IndexedCard | undefined {
    return this.cards.find((c) => c.id === id)
  }

  byTitle(title: string): IndexedCard | undefined {
    const wanted = title.toLowerCase()
    return this.cards.find((c) => c.title.toLowerCase() === wanted)
  }

  byRel(rel: string): IndexedCard | undefined {
    const norm = rel.replace(/\\/g, '/')
    return this.cards.find((c) => {
      const cnorm = c.rel.replace(/\\/g, '/')
      return cnorm === norm || c.fileName === rel || c.fileName.toLowerCase() === rel.toLowerCase()
    })
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const tokens = tokenizeQuery(query)
    const scores = new Map<number, number>()
    for (const t of tokens) {
      for (const idx of this.titleInverted.get(t) ?? []) {
        scores.set(idx, (scores.get(idx) ?? 0) + 4)
      }
      for (const idx of this.defInverted.get(t) ?? []) {
        scores.set(idx, (scores.get(idx) ?? 0) + 3)
      }
      for (const idx of this.tagInverted.get(t) ?? []) {
        scores.set(idx, (scores.get(idx) ?? 0) + 2)
      }
      for (const idx of this.inverted.get(t) ?? []) {
        scores.set(idx, (scores.get(idx) ?? 0) + 1)
      }
    }
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 50) : 8
    const hits: SearchHit[] = []
    for (const [idx, score] of scores) {
      if (score <= 0) continue
      const card = this.cards[idx]
      if (opts.domain && card.domain !== opts.domain && card.inferredDomain !== opts.domain) continue
      if (opts.status && card.status !== opts.status) continue
      hits.push({
        id: card.id,
        title: card.title,
        domain: card.domain,
        tags: card.tags,
        status: card.status,
        source: card.source,
        definition: card.definition,
        path: card.path,
        rel: card.rel,
        fileName: card.fileName,
        inferredDomain: card.inferredDomain,
        score,
        snippet: snippetOf(card, tokens),
      })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }
}
