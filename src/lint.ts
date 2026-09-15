/**
 * lint 引擎（2026-10 瘦身版）：规则注册表 + 报告渲染。
 *
 * 相对 2026-09 版本，本轮删掉了**全部模板类规则**（必填小节 / 主干线 / 重入点 /
 * 验证实验 / 排障判据 / 层级序号 / 自测题答案 / 关联块格式 / 领域标签 / 定义长度），
 * 并**废弃 100 分制**（架构选型 A9）：
 * 分值那套记分法建立在"模板缺节扣 5 分"之上，模板退场后分值不再可比，留着只会误导。
 * 现在报告的是**问题清单 + 严重级**，用户看得到"有什么问题"而不是"得了多少分"。
 *
 * 保留的三条通用规则与内容自由度无关，属数据卫生（架构选型 §6.4）：
 * - `session-residue`：会话残留（本机路径 / 源码行号 / 第二人称 / 会话口吻）
 * - `code-language`：未标语言的代码块
 * - `external-resource`：正文引用外部资源（Obsidian 打开会主动外联）
 *
 * 外加一条**由期望文件驱动**的 `expect-rule`：用户在《笔记期望.md》里写
 * `- [检查] 禁止 <内容>` 才启用。这样"检查什么"也是热配置，而不是写死在代码里。
 * @module lint
 */

import { blankOutBlocks, makeLineOf, type DocSection } from './notemodel.ts'
import { compareText } from './order.ts'
import {
  bodyLength, checkCodeFences, checkExternalResources, scanResidue, type ResidueHit,
} from './lintrules.ts'

export type Severity = 'error' | 'warn' | 'info'

export interface LintFinding {
  /** 规则 id（稳定，供 rule 过滤与统计） */
  rule: string
  severity: Severity
  /** 规则中文名 */
  title: string
  message: string
  /** 行号（1 基；0 = 不适用） */
  line: number
  /** 命中片段 */
  excerpt?: string
  suggestion?: string
}

export interface LintReport {
  title: string
  /** `block` = 有 ID 且有来源章节；`legacy` = 有 ID；`note` = 旧笔记（无 ID） */
  kind: 'block' | 'legacy' | 'note'
  /** 正文实际字数（不含代码块与折叠块） */
  chars: number
  findings: LintFinding[]
  /** 每条**已执行**规则是否通过（规则 id → 通过）；被禁用/未执行时不含该键 */
  passed: Record<string, boolean>
  /** 本次**未执行**的规则中文名（报告不得把它当成"通过"，N7） */
  notRun: string[]
}

/** 用户写在《笔记期望.md》里的检查项 */
export interface ExpectRule {
  /** 禁止 / 必须 出现的字面内容 */
  pattern: string
  mode: 'forbid' | 'require'
  severity: Severity
  reason?: string
}

export interface LintContext {
  /** 会话残留级别：off 不执行 / warn 警告 / error 错误（默认 warn） */
  residueLevel?: 'off' | 'warn' | 'error'
  /** 关闭的规则 id 列表 */
  rulesOff?: string[]
  kind?: 'block' | 'legacy' | 'note'
  /** 由《笔记期望.md》解析出的检查项（`- [检查] 禁止 xx` / `- [检查] 必须 xx`） */
  expectRules?: ExpectRule[]
}

export interface RuleCtx {
  title: string
  summary: string
  body: string
  sections: DocSection[]
  /** `blankOutBlocks(body)`：只扫正文（代码块与折叠块之外） */
  residueText: string
  bodyChars: number
  residueLevel: 'off' | 'warn' | 'error'
  kind: 'block' | 'legacy' | 'note'
  expectRules: ExpectRule[]
}

export interface Rule {
  id: string
  title: string
  severity: Severity
  /** 判定函数；返回空数组 = 通过 */
  run(ctx: RuleCtx): LintFinding[]
}

const RESIDUE_LABEL: Record<ResidueHit['rule'], string> = {
  path: '本机路径',
  line: '源码行号',
  person: '第二人称',
  time: '会话时间词',
  phase: '阶段代号',
  session: '会话口吻',
}

