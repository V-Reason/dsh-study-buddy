import { describe, expect, test } from 'vitest'
import {
  LINKS_SECTION, LINK_LABELS, VALID_STATUS, appendToSection, applyUpdate, findLinksSectionStart,
  generateId, inverseKind, parseLinkLine, renderNote, todayLocal, validateBlock, validateSummary, wikilinkOf,
} from '../src/note.ts'
import { addLink, linkTargetOf, listLinks, parseLinkTarget, removeLink } from '../src/links.ts'
import { normalizeSourceSection, normalizeSourceSectionText } from '../src/sourceSection.ts'

/**
 * 阶段 3 用例：笔记块契约（note / links / sourceSection）。
 *
 * 与旧 `card.spec` 的区别就是本轮重构本身：
 * - **模板类断言全部删除**（不再有必填小节、分型、模板推断）；
 * - **字数硬上限断言删除**（`简介` 无上限，只拒换行）；
 * - 新增 `来源章节` 归一、wikilink 关联、三动作更新（append/replace/definition）。
 */

const BASE = {
  title: '高斯消元法',
  source: '《计算方法》',
  content: '## 直接法\n\n用初等行变换把系数矩阵化为上三角。',
}

describe('note 块契约', () => {
  test('generateId / todayLocal 同源（本地时区）', () => {
    const now = new Date('2026-10-24T09:05:00')
    expect(generateId(now)).toMatch(/^202610240905_[0-9a-f]{6}$/)
    expect(todayLocal(now)).toBe('2026-10-24')
    expect(VALID_STATUS).toEqual(['草稿', '已确认', '需更新'])
  })

  test('validateBlock：必填项、状态枚举、标签空白、顺序数字', () => {
    expect(validateBlock(BASE).errors).toEqual([])
    expect(validateBlock({ ...BASE, title: '' }).errors.join()).toContain('title 不能为空')
    expect(validateBlock({ ...BASE, title: '带\n换行' }).errors.join()).toContain('title 不能包含换行')
    expect(validateBlock({ ...BASE, source: ' ' }).errors.join()).toContain('source（资料名称）不能为空')
    expect(validateBlock({ ...BASE, status: '随便' }).errors.join()).toContain('status 必须是 草稿/已确认/需更新 之一')
    expect(validateBlock({ ...BASE, status: undefined }).errors).toEqual([]) // 缺省草稿
    expect(validateBlock({ ...BASE, tags: ['线 性代数'] }).errors.join()).toContain('含空白字符')
    expect(validateBlock({ ...BASE, content: '  ' }).errors.join()).toContain('content（正文）不能为空')
    expect(validateBlock({ ...BASE, order: Number.NaN }).errors.join()).toContain('顺序 必须是数字')
  })

  test('简介 没有长度上限，只拒绝换行（需求 R7：解除字数约束）', () => {
    const long = '这是一句非常长的定位说明'.repeat(12) // 144 字，远超旧的 60 字硬上限
    expect(validateSummary(long).errors).toEqual([])
    expect(validateBlock({ ...BASE, summary: long }).errors).toEqual([])
    expect(validateSummary('两行\n说明').errors.join()).toContain('不能包含换行')
  })

  test('renderNote：frontmatter 键序固定、来源章节归一、简介缺省从正文引用块提取', () => {
    const text = renderNote({
      id: '202610240905_ab12cd',
      ...BASE,
      domain: '计算方法-线性方程组',
      tags: ['线性代数'],
      status: '已确认',
      sourceSection: '《计算方法》第 2 章　线性方程组数值解法 ／ 2.1 节',
      order: 3,
    })
    expect(text).toContain('ID: 202610240905_ab12cd')
    expect(text).toContain('领域: #计算方法-线性方程组 #线性代数')
    expect(text).toContain('来源章节: 《计算方法》第2章 线性方程组数值解法 / 2.1节')
    expect(text).toContain('顺序: 3')
    // 简介缺省时从正文首个引用块提取，且**不再另写一遍**（否则同一句话连着出现两次）
    const withLead = renderNote({ id: 'y', ...BASE, content: '> 化上三角后回代\n\n## 直接法\n\n正文。' })
    expect(withLead).toContain('简介: 化上三角后回代')
    expect(withLead.match(/^> 化上三角后回代$/gm)).toHaveLength(1)
    // 显式传 summary 时才前置引用块（正文里没有定位时仍会补上）
    const explicit = renderNote({ id: 'y', ...BASE, summary: '化上三角后回代', content: '## 直接法\n\n正文。' })
    expect(explicit).toContain('简介: 化上三角后回代')
    expect(explicit.match(/^> 化上三角后回代$/gm)).toHaveLength(1)
    // 旧笔记形态 `> 概念: …` 仍优先取概念行，此时正文自带的引用块保留（不回归）
    const concept = renderNote({ id: 'y', ...BASE, content: '> 概念: 迭代器是一种设计模式\n\n正文。' })
    expect(concept).toContain('简介: 迭代器是一种设计模式')
    expect(concept).toContain('> 概念: 迭代器是一种设计模式')
    // 键序：ID → 标题 → 领域 → 来源 → 状态 → 来源章节 → 顺序 → 简介
    const keys = [...text.matchAll(/^([^:\n]+):/gm)].map((m) => m[1])
    expect(keys.indexOf('标题')).toBeLessThan(keys.indexOf('领域'))
    expect(keys.indexOf('状态')).toBeLessThan(keys.indexOf('来源章节'))
    expect(keys.indexOf('来源章节')).toBeLessThan(keys.indexOf('顺序'))
  })

  test('renderNote：有关联时写「关联」小节，wikilink 目标已清洗', () => {
    const text = renderNote({ id: 'x', ...BASE, links: { prev: ['[[列主元消元]]'], next: ['[[LU 分解]]'] } })
    expect(text).toContain(`### ${LINKS_SECTION}`)
    expect(text).toContain('- 前置：[[列主元消元]]')
    expect(text).toContain('- 后续：[[LU 分解]]')
    expect(LINKS_SECTION).toBe('关联')
    expect(findLinksSectionStart(text)).toBeGreaterThan(0)
  })

  test('wikilinkOf 清洗会截断链接的字符（SEC-3）', () => {
    expect(wikilinkOf('高斯消元法.md')).toBe('[[高斯消元法]]')
    expect(wikilinkOf('A]]B.md')).toBe('[[A B]]')
    expect(wikilinkOf('带|管道.md')).toBe('[[带 管道]]')
  })

  test('inverseKind：prev↔next 互反，sibling 两侧同向', () => {
    expect(inverseKind('prev')).toBe('next')
    expect(inverseKind('next')).toBe('prev')
    expect(inverseKind('sibling')).toBe('sibling')
    expect(LINK_LABELS).toEqual({ prev: '前置', next: '后续', sibling: '兄弟' })
  })
})

