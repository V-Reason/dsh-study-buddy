/**
 * 笔记可发现性审计：找缺来源章节、缺微目录、孤立、断链、歧义链接和重复标题。
 *
 * 审计只返回问题，不修改文件。链接与正文只在这里读取一次，避免把全库正文
 * 常驻进检索索引。
 * @module discoverability
 */

import { dirOfRel, isTocRel, normRel } from './dirs.ts'
import { blankOutBlocks } from './notemodel.ts'
import { compareText } from './order.ts'
import type { NoteKind } from './search.ts'
import { isSourceRefComplete, normalizeSourceSection } from './sourceSection.ts'

export type DiscoverabilityIssueKind =
  | 'missing-source-section'
  | 'invalid-source-section'
  | 'missing-toc'
  | 'orphan'
  | 'broken-link'
  | 'ambiguous-link'
  | 'duplicate-title'

export interface DiscoverabilityNote {
  rel: string
  title: string
  kind: NoteKind
  sourceSection: string | null
  body: string
}

export interface DiscoverabilityIssue {
  kind: DiscoverabilityIssueKind
  severity: 'error' | 'warn' | 'info'
  title: string
  rel: string
  message: string
  suggestion: string
}

export interface DiscoverabilityReport {
  scope: string
  total: number
  legacy: number
  oldNotes: number
  issues: DiscoverabilityIssue[]
}

export interface DiscoverabilityOptions {
  /** vault 内相对目录；`.` / 空串表示全库 */
  path?: string
}

const WIKILINK_RE = /!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g

export function wikilinkTargets(body: string): string[] {
  return [...blankOutBlocks(String(body ?? '')).matchAll(WIKILINK_RE)]
    .map((match) => match[1].trim())
    .filter(Boolean)
}

function keyOf(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .toLowerCase()
    .trim()
}

function inScope(rel: string, rawScope: string | undefined): boolean {
  const scope = normRel(rawScope ?? '')
  const target = normRel(rel)
  return scope === '' || target === scope || target.startsWith(`${scope}/`)
}

function issue(
  kind: DiscoverabilityIssueKind,
  severity: DiscoverabilityIssue['severity'],
  title: string,
  rel: string,
  message: string,
  suggestion: string,
): DiscoverabilityIssue {
  return { kind, severity, title, rel, message, suggestion }
}

const ISSUE_ORDER: Record<DiscoverabilityIssueKind, number> = {
  'broken-link': 0,
  'ambiguous-link': 1,
  'missing-toc': 2,
  'missing-source-section': 3,
  'invalid-source-section': 4,
  orphan: 5,
  'duplicate-title': 6,
}

