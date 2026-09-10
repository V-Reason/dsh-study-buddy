import { describe, expect, test } from 'vitest'
import {
  cardTitleOf, detectBrokenLinks, formatRenameReport, planRename, replaceCardTitle, rewriteCardLinks, rewriteWikilinks,
} from '../src/rename.ts'

const CARD = [
  '---',
  'ID: 202609092139_92d2',
  '标题: URP IBL 接入',
  '领域: #图形学-光照模型',
  '来源: URP 文档',
  '状态: 已确认',
  '---',
  '',
  '> IBL 接入 = 环境侧喂数据 + shader 两行采样。',
  '',
  '### 核心思想',
  '环境侧喂数据。',
  '',
  '### 关联卡片',
  '- 前置：`间接光在实时渲染中的两个通道`（202609092139_2c27）',
  '- 后续：`URP IBL 接入`（202609092139_92d2）',
  '- 易混淆：`直接光`（202609092139_aaaa）',
].join('\n')

describe('rename 改名与入链重写', () => {
  test('replaceCardTitle：只改标题，其余字段与正文原样保留', () => {
    const next = replaceCardTitle(CARD, 'URP IBL 接入与探针')
    expect(next).toContain('标题: URP IBL 接入与探针')
    expect(next).toContain('ID: 202609092139_92d2')
    expect(next).toContain('领域: #图形学-光照模型')
    expect(next).toContain('> IBL 接入 = 环境侧喂数据')
    expect(next).toContain('- 前置：`间接光在实时渲染中的两个通道`')
    expect(next).not.toContain('标题: URP IBL 接入\n')
  })

  test('cardTitleOf：frontmatter 优先，回退正文一级标题', () => {
    expect(cardTitleOf(CARD)).toBe('URP IBL 接入')
    expect(cardTitleOf('# 裸标题\n正文')).toBe('裸标题')
    expect(cardTitleOf('没有标题')).toBe('')
  })

  test('rewriteCardLinks：按 ID 命中改标题（ID 是可靠锚点）', () => {
    const result = rewriteCardLinks(CARD, { oldTitle: 'URP IBL 接入', newTitle: 'URP IBL 接入与探针', targetId: '202609092139_92d2' })
    expect(result.changed).toBe(1)
    expect(result.text).toContain('- 后续：`URP IBL 接入与探针`（202609092139_92d2）')
    expect(result.text).toContain('- 前置：`间接光在实时渲染中的两个通道`（202609092139_2c27）')
    expect(result.samples[0]).toContain('→')
  })

  test('rewriteCardLinks：无 ID 时按反引号标题字面量改写（旧笔记按路径寻址）', () => {
    const raw = '### 关联卡片\n- 后续：`旧标题`（工作目录/旧笔记.md）\n- 前置：`无关`（x）'
    const result = rewriteCardLinks(raw, { oldTitle: '旧标题', newTitle: '新标题' })
    expect(result.changed).toBe(1)
    expect(result.text).toContain('`新标题`（工作目录/旧笔记.md）')
    expect(result.text).toContain('`无关`（x）')
  })

  test('rewriteCardLinks：不误改正文里的标题出现（只动关联块的行）', () => {
    const raw = '### 核心思想\nURP IBL 接入 的关键是查表。\n\n### 关联卡片\n- 后续：`URP IBL 接入`（202609092139_92d2）'
    const result = rewriteCardLinks(raw, { oldTitle: 'URP IBL 接入', newTitle: '新名字', targetId: '202609092139_92d2' })
    expect(result.text).toContain('### 核心思想\nURP IBL 接入 的关键是查表。')
    expect(result.text).toContain('- 后续：`新名字`（202609092139_92d2）')
  })

  test('rewriteWikilinks：支持别名与锚点', () => {
    const text = '- [[URP IBL 接入]]（id）· 标题\n- [[URP IBL 接入|别名]]\n- [[URP IBL 接入#重入点]]\n- [[别的]]'
    const result = rewriteWikilinks(text, 'URP IBL 接入', 'URP IBL 接入与探针')
    expect(result.changed).toBe(3)
    expect(result.text).toContain('[[URP IBL 接入与探针]]')
    expect(result.text).toContain('[[URP IBL 接入与探针|别名]]')
    expect(result.text).toContain('[[URP IBL 接入与探针#重入点]]')
    expect(result.text).toContain('[[别的]]')
  })

  test('detectBrokenLinks：旧标题残留与格式漂移', () => {
    const raw = [
      '### 关联卡片',
      '- 后续：`URP IBL 接入`（202609092139_92d2）',
      '- 前置知识：裸标题',
      '- 前置：`正常`（id2）',
    ].join('\n')
    const hits = detectBrokenLinks(raw, { oldTitle: 'URP IBL 接入', oldId: '202609092139_92d2' })
    // 带 ID 的旧标题行不算断链（ID 仍可寻址）
    expect(hits.map((h) => h.reason)).toEqual(['关联行格式不符（应为 "- 标签：`标题`（ID）"）'])
    const orphan = detectBrokenLinks('### 关联卡片\n- 后续：`URP IBL 接入`', { oldTitle: 'URP IBL 接入' })
    expect(orphan[0].reason).toContain('仍指向旧标题')
  })

  test('planRename：文件名与旧标题一致才同步改名', () => {
    expect(planRename({ fileName: 'URP IBL 接入.md', oldTitle: 'URP IBL 接入', newTitle: 'URP IBL 接入与探针' }))
      .toMatchObject({ renameFile: true, newBase: 'URP IBL 接入与探针' })
    expect(planRename({ fileName: '旧文件.md', oldTitle: 'URP IBL 接入', newTitle: '新标题' }))
      .toMatchObject({ renameFile: false })
    expect(planRename({ fileName: '标题.md', oldTitle: '标题', newTitle: '标题' }))
      .toMatchObject({ renameFile: false })
    // 新标题含非法字符 → 清洗后作为文件名
    expect(planRename({ fileName: '旧标题.md', oldTitle: '旧标题', newTitle: 'A/B:C' }))
      .toMatchObject({ renameFile: true, newBase: 'A B C' })
    // N13：既存文件名含已废弃字符（`[]`）时同口径归一后再比，仍同步改名
    expect(planRename({ fileName: 'A[B].md', oldTitle: 'A[B]', newTitle: 'C' }))
      .toMatchObject({ renameFile: true, oldBase: 'A[B]', newBase: 'C' })
  })

  test('formatRenameReport：dryRun 标记、改动清单与断链', () => {
    const plan = planRename({ fileName: 'URP IBL 接入.md', oldTitle: 'URP IBL 接入', newTitle: 'URP IBL 接入与探针' })
    const text = formatRenameReport({
      id: 'id1',
      oldTitle: 'URP IBL 接入',
      newTitle: 'URP IBL 接入与探针',
      plan,
      filesChanged: [{ rel: '游戏开发/图形学/x.md', kind: '关联卡片', changed: 1, samples: ['a → b'] }],
      broken: [{ line: 12, text: '- 前置知识：A', reason: '关联行格式不符' }],
      dryRun: true,
    })
    expect(text).toContain('[dryRun]')
    expect(text).toContain('URP IBL 接入.md → URP IBL 接入与探针.md')
    expect(text).toContain('游戏开发/图形学/x.md')
    expect(text).toContain('断链检测：1 处')
  })
})
