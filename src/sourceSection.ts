/**
 * `来源章节` 的语法与归一（架构选型 §4.2）。
 *
 * 它是**覆盖度总览的唯一数据源**：`note_overview` 按「资料 → 章 → 节」聚合，
 * 因此书写口径必须收敛。归一只做**无损归一**——全角/半角、`第 2 章` 与 `第2章`
 * 这类同义写法统一，绝不猜测或补全语义（不虚构章节，需求 R15）。
 *
 * 解析不出来时不报错：条目原文照样存进 `来源章节`，只是进总览的"未归类"，
 * 用户能看到是哪几条需要补。
 * @module sourceSection
 */

export interface SourceRef {
  /** 资料名（`《…》` 内的内容或章节号之前的裸文本） */
  material: string
  /** 章号（阿拉伯数字；缺失时为空串） */
  chapter: string
  /** 章标题（章号之后、节号之前） */
  chapterTitle: string
  /** 节号（`2.1`；缺失时为空串） */
  section: string
  /** 归一后的完整字符串（原样落进 frontmatter） */
  raw: string
}

const EMPTY: SourceRef = { material: '', chapter: '', chapterTitle: '', section: '', raw: '' }

/** 全角数字 → 半角（`第２章` 这类写法在中文输入法下很常见） */
function toHalfWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/** 折叠空白：连续空白 → 一个空格，去首尾 */
function squeeze(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 归一 `来源章节`：
 *
 * ```
 * 《计算方法》第 2 章　线性方程组数值解法／2.1 节   →  《计算方法》第2章 线性方程组数值解法 / 2.1节
 * 《算法设计与分析》第6章 动态规划                 →  《算法设计与分析》第6章 动态规划
 * ```
 *
 * 无法识别出「第N章」时：原文折叠空白后返回（`chapter` 等为空），不抛错。
 */
export function normalizeSourceSection(input: string): SourceRef {
  // 全角斜杠 → 半角；全角数字 → 半角；空白折叠（`第 2 章` 与 `第2章` 同义）
  const raw = squeeze(toHalfWidthDigits(String(input ?? '').replace(/／/g, '/')))
  if (!raw) return { ...EMPTY }

  const chapterMatch = /第\s*(\d+)\s*章/.exec(raw)
  if (!chapterMatch) return { ...EMPTY, raw }

  const chapter = chapterMatch[1]
  const beforeChapter = raw.slice(0, chapterMatch.index)
  const afterChapter = raw.slice(chapterMatch.index + chapterMatch[0].length)

  // 资料名：优先取 `《…》`；否则取章号之前的裸文本（去掉尾随分隔符）
  const materialMatch = /《([^》]*)》/.exec(beforeChapter)
  const material = materialMatch ? squeeze(materialMatch[1]) : squeeze(beforeChapter.replace(/[-—·:：,，、]+$/, ''))

  // 章标题与节号：以 `/` 切分（有节号时），否则整体都是章标题
  const slashAt = afterChapter.indexOf('/')
  const titlePart = slashAt === -1 ? afterChapter : afterChapter.slice(0, slashAt)
  const sectionPart = slashAt === -1 ? '' : afterChapter.slice(slashAt + 1)

  const sectionMatch = /(\d+(?:\.\d+)*)\s*节?/.exec(sectionPart)
  const section = sectionMatch ? sectionMatch[1] : ''
  // 节号文本可能还带说明（如 `2.1节 高斯消元`），保留在章标题之外的部分不做解析
  const chapterTitle = squeeze(titlePart)

  const normalized = [`《${material}》第${chapter}章`, chapterTitle].filter(Boolean).join(' ')
  const tail = section ? ` / ${section}节` : ''
  const raw2 = material ? `${normalized}${tail}` : `${`第${chapter}章 ${chapterTitle}`.trim()}${tail}`

  return { material, chapter, chapterTitle, section, raw: raw2 }
}

/** 归一后的字符串；识别不出「第N章」时返回原文折叠结果（保留用户写法） */
export function normalizeSourceSectionText(input: string): string {
  return normalizeSourceSection(input).raw
}

/** 是否可参与覆盖度聚合（能切出资料名与章号的才算） */
export function isSourceRefComplete(ref: SourceRef): boolean {
  return Boolean(ref.material && ref.chapter)
}
