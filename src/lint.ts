/**
 * lint 引擎：把一张卡片的多条规则发现汇总成分数与报告。
 *
 * 与 lintrules 的分工：lintrules 是纯判定（命中/未命中），本模块是**规则注册表**
 * + 打分 + 排序 + 渲染。2026-09 审查后（EXT-1/CPLX-3）规则收敛为一张 `RULES`
 * 表：加一条规则 = 加一个数组元素，工具描述与 `ruleIds()` 自动跟随；
 * 规则所需的小节切分 / 空白化正文在 `RuleCtx` 里**只算一次**（PERF-3）。
 * @module lint
 */

import { blankOutBlocks, findSection, hasSection, splitSections, type CardSection } from './notemodel.ts'
import { DEFINITION_MAX } from './card.ts'
import {
  ENGINEERING_SECTIONS, PREREQ_SECTION, REENTRY_SECTION, templateSpec,
  type TemplateSpec, type TemplateType,
} from './template.ts'
import {
  bodyLength, checkCodeFences, checkDomainTags, checkExperiments, checkExternalResources, checkLayers,
  checkLinksBlock, checkSelfTest, countSection, scanResidue, type ResidueHit,
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
  /** 文档类型（note = 旧笔记，只跑通用规则） */
  kind: 'card' | 'note'
  score: number
  chars: number
  findings: LintFinding[]
  /** 每条**已执行**规则是否通过（规则 id → 通过）；被禁用/不适用时不含该键 */
  passed: Record<string, boolean>
  /** 本次**未执行**的规则中文名（`residueLevel: 'off'` 等；报告不得把它当成"通过"，N7） */
  notRun: string[]
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
  /** 文档类型：note 时跳过结构类规则（BIZ-4） */
  kind?: 'card' | 'note'
}

/** 长卡判定阈值：正文超过该字数必须写「重入点」 */
export const REENTRY_CHARS = 3000
/** 出现 error 级发现时的封顶分 */
export const ERROR_SCORE_CAP = 59
/** 批量报告的分数分布桶宽 */
export const SCORE_BUCKET = 10
/** 软性残留（第二人称/会话口吻）的扣分权重：误报代价高，低于硬信号 */
const SOFT_RESIDUE_WEIGHT = 3
const SOFT_RESIDUE_RULES = new Set<ResidueHit['rule']>(['person', 'session'])

const RESIDUE_LABEL: Record<ResidueHit['rule'], string> = {
  path: '本机路径',
  line: '源码行号',
  person: '第二人称',
  time: '会话时间词',
  phase: '阶段代号',
  session: '会话口吻',
}

/** 规则执行上下文：所有可复用的中间产物在此预计算一次 */
export interface RuleCtx {
  title: string
  definition: string
  body: string
  /** `splitSections(body).sections`（只算一次） */
  sections: CardSection[]
  /** `blankOutBlocks(body)`（会话残留与字数统计共用） */
  residueText: string
  /** 正文实际字数（不含代码块与折叠块） */
  bodyChars: number
  spec: TemplateSpec
  tags: string[]
  knownDomains: string[]
  residueLevel: 'off' | 'warn' | 'error'
  kind: 'card' | 'note'
}

export interface Rule {
  id: string
  title: string
  /** 单条发现的扣分权重 */
  weight: number
  severity: Severity
  /** `card` = 仅卡片文档（旧笔记跳过结构类规则） */
  scope?: 'card'
  /** 返回 `null` 表示**本次未执行**（如 `residueLevel: 'off'`），报告不得计为"通过"（N7） */
  run: (ctx: RuleCtx) => LintFinding[] | null
}

/** 构造一条发现（权重默认取规则权重，可逐条覆盖） */
function finding(
  rule: Rule, severity: Severity, message: string,
  extra: Partial<Pick<LintFinding, 'line' | 'excerpt' | 'suggestion' | 'weight'>> = {},
): LintFinding {
  return {
    rule: rule.id,
    severity,
    title: rule.title,
    message,
    line: extra.line ?? 0,
    excerpt: extra.excerpt,
    suggestion: extra.suggestion,
    weight: extra.weight ?? rule.weight,
  }
}

