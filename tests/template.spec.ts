import { describe, expect, test } from 'vitest'
import {
  allTemplates, checkTemplate, inferTemplate, isTemplateType, sectionHints, templateSpec, templateTable,
} from '../src/template.ts'

const THEORY_BODY = [
  '### 核心思想',
  '一句话讲清。',
  '',
  '### 主干线',
  '问题 → 约束 → 解法 → 代价 → 验证。',
  '',
  '### 阶梯式解剖',
  '**第 1 层**：直觉\n**第 2 层**：机制\n**第 3 层**：细节\n**第 4 层**：边界',
  '',
  '### 实例走查',
  '数值代入。',
  '',
  '### 易错点',
  '- 坑：为什么错',
  '',
  '### 自测题',
  '- **Q1**：问题 → 答案',
].join('\n')

describe('template 模板注册表', () => {
  test('三种模板存在，各自必填小节符合提案 §4.2', () => {
    const specs = allTemplates()
    expect(specs.map((s) => s.type)).toEqual(['理论型', '工程型', '对比型'])
    const theory = templateSpec('理论型')
    expect(theory.required.map((s) => s.title)).toEqual(['核心思想', '主干线', '阶梯式解剖', '实例走查', '易错点', '自测题'])
    const eng = templateSpec('工程型')
    expect(eng.required.map((s) => s.title)).toEqual(expect.arrayContaining(['验证实验', '排障判据']))
    const cmp = templateSpec('对比型')
    expect(cmp.required.map((s) => s.title)).toEqual(expect.arrayContaining(['对比表', '选型口诀', '场景走查']))
    // 重入点/前置检查为三型推荐（非必填）
    for (const spec of specs) {
      expect(spec.optional.map((s) => s.title)).toEqual(['重入点', '前置检查'])
    }
  })

  test('未知模板类型回退理论型（不报错）', () => {
    expect(templateSpec('乱写').type).toBe('理论型')
    expect(templateSpec(undefined).type).toBe('理论型')
    expect(isTemplateType('工程型')).toBe(true)
    expect(isTemplateType('工程')).toBe(false)
  })

  test('checkTemplate：理论型齐全 / 工程型缺验证实验与排障判据', () => {
    const theory = checkTemplate('理论型', THEORY_BODY)
    expect(theory.missing).toEqual([])
    expect(theory.present).toHaveLength(6)
    const eng = checkTemplate('工程型', THEORY_BODY)
    expect(eng.missing.map((s) => s.title)).toEqual(['验证实验', '排障判据'])
    expect(eng.missingOptional.map((s) => s.title)).toEqual(['重入点', '前置检查'])
  })

  test('checkTemplate 兼容括号后缀变体（存量卡片不误判缺节）', () => {
    const legacy = THEORY_BODY.replace('### 阶梯式解剖', '### 阶梯式解剖（第 1 层 → 第 4 层）')
    expect(checkTemplate('理论型', legacy).missing).toEqual([])
  })

  test('inferTemplate：对比标题 → 对比型；工程领域/标题 → 工程型；其余 → 理论型', () => {
    expect(inferTemplate({ title: '光传输算法谱系对比', domain: '图形学' })).toBe('对比型')
    expect(inferTemplate({ title: 'IBL 接入配置', domain: '图形学-光照模型', mappedFolder: '游戏开发/图形学/光照模型' })).toBe('工程型')
    expect(inferTemplate({ title: 'URP 变体与宏', domain: 'Unity' })).toBe('工程型')
    expect(inferTemplate({ title: '红黑树插入修复', domain: '数据结构与算法', mappedFolder: '计算机/编程/数据结构与算法' })).toBe('理论型')
    // 显式覆盖由调用方负责：inferTemplate 只做推断
    expect(inferTemplate({ title: '蒙特卡洛积分', domain: '数学', mappedFolder: '数学' })).toBe('理论型')
  })

  // EXT-3：领域族判定不再用子串包含（"渲染数学"曾被误判工程型并被要求写验证实验）
  test('inferTemplate：领域键精确/前缀命中，不做子串包含', () => {
    expect(inferTemplate({ title: '渲染数学基础', domain: '渲染数学', mappedFolder: '数学/渲染数学' })).toBe('理论型')
    expect(inferTemplate({ title: 'IBL 接入', domain: '渲染', mappedFolder: '游戏开发/图形学' })).toBe('工程型')
    expect(inferTemplate({ title: '法线贴图', domain: '图形学-纹理与采样', mappedFolder: '游戏开发/图形学/纹理与采样' })).toBe('工程型')
    // 目录路径段精确等于领域键才算命中（"Shader与URP" 不等于 "Shader"）
    expect(inferTemplate({ title: '一个普通概念', domain: '其它', mappedFolder: '其它/Shader与URP' })).toBe('理论型')
  })

  test('inferTemplate：config.templateHints 可覆盖判定表（新增领域不必改源码）', () => {
    const hints = { engineeringDomains: ['Rust'], engineeringTitles: ['踩坑'], comparisonTitles: ['之争'] }
    expect(inferTemplate({ title: '所有权模型', domain: 'Rust', hints })).toBe('工程型')
    expect(inferTemplate({ title: 'Rust 与 C++ 之争', domain: 'Rust', hints })).toBe('对比型')
    expect(inferTemplate({ title: '编译期踩坑', domain: '其他', hints })).toBe('工程型')
    // 覆盖后不再命中内置表（图形学 → 理论型）
    expect(inferTemplate({ title: '光照模型', domain: '图形学-光照模型', hints })).toBe('理论型')
  })

  test('sectionHints / templateTable 可读输出', () => {
    expect(sectionHints(templateSpec('工程型').required)).toContain('### 验证实验（')
    const table = templateTable()
    expect(table).toHaveLength(3)
    expect(table[1]).toContain('工程型')
  })
})