describe('note 更新动作（append / replace / definition）', () => {
  const RAW = [
    '---',
    'ID: 202610240905_ab12cd',
    '标题: 高斯消元法',
    '来源: 《计算方法》',
    '状态: 已确认',
    '来源章节: 《计算方法》第2章 线性方程组数值解法 / 2.1节',
    '简介: 初等行变换化上三角后回代',
    '---',
    '',
    '> 初等行变换化上三角后回代',
    '',
    '## 直接法',
    '',
    '主元非零时逐列消元。',
    '',
    '### 关联',
    '- 前置：[[矩阵与向量]]',
    '',
  ].join('\n')

  test('appendToSection：命中已有小节 -> 追加到小节末尾；未命中 -> 新建小节', () => {
    const hit = appendToSection('## 甲\n\n原内容', '甲', '新增内容')
    expect(hit).toBe('## 甲\n\n原内容\n\n新增内容')
    const miss = appendToSection('## 甲\n\n原内容', '乙', '新增内容')
    expect(miss).toBe('## 甲\n\n原内容\n\n### 乙\n新增内容')
  })

  test('append：补充内容不改旧内容，也不产生历史块', () => {
    const result = applyUpdate(RAW, '202610240905_ab12cd', { action: 'append', changes: '主元为 0 时需换行。' })
    expect(result.text).toContain('主元非零时逐列消元。')
    expect(result.text).toContain('主元为 0 时需换行。')
    expect(result.text).not.toContain('<details>')
    expect(result.text).not.toContain('版本更新')
    expect(result.text).toContain('- 前置：[[矩阵与向量]]')
    expect(result.warnings).toEqual([])
    expect(() => applyUpdate(RAW, 'x', { action: 'append' })).toThrow('append 需要 changes 内容')
  })

  test('append 指定小节：内容落进该小节而不是文末', () => {
    const result = applyUpdate(RAW, 'x', { action: 'append', section: '直接法', changes: '补充一句。' })
    const at = result.text.indexOf('补充一句。')
    expect(at).toBeGreaterThan(result.text.indexOf('主元非零时逐列消元。'))
    expect(at).toBeLessThan(result.text.indexOf('### 关联'))
  })

  test('definition：只替换首个引用块，正文与关联不动', () => {
    const result = applyUpdate(RAW, 'x', { action: 'definition', summary: '新的定位' })
    expect(result.text).toContain('> 新的定位')
    expect(result.text).not.toContain('> 初等行变换化上三角后回代')
    expect(result.text).toContain('主元非零时逐列消元。')
    expect(result.text).toContain('- 前置：[[矩阵与向量]]')
    expect(() => applyUpdate(RAW, 'x', { action: 'definition', summary: '' })).toThrow('definition 需要 summary')
    expect(() => applyUpdate('---\nID: x\n---\n正文没有引用块', 'x', { action: 'definition', summary: 's' }))
      .toThrow('要求正文首行为引用块')
  })

  test('replace：整篇替换、不产生 <details> 历史块（旧正文由调用方先存档）', () => {
    const result = applyUpdate(RAW, '202610240905_ab12cd', {
      action: 'replace',
      block: { title: '高斯消元法', source: '《计算方法》', content: '## 重写\n\n新正文。' },
    })
    expect(result.text).toContain('新正文。')
    expect(result.text).not.toContain('主元非零时逐列消元。')
    expect(result.text).not.toContain('<details>')
    expect(result.text).toContain('ID: 202610240905_ab12cd') // ID 沿用
    expect(result.text).toContain('来源章节: 《计算方法》第2章 线性方程组数值解法 / 2.1节') // 旧值保留
    expect(() => applyUpdate(RAW, 'x', { action: 'replace' })).toThrow('replace 需要 block')
  })

  test('未知动作报错且列出可用值', () => {
    // @ts-expect-error 故意传非法动作，验证 fail-loud
    expect(() => applyUpdate(RAW, 'x', { action: 'sideways' })).toThrow('可用：append / replace / definition')
  })
})