/** 定义一条规则（`run` 能拿到自身元数据用于构造发现） */
function defineRule(def: Omit<Rule, 'run'> & { run: (ctx: RuleCtx, rule: Rule) => LintFinding[] | null }): Rule {
  const rule: Rule = {
    id: def.id,
    title: def.title,
    weight: def.weight,
    severity: def.severity,
    scope: def.scope,
    run: (ctx) => def.run(ctx, rule),
  }
  return rule
}

const VERIFY_TITLE = ENGINEERING_SECTIONS[0].title
const TROUBLESHOOT_TITLE = ENGINEERING_SECTIONS[1].title

/**
 * 规则注册表：**唯一权威**（id / 中文名 / 权重 / 严重度 / 适用范围 / 判定）。
 * 新增规则只改这里；`ruleIds()`、`ruleTitle()`、`card_lint` 的工具描述都由它派生。
 */
export const RULES: Rule[] = [
  defineRule({
    id: 'session-residue',
    title: '会话残留',
    weight: 10,
    severity: 'warn',
    run: (c, self) => {
      // 关闭时返回 null = 未执行：旧实现返回 []，报告把它当成"✓ 通过"（N7）
      if (c.residueLevel === 'off') return null
      const severity: Severity = c.residueLevel === 'error' ? 'error' : 'warn'
      return scanResidue(c.body, { blanked: c.residueText }).map((h) => finding(
        self,
        severity,
        `第 ${h.line} 行：${RESIDUE_LABEL[h.rule]}「${h.excerpt}」`,
        {
          line: h.line,
          excerpt: h.excerpt,
          suggestion: h.suggestion,
          weight: SOFT_RESIDUE_RULES.has(h.rule) ? SOFT_RESIDUE_WEIGHT : undefined,
        },
      ))
    },
  }),
  defineRule({
    id: 'definition-length',
    title: '定义长度',
    weight: 8,
    severity: 'warn',
    run: (c, self) => {
      const len = c.definition.length
      if (len <= DEFINITION_MAX) return []
      return [finding(self, 'warn', `定义 ${len} 字，超过 ${DEFINITION_MAX} 字硬上限（card_create 会直接拒绝）`, { suggestion: '精简到 30 字左右' })]
    },
  }),
  defineRule({
    id: 'template-sections',
    title: '模板必填小节',
    weight: 5,
    severity: 'warn',
    scope: 'card',
    run: (c, self) => c.spec.required
      .filter((s) => !hasSection(c.sections, s.title))
      .map((s) => finding(self, 'warn', `缺少 "### ${s.title}" 小节（${c.spec.type}：${s.hint}）`, { suggestion: `补写 ${s.title}` })),
  }),
  defineRule({
    id: 'mainline',
    title: '主干线唯一',
    weight: 5,
    severity: 'warn',
    scope: 'card',
    // 由 spec.mainline 驱动：缺小节由 template-sections 负责，这里只管"重复"
    run: (c, self) => c.spec.required
      .filter((s) => s.mainline)
      .map((s) => ({ title: s.title, count: countSection(c.sections, s.title) }))
      .filter(({ count }) => count > 1)
      .map(({ title, count }) => finding(self, 'warn', `出现 ${count} 个「${title}」小节，主线小节必须唯一`, { suggestion: '合并为一条' })),
  }),
  defineRule({
    id: 'prereq-check',
    title: '前置检查',
    weight: 3,
    severity: 'warn',
    scope: 'card',
    run: (c, self) => {
      const links = findSection(c.sections, '关联卡片')
      const hasPrev = links ? /^[ \t]*-[ \t]*前置[：:]/m.test(links.body) : false
      if (!hasPrev || hasSection(c.sections, PREREQ_SECTION.title)) return []
      return [finding(self, 'warn', `卡内有"前置"关联但缺 "### ${PREREQ_SECTION.title}"（列出需要知道的概念与卡片 ID）`, { suggestion: `补写${PREREQ_SECTION.title}` })]
    },
  }),
  defineRule({
    id: 'reentry-point',
    title: '重入点',
    weight: 3,
    severity: 'warn',
    scope: 'card',
    run: (c, self) => {
      if (hasSection(c.sections, REENTRY_SECTION.title) || c.bodyChars <= REENTRY_CHARS) return []
      return [finding(self, 'warn', `正文 ${c.bodyChars} 字（>${REENTRY_CHARS}）但缺 "### ${REENTRY_SECTION.title}"（30 秒 / 5 分钟 / 30 分钟三种读法）`, { suggestion: `补写${REENTRY_SECTION.title}` })]
    },
  }),
  defineRule({
    id: 'verify-experiment',
    title: '验证实验',
    weight: 5,
    severity: 'warn',
    scope: 'card',
    run: (c, self) => {
      if (!c.spec.required.some((s) => s.title === VERIFY_TITLE)) return []
      const { present, steps } = checkExperiments(c.sections)
      if (!present) {
        return [finding(self, 'warn', `${c.spec.type}卡片缺 "### ${VERIFY_TITLE}"（≥3 步，每步一句"看到什么说明什么"）`, { suggestion: `补写${VERIFY_TITLE}` })]
      }
      if (steps < 3) {
        return [finding(self, 'warn', `${VERIFY_TITLE}只有 ${steps} 步（${c.spec.type}要求 ≥3 步）`, { suggestion: '补足步骤' })]
      }
      return []
    },
  }),
  defineRule({
    id: 'troubleshoot-criteria',
    title: '排障判据',
    weight: 5,
    severity: 'warn',
    scope: 'card',
    run: (c, self) => {
      if (!c.spec.required.some((s) => s.title === TROUBLESHOOT_TITLE)) return []
      if (hasSection(c.sections, TROUBLESHOOT_TITLE)) return []
      return [finding(self, 'warn', `${c.spec.type}卡片缺 "### ${TROUBLESHOOT_TITLE}"（表格：症状 | 判据 | 修复）`, { suggestion: `补写${TROUBLESHOOT_TITLE}` })]
    },
  }),
  defineRule({
    id: 'code-language',
    title: '代码块语言',
    weight: 3,
    severity: 'warn',
    run: (c, self) => {
      const check = checkCodeFences(c.body)
      if (check.unlabeled === 0) return []
      return [finding(self, 'warn', `${check.unlabeled}/${check.total} 个代码块未标语言（第 ${check.unlabeledIndexes.join('、')} 块）`, { suggestion: '标注 hlsl/cpp/csharp/python/plaintext 等' })]
    },
  }),
  defineRule({
    id: 'selftest-answer',
    title: '自测题答案',
    weight: 3,
    severity: 'warn',
    scope: 'card',
    run: (c, self) => {
      const check = checkSelfTest(c.sections)
      const out: LintFinding[] = []
      if (check.missing.length > 0) {
        out.push(finding(self, 'warn', `自测题第 ${check.missing.join('、')} 题没有答案（应为 "Qn：… → 答案要点"）`, { suggestion: '补答案要点，并加"答不出 → 回看 X"' }))
      }
      if (check.usesNumbered) {
        out.push(finding(self, 'warn', '自测题用了 "1./2." 编号写法，规范为 "**Q1**：…"', { suggestion: '改为 Qn 写法' }))
      }
      return out
    },
  }),
  defineRule({
    id: 'layer-number',
    title: '层级序号',
    weight: 3,
    severity: 'warn',
    scope: 'card',
    run: (c, self) => {
      const check = checkLayers(c.sections, c.body)
      if (check.hasNumbers && !check.inRange) {
        return [finding(self, 'warn', `阶梯式解剖为 ${check.layers.length} 层（规范 4~6 层）`, { suggestion: '合并或补充层级' })]
      }
      if (check.hasNumbers && !check.sequential) {
        return [finding(self, 'warn', `层级序号不连续：第 ${check.layers.join('、')} 层`, { suggestion: '按 1→N 连续编号' })]
      }
      if (!check.hasNumbers && hasSection(c.sections, '阶梯式解剖')) {
        return [finding(self, 'warn', '阶梯式解剖缺少 "第 N 层" 序号', { suggestion: '补层级序号' })]
      }
      return []
    },
  }),
  defineRule({
    id: 'links-format',
    title: '关联块格式',
    weight: 3,
    severity: 'warn',
    run: (c, self) => {
      const check = checkLinksBlock(c.sections)
      if (check.malformed.length === 0) return []
      return [finding(self, 'warn', `关联块有 ${check.malformed.length} 行不符合 "- 前置/后续/易混淆：\`标题\`（ID）" 格式：${check.malformed.slice(0, 2).join(' / ')}`, { suggestion: '统一为带 ID 的关联行' })]
    },
  }),
  defineRule({
    id: 'domain-tag',
    title: '领域标签',
    weight: 3,
    severity: 'warn',
    run: (c, self) => {
      const check = checkDomainTags(c.tags, c.knownDomains)
      if (!check.mixed) return []
      return [finding(self, 'warn', `领域标签同时挂了根域与子域：${check.roots.join('、')} + ${check.children.join('、')}`, { suggestion: '只保留精确的子域键（或只保留根域）' })]
    },
  }),
  defineRule({
    id: 'external-resource',
    title: '外部资源',
    weight: 0,
    severity: 'info',
    // SEC-7：正文里的 HTML 外链会被 Obsidian 渲染并主动外联（信标/跟踪面）
    run: (c, self) => checkExternalResources(c.body).map((h) => finding(
      self,
      'info',
      `第 ${h.line} 行引用了外部资源（<iframe>/<script>/<img src="http…">）：Obsidian 打开卡片时会主动联网`,
      { line: h.line, excerpt: h.excerpt, suggestion: '确认来源可信；不需要就删掉该 HTML' },
    )),
  }),
]

