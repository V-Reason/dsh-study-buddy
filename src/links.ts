/**
 * 关联维护：把「关联」小节里的 `- 前置/后续/兄弟：[[目标]]` 行做增删与判重。
 *
 * 2026-10 变化（相对旧的 `card.ts` 关联实现）：
 * - **落盘改为 Obsidian wikilink**（需求 R16）：`[[目标]]` 而非 `` `标题`（ID） ``。
 *   这样笔记在 Obsidian 里可点、路径/标题改名后由 `note_rename` 统一改写。
 * - 判重范围仍是「关联」小节内（沿用旧口径的教训）：扫全正文会把正文里
 *   恰好以 `- 前置：` 开头的行误判成"已关联"，从而静默跳过真实关联。
 * - `kind` 由 `prev/next/conflict` 改为 `prev/next/sibling`（兄弟关系替代易混淆，
 *   语义更贴"同主题内的相邻块"）。
 * @module links
 */

import { findSection, inlineText, matchesTitle, renderSections, splitSections } from './notemodel.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { LINK_LABELS, LINKS_SECTION, wikilinkTarget, type LinkKind } from './note.ts'
import { sanitizeFilename } from './vault.ts'

export type { LinkKind }

/** 展示标签 → wikilink 目标（去 `.md`、去掉 `（ID）` 后缀、清洗非法字符） */
export function linkTargetOf(label: string): string {
  const text = String(label ?? '')
    .replace(/[（(][^（()）]*[)）]\s*$/, '')
    .replace(/^\[\[|\]\]$/g, '')
    .trim()
  return wikilinkTarget(text.replace(/\.md$/i, ''))
}

interface LinksTarget {
  start: number
  body: string
  lines: string[]
}

function findLinksTarget(body: string): LinksTarget | null {
  const sections = splitSections(body).sections
  const target = sections.find((s) => matchesTitle(s.title, LINKS_SECTION))
  if (!target) return null
  return { start: target.start, body: target.body, lines: target.body.split(/\r?\n/) }
}

/** 从一行关联行里取 wikilink 目标（`- 前置：[[目标]]` → `目标`） */
export function parseLinkTarget(line: string): string | null {
  const m = /^[ \t]*-\s*(?:前置|后续|兄弟|易混淆)\s*[：:]\s*(.+)$/.exec(String(line ?? ''))
  if (!m) return null
  const inner = /\[\[([^\]]+)\]\]/.exec(m[1])
  const raw = inner ? inner[1] : m[1]
  return linkTargetOf(raw.split('|')[0].split('#')[0])
}

/**
 * 在某篇笔记正文里加一条关联（**不改 frontmatter，不写盘**）。
 *
 * 返回原文表示"已存在或无需改动"（判重命中），调用方据此报告"未改动"。
 */
export function addLink(raw: string, kind: LinkKind, targetLabel: string): string {
  const parsed = parseFrontmatter(raw)
  const fm = raw.slice(0, raw.length - parsed.body.length)
  const target = linkTargetOf(targetLabel)
  if (!target) throw new Error(`关联目标为空：${String(targetLabel)}`)

  const existing = findLinksTarget(parsed.body)
  if (existing) {
    const duplicated = existing.lines.some((line) => parseLinkTarget(line) === target)
    if (duplicated) return raw
  }

  const line = `- ${LINK_LABELS[kind]}：[[${target}]]`
  const body = parsed.body.trimEnd()
  if (!existing) return `${fm}${body}\n\n### ${LINKS_SECTION}\n${line}\n`

  // 插到关联小节标题行的下一行（保留小节内既有内容）
  const nl = parsed.body.indexOf('\n', existing.start)
  const insertAt = nl === -1 ? body.length : Math.min(nl + 1, body.length)
  // 标题是正文最后一行时必须补换行（N4）：否则关联行会粘成 `### 关联- 前置：…`
  if (insertAt >= body.length) return `${fm}${body}\n${line}\n`
  return `${fm}${body.slice(0, insertAt)}${line}\n${body.slice(insertAt)}`
}

