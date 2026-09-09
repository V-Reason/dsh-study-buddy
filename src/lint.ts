/**
 * lint 引擎：把一张卡片的多条规则发现汇总成分数与报告。
 *
 * 与 lintrules 的分工：lintrules 是纯判定（命中/未命中），本模块是打分、
 * 排序与渲染。规则权重集中在这里，改口径只改一处；全部为纯函数，
 * 不碰文件系统，可对任意文本直接跑。
 * @module lint
 */

import { bodyLength } from './lintrules.ts'
import { findSection, hasSection, splitSections } from './cardmodel.ts'
import { checkTemplate, templateSpec, type TemplateType } from './template.ts'
import {
  checkCodeFences, checkDomainTags, checkExperiments, checkLayers, checkLinksBlock, checkMainline,
  checkSelfTest, scanResidue, type ResidueHit,
} from './lintrules.ts'

export type Severity = 'error' | 'warn' | 'info'

export interface LintFinding {
  /** 规则 id（稳定，供 --rule 过滤与统计） */
  rule: string
  severity: Severity
  /** 规则中文名（报告标题） */
  title: string
  message: string
  /** 行号（1 基；0 = 不适用） */
  line: number
  /** 命中片段 */
  excerpt?: string
  suggestion?: string
  weight: number
}

export interface LintReport {
  title: string
  template: TemplateType
  score: number
  chars: number
  findings: LintFinding[]
  /** 每条规则是否通过（规则 id → 通过） */
  passed: Record<string, boolean>
}

export interface LintContext {
  /** frontmatter 领域键列表（去 #） */
  tags?: string[]
  /** 已配置的领域键全集（用于根域/子域判定） */
  knownDomains?: string[]
  /** 是否把会话残留记为 error（默认 warn 级扣分，但不封顶分数） */
  residueLevel?: 'off' | 'warn' | 'error'
  /** 关闭的规则 id */
  rulesOff?: string[]
}

/** 定义硬上限（与 card.ts 的 DEFINITION_MAX 同源；此处独立成常量避免循环依赖） */
export const LINT_DEFINITION_MAX = 60

const RULE_TITLES: Record<string, string> = {
  'session-residue': '会话残留',
  'definition-length': '定义长度',
  'template-sections': '模板必填小节',
  'mainline': '主干线唯一',
  'prereq-check': '前置检查',
  'reentry-point': '重入点',
  'verify-experiment': '验证实验',
  'troubleshoot-criteria': '排障判据',
  'code-language': '代码块语言',
  'selftest-answer': '自测题答案',
  'layer-number': '层级序号',
  'links-format': '关联块格式',
  'domain-tag': '领域标签',
  'walkthrough': '实例走查',
}

/** 每条规则的扣分权重（同类多条按"每条/每处"累加，权重见 message 之外的定义） */
const WEIGHTS = {
  'session-residue': 10,
  'definition-length': 8,
  'template-sections': 5,
  'mainline': 5,
  'prereq-check': 3,
  'reentry-point': 3,
  'verify-experiment': 5,
  'troubleshoot-criteria': 5,
  'code-language': 3,
  'selftest-answer': 3,
  'layer-number': 3,
  'links-format': 3,
  'domain-tag': 3,
  'walkthrough': 3,
} as const

export type RuleId = keyof typeof WEIGHTS

/** 规则 id 全集（工具参数与文档共用） */
export function ruleIds(): RuleId[] {
  return Object.keys(WEIGHTS) as RuleId[]
}

/** 规则中文名（报告与文档共用） */
export function ruleTitle(id: string): string {
  return RULE_TITLES[id] ?? id
}

const RESIDUE_LABEL: Record<ResidueHit['rule'], string> = {
  path: '本机路径',
  line: '源码行号',
  person: '第二人称',
  time: '会话时间词',
  phase: '阶段代号',
  session: '会话口吻',
}

function finding(
  rule: RuleId, severity: Severity, message: string,
  extra: Partial<Pick<LintFinding, 'line' | 'excerpt' | 'suggestion'>> = {},
): LintFinding {
  return {
    rule,
    severity,
    title: ruleTitle(rule),
    message,
    line: extra.line ?? 0,
    excerpt: extra.excerpt,
    suggestion: extra.suggestion,
    weight: WEIGHTS[rule],
  }
}

