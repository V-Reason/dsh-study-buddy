/**
 * 原子卡片：ID 生成、校验、渲染、增量更新组装、关联卡片维护、MOC 组装。
 * 纯文本变换（不碰文件系统），便于单元测试。
 * @module card
 */

import { randomBytes } from 'node:crypto'
import { parseFrontmatter, renderFrontmatter } from './frontmatter.ts'

export const VALID_STATUS = ['草稿', '已确认', '需更新'] as const

export interface CardLinks {
  prev?: string[]
  next?: string[]
  conflict?: string[]
}

export interface CardInput {
  title: string
  /** 领域键（目录映射表的主键，也作为 frontmatter 领域标签写入） */
  domain: string
  source: string
  status: string
  /** 一句话定义，≤30 字 */
  definition: string
  /** 核心内容 Markdown */
  content: string
  /** 额外中文领域标签（如 线性代数） */
  tags?: string[]
  links?: CardLinks
}

export interface CardDoc extends CardInput {
  id: string
}

export interface ValidateResult {
  errors: string[]
  warnings: string[]
}

/** `YYYYMMDDHHmm_xxxx`（hex 后缀，恒为 [0-9a-f]） */
export function generateId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `${pad(now.getHours())}${pad(now.getMinutes())}`
  return `${stamp}_${randomBytes(2).toString('hex')}`
}

export function validateCard(input: CardInput): ValidateResult {
  const errors: string[] = []
  const warnings: string[] = []
  if (!input.title?.trim()) errors.push('title 不能为空')
  if (!input.domain?.trim()) errors.push('domain 不能为空')
  if (!input.source?.trim()) errors.push('source（资料名称）不能为空')
  if (!input.status?.trim()) errors.push('status 不能为空')
  else if (!VALID_STATUS.includes(input.status as (typeof VALID_STATUS)[number])) {
    errors.push(`status 必须是 ${VALID_STATUS.join('/')} 之一，收到 "${input.status}"`)
  }
  if (!input.definition?.trim()) errors.push('definition（一句话定义）不能为空')
  else if (input.definition.length > 30) warnings.push(`定义 ${input.definition.length} 字，超过 30 字建议精简`)
  if (!input.content?.trim()) errors.push('content（核心内容）不能为空')
  return { errors, warnings }
}

function linksSection(links?: CardLinks): string {
  if (!links) return ''
  const lines: string[] = []
  if (links.prev?.length) lines.push(`- 前置：${links.prev.join('、')}`)
  if (links.next?.length) lines.push(`- 后续：${links.next.join('、')}`)
  if (links.conflict?.length) lines.push(`- 易混淆：${links.conflict.join('、')}`)
  if (lines.length === 0) return ''
  return `\n### 关联卡片\n${lines.join('\n')}\n`
}

/**
 * 渲染整卡 Markdown（用户定稿格式）：
 * frontmatter 后空一行 → 一句话定义（裸 > 引用块）→ 自由 ### 小节正文
 * → 关联卡片（前置/后续/易混淆）。不加尾部标签。
 */
export function renderCard(card: CardDoc): string {
  const tags = [...new Set([card.domain, ...(card.tags ?? [])])]
  const meta = {
    id: card.id,
    title: card.title,
    domain: tags.map((t) => `#${t}`).join(' '),
    source: card.source,
    status: card.status,
  }
  const body = `> ${card.definition}\n\n${card.content.trim()}\n` + linksSection(card.links)
  return `${renderFrontmatter(meta)}\n${body}`
}

export type UpdateMode = 'append-version' | 'errata' | 'replace'

export interface UpdatePayload {
  mode: UpdateMode
  /** append-version / errata 追加的 Markdown 内容 */
  changes?: string
  /** append-version 的更新来源 */
  source?: string
  /** replace 模式的新卡内容（id 沿用旧卡） */
  card?: Omit<CardInput, 'id'>
}

export interface UpdateResult {
  text: string
  warnings: string[]
}

