/**
 * 原子卡片：ID 生成、校验、渲染、增量更新组装、关联卡片维护、MOC 组装。
 * 纯文本变换（不碰文件系统），便于单元测试。
 * @module card
 */

import { randomBytes } from 'node:crypto'
import { parseFrontmatter, renderFrontmatter } from './frontmatter.ts'

export const VALID_STATUS = ['草稿', '已确认', '需更新'] as const

/** 阶梯式解剖模板必需小节（缺失出 warning 提示，不阻塞落盘；硬强制在 persona/归档清单） */
export const TEMPLATE_SECTIONS = [
  { title: '核心思想', hint: '一句话讲清 + 为什么重要 + 记忆锚点' },
  { title: '阶梯式解剖', hint: '第 1 层直觉 → 第 2 层机制 → 第 3 层细节推导 → 第 4 层边界反例' },
  { title: '实例走查', hint: '代入具体数字/代码逐步走完' },
  { title: '易错点', hint: '坑 + 为什么错' },
  { title: '自测题', hint: '2~3 题，先答再看答案' },
] as const

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

/** 本地时区的 `YYYY-MM-DD`（与 generateId 同源；勿用 toISOString——UTC 会把凌晨会话日期算到前一天） */
export function todayLocal(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 一句话定义：≤30 字最佳；31~60 字允许放行（等级化提示）；>60 字硬拒绝 */
export const DEFINITION_TARGET = 30
export const DEFINITION_MAX = 60

/** 校验单条一句话定义（validateCard 与 card_update definition 模式共用） */
export function validateDefinition(definition: string): ValidateResult {
  const errors: string[] = []
  const warnings: string[] = []
  const def = String(definition ?? '')
  if (!def.trim()) {
    errors.push('definition（一句话定义）不能为空')
  } else if (def.length > DEFINITION_MAX) {
    errors.push(`定义 ${def.length} 字，超过 ${DEFINITION_MAX} 字硬上限；请精简到 ≤${DEFINITION_MAX} 字（${DEFINITION_TARGET} 字左右最佳）`)
  } else if (def.length > DEFINITION_TARGET) {
    const tier = def.length >= 46
      ? `定义 ${def.length} 字，偏长（接近 ${DEFINITION_MAX} 字上限）`
      : `定义 ${def.length} 字，稍长（≤${DEFINITION_TARGET} 字最佳）`
    warnings.push(`${tier}；允许放行，建议精简到 ≤${DEFINITION_TARGET} 字`)
  }
  return { errors, warnings }
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
  const defResult = validateDefinition(input.definition ?? '')
  errors.push(...defResult.errors)
  warnings.push(...defResult.warnings)
  if (!input.content?.trim()) errors.push('content（核心内容）不能为空')
  if (String(input.content ?? '').trim()) {
    for (const section of TEMPLATE_SECTIONS) {
      if (!String(input.content).includes(`### ${section.title}`)) {
        warnings.push(`正文缺少 "### ${section.title}" 小节（阶梯式解剖模板必需：${section.hint}）`)
      }
    }
  }
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

export type UpdateMode = 'append-version' | 'errata' | 'definition' | 'replace'

export interface UpdatePayload {
  mode: UpdateMode
  /** append-version / errata 追加的 Markdown 内容 */
  changes?: string
  /** append-version 的更新来源 */
  source?: string
  /** definition 模式：新的一句话定义（只替换定义，不产生历史折叠） */
  definition?: string
  /** replace 模式的新卡内容（id 沿用旧卡） */
  card?: Omit<CardInput, 'id'>
}

export interface UpdateResult {
  text: string
  warnings: string[]
}

/**
 * 增量更新：append-version / errata 保留旧内容并追加章节；
 * definition 只替换一句话定义（字段级微调，不产生历史折叠，不算知识更新）；
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
  if (payload.mode === 'definition') {
    const result = validateDefinition(payload.definition ?? '')
    if (result.errors.length > 0) {
      throw new Error(`definition 模式校验失败：${result.errors.join('；')}`)
    }
    warnings.push(...result.warnings)
    const parsed = parseFrontmatter(raw)
    const fm = raw.slice(0, raw.length - parsed.body.length)
    const body = parsed.body
    // 正文首行（跳过 frontmatter 后的空行）必须是定义引用块
    const trimmed = body.trimStart()
    if (!trimmed.startsWith('>')) {
      throw new Error('definition 模式要求卡片正文首行为定义引用块（> 定义）；非标准卡片请用 replace 或手动修正')
    }
    const lead = body.slice(0, body.length - trimmed.length)
    const lineEndRel = trimmed.indexOf('\n')
    const lineEnd = lead.length + (lineEndRel === -1 ? trimmed.length : lineEndRel)
    const next = `${body.slice(0, lead.length)}> ${payload.definition!.trim()}${body.slice(lineEnd)}`
    return { text: `${fm}${next}`, warnings }
  }
  if (payload.mode === 'replace') {
    if (!payload.card) throw new Error('replace 模式需要 card 字段（新卡内容）')
    const result = validateCard(payload.card)
    if (result.errors.length > 0) throw new Error(`replace 新卡校验失败：${result.errors.join('；')}`)
    warnings.push(...result.warnings)
    const oldBody = parseFrontmatter(raw).body.trim()
    const rendered = renderCard({ ...payload.card, id }).trimEnd()
    const date = todayLocal()
    const history = `\n\n<details>\n<summary>历史版本（${date}）</summary>\n\n${oldBody}\n\n</details>\n`
    return { text: rendered + history, warnings }
  }
  throw new Error(`未知更新模式 "${String(payload.mode)}"，可用：append-version / errata / definition / replace`)
}

/**
 * 剥离 MOC 标题开头的日期前缀（`YYYY-MM-DD_` / `YYYY-MM-DD ` 等）：
 * 旧惯例把完整日期写进 title，而 card_moc 会自动加日期前缀 → 双前缀。
 * 工具侧保证"title 只传主题"，本函数做兜底归一。
 */
export function stripMocDatePrefix(title: string): string {
  return String(title ?? '').trim().replace(/^\d{4}-\d{2}-\d{2}[_\s-]+/, '').trim()
}

export type LinkKind = 'prev' | 'next' | 'conflict'

const LINK_LABELS: Record<LinkKind, string> = {
  prev: '前置',
  next: '后续',
  conflict: '易混淆',
}

/**
 * 在卡片正文维护关联卡片：新增 `- 标签：目标` 行；目标已存在则跳过。保留原 frontmatter。
 * 去重规则：有 targetId 时按 `（ID）` 判重（标题变更后仍能识别已关联）；
 * 旧笔记无 ID 时回退为按目标标签文本判重。
 */
export function addLink(raw: string, kind: LinkKind, targetLabel: string, targetId?: string): string {
  const label = LINK_LABELS[kind]
  // 目标已出现过（无论挂在哪个标签下）就不再重复
  if (targetId ? raw.includes(`（${targetId}）`) : raw.includes(targetLabel)) return raw

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