/** 对单张卡片跑全部规则并打分 */
export function lintCard(input: { title?: string; definition?: string; body: string; template?: string; tags?: string[] }, ctx: LintContext = {}): LintReport {
  const body = String(input.body ?? '')
  const definition = String(input.definition ?? '')
  const off = new Set(ctx.rulesOff ?? [])
  const findings: LintFinding[] = []
  const passed: Record<string, boolean> = {}
  const spec = templateSpec(input.template)
  const sections = splitSections(body).sections
  const mark = (rule: string, ok: boolean): void => { passed[rule] = ok }

  // 1. 会话残留（P0）
  const residue = scanResidue(body)
  const residueLevel = ctx.residueLevel ?? 'warn'
  const residueFindings = residueLevel === 'off' || off.has('session-residue')
    ? []
    : residue.map((h) => finding(
      'session-residue',
      residueLevel === 'error' ? 'error' : 'warn',
      `第 ${h.line} 行：${RESIDUE_LABEL[h.rule]}「${h.excerpt}」`,
      { line: h.line, excerpt: h.excerpt, suggestion: h.suggestion },
    ))
  findings.push(...residueFindings)
  mark('session-residue', residueFindings.length === 0)

  // 2. 定义长度（>60 硬上限；card_create 侧同样硬拒）
  if (!off.has('definition-length')) {
    const len = definition.length
    if (len > LINT_DEFINITION_MAX) {
      findings.push(finding('definition-length', 'warn', `定义 ${len} 字，超过 ${LINT_DEFINITION_MAX} 字硬上限（card_create 会直接拒绝）`, { suggestion: '精简到 30 字左右' }))
    }
    mark('definition-length', len <= LINT_DEFINITION_MAX)
  }

  // 3. 模板必填小节（P1）
  if (!off.has('template-sections')) {
    const check = checkTemplate(spec.type, body)
    for (const missing of check.missing) {
      findings.push(finding('template-sections', 'warn', `缺少 "### ${missing.title}" 小节（${spec.type}：${missing.hint}）`, { suggestion: `补写 ${missing.title}` }))
    }
    mark('template-sections', check.missing.length === 0)
  }

  // 4. 主干线唯一（P1）
  if (!off.has('mainline')) {
    const { count } = checkMainline(body)
    if (count === 0) findings.push(finding('mainline', 'warn', '缺少 "### 主干线"（用一句话写"问题 → 约束 → 解法 → 代价 → 验证"）', { suggestion: '补写主干线' }))
    else if (count > 1) findings.push(finding('mainline', 'warn', `出现 ${count} 个 "### 主干线" 小节，主干线必须唯一`, { suggestion: '合并为一条' }))
    mark('mainline', count === 1)
  }

  // 5. 前置检查（有前置卡时必填）
  if (!off.has('prereq-check')) {
    const links = findSection(sections, '关联卡片')
    const hasPrev = links ? /^[ \t]*-[ \t]*前置[：:]/m.test(links.body) : false
    const ok = hasSection(sections, '前置检查') || !hasPrev
    if (!ok) findings.push(finding('prereq-check', 'warn', '卡内有"前置"关联但缺 "### 前置检查"（列出需要知道的概念与卡片 ID）', { suggestion: '补写前置检查' }))
    mark('prereq-check', ok)
  }

  // 6. 重入点（长卡必填）
  if (!off.has('reentry-point')) {
    const chars = bodyLength(body)
    const ok = hasSection(sections, '重入点') || chars <= 3000
    if (!ok) findings.push(finding('reentry-point', 'warn', `正文 ${chars} 字（>3000）但缺 "### 重入点"（30 秒 / 5 分钟 / 30 分钟三种读法）`, { suggestion: '补写重入点' }))
    mark('reentry-point', ok)
  }

  // 7. 验证实验（工程型 ≥3 步）
  if (!off.has('verify-experiment')) {
    const required = spec.required.some((s) => s.title === '验证实验')
    const { present, steps } = checkExperiments(body)
    const ok = !required || (present && steps >= 3)
    if (required && !present) findings.push(finding('verify-experiment', 'warn', '工程型卡片缺 "### 验证实验"（≥3 步，每步一句"看到什么说明什么"）', { suggestion: '补写验证实验' }))
    else if (required && steps < 3) findings.push(finding('verify-experiment', 'warn', `验证实验只有 ${steps} 步（工程型要求 ≥3 步）`, { suggestion: '补足步骤' }))
    mark('verify-experiment', ok)
  }

  // 8. 排障判据（工程型必填）
  if (!off.has('troubleshoot-criteria')) {
    const required = spec.required.some((s) => s.title === '排障判据')
    const ok = !required || hasSection(sections, '排障判据')
    if (!ok) findings.push(finding('troubleshoot-criteria', 'warn', '工程型卡片缺 "### 排障判据"（表格：症状 | 判据 | 修复）', { suggestion: '补写排障判据' }))
    mark('troubleshoot-criteria', ok)
  }

  // 9. 代码块语言（P1）
  if (!off.has('code-language')) {
    const check = checkCodeFences(body)
    if (check.unlabeled > 0) {
      findings.push(finding('code-language', 'warn', `${check.unlabeled}/${check.total} 个代码块未标语言（第 ${check.unlabeledIndexes.join('、')} 块）`, { suggestion: '标注 hlsl/cpp/csharp/python/plaintext 等' }))
    }
    mark('code-language', check.unlabeled === 0)
  }

  // 10. 自测题答案率（P1）
  if (!off.has('selftest-answer')) {
    const check = checkSelfTest(body)
    if (check.missing.length > 0) {
      findings.push(finding('selftest-answer', 'warn', `自测题第 ${check.missing.join('、')} 题没有答案（应为 "Qn：… → 答案要点"）`, { suggestion: '补答案要点，并加"答不出 → 回看 X"' }))
    }
    if (check.usesNumbered) {
      findings.push(finding('selftest-answer', 'warn', '自测题用了 "1./2." 编号写法，规范为 "**Q1**：…"', { suggestion: '改为 Qn 写法' }))
    }
    mark('selftest-answer', check.missing.length === 0 && !check.usesNumbered)
  }

  // 11. 层级序号（P1）
  if (!off.has('layer-number')) {
    const check = checkLayers(body)
    const ok = check.hasNumbers && check.inRange && check.sequential
    if (check.hasNumbers && !check.inRange) {
      findings.push(finding('layer-number', 'warn', `阶梯式解剖为 ${check.layers.length} 层（规范 4~6 层）`, { suggestion: '合并或补充层级' }))
    } else if (check.hasNumbers && !check.sequential) {
      findings.push(finding('layer-number', 'warn', `层级序号不连续：第 ${check.layers.join('、')} 层`, { suggestion: '按 1→N 连续编号' }))
    } else if (!check.hasNumbers && hasSection(sections, '阶梯式解剖')) {
      findings.push(finding('layer-number', 'warn', '阶梯式解剖缺少 "第 N 层" 序号', { suggestion: '补层级序号' }))
    }
    mark('layer-number', ok)
  }

  // 12. 关联块格式（P0-6 归一）
  if (!off.has('links-format')) {
    const check = checkLinksBlock(body)
    if (check.malformed.length > 0) {
      findings.push(finding('links-format', 'warn', `关联块有 ${check.malformed.length} 行不符合 "- 前置/后续/易混淆：\`标题\`（ID）" 格式：${check.malformed.slice(0, 2).join(' / ')}`, { suggestion: '统一为带 ID 的关联行' }))
    }
    mark('links-format', check.malformed.length === 0)
  }

  // 13. 领域标签（P1）
  if (!off.has('domain-tag')) {
    const check = checkDomainTags(input.tags ?? [], ctx.knownDomains ?? [])
    if (check.mixed) {
      findings.push(finding('domain-tag', 'warn', `领域标签同时挂了根域与子域：${check.roots.join('、')} + ${check.children.join('、')}`, { suggestion: '只保留精确的子域键（或只保留根域）' }))
    }
    mark('domain-tag', !check.mixed)
  }

  // 14. 实例走查（数值/代码走查 ≥1）
  if (!off.has('walkthrough')) {
    const ok = hasSection(sections, '实例走查')
    if (!ok) findings.push(finding('walkthrough', 'warn', '缺 "### 实例走查"（至少一种：数值代入 / 代码走查 / 场景走查）', { suggestion: '补实例走查' }))
    mark('walkthrough', ok)
  }

  const deducted = findings.reduce((sum, f) => sum + f.weight, 0)
  let score = Math.max(0, 100 - deducted)
  if (findings.some((f) => f.severity === 'error')) score = Math.min(score, 59)
  const chars = bodyLength(body)
  return {
    title: String(input.title ?? '').trim() || '（无标题）',
    template: spec.type,
    score,
    chars,
    findings,
    passed,
  }
}

