/**
 * 覆盖度总览：把一组笔记按 `来源章节` 聚合成「资料 → 章 → 节」的视图。
 *
 * 需求 R15 的口径：**不虚构章节**。完整性基线只由两件事构成——笔记里真实出现
 * 过的章节号，以及用户在《笔记期望.md》里声明的资料；因此这里只做聚合与
 * "跳号提示"，绝不去猜"这门课应该有 9 章"。
 *
 * 无法解析的条目进"未归类"而不是被丢掉：用户能看到是哪几篇需要补 `来源章节`。
 * @module overview
 */

import { compareText } from './order.ts'
import { normalizeSourceSection } from './sourceSection.ts'

/** 输入：一篇待聚合的笔记（由调用方从目录遍历或索引给出） */
export interface OverviewNote {
  title: string
  rel: string
  /** `来源章节` 原文（缺失/无法解析 → 未归类） */
  sourceSection: string | null
  /** 只有块（有 ID）参与覆盖度；存量卡与旧笔记由调用方过滤或标记 */
  kind: string
}

export interface OverviewEntry {
  title: string
  rel: string
  section: string
}

export interface OverviewChapter {
  material: string
  chapter: string
  chapterTitle: string
  entries: OverviewEntry[]
  /** 该章出现过的节号（去重升序，按数值） */
  sections: string[]
  /** 节号跳号提示（只提示，不断言资料缺节） */
  gaps: string[]
}

export interface OverviewResult {
  chapters: OverviewChapter[]
  /** 无法归入任何章节的笔记（缺 `来源章节` 或写法解析不出） */
  unclassified: Array<{ title: string; rel: string }>
  /** 每份资料已记录的章号（升序） */
  materials: Array<{ material: string; chapters: string[] }>
  /** 参与统计的笔记数（不含未归类与旧笔记） */
  counted: number
}

/** 节号排序键：`2.10` 要排在 `2.9` 之后（按数值逐段比较，不按字符串） */
function sectionKey(section: string): number[] {
  return section.split('.').map((n) => Number(n)).map((n) => (Number.isFinite(n) ? n : 0))
}

function compareSection(a: string, b: string): number {
  const ka = sectionKey(a)
  const kb = sectionKey(b)
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0)
    if (d !== 0) return d
  }
  return compareText(a, b)
}

/** 节号跳号：只在**同一父节**下相邻出现间隔 > 1 时提示（`2.1 → 2.3`） */
function gapsOf(sections: string[]): string[] {
  const gaps: string[] = []
  const byParent = new Map<string, number[]>()
  for (const section of sections) {
    const parts = section.split('.')
    const parent = parts.slice(0, -1).join('.')
    const last = Number(parts.at(-1))
    if (!Number.isFinite(last)) continue
    const list = byParent.get(parent) ?? []
    list.push(last)
    byParent.set(parent, list)
  }
  for (const [parent, list] of byParent) {
    const sorted = [...new Set(list)].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > 1) {
        const head = parent ? `${parent}.` : ''
        gaps.push(`${head}${sorted[i - 1]} → ${head}${sorted[i]}`)
      }
    }
  }
  return gaps
}

/**
 * 聚合。
 *
 * @param notes 候选笔记（调用方可先按目录/资料过滤）
 * @param opts.material 只统计某份资料（其余资料不参与，也不进"未归类"）
 */
export function summarizeOverview(notes: OverviewNote[], opts: { material?: string } = {}): OverviewResult {
  const groups = new Map<string, OverviewChapter>()
  const unclassified: Array<{ title: string; rel: string }> = []
  const materialChapters = new Map<string, Set<string>>()
  let counted = 0

  for (const note of notes) {
    // 只有块（有 ID 且有来源章节）参与覆盖度；存量卡与旧笔记另行标注
    if (note.kind === 'note') continue
    const ref = note.sourceSection ? normalizeSourceSection(note.sourceSection) : null
    if (!ref || !ref.material || !ref.chapter) {
      unclassified.push({ title: note.title, rel: note.rel })
      continue
    }
    if (opts.material && ref.material !== opts.material) continue
    counted += 1
    const key = `${ref.material}\u0000${ref.chapter}\u0000${ref.chapterTitle}`
    const group = groups.get(key) ?? {
      material: ref.material,
      chapter: ref.chapter,
      chapterTitle: ref.chapterTitle,
      entries: [],
      sections: [],
      gaps: [],
    }
    group.entries.push({ title: note.title, rel: note.rel, section: ref.section })
    groups.set(key, group)
    const set = materialChapters.get(ref.material) ?? new Set<string>()
    set.add(ref.chapter)
    materialChapters.set(ref.material, set)
  }

  const chapters = [...groups.values()]
    .map((group) => {
      const sections = [...new Set(group.entries.map((e) => e.section).filter(Boolean))].sort(compareSection)
      return {
        ...group,
        entries: group.entries.sort((a, b) => compareSection(a.section, b.section) || compareText(a.title, b.title)),
        sections,
        gaps: gapsOf(sections),
      }
    })
    .sort((a, b) => compareText(a.material, b.material) || compareSection(a.chapter, b.chapter))

  const materials = [...materialChapters.entries()]
    .map(([material, set]) => ({ material, chapters: [...set].sort(compareSection) }))
    .sort((a, b) => compareText(a.material, b.material))

  return { chapters, unclassified, materials, counted }
}

/** 渲染成对话可读的报告（工具直接返回它） */
export function formatOverview(result: OverviewResult, opts: { scope?: string } = {}): string {
  const lines: string[] = [`## 覆盖情况（${opts.scope || '整个库'}）`, '']
  if (result.chapters.length === 0 && result.unclassified.length === 0) {
    lines.push('该范围内还没有带 ID 的笔记。')
    return lines.join('\n')
  }
  lines.push(`已统计 ${result.counted} 篇（按 \`来源章节\` 聚合）`, '')
  for (const chapter of result.chapters) {
    const sectionText = chapter.sections.length > 0 ? `（节：${chapter.sections.join('、')}）` : ''
    lines.push(`《${chapter.material}》第${chapter.chapter}章 ${chapter.chapterTitle}——${chapter.entries.length} 篇${sectionText}`)
    for (const entry of chapter.entries) lines.push(`  - ${entry.title}（${entry.rel}）`)
    for (const gap of chapter.gaps) {
      lines.push(`  ⚠ 节号跳号：${gap}（按你的书写口径统计，不代表资料真的缺节）`)
    }
  }
  if (result.materials.length > 0) {
    lines.push('')
    for (const item of result.materials) lines.push(`- 《${item.material}》：已记录第 ${item.chapters.join('、')} 章`)
  }
  if (result.unclassified.length > 0) {
    lines.push('', `### 未归类 ${result.unclassified.length} 篇（缺 来源章节 或写法无法解析）`)
    for (const item of result.unclassified) lines.push(`- ${item.title}（${item.rel}）`)
    lines.push('（未归类不参与覆盖度统计；补齐 `来源章节` 后即计入）')
  }
  return lines.join('\n')
}
