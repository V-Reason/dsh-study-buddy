/**
 * 笔记块：ID 生成、校验、渲染、增量应用。
 *
 * 2026-10 文档式笔记重构的核心变化（相对旧的 `card.ts`）：
 * - **不再有模板**：三型模板与必填小节彻底退场（需求 R6），`note_write` 不对
 *   小节做任何检查——写什么、怎么组织，由用户自己的《笔记期望.md》决定。
 * - **不再有字数硬拒绝**：旧的"一句话定义 ≤60 字"是唯一保留的长度硬限，现改为
 *   可选键 `简介`，无长度限制（需求 R7）。
 * - **新增文档键**：`来源章节`（覆盖度数据源，写入时归一）、`顺序`（微目录排序）。
 * - **关联改 wikilink**：「关联」小节写 `- 前置：[[目标]]`（需求 R16）。
 *
 * 仍然是**纯文本变换**：不碰文件系统，历史存档由调用方通过 `archive.ts` 处理
 * （"先存档后写正文"的顺序不在这里，见 `archiveThenWrite`）。
 * @module note
 */

import { randomBytes } from 'node:crypto'
import { inlineText, matchesTitle, splitSections } from './notemodel.ts'
import { extractDefinition, parseFrontmatter, renderFrontmatter, type CardMeta } from './frontmatter.ts'
import { normalizeSourceSectionText } from './sourceSection.ts'

export const VALID_STATUS = ['草稿', '已确认', '需更新'] as const

/** 含换行的字段一律拒绝：会让 frontmatter 被截断、引用块被击穿（SEC-1） */
const NEWLINE_RE = /[\r\n]/

/** 关联小节标题（`note_link` 与渲染共用一处定义） */
export const LINKS_SECTION = '关联'

export interface BlockLinks {
  prev?: string[]
  next?: string[]
  sibling?: string[]
}

export interface BlockInput {
  title: string
  /** 资料名（课程/书/项目名） */
  source: string
  /** 正文 Markdown（尽细尽全，不设上下限） */
  content: string
  /** 领域键（可选；用于检索过滤与 domainFolders 快捷落盘） */
  domain?: string
  /** 状态：缺省"草稿" */
  status?: string
  /** 来源章节（写入时归一；不合法不报错，只原样保留） */
  sourceSection?: string
  /** 微目录排序键 */
  order?: number
  /** 一句话定位（可选，无长度限制；缺省时从正文首个引用块提取） */
  summary?: string
  /** 额外领域标签（如 线性代数） */
  tags?: string[]
  links?: BlockLinks
}

export interface BlockDoc extends BlockInput {
  id: string
}

export interface ValidateResult {
  errors: string[]
  warnings: string[]
}

/** `YYYYMMDDHHmm_xxxxxx`（6 位 hex 后缀；ID 是关联锚点，4 位碰撞概率不可忽略） */
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

/**
 * 校验 `简介`（可选键）：**没有长度上限**（旧 `DEFINITION_MAX` 已删除，需求 R7）。
 * 只拒绝换行——那是渲染层的正确性要求，不是内容约束。
 */
export function validateSummary(summary: string): ValidateResult {
  const errors: string[] = []
  const text = String(summary ?? '')
  if (text && NEWLINE_RE.test(text)) {
    errors.push('简介 不能包含换行——换行会截断 frontmatter 并伪造小节')
  }
  return { errors, warnings: [] }
}

export function validateBlock(input: BlockInput): ValidateResult {
  const errors: string[] = []
  const warnings: string[] = []
  if (!input.title?.trim()) errors.push('title 不能为空')
  else if (NEWLINE_RE.test(input.title)) errors.push('title 不能包含换行（会让 frontmatter 被截断）')
  if (!input.source?.trim()) errors.push('source（资料名称）不能为空')
  else if (NEWLINE_RE.test(input.source)) errors.push('source 不能包含换行')
  const status = input.status?.trim() || '草稿'
  if (NEWLINE_RE.test(status)) errors.push('status 不能包含换行')
  else if (!VALID_STATUS.includes(status as (typeof VALID_STATUS)[number])) {
    errors.push(`status 必须是 ${VALID_STATUS.join('/')} 之一，收到 "${input.status}"`)
  }
  if (input.domain && NEWLINE_RE.test(input.domain)) errors.push('domain 不能包含换行')
  // 领域标签以 `#tag` 空格分隔写入 frontmatter，含空白的标签会被拆成两个（BIZ-11c）
  for (const tag of input.tags ?? []) {
    if (/\s/.test(String(tag))) errors.push(`tags 中的「${String(tag)}」含空白字符，会被拆成多个领域标签`)
  }
  errors.push(...validateSummary(input.summary ?? '').errors)
  if (!input.content?.trim()) errors.push('content（正文）不能为空')
  if (input.sourceSection !== undefined && NEWLINE_RE.test(String(input.sourceSection))) {
    errors.push('来源章节 不能包含换行')
  }
  if (input.order !== undefined && !Number.isFinite(Number(input.order))) {
    errors.push(`顺序 必须是数字，收到 "${String(input.order)}"`)
  }
  return { errors, warnings }
}