const ICON: Record<Severity, string> = { error: '✗', warn: '⚠', info: '·' }

/** 渲染单卡报告（工具返回用） */
export function formatReport(report: LintReport): string {
  const lines: string[] = [`卡片：${report.title}  模板：${report.template}  总分：${report.score}/100（正文 ${report.chars} 字）`]
  const okRules = Object.entries(report.passed).filter(([, ok]) => ok).map(([rule]) => ruleTitle(rule))
  if (okRules.length > 0) lines.push(`  ✓ 通过：${okRules.join('、')}`)
  for (const f of report.findings) {
    lines.push(`  ${ICON[f.severity]} ${f.title}：${f.message}`)
    if (f.suggestion) lines.push(`      建议：${f.suggestion}`)
  }
  if (report.findings.length === 0) lines.push('  ✓ 无问题')
  return lines.join('\n')
}

export interface LintSummaryRow {
  title: string
  template: TemplateType
  score: number
  chars: number
  findingCount: number
  topRules: string[]
}

export interface LintBatch {
  total: number
  averageScore: number
  /** 分数分布（按 10 分一档） */
  distribution: Array<{ range: string; count: number }>
  /** 每条规则的命中卡片数与命中次数 */
  rules: Array<{ rule: string; title: string; cards: number; hits: number }>
  rows: LintSummaryRow[]
}