describe('links 关联维护（wikilink）', () => {
  test('linkTargetOf：剥 ID 后缀、去 .md、清洗截断字符', () => {
    expect(linkTargetOf('高斯消元法（202610240905_ab12cd）')).toBe('高斯消元法')
    expect(linkTargetOf('工作目录/子目录/旧笔记.md')).toBe('工作目录/子目录/旧笔记')
    expect(linkTargetOf('[[列主元消元]]')).toBe('列主元消元')
  })

  test('addLink：无关联小节 -> 新建；重复 -> 原样返回（不重复添加）', () => {
    const once = addLink('# 甲\n\n正文', 'prev', '矩阵与向量')
    expect(once).toContain('### 关联\n- 前置：[[矩阵与向量]]')
    const twice = addLink(once, 'prev', '矩阵与向量')
    expect(twice).toBe(once)
    // 同一目标写成不同形式（带 ID、带 .md）仍判为重复
    expect(addLink(once, 'prev', '矩阵与向量（202601010000_abcdef）')).toBe(once)
    expect(addLink(once, 'prev', '矩阵与向量.md')).toBe(once)
  })

  test('addLink：已有小节时插在标题行之后，且不粘行（N4）', () => {
    const raw = '正文\n\n### 关联'
    const next = addLink(raw, 'next', 'LU 分解')
    expect(next).toContain('### 关联\n- 后续：[[LU 分解]]')
    expect(next).not.toContain('### 关联- 后续')
  })

  test('addLink：判重只看「关联」小节，正文里的同名行不算已关联', () => {
    // 正文有 `- 前置：矩阵与向量`（不在关联小节）时，仍必须真的写入关联
    const raw = '## 前置检查\n- 前置：矩阵与向量\n\n### 关联\n'
    const next = addLink(raw, 'prev', '矩阵与向量')
    expect(next).toContain('- 前置：[[矩阵与向量]]')
  })

  test('removeLink：删掉目标行；小节空了连标题一起删', () => {
    const raw = '正文\n\n### 关联\n- 前置：[[甲]]\n- 后续：[[乙]]\n'
    const one = removeLink(raw, '甲')
    expect(one).not.toContain('[[甲]]')
    expect(one).toContain('- 后续：[[乙]]')
    expect(one).toContain('### 关联')
    const both = removeLink(one, '乙')
    expect(both).not.toContain('### 关联')
    expect(both.trim()).toBe('正文')
    expect(removeLink(raw, '不存在的目标')).toBe(raw)
  })

  test('parseLinkTarget / listLinks：解析与列出关联行', () => {
    expect(parseLinkTarget('- 前置：[[甲]]')).toBe('甲')
    expect(parseLinkTarget('- 兄弟：甲（202601010000_abcdef）')).toBe('甲')
    expect(parseLinkTarget('普通正文行')).toBeNull()
    const lines = listLinks('### 关联\n- 前置：[[甲]]\n- 兄弟：[[乙]]\n无关行')
    expect(lines.map((l) => `${l.kind}:${l.target}`)).toEqual(['prev:甲', 'sibling:乙'])
    expect(lines[0].line).toBe(2)
  })

  test('parseLinkLine：兼容旧的「易混淆」写法（读得懂，不再新写）', () => {
    expect(parseLinkLine('- 易混淆：[[甲]]')).toEqual({ kind: 'sibling', target: '[[甲]]' })
    expect(parseLinkLine('- 后续：[[乙]]')).toEqual({ kind: 'next', target: '[[乙]]' })
    expect(parseLinkLine('正文')).toBeNull()
  })
})