/** 字符下标 → 行号（1 基） */
function lineOfIndex(body: string, index: number): number {
  return makeLineOf(body)(index)
}

/** 规则注册表：加一条规则 = 加一个数组元素（工具描述与 ruleIds 自动跟随） */
export const RULES: Rule[] = [
  {
    id: 'session-residue',
    title: '会话残留',
    severity: 'warn',
    run(ctx) {
      if (ctx.residueLevel === 'off') return []
      // scanResidue 返回的就是行号（1 基），不需要再做下标换算
      return scanResidue(ctx.residueText).map((hit) => ({
        rule: 'session-residue',
        severity: ctx.residueLevel === 'error' ? 'error' : 'warn',
        title: '会话残留',
        message: `会话残留（${RESIDUE_LABEL[hit.rule]}）：${hit.excerpt}`,
        line: hit.line,
        excerpt: hit.excerpt,
        suggestion: '笔记是长期资产，把"本机路径 / 行号 / 你 / 上次"改成与场景无关的表述',
      }))
    },
  },
  {
    id: 'code-language',
    title: '代码块语言',
    severity: 'warn',
    run(ctx) {
      const check = checkCodeFences(ctx.body)
      if (check.unlabeled === 0) return []
      // unlabeledIndexes 是"第几个代码块"（1 基），不是行号——报告里按块序号说明
      return [{
        rule: 'code-language',
        severity: 'warn' as const,
        title: '代码块语言',
        message: `代码块未标语言（第 ${check.unlabeledIndexes.join('、')} 块，共 ${check.total} 块）`,
        line: 0,
        suggestion: '给围栏加语言标注（如 ```csharp、```hlsl、```python）；纯文本用 ```text',
      }]
    },
  },
  {
    id: 'external-resource',
    title: '外部资源',
    severity: 'info',
    run(ctx) {
      return checkExternalResources(ctx.body).map((hit) => ({
        rule: 'external-resource',
        severity: 'info' as const,
        title: '外部资源',
        message: '正文引用了外部资源（Obsidian 打开时会主动外联）',
        line: hit.line,
        excerpt: hit.excerpt,
        suggestion: '如需离线，改为本地附件或纯文字描述',
      }))
    },
  },
  {
    id: 'expect-rule',
    title: '期望检查项',
    severity: 'info',
    run(ctx) {
      if (ctx.expectRules.length === 0) return []
      const outgoing: LintFinding[] = []
      for (const item of ctx.expectRules) {
        const at = ctx.body.indexOf(item.pattern)
        if (item.mode === 'forbid' && at >= 0) {
          outgoing.push({
            rule: 'expect-rule',
            severity: item.severity,
            title: '期望检查项',
            message: `命中《笔记期望.md》的禁止项：${item.pattern}${item.reason ? `（${item.reason}）` : ''}`,
            line: lineOfIndex(ctx.body, at),
            excerpt: item.pattern,
          })
        } else if (item.mode === 'require' && at < 0) {
          outgoing.push({
            rule: 'expect-rule',
            severity: item.severity,
            title: '期望检查项',
            message: `缺少《笔记期望.md》的必须项：${item.pattern}${item.reason ? `（${item.reason}）` : ''}`,
            line: 0,
            excerpt: item.pattern,
          })
        }
      }
      return outgoing
    },
  },
]

export function ruleIds(): string[] {
  return RULES.map((r) => r.id)
}

export function ruleTitle(id: string): string {
  return RULES.find((r) => r.id === id)?.title ?? id
}

export function ruleCatalog(): Array<{ id: string; title: string; severity: Severity }> {
  return RULES.map((r) => ({ id: r.id, title: r.title, severity: r.severity }))
}

/** 规则清单渲染（工具描述由它派生，避免与注册表漂移） */
export function ruleTable(): string[] {
  return RULES.map((r) => `${r.id}（${r.title}）`)
}

