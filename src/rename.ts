/**
 * 改名与入链重写（P0-5）。
 *
 * MOC 用文件名生成 wikilink、关联卡片用 `标题（ID）` 生成入链，因此改标题
 * 必须同步：frontmatter 标题 + 文件名 + 全库入链 + MOC 链接，并做断链检测。
 * 本模块只做纯文本变换（给定正文/文件清单），文件遍历与写入由 VaultStore 负责。
 * @module rename
 */

import { parseFrontmatter } from './frontmatter.ts'
import { findSection, inlineText, renderSections, splitSections } from './notemodel.ts'
import { sanitizeFilename } from './vault.ts'

/** 转义正则元字符（用于把标题/文件名当字面量匹配） */
function escapeRe(text: string): string {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把 frontmatter 的标题替换为新标题，其余字段与正文原样保留（标题收敛为单行，SEC-1） */
export function replaceCardTitle(raw: string, newTitle: string): string {
  const title = inlineText(newTitle)
  const { body } = parseFrontmatter(raw)
  const head = raw.slice(0, raw.length - body.length)
  if (/^标题:/m.test(head)) return `${head.replace(/^标题:.*$/m, `标题: ${title}`)}${body}`
  return `---\n标题: ${title}\n---\n${body}`
}

/** 从原始文本提取卡片标题（frontmatter 优先，回退正文一级标题） */
export function cardTitleOf(raw: string): string {
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
 * 重写「关联卡片」小节里指向目标卡片的行：
 * - 有 ID：`- 前置：\`旧标题\`（ID）` → `- 前置：\`新标题\`（ID）`（ID 是可靠锚点）；
 * - 无 ID（旧笔记按路径寻址）：按 `` `旧标题` `` 字面量替换。
 * 只动以 `-` 开头且落在关联卡片小节内的行，避免误改正文引用。
 */
export function rewriteCardLinks(body: string, opts: { oldTitle: string; newTitle: string; targetId?: string }): LinkRewrite {
  const { lead, sections } = splitSections(body)
  const samples: string[] = []
  let changed = 0
  const idRe = opts.targetId ? new RegExp(`（${escapeRe(opts.targetId)}）`) : null
  const next = sections.map((section) => {
    if (!/^关联卡片/.test(section.title)) return section
    const lines = section.body.split(/\r?\n/).map((line) => {
      if (!/^[ \t]*-/.test(line)) return line
      const hit = idRe ? idRe.test(line) : line.includes(`\`${opts.oldTitle}\``)
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
  const section = findSection(splitSections(body).sections, '关联卡片')
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
    if (checkFormat && !/^[ \t]*-\s*(?:前置|后续|易混淆)\s*[：:]/.test(line)) {
      hits.push({ line: lineNo, text: line.trim(), reason: '关联行格式不符（应为 "- 标签：`标题`（ID）"）' })
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
