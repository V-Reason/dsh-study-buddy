/**
 * 版本更新 / 勘误 / 历史折叠块（P0-3 / P0-4）。
 *
 * 2026-09 之前的 bug：`append-version`/`errata` 直接追加到文件末尾，于是阅读
 * 顺序变成「知识 → 关联卡片 → 新知识」。这里把历史块当作文档模型的一类小节
 * 来定位与插入，插到「关联卡片」之前，并提供 list / strip / 配对校验。
 * @module history
 */

import { insertBlockBefore, renderSections, splitSections } from './cardmodel.ts'

export type HistoryKind = 'version' | 'errata' | 'details'

export interface HistoryBlock {
  kind: HistoryKind
  /** 小节标题（details 块为 `<summary>` 内容） */
  title: string
  /** 正文 */
  body: string
  /** 起始行号（1 基） */
  line: number
  /** 结束行号（1 基，含） */
  endLine: number
}

export interface DetailsCheck {
  /** `<details>` 与 `</details>` 是否配对 */
  balanced: boolean
  opens: number
  closes: number
  /** 未闭合的起始行号 */
  unclosed: number[]
}

/** 校验 `<details>` 配对（strip 前必查，避免切坏折叠块） */
export function checkDetails(body: string): DetailsCheck {
  const lines = String(body ?? '').split(/\r?\n/)
  let depth = 0
  let opens = 0
  let closes = 0
  const unclosed: number[] = []
  lines.forEach((line, i) => {
    const openMatches = line.match(/<details\b/gi) ?? []
    const closeMatches = line.match(/<\/details>/gi) ?? []
    for (let n = 0; n < openMatches.length; n++) {
      if (depth === 0) unclosed.push(i + 1)
      depth += 1
      opens += 1
    }
    for (let n = 0; n < closeMatches.length; n++) {
      closes += 1
      depth -= 1
      if (depth <= 0) {
        depth = 0
        unclosed.pop()
      }
    }
  })
  return { balanced: depth === 0 && opens === closes, opens, closes, unclosed }
}

/** 提取全部历史块（版本更新 / 勘误小节 + `<details>` 折叠块） */
export function extractHistory(body: string): HistoryBlock[] {
  const text = String(body ?? '')
  const { sections } = splitSections(text)
  const blocks: HistoryBlock[] = []
  const lineOf = (index: number): number => text.slice(0, index).split('\n').length
  for (const section of sections) {
    if (/^版本更新/.test(section.title)) {
      blocks.push({ kind: 'version', title: section.title, body: section.body, line: lineOf(section.start), endLine: lineOf(section.end) })
    } else if (/^勘误/.test(section.title)) {
      blocks.push({ kind: 'errata', title: section.title, body: section.body, line: lineOf(section.start), endLine: lineOf(section.end) })
    }
  }
  // `<details>` 折叠块：逐行配对（可能跨多行，也可能与正文同行）
  const lines = text.split(/\r?\n/)
  let start = -1
  let depth = 0
  let buffer: string[] = []
  lines.forEach((line, i) => {
    if (/<details\b/i.test(line) && depth === 0) {
      start = i
      buffer = []
      depth = 0
    }
    if (start !== -1) {
      buffer.push(line)
      depth += (line.match(/<details\b/gi) ?? []).length
      depth -= (line.match(/<\/details>/gi) ?? []).length
      if (depth <= 0) {
        const raw = buffer.join('\n')
        const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(raw)
        blocks.push({
          kind: 'details',
          title: summary ? summary[1].trim() : '历史版本',
          body: raw.replace(/<\/?details\b[^>]*>/gi, '').replace(/<summary>[\s\S]*?<\/summary>/i, '').trim(),
          line: start + 1,
          endLine: i + 1,
        })
        start = -1
        buffer = []
      }
    }
  })
  return blocks.sort((a, b) => a.line - b.line)
}

/** 渲染版本更新块（插入到关联卡片之前） */
export function versionBlock(source: string, changes: string): string {
  return `### 版本更新（来源：${source}）\n${String(changes ?? '').trim()}`
}

/** 渲染勘误块 */
export function errataBlock(changes: string): string {
  return `### 勘误\n${String(changes ?? '').trim()}`
}

/**
 * 把版本更新/勘误块插到「关联卡片」之前（无该小节时追加到末尾）。
 * 这是 P0-3 的修复点：旧实现直接拼到文件末尾。
 */
export function insertHistoryBlock(body: string, block: string): string {
  return insertBlockBefore(body, block, '关联卡片')
}

export interface StripResult {
  text: string
  removed: HistoryBlock[]
  warnings: string[]
}

/** 删除指定的 `<details>` 折叠块（按 `</details>` 结尾的整块删除，保留块外内容） */
function dropDetailsBlocks(text: string, blocks: HistoryBlock[]): string {
  if (blocks.length === 0) return text
  const targets = new Set(blocks.map((b) => b.line))
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  let i = 0
  while (i < lines.length) {
    const lineNo = i + 1
    if (targets.has(lineNo)) {
      const target = blocks.find((b) => b.line === lineNo)!
      i = target.endLine
      continue
    }
    kept.push(lines[i])
    i += 1
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/, '')
}

/**
 * 剥离历史块（P0-4 `card_history strip`）。
 * - 先校验 `<details>` 配对：不配对时给出警告，未闭合块不会被删除；
 * - `kinds` 可指定只清某类（如只清历史折叠、保留勘误）。
 */
export function stripHistory(body: string, opts: { kinds?: HistoryKind[] } = {}): StripResult {
  const text = String(body ?? '')
  const warnings: string[] = []
  const check = checkDetails(text)
  if (!check.balanced) {
    warnings.push(`<details> 标签不配对（开 ${check.opens} / 闭 ${check.closes}），未闭合块不会被删除${check.unclosed.length > 0 ? `（起始行 ${check.unclosed.join('、')}）` : ''}`)
  }
  const kinds = new Set<HistoryKind>(opts.kinds ?? ['version', 'errata', 'details'])
  const removed = extractHistory(text).filter((b) => kinds.has(b.kind))
  if (removed.length === 0) return { text, removed, warnings }
  const { lead, sections } = splitSections(text)
  const kept = sections.filter((s) => {
    if (kinds.has('version') && /^版本更新/.test(s.title)) return false
    if (kinds.has('errata') && /^勘误/.test(s.title)) return false
    return true
  })
  let next = renderSections(lead, kept)
  if (kinds.has('details')) next = dropDetailsBlocks(next, removed.filter((b) => b.kind === 'details'))
  return { text: next, removed, warnings }
}

/** 渲染历史块清单（`card_history list`） */
export function formatHistory(blocks: HistoryBlock[]): string {
  if (blocks.length === 0) return '（无历史块：该卡没有版本更新/勘误/历史折叠）'
  const label: Record<HistoryKind, string> = { version: '版本更新', errata: '勘误', details: '历史折叠' }
  return blocks
    .map((b) => `- [${label[b.kind]}] 第 ${b.line}-${b.endLine} 行：${b.title}${b.body ? `（${b.body.replace(/\s+/g, ' ').slice(0, 60)}…）` : ''}`)
    .join('\n')
}