/** 移除一条关联；目标不存在时返回原文 */
export function removeLink(raw: string, targetLabel: string): string {
  const parsed = parseFrontmatter(raw)
  const fm = raw.slice(0, raw.length - parsed.body.length)
  const target = linkTargetOf(targetLabel)
  const existing = findLinksTarget(parsed.body)
  if (!existing || !target) return raw
  // 小节正文里以 `- ` 开头的才是关联行；其余（用户写的说明文字）原样保留
  const keptLines: string[] = []
  let removed = 0
  for (const line of existing.lines) {
    if (!/^[ \t]*-/.test(line)) {
      keptLines.push(line)
      continue
    }
    const hit = parseLinkTarget(line)
    if (hit === target) removed += 1
    else keptLines.push(line)
  }
  if (removed === 0) return raw

  const head = parsed.body.slice(0, existing.start).replace(/\s+$/, '')
  // 小节结束位置 = 标题行尾 + 小节正文长度（`existing.body` 不含标题行）
  const headingEnd = existing.start + rawHeadingLength(parsed.body, existing.start)
  const tail = parsed.body.slice(headingEnd + existing.body.length).replace(/^\s+/, '')
  const keptBody = keptLines.join('\n').replace(/\s+$/, '')

  if (!keptBody) {
    // 关联行全删光：不留空小节（用户的说明文字也没有时）
    if (!tail) return `${fm}${head}\n`
    return `${fm}${head ? `${head}\n\n` : ''}${tail.replace(/\s+$/, '')}\n`
  }
  const section = `### ${LINKS_SECTION}\n${keptBody}`
  if (!tail) return `${fm}${head ? `${head}\n\n` : ''}${section}\n`
  return `${fm}${head ? `${head}\n\n` : ''}${section}\n\n${tail.replace(/\s+$/, '')}\n`
}

/** 关联小节标题行（含换行）的长度；用于定位小节结束 */
function rawHeadingLength(body: string, start: number): number {
  const nl = body.indexOf('\n', start)
  return nl === -1 ? body.length - start : nl + 1 - start
}

export interface LinkLine {
  kind: LinkKind | 'conflict'
  target: string
  line: number
}

/** 列出正文里的全部关联行（供 `note_link` 报告与去重检查） */
export function listLinks(body: string): LinkLine[] {
  const out: LinkLine[] = []
  String(body ?? '').split(/\r?\n/).forEach((text, i) => {
    const m = /^[ \t]*-\s*(前置|后续|兄弟|易混淆)\s*[：:]\s*(.+)$/.exec(text)
    if (!m) return
    const kind: LinkLine['kind'] = m[1] === '前置' ? 'prev' : m[1] === '后续' ? 'next' : m[1] === '兄弟' ? 'sibling' : 'conflict'
    out.push({ kind, target: parseLinkTarget(text) ?? m[2].trim(), line: i + 1 })
  })
  return out
}