export type RuleId = string

/** 规则 id 全集（工具参数与文档共用） */
export function ruleIds(): RuleId[] {
  return RULES.map((r) => r.id)
}

/** 规则中文名（报告与文档共用） */
export function ruleTitle(id: string): string {
  return RULES.find((r) => r.id === id)?.title ?? id
}

/** 规则目录（文档 / 测试 / 配置校验共用） */
export function ruleCatalog(): Array<{ id: string; title: string; weight: number; severity: Severity; scope: 'card' | 'all' }> {
  return RULES.map((r) => ({ id: r.id, title: r.title, weight: r.weight, severity: r.severity, scope: r.scope ?? 'all' }))
}

/** 对单张卡片（或旧笔记）跑全部规则并打分 */
export function lintCard(
  input: { title?: string; definition?: string; body: string; template?: string; tags?: string[] },
  ctx: LintContext = {},
): LintReport {
  const body = String(input.body ?? '')
  const off = new Set(ctx.rulesOff ?? [])
  const spec = templateSpec(input.template)
  const sections = splitSections(body).sections
  const residueText = blankOutBlocks(body)
  const ruleCtx: RuleCtx = {
    title: String(input.title ?? '').trim() || '（无标题）',
    definition: String(input.definition ?? ''),
    body,
    sections,
    residueText,
    bodyChars: bodyLength(body, residueText),
    spec,
    tags: input.tags ?? [],
    knownDomains: ctx.knownDomains ?? [],
    residueLevel: ctx.residueLevel ?? 'warn',
    kind: ctx.kind ?? 'card',
  }
  const findings: LintFinding[] = []
  const passed: Record<string, boolean> = {}
  const notRun: string[] = []
  for (const rule of RULES) {
    if (off.has(rule.id)) continue
    if (rule.scope === 'card' && ruleCtx.kind === 'note') continue
    const out = rule.run(ruleCtx)
    if (out === null) {
      // 未执行 ≠ 通过（N7）：不进 passed，报告单列
      notRun.push(rule.title)
      continue
    }
    findings.push(...out)
    passed[rule.id] = out.length === 0
  }
  const deducted = findings.reduce((sum, f) => sum + f.weight, 0)
  let score = Math.max(0, 100 - deducted)
  if (findings.some((f) => f.severity === 'error')) score = Math.min(score, ERROR_SCORE_CAP)
  return {
    title: ruleCtx.title,
    template: spec.type,
    kind: ruleCtx.kind,
    score,
    chars: ruleCtx.bodyChars,
    findings,
    passed,
    notRun,
  }
}

