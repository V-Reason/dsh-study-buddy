import { describe, expect, test } from 'vitest'
import { formatOverview, summarizeOverview, type OverviewNote } from '../src/overview.ts'

/**
 * 阶段 5 用例：覆盖度总览（需求 R15）。
 *
 * 最要紧的一条口径是**不虚构章节**：完整性只由笔记里真实出现的章节号构成，
 * 缺口只给"未归类"与"节号跳号"，绝不替用户断言"资料应该有第 3 章"。
 */

const ROOT = '计算机通识/计算方法/第2章 线性方程组数值解法'
const SRC = '《计算方法》第2章 线性方程组数值解法'

function note(title: string, sourceSection: string | null, kind: OverviewNote['kind'] = 'block', rel = ''): OverviewNote {
  return { title, sourceSection, kind, rel: rel || `${ROOT}/${title}.md` }
}

describe('summarizeOverview 聚合', () => {
  test('按 资料 → 章 → 节 分组，节号按数值排序', () => {
    const result = summarizeOverview([
      note('高斯消元法', `${SRC} / 2.1节`),
      note('列主元消元', `${SRC} / 2.2节`),
      note('范数', `${SRC} / 2.10节`),
    ])
    expect(result.counted).toBe(3)
    expect(result.chapters).toHaveLength(1)
    const chapter = result.chapters[0]
    expect(chapter.material).toBe('计算方法')
    expect(chapter.chapter).toBe('2')
    expect(chapter.chapterTitle).toBe('线性方程组数值解法')
    // 2.10 排在 2.2 之后（按数值，不按字符串）
    expect(chapter.sections).toEqual(['2.1', '2.2', '2.10'])
    expect(chapter.entries.map((e) => e.title)).toEqual(['高斯消元法', '列主元消元', '范数'])
  })

  test('同资料多章、多资料各自分组；materials 汇总章号', () => {
    const result = summarizeOverview([
      note('误差', '《计算方法》第1章 误差与有效数字 / 1.1节', 'block', 'a/误差.md'),
      note('高斯消元法', `${SRC} / 2.1节`),
      note('递归', '《算法设计与分析》第3章 递归 / 3.1节', 'block', 'b/递归.md'),
    ])
    expect(result.chapters.map((c) => `${c.material}-${c.chapter}`)).toEqual(['计算方法-1', '计算方法-2', '算法设计与分析-3'])
    expect(result.materials).toEqual([
      { material: '计算方法', chapters: ['1', '2'] },
      { material: '算法设计与分析', chapters: ['3'] },
    ])
  })

  test('不虚构章节：缺失的章号不会被补出来（只出现真实记录的章）', () => {
    const result = summarizeOverview([
      note('递归', '《算法设计与分析》第3章 递归', 'block', 'b/递归.md'),
      note('动态规划', '《算法设计与分析》第6章 动态规划', 'block', 'b/dp.md'),
    ])
    expect(result.materials[0].chapters).toEqual(['3', '6'])
    expect(formatOverview(result)).not.toContain('第4章')
    expect(formatOverview(result)).not.toContain('第5章')
  })

  test('节号跳号只做提示，不补节号', () => {
    const result = summarizeOverview([
      note('甲', `${SRC} / 2.1节`),
      note('乙', `${SRC} / 2.3节`),
    ])
    expect(result.chapters[0].gaps).toEqual(['2.1 → 2.3'])
    const text = formatOverview(result)
    expect(text).toContain('⚠ 节号跳号：2.1 → 2.3')
    expect(text).toContain('不代表资料真的缺节')
  })

  test('无节号 / 无法解析 / 缺 来源章节 → 未归类（不丢、不计入统计）', () => {
    const result = summarizeOverview([
      note('有章无节', '《计算方法》第3章 非线性方程求根', 'block', 'a/x.md'),
      note('解析不出', '随手写的一句话', 'block', 'a/y.md'),
      note('缺来源章节', null, 'legacy', 'a/z.md'),
    ])
    expect(result.counted).toBe(1)
    expect(result.chapters[0].chapter).toBe('3')
    expect(result.chapters[0].sections).toEqual([])
    expect(result.unclassified.map((u) => u.title)).toEqual(['解析不出', '缺来源章节'])
    expect(formatOverview(result)).toContain('### 未归类 2 篇')
  })

  test('旧笔记（kind=note）不参与也不进未归类', () => {
    const result = summarizeOverview([
      note('旧笔记', null, 'note', '随手/旧.md'),
      note('块', `${SRC} / 2.1节`),
    ])
    expect(result.counted).toBe(1)
    expect(result.unclassified).toEqual([])
  })

  test('material 过滤只留指定资料', () => {
    const notes = [
      note('误差', '《计算方法》第1章 误差与有效数字 / 1.1节', 'block', 'a/误差.md'),
      note('递归', '《算法设计与分析》第3章 递归 / 3.1节', 'block', 'b/递归.md'),
    ]
    const only = summarizeOverview(notes, { material: '计算方法' })
    expect(only.chapters).toHaveLength(1)
    expect(only.chapters[0].material).toBe('计算方法')
    expect(only.unclassified).toEqual([])
  })

  test('全角/空格写法归一后仍能归组（归一不收钱）', () => {
    const result = summarizeOverview([
      note('甲', '《计算方法》第 2 章　线性方程组数值解法 ／ 2.1 节'),
      note('乙', `${SRC} / 2.2节`),
    ])
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0].sections).toEqual(['2.1', '2.2'])
  })

  test('空输入：明确写"还没有带 ID 的笔记"', () => {
    const result = summarizeOverview([])
    expect(result.counted).toBe(0)
    expect(formatOverview(result)).toContain('还没有带 ID 的笔记')
  })
})
