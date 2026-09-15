/**
 * 迁移期兼容层（阶段 3~4）：把旧的卡片 API 映射到新的笔记 API。
 *
 * 为什么保留这一层：阶段 3 的地基（`note.ts` / `lint.ts`）已经落地，但工具面
 * （`tools.ts` / `index.ts` 的 18 个工具）要到阶段 4 才切换。若此刻直接删掉
 * `card.ts`，中间态会**既不能建卡也不能建块**——与重构计划 P2（"删旧与建新同批"）
 * 正好相反。因此这里用受控的兼容层过渡：模板/字数口径**在本文件里就已经消失**
 * （`template` 入参被忽略、定义不再有长度上限），工具面留下的只是名字。
 *
 * 阶段 4 结束时本文件整体删除，其能力由 `note.ts` 承担。
 * @module card
 */

import { inlineText } from './notemodel.ts'
import { renderFrontmatter } from './frontmatter.ts'
import { validateBlock, type BlockLinks, type BlockInput, type ValidateResult } from './note.ts'

export { generateId, todayLocal, VALID_STATUS } from './note.ts'
export { addLink, type LinkKind } from './links.ts'
export { renderMoc, stripMocDatePrefix, type MocEntry } from './moc.ts'
/** 旧的四模式更新管线（阶段 4 换成 append/replace + 存档） */
export { applyUpdate, type UpdateMode, type UpdatePayload, type UpdateResult } from './updatelegacy.ts'

export type CardLinks = BlockLinks & {
  /**
   * @deprecated 旧的"易混淆"关系。新口径用 `sibling`（同主题兄弟块）承担同类语义；
   * 该键为迁移期兼容保留，渲染时与 `sibling` 合并（阶段 4 随工具面切换删除）。
   */
  conflict?: string[]
}

export interface CardInput extends Omit<BlockInput, 'summary'> {
  /**
   * @deprecated 模板类型。模板概念已退场（需求 R6）：**该入参被忽略**，
   * 只保留声明以让尚未迁移的调用点编译通过。
   */
  template?: string
  /** @deprecated 旧名；映射为 `简介`，不再有长度上限 */
  definition?: string
  summary?: string
}

export interface CardDoc extends CardInput {
  id: string
}

export type { ValidateResult }

/**
 * 校验（兼容旧签名）。
 *
 * **仍然 fail-loud**：必填项、状态枚举、含换行字段照旧拒绝——去掉的只是
 * 模板校验与 `定义` 长度上限（需求量 F4：解除字数与模块约束）。
 * 这条边界很重要：约束可以解除，写入的正确性校验不能松。
 */
export function validateCard(input: CardInput): ValidateResult {
  const errors: string[] = []
  const warnings: string[] = []
  const summary = String(input.summary ?? input.definition ?? '')
  const block = { ...input, summary }
  const result = validateBlock(block)
  errors.push(...result.errors.filter((e) => !e.startsWith('content（正文）')))
  warnings.push(...result.warnings)
  if (!String(input.content ?? '').trim() && !String(input.definition ?? '').trim()) {
    errors.push('content（正文）不能为空')
  }
  return { errors, warnings }
}

function linksSection(links?: CardLinks): string {
  if (!links) return ''
  const lines: string[] = []
  if (links.prev?.length) lines.push(`- 前置：${links.prev.join('、')}`)
  if (links.next?.length) lines.push(`- 后续：${links.next.join('、')}`)
  const siblings = [...(links.sibling ?? []), ...(links.conflict ?? [])]
  if (siblings.length > 0) lines.push(`- 兄弟：${siblings.join('、')}`)
  if (lines.length === 0) return ''
  return `\n### 关联\n${lines.join('\n')}\n`
}

/**
 * 渲染一篇笔记（迁移期签名）。
 *
 * 与旧实现一致的部分：frontmatter → 裸引用块定位 → 自由正文 → 关联小节，
 * 且**不含模板行**（模板概念已退场）。注意 `links` 只写标签、不自动套 wikilink
 * ——调用点若要 wikilink，请用 `links.ts` 的 `addLink`。
 */
export function renderCard(card: CardDoc): string {
  const tags = [...new Set([card.domain, ...(card.tags ?? [])].filter((t): t is string => Boolean(t)))]
  const meta = {
    id: card.id,
    title: card.title,
    domain: tags.length > 0 ? tags.map((t) => `#${t}`).join(' ') : undefined,
    source: card.source,
    status: card.status || '草稿',
  }
  const lead = `> ${inlineText(card.summary ?? card.definition ?? '')}\n\n`
  const body = `${card.definition || card.summary ? lead : ''}${String(card.content ?? '').trim()}\n` + linksSection(card.links)
  return `${renderFrontmatter(meta).trimEnd()}\n\n${body}`
}
