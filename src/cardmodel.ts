/**
 * 卡片文档模型：把卡片正文视为「有序小节序列」，而不是一整块字符串。
 *
 * 这是 2026-09 框架重设计的地基：模板校验、lint 评分、版本块插入、
 * 历史折叠剥离、改名重写都基于同一套段落模型，避免每加一条规则就动一处
 * 字符串拼接。纯文本变换，不碰文件系统。
 * @module cardmodel
 */

/** 一个 `#`~`######` 小节（含正文，不含标题行） */
export interface CardSection {
  /** 井号数量（1~6） */
  level: number
  /** 标题文本（已 trim，不含井号） */
  title: string
  /** 小节正文（不含标题行；行尾空白已裁掉） */
  body: string
  /** 标题行在输入文本中的起始下标 */
  start: number
  /** 小节结束下标（下一个标题行之前，或文本末尾） */
  end: number
}

/**
 * 单行字段收敛：**只把换行折成一个空格**（SEC-1）。
 *
 * 用途是**渲染兜底**：frontmatter 标量、一句话定义、`### 版本更新（来源：…）`、
 * MOC 标题里出现换行时，会让 `parseFrontmatter` 的非贪婪正则在注入的 `---`
 * 处提前闭合，导致后半段元数据静默降级为正文（索引/lint/改名全部依据错）。
 * 校验层仍会拒绝换行（fail-loud），本函数是纵深防御，不替代校验。
 *
 * 不压缩连续空格（N12）：`C++  STL` 是**合法输入**，静默改写等于"用户看到
 * 的标题与磁盘上的不是同一个"。需要压空白的场景各自显式处理
 * （`sanitizeFilename` 压文件名、`wikilinkTarget` 压链接目标）。
 */
export function inlineText(value: unknown): string {
  return String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

export interface SplitBody {
  /** 首个标题之前的引言（一句话定义引用块等） */
  lead: string
  sections: CardSection[]
}

/** 标题行匹配：`### 标题`（允许标题后尾随空白；至少一个 `#` 与一个非空白字符） */
const HEADING_RE = /^(#{1,6})[ \t]+(\S.*?)[ \t]*$/gm

/**
 * 切分正文为有序小节。标题之前的引言保留在 `lead`；
 * `renderSections(splitSections(x))` 与原文本语义等价（只归一化空行）。
 */
export function splitSections(body: string): SplitBody {
  const text = String(body ?? '')
  const marks: Array<{ level: number; title: string; index: number; end: number }> = []
  // matchAll 内部克隆正则，不共享 lastIndex（CPLX-10：避免"共享可变正则状态"）
  for (const m of text.matchAll(HEADING_RE)) {
    marks.push({ level: m[1].length, title: m[2].trim(), index: m.index, end: m.index + m[0].length })
  }
  if (marks.length === 0) return { lead: text.replace(/\s+$/, ''), sections: [] }
  const lead = text.slice(0, marks[0].index).replace(/\s+$/, '')
  const sections: CardSection[] = marks.map((mark, i) => {
    const nextStart = i + 1 < marks.length ? marks[i + 1].index : text.length
    return {
      level: mark.level,
      title: mark.title,
      body: text.slice(mark.end, nextStart).replace(/^[ \t]*\r?\n/, '').replace(/\s+$/, ''),
      start: mark.index,
      end: nextStart,
    }
  })
  return { lead, sections }
}

/** 渲染小节序列为 Markdown 正文（lead 与小节之间、小节之间以空行分隔） */
export function renderSections(lead: string, sections: CardSection[]): string {
  const parts: string[] = []
  const head = String(lead ?? '').replace(/\s+$/, '')
  if (head.trim()) parts.push(head)
  for (const s of sections) {
    const hashes = '#'.repeat(Math.min(Math.max(s.level, 1), 6))
    const heading = `${hashes} ${s.title}`
    const body = String(s.body ?? '').replace(/\s+$/, '')
    parts.push(body ? `${heading}\n${body}` : heading)
  }
  return parts.join('\n\n')
}

/**
 * 小节标题匹配：精确相等，或以 `title` 开头且紧跟括号/冒号/破折号
 * （允许 `### 阶梯式解剖（第 1 层 → 第 4 层）`、`### 核心思想（直击）` 这类变体）。
 * 说明性后缀不算新小节——这是存量卡片格式漂移的兼容口径。
 */
export function matchesTitle(heading: string, title: string): boolean {
  const h = String(heading ?? '').trim()
  const t = String(title ?? '').trim()
  if (!h || !t) return false
  if (h === t) return true
  if (!h.startsWith(t)) return false
  return /^[（(：:—\-·\s]/.test(h.slice(t.length))
}

/** 取首个匹配的小节（按模板标题或变体） */
export function findSection(sections: CardSection[], title: string): CardSection | undefined {
  return sections.find((s) => matchesTitle(s.title, title))
}

/** 是否存在匹配的小节 */
export function hasSection(sections: CardSection[], title: string): boolean {
  return findSection(sections, title) !== undefined
}

/**
 * 构造「下标 → 行号（1 基）」查询函数（PERF-4）。
 *
 * 旧写法 `text.slice(0, index).split('\n').length` 对每个小节都做一次
 * 前缀切片 + split，整卡成本 ≈ 正文长度 × 小节数（`cross` 对全库跑时放大）。
 * 这里预计算一次换行位置并二分查找，纯函数、可复用。
 */
export function makeLineOf(text: string): (index: number) => number {
  const src = String(text ?? '')
  const breaks: number[] = []
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) breaks.push(i)
  }
  return (index: number): number => {
    const at = Math.max(0, Math.min(Number(index) || 0, src.length))
    let lo = 0
    let hi = breaks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (breaks[mid] < at) lo = mid + 1
      else hi = mid
    }
    return lo + 1
  }
}

