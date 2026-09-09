/**
 * lint 规则集：会话残留（P0）与结构规范（P1）的共享判定逻辑。
 *
 * 规则集中在这里的目的有三：
 * 1. 代码与文档同源——persona / card-format 技能里写的正则口径就是这里的常量；
 * 2. 误伤控制显式化（白名单、代码块与折叠块跳过），可被单测钉住；
 * 3. 新增规则只改本文件，lint 引擎与工具描述自动跟随。
 *
 * 2026-09 审查后（CPLX-4 / PERF-3）：会话残留从"内联 if 链"改成数据表 + 单次遍历；
 * 结构类判定统一接收**已切好的小节**，不再各自重新 `splitSections`。
 * @module lintrules
 */

import {
  blankOutBlocks, codeFenceLanguages, countListItems, findSection, layerNumbers, matchesTitle,
  type CardSection,
} from './cardmodel.ts'

/** 会话残留：文件路径（`.md` 引用不算——卡片互引是合法内容） */
export const RESIDUE_PATH_RE = /(?:[A-Za-z]:\\|Assets[\\/]|\.(?:shader|unity|mat|asset|hlsl|cs|cginc|compute)\b)/
/** 会话残留：源码行号（需紧跟文件名或成 `L35-55` 区间；`L0/L1/L2` 球谐带白名单） */
export const RESIDUE_LINE_RE = /\bL\d+(?:\s*[-–]\s*L?\d+)?\b/
/** 会话残留：第二人称 */
export const RESIDUE_PERSON_RE = /你|我们|咱们/
/** 会话残留：会话相对时间词（`今天` 可作口语化定义，不在此列） */
export const RESIDUE_TIME_RE = /上次|本次|刚才|刚刚|昨天|前天|前几讲/
/** 会话残留：阶段/里程碑代号 */
export const RESIDUE_PHASE_RE = /\b(?:P[0-3]|W[1-9])\b/
/**
 * 会话残留：会话口吻词。
 * 2026-09 审查后移除 `实测`（BIZ-11i）：工程卡里"实测帧率 60fps"是正常表述，
 * 真正要抓的是"本工程实测"里的 `本工程`，`实测` 单独出现误报率过高。
 */
