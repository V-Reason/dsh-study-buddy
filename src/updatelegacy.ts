/**
 * 旧的"增量更新"管线 —— **迁移期保留，阶段 4 删除**。
 *
 * 它实现的是卡片时代的四模式（`append-version` / `errata` / `definition` /
 * `replace`，其中 replace 把旧正文压进 `<details>` 折叠块）。新口径（需求 R23）
 * 已改为"正文只留最新版，旧版本另存 `.study/archive/`"（见 `note.ts` 的
 * `applyUpdate` 与 `archive.ts` 的 `archiveThenWrite`）。
 *
 * 之所以暂时保留：阶段 4 才会切换工具面；在它之前删掉会让 `card_update` 失效。
 * @module updatelegacy
 */

import { inlineText } from './notemodel.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { errataBlock, insertHistoryBlock, versionBlock } from './history.ts'
import { validateSummary } from './note.ts'
import { generateId, renderCard, validateCard, type CardInput } from './card.ts'

export type UpdateMode = 'append-version' | 'errata' | 'definition' | 'replace'

export interface UpdatePayload {
  mode: UpdateMode
  /** append-version / errata 追加的 Markdown 内容 */
  changes?: string
  /** append-version 的更新来源 */
  source?: string
  /** definition 模式：新的一句话定位 */
  definition?: string
  /** replace 模式的新内容（id 沿用旧笔记） */
  card?: Omit<CardInput, 'id'>
}

export interface UpdateResult {
  text: string
  warnings: string[]
}

export { generateId }

/** 生成一个可预测测试的 ID（供旧管线复用） */
export function newId(): string {
  return generateId()
}

export function applyUpdate(raw: string, id: string, payload: UpdatePayload): UpdateResult {
  const warnings: string[] = []
  if (payload.mode === 'append-version') {
    if (!payload.changes?.trim()) throw new Error('append-version 模式需要 changes 内容')
    const src = payload.source?.trim() || '学习补充'
    // P0-3：插到「关联」之前——旧实现追加到文件末尾，阅读顺序被破坏
    return { text: insertHistoryBlock(raw, versionBlock(src, payload.changes)), warnings }
  }
  if (payload.mode === 'errata') {
    if (!payload.changes?.trim()) throw new Error('errata 模式需要 changes 内容（含纠正原因）')
    return { text: insertHistoryBlock(raw, errataBlock(payload.changes)), warnings }
  }
  if (payload.mode === 'definition') {
    const result = validateSummary(payload.definition ?? '')
    if (result.errors.length > 0) throw new Error(`definition 模式校验失败：${result.errors.join('；')}`)
    warnings.push(...result.warnings)
    const parsed = parseFrontmatter(raw)
    const fm = raw.slice(0, raw.length - parsed.body.length)
    const body = parsed.body
    const trimmed = body.trimStart()
    if (!trimmed.startsWith('>')) {
      throw new Error('definition 模式要求正文首行为引用块（> …）；非标准笔记请用 replace 或手动修正')
    }
    const lead = body.slice(0, body.length - trimmed.length)
    const lineEndRel = trimmed.indexOf('\n')
    const lineEnd = lead.length + (lineEndRel === -1 ? trimmed.length : lineEndRel)
    const next = `${body.slice(0, lead.length)}> ${String(payload.definition).trim()}${body.slice(lineEnd)}`
    return { text: `${fm}${next}`, warnings }
  }
  if (payload.mode === 'replace') {
    if (!payload.card) throw new Error('replace 模式需要 card 字段（新内容）')
    const result = validateCard(payload.card)
    if (result.errors.length > 0) throw new Error(`replace 新内容校验失败：${result.errors.join('；')}`)
    warnings.push(...result.warnings)
    const oldBody = parseFrontmatter(raw).body.trim()
    const rendered = renderCard({ ...payload.card, id }).trimEnd()
    const date = new Date().toISOString().slice(0, 10)
    const history = `\n\n<details>\n<summary>历史版本（${date}）</summary>\n\n${oldBody}\n\n</details>\n`
    return { text: rendered + history, warnings }
  }
  throw new Error(`未知更新模式 "${String(payload.mode)}"，可用：append-version / errata / definition / replace`)
}

/** `inlineText` 转出，供调用点复用（避免各处重复 import） */
export { inlineText }