/**
 * 在小节 `beforeTitle` 之前插入一段原始 Markdown（P0-3 版本块定位）；
 * 找不到该小节时追加到正文末尾。段落两侧空行归一化，不产生连续空行。
 */
export function insertBlockBefore(body: string, block: string, beforeTitle = '关联卡片'): string {
  const text = String(body ?? '')
  const { lead, sections } = splitSections(text)
  const trimmed = String(block ?? '').replace(/^\s*\n/, '').replace(/\s+$/, '')
  if (!trimmed) return renderSections(lead, sections)
  const idx = sections.findIndex((s) => matchesTitle(s.title, beforeTitle))
  const at = idx === -1 ? text.length : sections[idx].start
  const head = text.slice(0, at).replace(/\s+$/, '')
  const tail = text.slice(at).replace(/^\s+/, '')
  if (!tail) return `${head}\n\n${trimmed}`
  if (!head) return `${trimmed}\n\n${tail}`
  return `${head}\n\n${trimmed}\n\n${tail}`
}

/** 从 Markdown 中提取 fenced code block 的语言标注（空串 = 未标语言） */
export function codeFenceLanguages(body: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = /^[ \t]*(```+|~~~+)[ \t]*([^\s`~]*)/.exec(line)
    if (!m) continue
    if (inFence) {
      inFence = false
      continue
    }
    inFence = true
    out.push(m[2] ?? '')
  }
  return out
}

/** 阶梯式解剖层号：返回出现的层号（去重升序） */
export function layerNumbers(body: string): number[] {
  const found = new Set<number>()
  const text = String(body ?? '')
  const re = /第\s*(\d+)\s*层/g
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) found.add(n)
  }
  return [...found].sort((a, b) => a - b)
}

/** 编号/项目列表项数量（`1.` / `1)` / `- ` / `* ` / `+ `，用于"验证实验 ≥3 步"） */
export function countListItems(body: string): number {
  return (String(body ?? '').match(/^[ \t]*(?:\d+[.)]|[-*+])[ \t]+\S/gm) ?? []).length
}

/**
 * 用空行替换 fenced code block 与 `<details>` 折叠块的内容（保留行号），
 * 供"只扫正文"的规则（会话残留）使用，避免代码/历史块误伤。
 */
export function blankOutBlocks(body: string): string {
  const lines = String(body ?? '').split(/\r?\n/)
  let fence: string | null = null
  let inDetails = 0
  return lines
    .map((line) => {
      const fenceMatch = /^[ \t]*(```+|~~~+)/.exec(line)
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null
        return ''
      }
      if (fenceMatch) {
        fence = fenceMatch[1]
        return ''
      }
      if (inDetails > 0) {
        if (/<\/details>/i.test(line)) inDetails -= 1
        return ''
      }
      if (/<details\b/i.test(line)) {
        if (!/<\/details>/i.test(line)) inDetails += 1
        return ''
      }
      return line
    })
    .join('\n')
}
