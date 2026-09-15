/**
 * 极简 YAML frontmatter 解析/生成：只支持标量 `key: value` 行。
 *
 * 2026-10 文档式笔记重构：六键（ID/标题/领域/来源/状态 + 可选 模板）之外，
 * 新增三个文档键——`来源章节`（覆盖度唯一数据源）、`顺序`（微目录排序）、
 * `简介`（一句话定位，取代旧的「定义」，不再有长度硬限）。
 *
 * 兼容口径：
 * - `定义` 作为 `简介` 的别名读取（存量卡可读，无需改写）；
 * - `模板` 只读不渲染（模板概念已退场），读到即丢弃、不报错——存量卡不应因此变红。
 *
 * 解析失败不吞：调用方按"无 frontmatter"降级索引并标记。
 * @module frontmatter
 */

import { inlineText } from './notemodel.ts'

export interface CardMeta {
  id?: string
  title?: string
  domain?: string
  source?: string
  status?: string
  /** 来源章节（`《资料》第N章 章标题 / N.N节`），覆盖度按它聚合 */
  sourceSection?: string
  /** 微目录排序键 */
  order?: number
  /** 一句话定位（无长度硬限；正文首个引用块可回填） */
  summary?: string
  /**
   * @deprecated 模板声明（理论型/工程型/对比型）。
   * 模板概念已退场（需求 R6），本字段**只读不渲染**，仅为迁移期让尚未删除的
   * `template.ts` 能编译；阶段 6 随模板模块一起删除。
   */
  template?: string
}

export interface ParsedNote {
  /** 解析出的标量 meta；文件以 `---` 开头但字段为空时是空对象，无 frontmatter 时为 null */
  meta: CardMeta | null
  /** frontmatter 之后的正文字段 */
  body: string
  /** 原始全文 */
  raw: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export function parseFrontmatter(raw: string): ParsedNote {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return { meta: null, body: raw, raw }
  const meta: CardMeta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (value === '') continue
    if (key === 'ID') meta.id = value
    else if (key === '标题') meta.title = value
    else if (key === '领域') meta.domain = value
    else if (key === '来源') meta.source = value
    else if (key === '状态') meta.status = value
    // 简介优先；存量卡的「定义」作别名兜底（同现时以 简介 为准）
    else if (key === '简介') meta.summary = value
    else if (key === '定义' && meta.summary === undefined) meta.summary = value
    else if (key === '来源章节') meta.sourceSection = value
    else if (key === '顺序') {
      const n = Number(value)
      if (Number.isFinite(n)) meta.order = n
    }
    // 模板声明（迁移期读取，不渲染；阶段 6 随 template.ts 删除）
    else if (key === '模板') meta.template = value
  }
  return { meta, body: raw.slice(m[0].length), raw }
}

/**
 * 渲染 frontmatter。每个值都过 `inlineText`（SEC-1）：标题/来源里混入换行时
 * 会把 `key: value` 截成两行，`parseFrontmatter` 的非贪婪正则在注入的 `---`
 * 处提前闭合，后半段元数据静默降级为正文。校验层会拒绝换行，这里是兜底。
 *
 * 键序固定（ID → 标题 → 领域 → 来源 → 状态 → 来源章节 → 顺序 → 简介），
 * 保证同一篇笔记多次渲染字节一致，git diff 不产生噪声。
 */
export function renderFrontmatter(meta: CardMeta): string {
  const lines = ['---']
  const push = (key: string, value: string | undefined): void => {
    const v = inlineText(value)
    if (v) lines.push(`${key}: ${v}`)
  }
  push('ID', meta.id)
  push('标题', meta.title)
  push('领域', meta.domain)
  push('来源', meta.source)
  push('状态', meta.status)
  push('来源章节', meta.sourceSection)
  if (meta.order !== undefined && Number.isFinite(meta.order)) lines.push(`顺序: ${meta.order}`)
  push('简介', meta.summary)
  lines.push('---', '')
  return lines.join('\n')
}

/**
 * 从正文提取一句话定位，按格式优先级：
 * 1. `> 概念:` 块引用（旧笔记约定）；
 * 2. `### 定义` 小节下的首行引用（旧卡片格式）；
 * 3. 正文首个裸 `> ` 引用块（渲染侧输出：frontmatter 后第一行即该引用块）。
 *
 * 提取不到返回 `null`——**不报错**：简介是可选键，缺失只影响检索命中行的一行
 * 展示，不该阻断写入。
 */
export function extractDefinition(body: string): string | null {
  const concept = /^>\s*概念[:：]\s*(.+)$/m.exec(body)
  if (concept) return concept[1].trim()
  const section = /###\s*定义(?:（[^）]*）)?\s*[\r\n]+>\s*(.+)/.exec(body)
  if (section) return section[1].trim()
  const bare = /^>\s*([^\n]+)/.exec(body.trimStart())
  if (bare) return bare[1].trim()
  return null
}

/** 正文首个一级标题；没有则 null */
export function firstHeading(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body)
  return m ? m[1].trim() : null
}