const ICON: Record<Severity, string> = { error: '✗', warn: '⚠', info: '·' }

/** 渲染单卡报告（工具返回用） */
export function formatReport(report: LintReport): string {
  const template = report.kind === 'note' ? '—（旧笔记：仅体检通用规则）' : report.template
  const lines: string[] = [`卡片：${report.title}  模板：${template}  总分：${report.score}/100（正文 ${report.chars} 字）`]
  const okRules = Object.entries(report.passed).filter(([, ok]) => ok).map(([rule]) => ruleTitle(rule))
  if (okRules.length > 0) lines.push(`  ✓ 通过：${okRules.join('、')}`)
  if (report.notRun.length > 0) lines.push(`  ⊘ 未执行（不计入通过）：${report.notRun.join('、')}`)
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
  kind: 'card' | 'note'
  score: number
  chars: number
  findingCount: number
  topRules: string[]
}

export interface LintBatch {
  total: number
  /** 其中旧笔记数量（仅体检通用规则） */
  noteCount: number
  averageScore: number
  /** 分数分布（按 10 分一档） */
  distribution: Array<{ range: string; count: number }>
  /** 每条规则的命中卡片数与命中次数 */
  rules: Array<{ rule: string; title: string; cards: number; hits: number }>
  rows: LintSummaryRow[]
}