function escapeRe(text: string): string {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把 frontmatter 的标题替换为新标题，其余字段与正文原样保留（标题收敛为单行，SEC-1） */
export function replaceNoteTitle(raw: string, newTitle: string): string {
  const title = inlineText(newTitle)
  const { body } = parseFrontmatter(raw)
  const head = raw.slice(0, raw.length - body.length)
  if (/^标题:/m.test(head)) return `${head.replace(/^标题:.*$/m, `标题: ${title}`)}${body}`
  return `---\n标题: ${title}\n---\n${body}`
}

/** 从原始文本提取卡片标题（frontmatter 优先，回退正文一级标题） */
export function noteTitleOf(raw: string): string {
  const { meta, body } = parseFrontmatter(raw)
  if (meta?.title) return meta.title
  const heading = /^#\s+(.+)$/m.exec(body)
  return heading ? heading[1].trim() : ''
}

export interface LinkRewrite {
  text: string
  /** 被改写的行数 */
  changed: number
  /** 改写前的行样本（最多 3 条，供 dryRun 报告） */
  samples: string[]
}

/**
 * 重写「关联」小节里指向目标笔记的行（2026-10：关联改为 wikilink 格式）：
 * - wikilink：`- 前置：[[旧标题]]` → `- 前置：[[新标题]]`（按字面量替换）；
 * - 旧格式（迁移期兼容）：`- 前置：`旧标题`（ID）` —— 有 ID 时按 `（ID）` 锚点命中。
 * 只动以 `-` 开头且落在关联小节内的行，避免误改正文引用。
 */
export function rewriteLinkLines(body: string, opts: { oldTitle: string; newTitle: string; targetId?: string }): LinkRewrite {
  const { lead, sections } = splitSections(body)
  const samples: string[] = []
  let changed = 0
  const idRe = opts.targetId ? new RegExp(`（${escapeRe(opts.targetId)}）`) : null
  const next = sections.map((section) => {
    if (!/^关联/.test(section.title)) return section
    const lines = section.body.split(/\r?\n/).map((line) => {
      if (!/^[ \t]*-/.test(line)) return line
      const hit = idRe ? idRe.test(line) : (line.includes(`\`${opts.oldTitle}\``) || line.includes(`[[${opts.oldTitle}]]`))
      if (!hit) return line
      const replaced = line.split(opts.oldTitle).join(opts.newTitle)
      if (replaced === line) return line
      changed += 1
      if (samples.length < 3) samples.push(`${line.trim()} → ${replaced.trim()}`)
      return replaced
    })
    return { ...section, body: lines.join('\n') }
  })
  return { text: renderSections(lead, next), changed, samples }
}

/**
 * 重写 Obsidian wikilink（MOC 用文件名建链）：
 * `[[旧名]]` / `[[旧名|别名]]` / `[[旧名#标题]]` → 新文件名。
 */
export function rewriteWikilinks(body: string, oldBase: string, newBase: string): LinkRewrite {
  const samples: string[] = []
  let changed = 0
  const re = new RegExp(`\\[\\[${escapeRe(oldBase)}(\\|[^\\]]*|#[^\\]]*)?\\]\\]`, 'g')
  const text = String(body ?? '').replace(re, (match, tail: string | undefined) => {
    changed += 1
    const replaced = `[[${newBase}${tail ?? ''}]]`
    if (samples.length < 3) samples.push(`${match} → ${replaced}`)
    return replaced
  })
  return { text, changed, samples }
}

export interface BrokenLinkHit {
  /** 行号（1 基） */
  line: number
  text: string
  reason: string
}

/**
 * 断链检测（改名后调用）：在关联卡片小节里找
 * ① 仍指向旧标题且没有 ID 锚点的行（改名没同步到）；
 * ② 格式可疑（既不是 `- 标签：…` 也不像路径）的行（`checkFormat: false` 时跳过，
 *    用于"改别的文件时只关心本次改名相关的断链"，避免无关格式噪声）。
 * 注意：不带 `（ID）` 的关联行是合法的（旧笔记用路径寻址），不据此判为断链。
 */
export function detectBrokenLinks(
  body: string,
  opts: { oldTitle: string; oldId?: string; newTitle?: string; checkFormat?: boolean } = { oldTitle: '' },
): BrokenLinkHit[] {
  const checkFormat = opts.checkFormat !== false
  const section = findSection(splitSections(body).sections, '关联') ?? findSection(splitSections(body).sections, '关联卡片')
  if (!section) return []
  const hits: BrokenLinkHit[] = []
  const text = String(body ?? '')
  const baseLine = text.slice(0, section.start).split('\n').length
  section.body.split(/\r?\n/).forEach((line, i) => {
    if (!/^[ \t]*-/.test(line)) return
    const lineNo = baseLine + i
    // 新标题包含旧标题（如 "A" → "A 与探针"）时不能据此判断链：先看是否已含新标题
    const pointsToOld = opts.oldTitle && line.includes(opts.oldTitle)
      && !(opts.newTitle && line.includes(opts.newTitle))
      && !(opts.oldId && line.includes(`（${opts.oldId}）`))
    if (pointsToOld) {
      hits.push({ line: lineNo, text: line.trim(), reason: `仍指向旧标题「${opts.oldTitle}」` })
      return
    }
    if (checkFormat && !/^[ \t]*-\s*(?:前置|后续|兄弟|易混淆)\s*[：:]/.test(line)) {
      hits.push({ line: lineNo, text: line.trim(), reason: '关联行格式不符（应为 "- 标签：[[标题]]"）' })
    }
  })
  return hits
}

export interface RenamePlanInput {
  /** 卡片当前文件名（含 .md） */
  fileName: string
  /** frontmatter 旧标题 */
  oldTitle: string
  newTitle: string
}

export interface RenamePlan {
  /** 是否同步改文件名（仅当文件名 == 旧标题清洗结果时为真） */
  renameFile: boolean
  oldBase: string
  newBase: string
  reason: string
}

/**
 * 决定是否同步改文件名。文件名与旧标题脱节时（历史遗留、手动改过名）
 * 保留文件名，只改标题与入链——避免"改标题顺带搬文件"的意外。
 */
export function planRename(input: RenamePlanInput): RenamePlan {
  const oldBase = input.fileName.replace(/\.md$/i, '')
  const newBase = sanitizeFilename(input.newTitle)
  const expected = sanitizeFilename(input.oldTitle)
  if (oldBase === newBase) return { renameFile: false, oldBase, newBase, reason: '新标题清洗后与原文件名相同，无需改名' }
  // 既存文件名含已废弃字符（如 `A[B].md`）时，两边同口径归一后再比（N13）：
  // 否则会被判成"历史遗留"而不再同步文件名
  if (oldBase === expected || sanitizeFilename(oldBase) === expected) {
    return { renameFile: true, oldBase, newBase, reason: '文件名与旧标题一致，同步改名为新标题' }
  }
  return { renameFile: false, oldBase, newBase, reason: `文件名「${oldBase}」与旧标题「${input.oldTitle}」不一致（历史遗留），保留文件名，只改标题与入链` }
}

/** 渲染改名报告（工具返回用） */
export function formatRenameReport(input: {
  id: string
  oldTitle: string
  newTitle: string
  plan: RenamePlan
  filesChanged: Array<{ rel: string; kind: string; changed: number; samples: string[] }>
  broken: BrokenLinkHit[]
  dryRun: boolean
  /** 额外提示（回滚失败、旧文件未删除、跳过文件等） */
  notes?: string[]
}): string {
  const lines: string[] = []
  lines.push(`${input.dryRun ? '[dryRun] ' : ''}改名：${input.oldTitle} → ${input.newTitle}（ID：${input.id}）`)
  lines.push(`文件名：${input.plan.renameFile ? `${input.plan.oldBase}.md → ${input.plan.newBase}.md` : `不变（${input.plan.reason}）`}`)
  if (input.filesChanged.length === 0) lines.push('入链：无改动')
  else {
    lines.push(`入链：${input.filesChanged.length} 个文件`)
    for (const f of input.filesChanged) {
      lines.push(`  - ${f.rel}（${f.kind}，${f.changed} 行）`)
      for (const s of f.samples) lines.push(`      ${s}`)
    }
  }
  if (input.broken.length > 0) {
    lines.push(`断链检测：${input.broken.length} 处`)
    for (const b of input.broken) lines.push(`  - 第 ${b.line} 行：${b.reason}：${b.text}`)
  } else {
    lines.push('断链检测：无')
  }
  for (const note of input.notes ?? []) lines.push(note)
  return lines.join('\n')
}