/**
 * 解析《笔记期望.md》里的检查项：
 *
 * ```
 * - [检查] 禁止 本机绝对路径 理由：笔记要能换机器读
 * - [检查] 禁止 🚀 严重：error
 * - [检查] 必须 ## 目录
 * ```
 *
 * 只认这一种明确写法——自由 Markdown 的其它内容不会被误当规则
 * （"能被解析的就不靠自觉"，但也不能靠猜）。
 */
export function parseExpectRules(text: string): ExpectRule[] {
  const out: ExpectRule[] = []
  const lineRe = /^[ \t]*-[ \t]*\[检查\][ \t]*(禁止|必须)[ \t]*(\S.*)$/gm
  for (const m of String(text ?? '').matchAll(lineRe)) {
    const mode = m[1] === '禁止' ? 'forbid' : 'require'
    let rest = m[2].trim()
    let severity: Severity = 'info'
    const severityMatch = /(?:严重|级别|severity)[:：][ \t]*(error|warn|info|错误|警告|提示)/i.exec(rest)
    if (severityMatch) {
      const raw = severityMatch[1].toLowerCase()
      severity = raw === 'error' || raw === '错误' ? 'error' : raw === 'warn' || raw === '警告' ? 'warn' : 'info'
      rest = rest.replace(severityMatch[0], '').trim()
    }
    let reason: string | undefined
    const reasonMatch = /(?:理由|原因)[:：][ \t]*(.+)$/.exec(rest)
    if (reasonMatch) {
      reason = reasonMatch[1].trim()
      rest = rest.replace(reasonMatch[0], '').trim()
    }
    const pattern = rest.trim()
    if (pattern) out.push({ pattern, mode, severity, ...(reason ? { reason } : {}) })
  }
  return out
}

export function lintNote(
  input: { title?: string; summary?: string; body: string; kind?: LintReport['kind'] },
  ctx: LintContext = {},
): LintReport {
  const body = String(input.body ?? '')
  const kind = ctx.kind ?? 'block'
  const rulesOff = new Set(ctx.rulesOff ?? [])
  const residueLevel = ctx.residueLevel ?? 'warn'
  const residueText = blankOutBlocks(body)
  const ruleCtx: RuleCtx = {
    title: String(input.title ?? ''),
    summary: String(input.summary ?? ''),
    body,
    sections: [],
    residueText,
    bodyChars: bodyLength(body, residueText),
    residueLevel,
    kind,
    expectRules: ctx.expectRules ?? [],
  }
  const findings: LintFinding[] = []
  const passed: Record<string, boolean> = {}
  const notRun: string[] = []
  for (const rule of RULES) {
    if (rulesOff.has(rule.id)) {
      notRun.push(rule.title)
      continue
    }
    if (rule.id === 'session-residue' && residueLevel === 'off') {
      notRun.push(rule.title)
      continue
    }
    if (rule.id === 'expect-rule' && ruleCtx.expectRules.length === 0) {
      notRun.push(rule.title)
      continue
    }
    const hits = rule.run(ruleCtx)
    if (hits.length === 0) passed[rule.id] = true
    else findings.push(...hits)
  }
  findings.sort((a, b) => (a.line || Number.MAX_SAFE_INTEGER) - (b.line || Number.MAX_SAFE_INTEGER))
  return { title: ruleCtx.title, kind, chars: ruleCtx.bodyChars, findings, passed, notRun }
}

const SEVERITY_LABEL: Record<Severity, string> = { error: '✗', warn: '⚠', info: 'ℹ' }

export function formatReport(report: LintReport): string {
  const head = `## ${report.title || '(未命名)'}（${report.kind === 'note' ? '旧笔记' : report.kind === 'legacy' ? '存量卡' : '块'}，正文 ${report.chars} 字）`
  const lines = [head, '']
  if (report.findings.length === 0) {
    lines.push('未发现问题。')
  } else {
    lines.push('| 级别 | 规则 | 行 | 说明 |', '| :-- | :-- | --: | :-- |')
    for (const f of report.findings) {
      lines.push(`| ${SEVERITY_LABEL[f.severity]} | ${f.title} | ${f.line || '—'} | ${f.message} |`)
    }
    const suggestions = report.findings.map((f) => f.suggestion).filter((s): s is string => Boolean(s))
    if (suggestions.length > 0) {
      lines.push('', '建议：')
      for (const s of [...new Set(suggestions)]) lines.push(`- ${s}`)
    }
  }
  if (report.notRun.length > 0) lines.push('', `⊘ 未执行（不计入通过）：${report.notRun.join('、')}`)
  return lines.join('\n')
}