/** 汇总多张卡片/笔记的 lint 结果（批量模式） */
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
    const bucket = Math.floor(report.score / SCORE_BUCKET) * SCORE_BUCKET
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  const total = reports.length
  const averageScore = total === 0 ? 0 : Math.round(reports.reduce((s, r) => s + r.score, 0) / total)
  return {
    total,
    noteCount: reports.filter((r) => r.kind === 'note').length,
    averageScore,
    distribution: [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([lo, count]) => {
      // 满分桶不能显示 `100~109`（N10）：上界封顶 100，单值桶只显示一个数
      const hi = Math.min(lo + SCORE_BUCKET - 1, 100)
      return { range: lo === hi ? `${lo}` : `${lo}~${hi}`, count }
    }),
    rules: [...ruleMap.entries()]
      .map(([rule, v]) => ({ rule, title: ruleTitle(rule), cards: v.cards, hits: v.hits }))
      .sort((a, b) => b.cards - a.cards || a.rule.localeCompare(b.rule)),
    rows: reports.map((r, i) => ({
      title: titles[i] ?? r.title,
      template: r.template,
      kind: r.kind,
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
    `批量 lint：${batch.total} 篇，平均 ${batch.averageScore}/100`,
    `分数分布：${batch.distribution.map((d) => `${d.range} 分 ${d.count} 篇`).join('，') || '—'}`,
  ]
  if (batch.noteCount > 0) {
    lines.push(`其中旧笔记 ${batch.noteCount} 篇（仅体检通用规则：会话残留/定义长度/代码块语言/关联块格式/领域标签/外部资源）`)
  }
  if (batch.rules.length > 0) {
    lines.push('规则命中（按命中篇数排序）：')
    for (const r of batch.rules) lines.push(`  - ${r.title}：${r.cards} 篇 / ${r.hits} 处`)
  } else {
    lines.push('规则命中：无')
  }
  const worst = [...batch.rows].sort((a, b) => a.score - b.score).slice(0, limit)
  if (worst.length > 0) {
    lines.push(`最低分 ${worst.length} 篇：`)
    for (const row of worst) {
      const kind = row.kind === 'note' ? '旧笔记' : row.template
      lines.push(`  - ${row.score}/100 ${row.title}（${kind}，${row.chars} 字）${row.topRules.length ? `：${row.topRules.join('、')}` : ''}`)
    }
  }
  return lines.join('\n')
}
