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

import { matchesTitle, splitSections } from './notemodel.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { LINK_LABELS, LINKS_SECTION, wikilinkTarget, type LinkKind } from './note.ts'

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