export const RESIDUE_SESSION_RE = /本工程|本卡会话|排查顺序|先证据后结论|课上/
/** 行号白名单：球谐带 / 正则化 / LOD 等专有记号 */
export const LINE_WHITELIST_RE = /\bL[0-2]\b(?!\s*[-–~]\s*L?\d)|LOD/
/** 讲义/章节引用白名单（`GAMES101 L15`、`第 15 讲`）——是出处，不是会话残留 */
export const LECTURE_REF_RE = /(?:[A-Za-z]+\s*)?L\d+\b[^。；\n]{0,12}(?:讲|课|课件)|第\s*\d+\s*讲|Lecture\s*\d+/i
/** 外部资源引用（SEC-7）：Obsidian 打开卡片时会主动外联（信标/跟踪面） */
export const EXTERNAL_RESOURCE_RE = /<iframe\b|<script\b|<img\b[^>]*\bsrc\s*=\s*["']?https?:/i

export interface ResidueHit {
  rule: 'path' | 'line' | 'person' | 'time' | 'phase' | 'session'
  line: number
  excerpt: string
  suggestion: string
}

const SUGGESTIONS: Record<ResidueHit['rule'], string> = {
  path: '删掉本机路径，改成"源码里 XX 函数"这类不依赖机器的说法',
  line: '删掉行号或改成符号名（如"RealtimeLights 里的 XXX 函数"）；行号会随版本失效',
  person: '改成第三人称陈述（"shader 需要…"），卡片面向半年后的自己',
  time: '删掉会话相对时间，改成绝对出处（书名/章节/日期）',
  phase: '把阶段代号换成它的含义（如"W2"→"接入 IBL 之后"）',
  session: '删掉会话口吻词，改成对现象的客观描述',
}

/** 命中片段的展示上下文（前后各截一点，压缩空白） */
function excerptOf(line: string, index: number, width = 16): string {
  const start = Math.max(0, index - width)
  return line.slice(start, index + width + 12).replace(/\s+/g, ' ').trim()
}

interface ResidueRule {
  rule: ResidueHit['rule']
  re: RegExp
  /** 命中后的白名单/邻近性判定：返回 true 表示"确实是残留" */
  guard?: (line: string, m: RegExpExecArray) => boolean
  /** nonQuote = 引用块（`> …`）内不判（定义句里的"我们"不算残留） */
  scope: 'all' | 'nonQuote'
}

/** 行号残留判定：只在"紧邻文件名"或"成区间"时才报（`RealtimeLights.hlsl L182`、`L35-55`） */
function lineGuard(line: string, m: RegExpExecArray): boolean {
  if (LINE_WHITELIST_RE.test(m[0]) || LECTURE_REF_RE.test(line)) return false
  const before = line.slice(0, m.index)
  const after = line.slice(m.index + m[0].length)
  const nearFile = /\.[a-z0-9]{2,6}[`）)\s]*$/i.test(before)
  const isRange = /[-–]\s*L?\d/.test(m[0])
  const fileAfter = /^[`\s]*[\w./\\-]+\.[a-z0-9]{2,6}/i.test(after)
  return nearFile || isRange || fileAfter
}

/**
 * 残留规则表（顺序即报告顺序，line 在 path 之前是有意的：
 * `RealtimeLights.hlsl L182` 同时命中两者时，行号条目在前更贴近阅读习惯）。
 * `M1/M2/M3` 默认不报（真实语料里多为里程碑/数学记号），仅同行出现"工程/阶段/里程碑"时提示。
 */
const RESIDUE_RULES: ResidueRule[] = [
  { rule: 'line', re: RESIDUE_LINE_RE, guard: lineGuard, scope: 'all' },
  { rule: 'path', re: RESIDUE_PATH_RE, scope: 'all' },
  { rule: 'person', re: RESIDUE_PERSON_RE, scope: 'nonQuote' },
  { rule: 'time', re: RESIDUE_TIME_RE, scope: 'nonQuote' },
  { rule: 'phase', re: RESIDUE_PHASE_RE, scope: 'nonQuote' },
  { rule: 'session', re: RESIDUE_SESSION_RE, scope: 'nonQuote' },
  { rule: 'phase', re: /\bM[1-3]\b/, guard: (line) => /工程|阶段|里程碑|排期/.test(line), scope: 'nonQuote' },
]

/**
 * 扫描会话残留（P0-2）。
 *
 * 误伤控制（与提案 §5.2 一致，并用真实 vault 223 张卡校准）：
 * ① 只扫代码块与 `<details>` 折叠块**之外**的正文（`blanked` 可传入已算好的结果）；
 * ② 白名单优先：`L0/L1/L2`、`LOD`、讲义/章节引用（`GAMES101 L15`、`第 15 讲`）；
 * ③ 行号只在"紧邻文件名"或"成区间"时才报；
 * ④ `M1/M2/M3` 默认不报。
 */
export function scanResidue(body: string, opts: { blanked?: string } = {}): ResidueHit[] {
  const text = opts.blanked ?? blankOutBlocks(body)
  const lines = text.split(/\r?\n/)
  const hits: ResidueHit[] = []
  lines.forEach((line, i) => {
    if (!line.trim()) return
    const quoted = /^[ \t]*>/.test(line)
    for (const entry of RESIDUE_RULES) {
      if (entry.scope === 'nonQuote' && quoted) continue
      const m = entry.re.exec(line)
      if (!m) continue
      if (entry.guard && !entry.guard(line, m)) continue
      hits.push({ rule: entry.rule, line: i + 1, excerpt: excerptOf(line, m.index), suggestion: SUGGESTIONS[entry.rule] })
    }
  })
  return hits
}

export interface CodeFenceCheck {
  total: number
  unlabeled: number
  /** 未标语言的代码块序号（1 基） */
  unlabeledIndexes: number[]
}

/** 代码块语言标注检查（P1-3） */
export function checkCodeFences(body: string): CodeFenceCheck {
  const langs = codeFenceLanguages(body)
  const unlabeledIndexes = langs.map((l, i) => (l.trim() === '' ? i + 1 : 0)).filter((n) => n > 0)
  return { total: langs.length, unlabeled: unlabeledIndexes.length, unlabeledIndexes }
}

export interface SelfTestCheck {
  /** 题目数量（`**Q1**` / `Q1：` / `1.` 三种写法均计） */
  questions: number
  /** 带 `→` 答案的题目数量 */
  answered: number
  /** 无答案的题号（1 基） */
  missing: number[]
  /** 是否使用了 `Qn` 规范写法 */
  usesQn: boolean
  /** 是否混用了 `1./2.` 编号写法 */
  usesNumbered: boolean
}

/** 自测题格式与答案校验（P1-2） */
export function checkSelfTest(sections: CardSection[]): SelfTestCheck {
  const section = findSection(sections, '自测题')
  const text = section?.body ?? ''
  const qn = [...text.matchAll(/^[ \t]*(?:[-*+][ \t]*)?\*{0,2}Q(\d+)\*{0,2}[ \t]*[:：]/gm)]
  const numbered = [...text.matchAll(/^[ \t]*(\d+)[.)][ \t]+\S/gm)]
  const usesQn = qn.length > 0
  const usesNumbered = !usesQn && numbered.length > 0
  const questions = usesQn ? qn.length : numbered.length
  const missing: number[] = []
  let answered = 0
  if (usesQn) {
    for (const m of qn) {
      const start = (m.index ?? 0) + m[0].length
      const nextIdx = text.indexOf('\n', start)
      const line = text.slice((m.index ?? 0), nextIdx === -1 ? text.length : nextIdx)
      if (line.includes('→')) answered += 1
      else missing.push(Number(m[1]))
    }
  } else {
    const lines = text.split(/\r?\n/).filter((l) => /^[ \t]*\d+[.)][ \t]+\S/.test(l))
    lines.forEach((line, i) => {
      if (line.includes('→')) answered += 1
      else missing.push(i + 1)
    })
  }
  return { questions, answered, missing, usesQn, usesNumbered }
}