/**
 * 增量更新：append-version / errata 保留旧内容并追加章节；
 * replace 整卡替换但把旧正文压入"历史版本"折叠块。
 */
export function applyUpdate(raw: string, id: string, payload: UpdatePayload): UpdateResult {
  const warnings: string[] = []
  if (payload.mode === 'append-version') {
    if (!payload.changes?.trim()) throw new Error('append-version 模式需要 changes 内容')
    const src = payload.source?.trim() || '学习补充'
    const section = `\n\n### 版本更新（来源：${src}）\n${payload.changes.trim()}\n`
    return { text: `${raw.replace(/\s+$/, '')}${section}`, warnings }
  }
  if (payload.mode === 'errata') {
    if (!payload.changes?.trim()) throw new Error('errata 模式需要 changes 内容（含纠正原因）')
    const section = `\n\n### 勘误\n${payload.changes.trim()}\n`
    return { text: `${raw.replace(/\s+$/, '')}${section}`, warnings }
  }
  if (payload.mode === 'replace') {
    if (!payload.card) throw new Error('replace 模式需要 card 字段（新卡内容）')
    const result = validateCard(payload.card)
    if (result.errors.length > 0) throw new Error(`replace 新卡校验失败：${result.errors.join('；')}`)
    warnings.push(...result.warnings)
    const oldBody = parseFrontmatter(raw).body.trim()
    const rendered = renderCard({ ...payload.card, id }).trimEnd()
    const date = new Date().toISOString().slice(0, 10)
    const history = `\n\n<details>\n<summary>历史版本（${date}）</summary>\n\n${oldBody}\n\n</details>\n`
    return { text: rendered + history, warnings }
  }
  throw new Error(`未知更新模式 "${String(payload.mode)}"，可用：append-version / errata / replace`)
}

export type LinkKind = 'prev' | 'next' | 'conflict'

const LINK_LABELS: Record<LinkKind, string> = {
  prev: '前置',
  next: '后续',
  conflict: '易混淆',
}

/** 在卡片正文维护关联卡片：新增 `- 标签：目标` 行；目标已存在则跳过。保留原 frontmatter。 */
export function addLink(raw: string, kind: LinkKind, targetLabel: string): string {
  const label = LINK_LABELS[kind]
  // 目标已出现过（无论挂在哪个标签下）就不再重复
  if (raw.includes(targetLabel)) return raw

  const parsed = parseFrontmatter(raw)
  const fm = raw.slice(0, raw.length - parsed.body.length)
  const body = parsed.body.trimEnd()
  const heading = '### 关联卡片'
  const idx = body.indexOf(heading)
  if (idx === -1) {
    return `${fm}${body}\n\n${heading}\n- ${label}：${targetLabel}\n`
  }
  // 找到 heading 之后首个换行，紧随其后插入新行
  const afterHeading = body.indexOf('\n', idx + heading.length)
  const insertAt = afterHeading === -1 ? body.length : afterHeading + 1
  const line = `- ${label}：${targetLabel}\n`
  return `${fm}${body.slice(0, insertAt)}${line}${body.slice(insertAt)}`
}

export interface MocEntry {
  id: string
  title: string
  domain: string
  fileName: string
}

/** 生成 MOC Markdown：按领域分组 + Obsidian wikilink */
export function renderMoc(title: string, date: string, entries: MocEntry[]): string {
  const groups = new Map<string, MocEntry[]>()
  for (const e of entries) {
    const list = groups.get(e.domain) ?? []
    list.push(e)
    groups.set(e.domain, list)
  }
  const lines = [`# ${title}`, '', `> 知识目录（MOC）· ${date}`, '']
  for (const [domain, list] of groups) {
    lines.push(`## ${domain}`)
    for (const e of list) lines.push(`- [[${e.fileName.replace(/\.md$/, '')}]]（${e.id}）${e.title !== e.fileName.replace(/\.md$/, '') ? `· ${e.title}` : ''}`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
