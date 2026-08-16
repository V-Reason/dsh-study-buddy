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

  test('firstHeading', () => {
    expect(firstHeading('# 标题一\n## 二级')).toBe('标题一')
    expect(firstHeading('没有标题')).toBeNull()
  })
})