export interface LayerCheck {
  layers: number[]
  /** 层数是否在 4~6 区间 */
  inRange: boolean
  /** 序号是否连续（1..n） */
  sequential: boolean
  /** 是否至少出现一次 `第 N 层` */
  hasNumbers: boolean
}

/** 阶梯式解剖层数与序号检查（P1-4） */
export function checkLayers(sections: CardSection[], body = ''): LayerCheck {
  const section = findSection(sections, '阶梯式解剖')
  const text = section ? `${section.title}\n${section.body}` : body
  const layers = layerNumbers(text)
  const sequential = layers.length > 0 && layers.every((n, i) => n === i + 1)
  return { layers, inRange: layers.length >= 4 && layers.length <= 6, sequential, hasNumbers: layers.length > 0 }
}

export interface DomainTagCheck {
  /** frontmatter 领域键（去 #） */
  tags: string[]
  /** 根域标签（存在同名子域键，如 `图形学` vs `图形学-光照模型`） */
  roots: string[]
  /** 子域标签 */
  children: string[]
  /** 同一张卡同时挂了根域与子域 */
  mixed: boolean
}

/**
 * 领域标签归一检查（P1-5）：同一张卡不应同时挂根域与子域标签。
 *
 * 判定口径（对真实语料校准过，避免把 `Cook-Torrance` 这类关键词误判）：
 * - 子域标签 = 含 `-` **且**存在另一个标签是它的前缀（`图形学-光照模型` ← `图形学`），
 *   或与 `knownKeys` 中的子域键同前缀；
 * - 根域标签 = 存在另一个标签以 `${tag}-` 开头；
 * - 其余（`PBR`、`数学直觉`、`Cook-Torrance`）是自由关键词，不参与判定。
 */
export function checkDomainTags(tags: string[], knownKeys: string[] = []): DomainTagCheck {
  const list = tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean)
  const keys = knownKeys.map((k) => String(k))
  const roots: string[] = []
  const children: string[] = []
  for (const tag of list) {
    const isRoot = list.some((other) => other !== tag && other.startsWith(`${tag}-`))
      || keys.some((k) => k.startsWith(`${tag}-`))
    if (isRoot) {
      roots.push(tag)
      continue
    }
    const isChild = tag.includes('-')
      && (list.some((other) => other !== tag && tag.startsWith(`${other}-`))
        || keys.some((k) => tag.startsWith(`${k}-`)))
    if (isChild) children.push(tag)
  }
  return { tags: list, roots, children, mixed: roots.length > 0 && children.length > 0 }
}

export interface LinksBlockCheck {
  present: boolean
  /** 不符合 `- 标签：\`标题\`（ID）` 归一格式的行 */
  malformed: string[]
  lines: string[]
}

/** 关联块格式检查：统一 `- 前置/后续/易混淆：\`标题\`（ID）` */
export function checkLinksBlock(sections: CardSection[]): LinksBlockCheck {
  const section = findSection(sections, '关联卡片')
  if (!section) return { present: false, malformed: [], lines: [] }
  const lines = section.body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('-'))
  const malformed = lines.filter((l) => !/^-\s*(?:前置|后续|易混淆)\s*[：:]\s*\S/.test(l))
  return { present: true, malformed, lines }
}

/** 验证实验步数（工程型 ≥3 步） */
export function checkExperiments(sections: CardSection[]): { present: boolean; steps: number } {
  const section = findSection(sections, '验证实验')
  if (!section) return { present: false, steps: 0 }
  const items = countListItems(section.body)
  return { present: true, steps: items > 0 ? items : section.body.trim() ? 1 : 0 }
}

/** 某个小节标题在正文中出现的次数（变体计入；spec.mainline 驱动的唯一性检查，EXT-2） */
export function countSection(sections: CardSection[], title: string): number {
  return sections.filter((s) => matchesTitle(s.title, title)).length
}

export interface ExternalResourceHit {
  line: number
  excerpt: string
}

/** 外部资源引用检查（SEC-7）：Obsidian 渲染 HTML 时会主动外联（信标/跟踪） */
export function checkExternalResources(body: string): ExternalResourceHit[] {
  const hits: ExternalResourceHit[] = []
  String(body ?? '').split(/\r?\n/).forEach((line, i) => {
    const m = EXTERNAL_RESOURCE_RE.exec(line)
    if (m) hits.push({ line: i + 1, excerpt: excerptOf(line, m.index) })
  })
  return hits
}

/** 正文实际字数（不含 frontmatter、代码块与折叠块；`blanked` 可复用已算好的结果） */
export function bodyLength(body: string, blanked?: string): number {
  return (blanked ?? blankOutBlocks(body)).replace(/\s+/g, '').length
}