/** 关联小节渲染：`- 前置：[[目标]]`（与 `note_link` 的落盘格式同源） */
function linksSection(links?: BlockLinks): string {
  if (!links) return ''
  const lines: string[] = []
  if (links.prev?.length) lines.push(`- 前置：${links.prev.join('、')}`)
  if (links.next?.length) lines.push(`- 后续：${links.next.join('、')}`)
  if (links.sibling?.length) lines.push(`- 兄弟：${links.sibling.join('、')}`)
  if (lines.length === 0) return ''
  return `\n### ${LINKS_SECTION}\n${lines.join('\n')}\n`
}

/**
 * 渲染整篇笔记：
 * frontmatter → 一句话定位（裸 `>` 引用块，可选）→ 正文 → 关联小节。
 * 不加尾部标签；键序由 `renderFrontmatter` 固定。
 */
export function renderNote(doc: BlockDoc): string {
  const tags = [...new Set([doc.domain, ...(doc.tags ?? [])].filter((t): t is string => Boolean(t)))]
  const summary = doc.summary?.trim() || extractDefinition(doc.content) || ''
  const meta: CardMeta = {
    id: doc.id,
    title: doc.title,
    domain: tags.length > 0 ? tags.map((t) => `#${t}`).join(' ') : undefined,
    source: doc.source,
    status: doc.status?.trim() || '草稿',
    sourceSection: doc.sourceSection ? normalizeSourceSectionText(doc.sourceSection) : undefined,
    order: doc.order,
    summary: summary || undefined,
  }
  const lead = summary ? `> ${inlineText(summary)}\n\n` : ''
  const body = `${lead}${doc.content.trim()}\n${linksSection(doc.links)}`
  return `${renderFrontmatter(meta).trimEnd()}\n\n${body}`
}

export type UpdateAction = 'append' | 'replace' | 'definition'

export interface UpdatePayload {
  action: UpdateAction
  /** append 追加的 Markdown 内容 */
  changes?: string
  /** append 的追加位置：`### <section>` 标题；缺省追加到正文末尾 */
  section?: string
  /** definition：新的一句话定位（只替换正文首个引用块） */
  summary?: string
  /** replace 的新正文（id 沿用旧块；旧正文由调用方先存档） */
  block?: Omit<BlockInput, 'id'>
}

export interface UpdateResult {
  text: string
  warnings: string[]
}

/**
 * 在正文的小节内追加内容：命中 `### <section>` 时插到该小节正文末尾，
 * 找不到该小节时**新建小节**（比静默追加到末尾更符合"补充到对应位置"的意图）。
 */
export function appendToSection(body: string, section: string, changes: string): string {
  const text = String(body ?? '').trimEnd()
  const block = String(changes ?? '').trim()
  const { lead, sections } = splitSections(text)
  const index = sections.findIndex((s) => matchesTitle(s.title, section))
  if (index === -1) {
    const base = text.trim() ? `${text}\n\n### ${section}\n${block}` : `### ${section}\n${block}`
    return base
  }
  const target = sections[index]
  const updated = {
    ...target,
    body: target.body.trim() ? `${target.body.trimEnd()}\n\n${block}` : block,
  }
  const next = [...sections.slice(0, index), updated, ...sections.slice(index + 1)]
  const parts: string[] = []
  if (lead.trim()) parts.push(lead.trimEnd())
  for (const s of next) {
    const hashes = '#'.repeat(Math.min(Math.max(s.level, 1), 6))
    parts.push(s.body ? `${hashes} ${s.title}\n${s.body}` : `${hashes} ${s.title}`)
  }
  return parts.join('\n\n')
}

function replaceSummaryLine(body: string, summary: string, kind: '简介' | '定义'): string {
  const trimmed = body.trimStart()
  if (!trimmed.startsWith('>')) {
    throw new Error(`${kind} 模式要求正文首行为引用块（> …）；非标准笔记请用 replace 或手动修正`)
  }
  const lead = body.slice(0, body.length - trimmed.length)
  const lineEndRel = trimmed.indexOf('\n')
  const lineEnd = lead.length + (lineEndRel === -1 ? trimmed.length : lineEndRel)
  return `${body.slice(0, lead.length)}> ${summary.trim()}${body.slice(lineEnd)}`
}

