/**
 * 跨卡洞察（P2）：跨卡一致性检查、质量趋势统计、可执行性评级。
 *
 * 全部建立在 lint 结果与卡片模型之上，不重新扫盘：lint 负责单卡判定，
 * 本模块负责"卡片之间"和"时间维度"的分析。
 * @module insight
 */

import { codeFenceLanguages, findSection, makeLineOf, splitSections } from './cardmodel.ts'
import type { LintReport } from './lint.ts'

export interface CardFact {
  /** 事实键（表头列名 / 公式左侧） */
  key: string
  /** 事实值 */
  value: string
  /** 来源卡片（展示路径或标题） */
  card: string
  /** 来源小节 */
  section: string
  line: number
}

const SKIP_TABLE_COLUMNS = new Set(['症状', '判据', '修复', '现象', '原因', '处理', '层', '层级', '序号'])

/** 值归一：去反引号/空白、去掉尾部句号，便于"3.14" 与 "3.14。" 视为同值 */
function normalizeValue(value: string): string {
  return String(value ?? '')
    .replace(/[`*]/g, '')
    .replace(/[。；;,，\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeKey(key: string): string {
  return String(key ?? '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * 抽取"可比较事实"：
 * 1. 正文表格行 `| 键 | 值 |`（取前两列；表头/分隔行/白名单列跳过）；
 * 2. 行内公式赋值 `$符号 = 数值$` 或 `符号 = 数值`（键取左侧符号）。
 */
export function extractFacts(cardLabel: string, body: string): CardFact[] {
  const facts: CardFact[] = []
  const text = String(body ?? '')
  const { sections } = splitSections(text)
  const lineOf = makeLineOf(text)
  for (const section of sections) {
    const startLine = lineOf(section.start)
    const lines = section.body.split(/\r?\n/)
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      const tableMatch = /^\|(.+)\|\s*$/.exec(trimmed)
      if (tableMatch) {
        const cells = tableMatch[1].split('|').map((c) => c.trim())
        if (cells.length >= 2 && !/^:?-{2,}:?$/.test(cells[0]) && cells[0] !== '') {
          const key = normalizeKey(cells[0])
          const value = normalizeValue(cells[1])
          if (key && value && !SKIP_TABLE_COLUMNS.has(key) && !/^:?-{2,}:?$/.test(value)) {
            facts.push({ key, value, card: cardLabel, section: section.title, line: startLine + i + 1 })
          }
        }
        return
      }
      const formula = /\$\s*([A-Za-z\\][^$=]{0,24})\s*=\s*([^$]{1,32})\$/.exec(trimmed)
        ?? /^([A-Za-z\u0370-\u03ff][\w\s]{0,16})\s*=\s*([^=]{1,32})$/.exec(trimmed)
      if (formula) {
        const key = normalizeKey(formula[1])
        const value = normalizeValue(formula[2])
        if (key && value) facts.push({ key, value, card: cardLabel, section: section.title, line: startLine + i + 1 })
      }
    })
  }
  return facts
}

export interface ConflictGroup {
  key: string
  variants: Array<{ value: string; cards: string[] }>
  /** 命中的卡数 */
  cards: number
}

/**
 * 跨卡一致性检查（P2-1）：同一事实键在多张卡上取值不一致 → 列出冲突组。
 * 只报"同键 ≥2 种值"，不做语义判断（取值是否正确由人判断）。
 */
export function crossCardConflicts(cards: Array<{ label: string; body: string }>): ConflictGroup[] {
  const byKey = new Map<string, Map<string, Set<string>>>()
  for (const card of cards) {
    for (const fact of extractFacts(card.label, card.body)) {
      const values = byKey.get(fact.key) ?? new Map<string, Set<string>>()
      const cards4Value = values.get(fact.value) ?? new Set<string>()
      cards4Value.add(fact.card)
      values.set(fact.value, cards4Value)
      byKey.set(fact.key, values)
    }
  }
  const groups: ConflictGroup[] = []
  for (const [key, values] of byKey) {
    if (values.size < 2) continue
    const variants = [...values.entries()].map(([value, cards4Value]) => ({ value, cards: [...cards4Value] }))
    const cards = new Set(variants.flatMap((v) => v.cards)).size
    groups.push({ key, variants, cards })
  }
  return groups.sort((a, b) => b.cards - a.cards || a.key.localeCompare(b.key))
}

/** 渲染跨卡一致性报告 */
export function formatConflicts(groups: ConflictGroup[], limit = 20): string {
  if (groups.length === 0) return '跨卡一致性：未发现同键取值冲突。'
  const lines = [`跨卡一致性：${groups.length} 组同键取值冲突（同键 ≥2 种值）`]
  for (const group of groups.slice(0, limit)) {
    lines.push(`- ${group.key}（${group.cards} 张卡）`)
    for (const v of group.variants) {
      lines.push(`    = ${v.value}  ← ${v.cards.slice(0, 3).join('、')}${v.cards.length > 3 ? ' 等' : ''}`)
    }
  }
  return lines.join('\n')
}

export interface TrendBucket {
  /** 周标签（`YYYY-Www`，按卡片 ID 日期归周） */
  week: string
  cards: number
  averageScore: number
  /** 该周命中最多的规则（前 3） */
  topRules: Array<{ rule: string; cards: number }>
}

/** 从卡片 ID（`YYYYMMDDHHmm_xxxx`）解析日期；解析失败返回 null */
export function dateOfCardId(id: string | null): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(id ?? ''))
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** ISO 周标签（`YYYY-Www`）；跨年按 ISO 规则归属 */
export function isoWeek(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''))
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (Number.isNaN(d.getTime())) return null
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** 质量趋势统计（P2-2）：按卡片 ID 日期分周，输出均分与短板分布 */
export function qualityTrend(entries: Array<{ id: string | null; report: LintReport }>): TrendBucket[] {
  const buckets = new Map<string, { scores: number[]; rules: Map<string, number> }>()
  for (const entry of entries) {
    const date = dateOfCardId(entry.id)
    const week = date ? isoWeek(date) : null
    if (!week) continue
    const bucket = buckets.get(week) ?? { scores: [], rules: new Map<string, number>() }
    bucket.scores.push(entry.report.score)
    for (const rule of new Set(entry.report.findings.map((f) => f.rule))) {
      bucket.rules.set(rule, (bucket.rules.get(rule) ?? 0) + 1)
    }
    buckets.set(week, bucket)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, bucket]) => ({
      week,
      cards: bucket.scores.length,
      averageScore: Math.round(bucket.scores.reduce((s, v) => s + v, 0) / bucket.scores.length),
      topRules: [...bucket.rules.entries()]
        .map(([rule, cards]) => ({ rule, cards }))
        .sort((a, b) => b.cards - a.cards)
        .slice(0, 3),
    }))
}

/** 渲染质量趋势报告 */
export function formatTrend(buckets: TrendBucket[]): string {
  if (buckets.length === 0) return '质量趋势：卡片 ID 无法解析日期（或没有卡片）。'
  const lines = [`质量趋势（${buckets.length} 周，按卡片 ID 日期归周）：`]
  for (const bucket of buckets) {
    const rules = bucket.topRules.map((r) => `${r.rule}×${r.cards}`).join('、')
    lines.push(`- ${bucket.week}：${bucket.cards} 张，均分 ${bucket.averageScore}${rules ? `，短板：${rules}` : ''}`)
  }
  const first = buckets[0]
  const last = buckets[buckets.length - 1]
  if (buckets.length > 1) {
    const delta = last.averageScore - first.averageScore
    lines.push(`趋势：${first.week} ${first.averageScore} → ${last.week} ${last.averageScore}（${delta >= 0 ? '+' : ''}${delta}）`)
  }
  return lines.join('\n')
}

export type Executability = '能跑' | '能查' | '只能读'

/**
 * 可执行性评级（P2-3）：
 * - 能跑：有代码块 + 验证实验；
 * - 能查：有排障判据或对比表（可跳读定位）；
 * - 只能读：其余。
 */
export function executabilityOf(body: string): Executability {
  const sections = splitSections(body).sections
  const hasCode = codeFenceLanguages(body).length > 0
  const hasExperiment = findSection(sections, '验证实验') !== undefined
  if (hasCode && hasExperiment) return '能跑'
  const hasQuery = findSection(sections, '排障判据') !== undefined || findSection(sections, '对比表') !== undefined
  return hasQuery ? '能查' : '只能读'
}

/** 可执行性分布（配合批量 lint 输出） */
export function executabilitySummary(entries: Array<{ body: string }>): Array<{ rating: Executability; count: number }> {
  const counts = new Map<Executability, number>()
  for (const entry of entries) {
    const rating = executabilityOf(entry.body)
    counts.set(rating, (counts.get(rating) ?? 0) + 1)
  }
  return (['能跑', '能查', '只能读'] as Executability[])
    .map((rating) => ({ rating, count: counts.get(rating) ?? 0 }))
    .filter((row) => row.count > 0)
}
