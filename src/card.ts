/**
 * 原子卡片：ID 生成、校验、渲染、增量更新组装、关联卡片维护、MOC 组装。
 * 纯文本变换（不碰文件系统），便于单元测试。
 * @module card
 */

import { randomBytes } from 'node:crypto'
import { inlineText, matchesTitle, splitSections } from './notemodel.ts'
import { parseFrontmatter, renderFrontmatter } from './frontmatter.ts'
import { errataBlock, insertHistoryBlock, versionBlock } from './history.ts'
import { checkTemplate, inferTemplate, isTemplateType, sectionHints, type TemplateHints, type TemplateType } from './template.ts'

export const VALID_STATUS = ['草稿', '已确认', '需更新'] as const

/** 含换行的字段一律拒绝：会让 frontmatter 被截断、引用块被击穿（SEC-1） */
const NEWLINE_RE = /[\r\n]/

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
  /** 模板类型：理论型/工程型/对比型；缺省按领域与标题自动推断 */
  template?: string
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

/** `YYYYMMDDHHmm_xxxxxx`（6 位 hex 后缀，恒为 [0-9a-f]；ID 是关联锚点，4 位碰撞概率不可忽略） */
export function generateId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `${pad(now.getHours())}${pad(now.getMinutes())}`
  return `${stamp}_${randomBytes(3).toString('hex')}`
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
  } else if (NEWLINE_RE.test(def)) {
    errors.push('definition（一句话定义）不能包含换行——换行会击穿引用块并伪造小节')
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

export interface ValidateOptions {
  /** 已解析的模板类型（缺省按 domain/title 推断） */
  template?: string
  /** domainFolders[domain] 的落盘目录，用于按领域族推断模板 */
  mappedFolder?: string
  /** 模板推断提示词表（config.templateHints） */
  hints?: TemplateHints
}

/** 解析卡片模板：显式声明优先（非法值报错），否则按领域与标题推断 */
export function resolveTemplate(input: { title?: string; domain?: string; template?: string }, opts: ValidateOptions = {}): { type: TemplateType; error?: string } {
  const declared = String(opts.template ?? input.template ?? '').trim()
  if (declared) {
    if (!isTemplateType(declared)) {
      return { type: '理论型', error: `template 必须是 理论型/工程型/对比型 之一，收到 "${declared}"` }
    }
    return { type: declared }
  }
  return {
    type: inferTemplate({
      title: String(input.title ?? ''),
      domain: String(input.domain ?? ''),
      mappedFolder: opts.mappedFolder,
      hints: opts.hints,
    }),
  }
}

export function validateCard(input: CardInput, opts: ValidateOptions = {}): ValidateResult {
  const errors: string[] = []
  const warnings: string[] = []
  if (!input.title?.trim()) errors.push('title 不能为空')
  else if (NEWLINE_RE.test(input.title)) errors.push('title 不能包含换行（会让 frontmatter 被截断）')
  if (!input.domain?.trim()) errors.push('domain 不能为空')
  else if (NEWLINE_RE.test(input.domain)) errors.push('domain 不能包含换行')
  if (!input.source?.trim()) errors.push('source（资料名称）不能为空')
  else if (NEWLINE_RE.test(input.source)) errors.push('source 不能包含换行')
  if (!input.status?.trim()) errors.push('status 不能为空')
  else if (NEWLINE_RE.test(input.status)) errors.push('status 不能包含换行')
  else if (!VALID_STATUS.includes(input.status as (typeof VALID_STATUS)[number])) {
    errors.push(`status 必须是 ${VALID_STATUS.join('/')} 之一，收到 "${input.status}"`)
  }
  // 领域标签以 `#tag` 空格分隔写入 frontmatter，含空白的标签会被拆成两个（BIZ-11c）
  for (const tag of input.tags ?? []) {
    if (/\s/.test(String(tag))) errors.push(`tags 中的「${String(tag)}」含空白字符，会被拆成多个领域标签`)
  }
  const template = resolveTemplate(input, opts)
  if (template.error) errors.push(template.error)
  const defResult = validateDefinition(input.definition ?? '')
  errors.push(...defResult.errors)
  warnings.push(...defResult.warnings)
  if (!input.content?.trim()) errors.push('content（核心内容）不能为空')
  if (String(input.content ?? '').trim()) {
    const check = checkTemplate(template.type, String(input.content))
    // 缺节提示由 template.sectionHints 统一生成（N8：它此前是零引用死代码）
    if (check.missing.length > 0) {
      warnings.push(`正文缺少必填小节（${template.type}）：${sectionHints(check.missing)}`)
    }
    if (check.missingOptional.length > 0) {
      warnings.push(`正文缺少推荐小节（${template.type}）：${sectionHints(check.missingOptional)}`)
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
  const body = `> ${inlineText(card.definition)}\n\n${card.content.trim()}\n` + linksSection(card.links)
  // 迁移期：`模板` 键已从 frontmatter 渲染口径移出（模板概念退场），这里按旧格式
  // 补回「状态」之后、「---」之前，保证存量卡与 legacy 用例在阶段 3~6 期间字节不变。
  const rendered = renderFrontmatter(meta).trimEnd()
  if (!card.template) return `${rendered}\n\n${body}`
  const lines = rendered.split('\n')
  lines.splice(lines.length - 1, 0, `模板: ${inlineText(card.template)}`)
  return `${lines.join('\n')}\n\n${body}`
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
  /** replace 模式：domainFolders 映射出的落盘目录（用于模板推断） */
  mappedFolder?: string
  /** replace 模式：模板推断提示词表（config.templateHints） */
  hints?: TemplateHints
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
    // P0-3：插到「关联卡片」之前——旧实现追加到文件末尾，阅读顺序被破坏
    return { text: insertHistoryBlock(raw, versionBlock(src, payload.changes)), warnings }
  }
  if (payload.mode === 'errata') {
    if (!payload.changes?.trim()) throw new Error('errata 模式需要 changes 内容（含纠正原因）')
    return { text: insertHistoryBlock(raw, errataBlock(payload.changes)), warnings }
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
    // 模板：显式 > 新卡自带 > 旧卡 frontmatter 声明 > 按标题/领域推断
    const oldTemplate = parseFrontmatter(raw).meta?.template
    const resolved = resolveTemplate(
      { ...payload.card, template: payload.card.template ?? oldTemplate },
      { mappedFolder: payload.mappedFolder, hints: payload.hints },
    )
    const card = { ...payload.card, template: resolved.type }
    const result = validateCard(card)
    if (result.errors.length > 0) throw new Error(`replace 新卡校验失败：${result.errors.join('；')}`)
    warnings.push(...result.warnings)
    const oldBody = parseFrontmatter(raw).body.trim()
    const rendered = renderCard({ ...card, id }).trimEnd()
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
  return String(title ?? '')
    .trim()
    .replace(/^(\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?|月)?)[_\s-]+/, '')
    .trim()
}

export type LinkKind = 'prev' | 'next' | 'conflict'

const LINK_LABELS: Record<LinkKind, string> = {
  prev: '前置',
  next: '后续',
  conflict: '易混淆',
}

/** 关联目标：从展示标签里剥出标题（去掉尾部 `（ID）` / `（路径.md）` 与反引号） */
export function linkTargetTitle(label: string): string {
  return String(label ?? '')
    .replace(/`/g, '')
    .replace(/[（(][^（()）]*[)）]\s*$/, '')
    .trim()
}

/** 关联目标：从展示标签里剥出 ID / 路径锚点（无则空串） */
export function linkTargetId(label: string): string {
  const m = /[（(]([^（()）]*)[)）]\s*$/.exec(String(label ?? ''))
  return m ? m[1].trim() : ''
}

/**
 * 归一关联行标签：`标题（ID）` → `` `标题`（ID） ``（P0-6）。
 * 标题已带反引号时保持原样；标题含反引号时跳过归一（避免破坏内容）。
 */
export function normalizeLinkLabel(label: string): string {
  const text = String(label ?? '').trim()
  if (!text || text.includes('`')) return text
  const title = linkTargetTitle(text)
  const anchor = linkTargetId(text)
  if (!title) return text
  return anchor ? `\`${title}\`（${anchor}）` : `\`${title}\``
}

/**
 * 在卡片正文维护关联卡片：新增 `- 标签：目标` 行。
 *
 * 判重范围**限定在「关联卡片」小节内**（BIZ-6）：旧实现扫全正文的 `-` 行，
 * 卡片「前置检查」小节里的 `- 前置：甲` 会被当成"已关联"，静默跳过真实关联
 * 却报告"已建立关联"。小节不存在时视为无重复。
 *
 * 去重规则（P0-6）：**标题或 ID 任一命中即跳过**——既覆盖"标题改了但 ID 未变"
 * （按 ID 判重），也覆盖"标题相同但没写 ID / ID 写错"（按标题判重）。
 * 保留原 frontmatter。
 */
export function addLink(raw: string, kind: LinkKind, targetLabel: string, targetId?: string): string {
  const label = LINK_LABELS[kind]
  const title = linkTargetTitle(targetLabel)
  const anchor = targetId?.trim() || linkTargetId(targetLabel)
  const parsed = parseFrontmatter(raw)
  const fm = raw.slice(0, raw.length - parsed.body.length)
  const bodyText = parsed.body
  const heading = '### 关联卡片'
  const sections = splitSections(bodyText).sections
  const target = sections.find((s) => matchesTitle(s.title, '关联卡片'))
  const existing = target ? target.body.split(/\r?\n/).filter((line) => /^[ \t]*-/.test(line)) : []
  const duplicated = existing.some((line) => {
    const lineTitle = linkTargetTitle(line.replace(/^[ \t]*-\s*(?:前置|后续|易混淆)\s*[：:]\s*/, ''))
    const lineAnchor = linkTargetId(line)
    if (anchor && lineAnchor && lineAnchor === anchor) return true
    return Boolean(title) && lineTitle === title
  })
  if (duplicated) return raw

  const body = bodyText.trimEnd()
  const line = `- ${label}：${normalizeLinkLabel(targetLabel)}\n`
  if (!target) return `${fm}${body}\n\n${heading}\n${line}`
  // 插到标题行之后的首个换行后（保留小节内既有内容）
  const nl = bodyText.indexOf('\n', target.start)
  const insertAt = nl === -1 ? body.length : Math.min(nl + 1, body.length)
  // 标题是正文最后一行（无内容，或只跟一个尾换行）时必须补换行（N4）：否则关联行会
  // 粘成 `### 关联卡片- 前置：…`——Obsidian 不渲染为列表，links-format 也认不出
  if (insertAt >= body.length) return `${fm}${body}\n${line}`
  return `${fm}${body.slice(0, insertAt)}${line}${body.slice(insertAt)}`
}

export interface MocEntry {
  id: string
  title: string
  domain: string
  fileName: string
}

/**
 * Obsidian wikilink 目标清洗：`[` `]` `#` `|` `^` 会截断链接
 * （SEC-3：文件名含 `]]` 时 `[[A]]B]]` 在 Obsidian 里点不开）。
 */
function wikilinkTarget(name: string): string {
  return inlineText(String(name ?? '').replace(/[[\]#|^]/g, ' ').replace(/\s{2,}/g, ' '))
}

/** 生成 MOC Markdown：按领域分组 + Obsidian wikilink */
export function renderMoc(title: string, date: string, entries: MocEntry[]): string {
  const groups = new Map<string, MocEntry[]>()
  for (const e of entries) {
    const domain = inlineText(e.domain) || '未分类'
    const list = groups.get(domain) ?? []
    list.push(e)
    groups.set(domain, list)
  }
  const lines = [`# ${inlineText(title) || '知识目录'}`, '', `> 知识目录（MOC）· ${inlineText(date)}`, '']
  for (const [domain, list] of groups) {
    lines.push(`## ${domain}`)
    for (const e of list) {
      const base = wikilinkTarget(e.fileName.replace(/\.md$/, ''))
      const suffix = e.title && e.title !== e.fileName.replace(/\.md$/, '') ? `· ${inlineText(e.title)}` : ''
      lines.push(`- [[${base}]]（${inlineText(e.id)}）${suffix}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