export function auditDiscoverability(
  notes: DiscoverabilityNote[],
  tocDirs: string[],
  opts: DiscoverabilityOptions = {},
): DiscoverabilityReport {
  const scope = normRel(opts.path ?? '')
  const toc = new Set(tocDirs.map(normRel))
  const scoped = notes.filter((note) => inScope(note.rel, scope))
  const issues: DiscoverabilityIssue[] = []

  const targetMap = new Map<string, Set<string>>()
  const addTarget = (key: string, rel: string): void => {
    if (!key) return
    const current = targetMap.get(key) ?? new Set<string>()
    current.add(normRel(rel))
    targetMap.set(key, current)
  }
  for (const note of notes) {
    addTarget(keyOf(note.title), note.rel)
    addTarget(keyOf(note.rel.split('/').at(-1) ?? ''), note.rel)
    addTarget(keyOf(note.rel), note.rel)
  }

  const inbound = new Map<string, number>()
  for (const note of notes) {
    if (isTocRel(note.rel)) continue
    for (const target of wikilinkTargets(note.body)) {
      const matches = targetMap.get(keyOf(target))
      if (!matches || matches.size === 0) {
        if (inScope(note.rel, scope)) {
          issues.push(issue(
            'broken-link', 'error', '断链', note.rel,
            `[[${target}]] 找不到目标`,
            '确认标题/路径；必要时改链而不是新建同名孤儿笔记',
          ))
        }
        continue
      }
      if (matches.size > 1) {
        if (inScope(note.rel, scope)) {
          issues.push(issue(
            'ambiguous-link', 'warn', '歧义链接', note.rel,
            `[[${target}]] 命中 ${matches.size} 篇笔记`,
            '改用根限定路径或更明确的标题',
          ))
        }
      }
      for (const targetRel of matches) {
        if (targetRel !== normRel(note.rel)) inbound.set(targetRel, (inbound.get(targetRel) ?? 0) + 1)
      }
    }
  }

  const contentByDir = new Map<string, number>()
  for (const note of scoped) {
    if (isTocRel(note.rel)) continue
    const dir = dirOfRel(note.rel)
    if (dir) contentByDir.set(dir, (contentByDir.get(dir) ?? 0) + 1)
  }
  for (const [dir, count] of contentByDir) {
    if (count > 0 && !toc.has(dir)) {
      issues.push(issue(
        'missing-toc', 'warn', '缺微目录', dir,
        `目录有 ${count} 篇可导航笔记，但没有微目录.md`,
        `确认目录范围后调用 note_toc(dir="${dir}")`,
      ))
    }
  }

  const titleGroups = new Map<string, DiscoverabilityNote[]>()
  for (const note of scoped) {
    if (isTocRel(note.rel)) continue
    const key = keyOf(note.title)
    titleGroups.set(key, [...(titleGroups.get(key) ?? []), note])
  }
  for (const group of titleGroups.values()) {
    if (group.length < 2) continue
    for (const note of group) {
      issues.push(issue(
        'duplicate-title', 'info', '重复标题', note.rel,
        `标题「${note.title}」在同一范围出现 ${group.length} 次`,
        '确认是否为重复知识；不是则改成可区分的标题',
      ))
    }
  }

  for (const note of scoped) {
    if (isTocRel(note.rel)) continue
    if (note.kind === 'legacy') {
      issues.push(issue(
        'missing-source-section', 'warn', '缺来源章节', note.rel,
        `「${note.title}」有 ID，但缺少来源章节`,
        '确认资料与章节后用 note_update(action=metadata) 补齐',
      ))
    }
    if (note.sourceSection && !isSourceRefComplete(normalizeSourceSection(note.sourceSection))) {
      issues.push(issue(
        'invalid-source-section', 'warn', '来源章节不可归类', note.rel,
        `无法从「${note.sourceSection}」解析资料名与章号`,
        '改成《资料名》第N章 标题 / N.N节 的形式',
      ))
    }
    const dir = dirOfRel(note.rel)
    if (note.kind !== 'note' && (inbound.get(normRel(note.rel)) ?? 0) === 0 && !toc.has(dir)) {
      issues.push(issue(
        'orphan', 'info', '孤立笔记', note.rel,
        `「${note.title}」没有入链，且所在目录没有微目录`,
        '补一个有意义的 wikilink，或为所在主题生成微目录',
      ))
    }
  }

  issues.sort((a, b) => ISSUE_ORDER[a.kind] - ISSUE_ORDER[b.kind]
    || compareText(a.rel, b.rel)
    || compareText(a.message, b.message))
  return {
    scope,
    total: scoped.length,
    legacy: scoped.filter((note) => note.kind === 'legacy').length,
    oldNotes: scoped.filter((note) => note.kind === 'note').length,
    issues,
  }
}

export function formatDiscoverability(report: DiscoverabilityReport, limit = 10): string {
  const lines = [
    `## 笔记可发现性体检（${report.scope || '全库'}）`,
    '',
    `- 检查：${report.total} 篇（存量卡 ${report.legacy}，旧笔记 ${report.oldNotes}）`,
    `- 问题：${report.issues.length} 条`,
  ]
  if (report.issues.length === 0) return `${lines.join('\n')}\n\n未发现问题。`
  const counts = new Map<string, number>()
  for (const item of report.issues) counts.set(item.title, (counts.get(item.title) ?? 0) + 1)
  lines.push(`- 分布：${[...counts].map(([title, count]) => `${title} ${count}`).join('，')}`, '', '优先处理：')
  for (const item of report.issues.slice(0, limit)) {
    lines.push(`- [${item.severity}] ${item.title}：${item.rel}｜${item.message}；${item.suggestion}`)
  }
  if (report.issues.length > limit) lines.push(`- 其余 ${report.issues.length - limit} 条未展开`)
  return lines.join('\n')
}