describe('sourceSection 归一（覆盖度数据源）', () => {
  test('标准写法：资料名 + 章 + 节', () => {
    const ref = normalizeSourceSection('《计算方法》第2章 线性方程组数值解法 / 2.1节')
    expect(ref).toEqual({
      material: '计算方法',
      chapter: '2',
      chapterTitle: '线性方程组数值解法',
      section: '2.1',
      raw: '《计算方法》第2章 线性方程组数值解法 / 2.1节',
    })
  })

  test('归一：全角数字、全角斜杠、`第 2 章` 的空格、多余空白', () => {
    expect(normalizeSourceSectionText('《计算方法》第 ２ 章　线性方程组数值解法 ／ 2.1 节'))
      .toBe('《计算方法》第2章 线性方程组数值解法 / 2.1节')
    expect(normalizeSourceSectionText('《算法设计与分析》第6章  动态规划')).toBe('《算法设计与分析》第6章 动态规划')
  })

  test('无节号时合法；资料名可省略（用章号前的裸文本）', () => {
    expect(normalizeSourceSection('《算法》第9章 NP-完全问题').section).toBe('')
    expect(normalizeSourceSection('计算方法 第1章 误差').material).toBe('计算方法')
    expect(normalizeSourceSection('第3章 递归').material).toBe('')
  })

  test('识别不出「第N章」时不报错：原文折叠后保留（进总览的"未归类"）', () => {
    const ref = normalizeSourceSection('随手写的一句话')
    expect(ref.chapter).toBe('')
    expect(ref.raw).toBe('随手写的一句话')
    expect(normalizeSourceSection('').raw).toBe('')
  })
})