/**
 * 增量更新。**不再有"版本更新/勘误"块**（需求 R23）：旧内容由调用方先写进
 * `.study/archive/`，正文只保留最新版。
 *
 * - `append`：补充内容（可指定小节），旧内容天然保留；
 * - `replace`：整体替换（旧正文已存档），返回新渲染的全文；
 * - `definition`：字段级微调，只替换正文首个引用块，不算知识更新。
 */
export function applyUpdate(raw: string, id: string, payload: UpdatePayload): UpdateResult {
  const warnings: string[] = []
  const parsed = parseFrontmatter(raw)
  const fm = raw.slice(0, raw.length - parsed.body.length)

  if (payload.action === 'append') {
    if (!payload.changes?.trim()) throw new Error('append 需要 changes 内容')
    const section = payload.section?.trim()
    const body = section
      ? appendToSection(parsed.body, section, payload.changes)
      : `${parsed.body.trimEnd()}\n\n${payload.changes.trim()}`
    return { text: `${fm}${body}\n`, warnings }
  }

  if (payload.action === 'definition') {
    const summary = String(payload.summary ?? '').trim()
    if (!summary) throw new Error('definition 需要 summary（新的一句话定位）')
    const result = validateSummary(summary)
    if (result.errors.length > 0) throw new Error(`definition 校验失败：${result.errors.join('；')}`)
    warnings.push(...result.warnings)
    return { text: `${fm}${replaceSummaryLine(parsed.body, summary, '定义')}`, warnings }
  }

  if (payload.action === 'replace') {
    if (!payload.block) throw new Error('replace 需要 block 字段（新正文）')
    const result = validateBlock(payload.block)
    if (result.errors.length > 0) throw new Error(`replace 新正文校验失败：${result.errors.join('；')}`)
    warnings.push(...result.warnings)
    // 保留旧 frontmatter 里未被新内容覆盖的 来源章节
    const sourceSection = payload.block.sourceSection ?? parsed.meta?.sourceSection
    const rendered = renderNote({ ...payload.block, sourceSection, id }).trimEnd()
    return { text: `${rendered}\n`, warnings }
  }

  throw new Error(`未知更新动作 "${String(payload.action)}"，可用：append / replace / definition`)
}

/** 关联行标签（wikilink 场景下只用于人类可读的粗标签） */
export type LinkKind = 'prev' | 'next' | 'sibling'

export const LINK_LABELS: Record<LinkKind, string> = {
  prev: '前置',
  next: '后续',
  sibling: '兄弟',
}

/**
 * 反向关系：`prev` ↔ `next`；`sibling` 两侧同向。
 * `note_link` 用它决定对端写哪一行（双向关联，需求 F7）。
 */
export function inverseKind(kind: LinkKind): LinkKind {
  if (kind === 'prev') return 'next'
  if (kind === 'next') return 'prev'
  return 'sibling'
}

/**
 * wikilink 目标清洗：`[` `]` `#` `|` `^` 会截断链接
 * （SEC-3：文件名含 `]]` 时 `[[A]]B]]` 在 Obsidian 里点不开）。
 */
export function wikilinkTarget(name: string): string {
  return inlineText(String(name ?? '').replace(/[[\]#|^]/g, ' ').replace(/\s{2,}/g, ' '))
}

/** 由文件名生成 wikilink 目标（去 `.md` 并清洗） */
export function wikilinkOf(fileName: string): string {
  return `[[${wikilinkTarget(String(fileName ?? '').replace(/\.md$/i, ''))}]]`
}

/** 在正文中找「关联」小节的起始下标（找不到返回 -1） */
export function findLinksSectionStart(body: string): number {
  const sections = splitSections(body).sections
  const target = sections.find((s) => matchesTitle(s.title, LINKS_SECTION))
  return target ? target.start : -1
}

export interface LinkLineHit {
  kind: LinkKind
  target: string
}

/** 解析一行关联行：`- 前置：[[目标]]` → `{ kind, target }`；不是关联行返回 null */
export function parseLinkLine(line: string): LinkLineHit | null {
  const m = /^[ \t]*-\s*(前置|后续|兄弟|易混淆)\s*[：:]\s*(.+)$/.exec(String(line ?? ''))
  if (!m) return null
  const kind: LinkKind = m[1] === '前置' ? 'prev' : m[1] === '后续' ? 'next' : 'sibling'
  const target = m[2].trim()
  return { kind, target }
}
