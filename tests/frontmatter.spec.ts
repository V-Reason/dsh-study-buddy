import { describe, expect, test } from 'vitest'
import { extractDefinition, firstHeading, parseFrontmatter, renderFrontmatter } from '../src/frontmatter.ts'

const CARD = `---
ID: 202608161430_ab12
标题: 透视投影矩阵的三步分解
领域: #图形学与渲染 #线性代数
来源: GAMES101 L04
状态: 草稿
---

### 定义（一句话总结）
> 透视投影矩阵可拆为缩放、平移与齐次除三步

### 核心内容
推导正文……

### 关联卡片
- 前置知识：正交投影
- 后续延伸：光栅化
- 冲突/易混淆：正交投影矩阵
`

describe('frontmatter', () => {
  test('parseCardFields', () => {
    const parsed = parseFrontmatter(CARD)
    expect(parsed.meta).toEqual({
      id: '202608161430_ab12',
      title: '透视投影矩阵的三步分解',
      domain: '#图形学与渲染 #线性代数',
      source: 'GAMES101 L04',
      status: '草稿',
    })
    expect(parsed.body).toContain('### 核心内容')
    expect(parsed.body).not.toContain('ID: 202608161430')
  })

  test('noFrontmatter', () => {
    const parsed = parseFrontmatter('# 迭代器\n正文')
    expect(parsed.meta).toBeNull()
    expect(parsed.body).toBe('# 迭代器\n正文')
  })

  test('emptyFrontmatterFieldsGiveEmptyMeta', () => {
    const parsed = parseFrontmatter('---\n未知字段: x\n---\n正文')
    expect(parsed.meta).toEqual({})
  })

  // 2026-10 文档式笔记：新增 来源章节 / 顺序 / 简介 三个文档键
  test('文档键往返：来源章节 / 顺序 / 简介，键序固定', () => {
    const meta = {
      id: '202609092139_92d2ab',
      title: '高斯消元法',
      domain: '#计算方法-线性方程组',
      source: '计算方法课件',
      status: '已确认',
      sourceSection: '《计算方法》第2章 线性方程组数值解法 / 2.1节',
      order: 3,
      summary: '初等行变换化上三角后回代',
    }
    const rendered = renderFrontmatter(meta)
    expect(rendered).toBe([
      '---',
      'ID: 202609092139_92d2ab',
      '标题: 高斯消元法',
      '领域: #计算方法-线性方程组',
      '来源: 计算方法课件',
      '状态: 已确认',
      '来源章节: 《计算方法》第2章 线性方程组数值解法 / 2.1节',
      '顺序: 3',
      '简介: 初等行变换化上三角后回代',
      '---',
      '',
    ].join('\n'))
    expect(parseFrontmatter(`${rendered}正文`).meta).toEqual(meta)
  })

  test('顺序 只在数字合法时渲染与解析', () => {
    expect(renderFrontmatter({ title: 't', order: Number.NaN })).not.toContain('顺序')
    expect(renderFrontmatter({ title: 't', order: 0 })).toContain('顺序: 0')
    expect(parseFrontmatter('---\n顺序: 三点五\n---\n').meta?.order).toBeUndefined()
    expect(parseFrontmatter('---\n顺序: -2\n---\n').meta?.order).toBe(-2)
  })

  test('存量卡的「定义」作「简介」别名读取；两者同现时简介优先', () => {
    expect(parseFrontmatter('---\n定义: 旧卡的一句话\n---\n').meta?.summary).toBe('旧卡的一句话')
    const both = parseFrontmatter('---\n定义: 旧\n简介: 新\n---\n').meta
    expect(both?.summary).toBe('新')
    // 简介渲染回 简介 键，不再写回 定义
    expect(renderFrontmatter({ summary: '新' })).toContain('简介: 新')
    expect(renderFrontmatter({ summary: '新' })).not.toContain('定义')
  })

  test('「模板」键只读不渲染（模板概念已退场，存量卡不应变红）', () => {
    expect(parseFrontmatter('---\n模板: 工程型\n---\n').meta?.template).toBe('工程型')
    expect(renderFrontmatter({ title: 't', template: '工程型' })).not.toContain('模板')
  })

  test('renderRoundtrip', () => {
    const meta = { id: 'x', title: 't', domain: '#图形学', source: 's', status: '草稿' }
    const rendered = renderFrontmatter(meta)
    const parsed = parseFrontmatter(rendered + '正文')
    expect(parsed.meta).toEqual(meta)
  })

  test('crlfFrontmatter', () => {
    const raw = '---\r\n标题: 卡片\r\n状态: 已确认\r\n---\r\n\r\n正文'
    const parsed = parseFrontmatter(raw)
    expect(parsed.meta?.title).toBe('卡片')
    expect(parsed.meta?.status).toBe('已确认')
  })

  test('extractDefinition', () => {
    expect(extractDefinition('> 概念: 迭代器是一种设计模式\n# 正文')).toBe('迭代器是一种设计模式')
    expect(extractDefinition('### 定义（一句话总结）\n> 三十字内的本质')).toBe('三十字内的本质')
    expect(extractDefinition('普通正文')).toBeNull()
  })

  test('extractDefinitionBareQuoteFormat', () => {
    // v0.3.0 定稿格式：renderCard 输出的裸引用块定义（frontmatter 后第一行）
    const body = '> 透视投影矩阵可拆解为缩放、平移与齐次除三步\n\n### 核心机制\n正文'
    expect(extractDefinition(body)).toBe('透视投影矩阵可拆解为缩放、平移与齐次除三步')
    // 首行前有空白也提取；只取正文首个引用块
    expect(extractDefinition('\n\n> 光栅化把图元离散为屏幕像素\n\n> 正文中的其他引用')).toBe('光栅化把图元离散为屏幕像素')
    // 旧约定优先级不变：`> 概念:` 与 `### 定义` 仍优先于裸引用块
    expect(extractDefinition('> 概念: 旧笔记定义\n> 裸引用')).toBe('旧笔记定义')
    expect(extractDefinition('### 定义\n> 小节定义\n> 裸引用')).toBe('小节定义')
  })

  test('firstHeading', () => {
    expect(firstHeading('# 标题一\n## 二级')).toBe('标题一')
    expect(firstHeading('没有标题')).toBeNull()
  })
})
