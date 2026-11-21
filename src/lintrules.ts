/**
 * lint 判定函数（纯函数）+ 共享正则常量。
 *
 * 2026-10 瘦身：模板类判定（小节齐备度 / 层级序号 / 自测题 / 领域标签 / 关联块格式）
 * 随三型模板一起删除（需求 R6）。保留的都是**与内容自由度无关**的数据卫生判定：
 * 会话残留、代码块语言、外部资源、正文字数。
 *
 * 规则集中在这里的目的不变：
 * 1. 代码与文档同源——技能/期望文件里写的口径就是这里的常量；
 * 2. 误伤控制显式化（白名单、代码块与折叠块跳过），可被单测钉住；
 * 3. 新增判定只改本文件，lint 引擎与工具描述自动跟随。
 * @module lintrules
 */

import { blankOutBlocks, scanCodeFences } from './notemodel.ts'

/** 会话残留：带机器根的路径；仓库相对的 `Assets/...` 源码地图是长期资产，不在此列 */
export const RESIDUE_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|file:\/\/|~\/|\/(?:Users|home|mnt|Volumes)\/)/
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
 * 2026-09 审查后移除 `实测`（BIZ-11i）：工程笔记里"实测帧率 60fps"是正常表述，
 * 真正要抓的是"本工程实测"里的 `本工程`，`实测` 单独出现误报率过高。
 */
export const RESIDUE_SESSION_RE = /本工程|本笔记会话|排查顺序|先证据后结论|课上/
/** 行号白名单：球谐带 / 正则化 / LOD 等专有记号 */
export const LINE_WHITELIST_RE = /\bL[0-2]\b(?!\s*[-–~]\s*L?\d)|LOD/
/** 讲义/章节引用白名单（`GAMES101 L15`、`第 15 讲`）——是出处，不是会话残留 */
export const LECTURE_REF_RE = /(?:[A-Za-z]+\s*)?L\d+\b[^。；\n]{0,12}(?:讲|课|课件)|第\s*\d+\s*讲|Lecture\s*\d+/i
/** 外部资源引用（SEC-7）：Obsidian 打开笔记时会主动外联（信标/跟踪面） */
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
  person: '改成第三人称陈述（"shader 需要…"），笔记面向半年后的自己',
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

/**
 * 行号残留判定：只在"紧邻文件名"或"成区间"时才报（`RealtimeLights.hlsl L182`、`L35-55`）；
 * 白名单（`L0/L1/L2`、`LOD`）与讲义引用（`GAMES101 L15`、`第 15 讲`）直接放过。
 */
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
 * 扫描会话残留。
 *
 * 误伤控制（用真实 vault 223 篇校准，误伤代价高于漏报）：
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
  /** 未标语言的代码块序号（1 基，**不是行号**） */
  unlabeledIndexes: number[]
  /** 未标语言 opener 的 1 基行号，与 unlabeledIndexes 同下标 */
  unlabeledLines: number[]
  /** 最后一个 opener 是否缺少同类型 closer */
  balanced: boolean
  /** 未闭合 opener 的行号（1 基） */
  unclosedLine: number | null
}

/** 代码块语言标注检查 */
export function checkCodeFences(body: string): CodeFenceCheck {
  const scan = scanCodeFences(body)
  const langs = scan.languages
  const missing = langs
    .map((language, index) => ({ language, index }))
    .filter(({ language }) => language.trim() === '')
  const unlabeledIndexes = missing.map(({ index }) => index + 1)
  return {
    total: langs.length,
    unlabeled: unlabeledIndexes.length,
    unlabeledIndexes,
    unlabeledLines: missing.map(({ index }) => scan.openerLines[index]),
    balanced: scan.unclosedLine === null,
    unclosedLine: scan.unclosedLine,
  }
}

export const EVIDENCE_LEVEL_RE = /源码已核对|测试已覆盖|运行已观察|待验证/

export interface SourceReference {
  path: string
  symbol: string | null
  line: number
}

/**
 * 提取仓库相对源码地图。只认带目录与源码扩展名的 inline code，避免把普通文件名
 * 或绝对路径当工程索引；`· Symbol` 是推荐形式，但不是语法硬要求。
 */
export function sourceReferences(body: string): SourceReference[] {
  const refs: SourceReference[] = []
  const text = blankOutBlocks(body)
  const re = /`((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:cs|shader|hlsl|cginc|compute|asmdef|json|unity))(?:\s*·\s*([^`\n]+))?`/g
  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(re)) {
      refs.push({ path: match[1], symbol: match[2]?.trim() || null, line: index + 1 })
    }
  })
  return refs
}

/** Mermaid 主图块数量（只看 opener 的语言标记）。 */
export function mermaidDiagramCount(body: string): number {
  return scanCodeFences(body).languages.filter((lang) => lang.toLowerCase() === 'mermaid').length
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
