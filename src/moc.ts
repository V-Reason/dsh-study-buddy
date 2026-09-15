/**
 * MOC（知识目录）组装 —— **迁移期保留，阶段 4 删除**。
 *
 * 需求 R22 与架构选型 §4.4 决定：不再有 vault 根的全局总目录，导航改由各级
 * 主题目录下的 `微目录.md` 承担（`note_toc` 生成）。因此 `card_moc` 工具与
 * 本模块都会在阶段 4 退场；此刻保留它只为让尚未迁移的工具面继续可用。
 * @module moc
 */

import { inlineText } from './notemodel.ts'
import { wikilinkTarget } from './note.ts'

export interface MocEntry {
  id: string
  title: string
  domain: string
  fileName: string
}

/**
 * 剥离 MOC 标题开头的日期前缀（`YYYY-MM-DD_` / `YYYY-MM-DD ` 等）：
 * 旧惯例把完整日期写进 title，而 `card_moc` 会自动加日期前缀 → 双前缀。
 * 工具侧保证"title 只传主题"，本函数做兜底归一。
 */
export function stripMocDatePrefix(title: string): string {
  return String(title ?? '')
    .trim()
    .replace(/^(\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?|月)?)[_\s-]+/, '')
    .trim()
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