export interface LintBatch {
  total: number
  noteCount: number
  legacyCount: number
  /** 有问题（至少一条 finding）的文档数 */
  problemCount: number
  /** 平均问题数（保留 1 位） */
  average: number
  /** 按"问题数"的分布桶标签（如 `1~2 条`）与计数 */
  distribution: Array<{ label: string; count: number }>
  /** 规则命中统计（规则 id → 命中文档数） */
  rules: Array<{ id: string; title: string; count: number }>
  /** 问题最多的文档（降序） */
  worst: Array<{ title: string; count: number }>
}

/** 分布桶宽（按问题条数） */
export const PROBLEM_BUCKET = 2

export function summarizeLint(reports: LintReport[]): LintBatch {
  const total = reports.length
  const counts = reports.map((r) => r.findings.length)
  const buckets = new Map<string, number>()
  for (const n of counts) {
    const lower = n === 0 ? 0 : Math.floor((n - 1) / PROBLEM_BUCKET) * PROBLEM_BUCKET + 1
    const label = n === 0 ? '0 条' : `${lower}~${lower + PROBLEM_BUCKET - 1} 条`
    buckets.set(label, (buckets.get(label) ?? 0) + 1)
  }
  const ruleHits = new Map<string, number>()
  for (const r of reports) {
    for (const id of new Set(r.findings.map((f) => f.rule))) ruleHits.set(id, (ruleHits.get(id) ?? 0) + 1)
  }
  const sum = counts.reduce((a, b) => a + b, 0)
  return {
    total,
    noteCount: reports.filter((r) => r.kind === 'note').length,
    legacyCount: reports.filter((r) => r.kind === 'legacy').length,
    problemCount: counts.filter((n) => n > 0).length,
    average: total === 0 ? 0 : Math.round((sum / total) * 10) / 10,
    distribution: [...buckets.entries()]
      .sort((a, b) => Number(a[0].split(' ')[0]) - Number(b[0].split(' ')[0]))
      .map(([label, count]) => ({ label, count })),
    rules: [...ruleHits.entries()]
      .map(([id, count]) => ({ id, title: ruleTitle(id), count }))
      .sort((a, b) => b.count - a.count || compareText(a.id, b.id)),
    worst: reports
      .map((r) => ({ title: r.title, count: r.findings.length }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count || compareText(a.title, b.title)),
  }
}

export function formatBatch(batch: LintBatch, limit = 10): string {
  const lines: string[] = []
  lines.push(`## 批量体检（共 ${batch.total} 篇）`)
  lines.push('')
  if (batch.noteCount > 0 || batch.legacyCount > 0) {
    lines.push(`- 其中旧笔记 ${batch.noteCount} 篇、存量卡 ${batch.legacyCount} 篇（不参与"块"的规则口径）`)
  }
  lines.push(`- 有问题的文档：${batch.problemCount} 篇；平均问题数：${batch.average} 条`)
  if (batch.distribution.length > 0) {
    lines.push(`- 问题数分布：${batch.distribution.map((d) => `${d.label} ${d.count} 篇`).join('，')}`)
  }
  if (batch.rules.length > 0) {
    lines.push('', '规则命中：')
    for (const r of batch.rules) lines.push(`- ${r.title}（${r.id}）：${r.count} 篇`)
  }
  if (batch.worst.length > 0) {
    lines.push('', `问题最多的文档（前 ${Math.min(limit, batch.worst.length)}）：`)
    for (const w of batch.worst.slice(0, limit)) lines.push(`- ${w.title}：${w.count} 条`)
  }
  if (batch.rules.length === 0) lines.push('', '全部通过。')
  return lines.join('\n')
}