/** 汇总多张卡片的 lint 结果（批量模式） */
export function summarizeLint(reports: LintReport[], titles: string[]): LintBatch {
  const ruleMap = new Map<string, { cards: number; hits: number }>()
  const buckets = new Map<number, number>()
  for (const report of reports) {
    const seen = new Set<string>()
    for (const f of report.findings) {
      const entry = ruleMap.get(f.rule) ?? { cards: 0, hits: 0 }
      entry.hits += 1
      if (!seen.has(f.rule)) {
        entry.cards += 1
        seen.add(f.rule)
      }
      ruleMap.set(f.rule, entry)
    }
    buckets.set(Math.floor(report.score / 10) * 10, (buckets.get(Math.floor(report.score / 10) * 10) ?? 0) + 1)
  }
  const total = reports.length
  const averageScore = total === 0 ? 0 : Math.round(reports.reduce((s, r) => s + r.score, 0) / total)
  return {
    total,
    averageScore,
    distribution: [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([lo, count]) => ({ range: `${lo}~${lo + 9}`, count })),
    rules: [...ruleMap.entries()]
      .map(([rule, v]) => ({ rule, title: ruleTitle(rule), cards: v.cards, hits: v.hits }))
      .sort((a, b) => b.cards - a.cards || a.rule.localeCompare(b.rule)),
    rows: reports.map((r, i) => ({
      title: titles[i] ?? r.title,
      template: r.template,
      score: r.score,
      chars: r.chars,
      findingCount: r.findings.length,
      topRules: [...new Set(r.findings.map((f) => f.title))].slice(0, 3),
    })),
  }
}

/** 渲染批量汇总（工具返回用） */
export function formatBatch(batch: LintBatch, limit = 20): string {
  const lines: string[] = [
    `批量 lint：${batch.total} 张卡，平均 ${batch.averageScore}/100`,
    `分数分布：${batch.distribution.map((d) => `${d.range} 分 ${d.count} 张`).join('，') || '—'}`,
  ]
  if (batch.rules.length > 0) {
    lines.push('规则命中（按命中卡片数排序）：')
    for (const r of batch.rules) lines.push(`  - ${r.title}：${r.cards} 张 / ${r.hits} 处`)
  } else {
    lines.push('规则命中：无')
  }
  const worst = [...batch.rows].sort((a, b) => a.score - b.score).slice(0, limit)
  if (worst.length > 0) {
    lines.push(`最低分 ${worst.length} 张：`)
    for (const row of worst) {
      lines.push(`  - ${row.score}/100 ${row.title}（${row.template}，${row.chars} 字）${row.topRules.length ? `：${row.topRules.join('、')}` : ''}`)
    }
  }
  return lines.join('\n')
}
