/**
 * 极简 YAML frontmatter 解析/生成：只支持标量 `key: value` 行，
 * 覆盖原子卡片的 ID/标题/领域/来源/状态 五字段。解析失败不吞——
 * 调用方按"无 frontmatter"降级索引并标记。
 * @module frontmatter
 */

export interface CardMeta {
  id?: string
  title?: string
  domain?: string
  source?: string
  status?: string
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
  }
  return { meta, body: raw.slice(m[0].length), raw }
}

export function renderFrontmatter(meta: CardMeta): string {
  const lines = ['---']
  if (meta.id) lines.push(`ID: ${meta.id}`)
  if (meta.title) lines.push(`标题: ${meta.title}`)
  if (meta.domain) lines.push(`领域: ${meta.domain}`)
  if (meta.source) lines.push(`来源: ${meta.source}`)
  if (meta.status) lines.push(`状态: ${meta.status}`)
  lines.push('---', '')
  return lines.join('\n')
}

/** 从正文提取一句话概念：优先 `> 概念:` 块引用，其次 `### 定义` 下的首行引用 */
export function extractDefinition(body: string): string | null {
  const concept = /^>\s*概念[:：]\s*(.+)$/m.exec(body)
  if (concept) return concept[1].trim()
  const section = /###\s*定义(?:（[^）]*）)?\s*[\r\n]+>\s*(.+)/.exec(body)
  if (section) return section[1].trim()
  return null
}

/** 正文首个一级标题；没有则 null */
export function firstHeading(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body)
  return m ? m[1].trim() : null
}
