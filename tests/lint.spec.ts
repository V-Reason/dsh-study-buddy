import { describe, expect, test } from 'vitest'
import { splitSections } from '../src/cardmodel.ts'
import {
  checkCodeFences, checkDomainTags, checkExperiments, checkLayers, checkLinksBlock,
  checkSelfTest, countSection, scanResidue,
} from '../src/lintrules.ts'
import { formatBatch, formatReport, lintCard, ruleCatalog, ruleIds, ruleTitle, summarizeLint } from '../src/lint.ts'

/** 便捷：正文 → 小节数组（结构类判定统一接收已切好的小节） */
const sec = (body: string) => splitSections(body).sections

const GOOD_ENGINEERING = [
  '> IBL 接入 = 环境侧喂数据 + shader 两行采样。',
  '',
  '### 重入点',
  '- **30 秒**：间接光是查表不是算；漫反射查 9 个 SH 系数，镜面查 mip 立方图。',
  '- **5 分钟**：读主干线 + 第 1~2 层。',
  '- **30 分钟**：全卡 + 跑验证实验。',
  '',
  '### 前置检查',
  '- 需要知道：间接光的两个通道（202609092139_2c27）',
  '',
  '### 核心思想',
  '**一句话讲清**：环境侧喂数据、shader 两行采样。',
  '',
  '### 主干线',
  '间接光算不起 → 预计算成 SH 与立方图 → 环境侧喂数据 → shader 两次采样 → 代价是烘死的。',
  '',
  '### 阶梯式解剖',
  '**第 1 层 · 直觉**：查表。',
  '**第 2 层 · 机制**：`SampleSH`。',
  '**第 3 层 · 细节**：签名 `SampleSH(float3)`。',
  '**第 4 层 · 边界**：烘死的，不随灯变。',
  '',
  '### 实例走查',
  'r=0.31 → mip≈2.76 → surfaceReduction≈0.912。',
  '',
  '```hlsl',
  'float3 c = SampleSH(normalWS);',
  '```',
  '',
  '### 验证实验',
  '1. 主光 Intensity → 0：暗部仍被环境填亮 → SH 通道通。',
  '2. Ambient Intensity → 0：整体塌黑 → 确认 SH 数据源。',
  '3. 金属球 + Baked 探针：球面映出周围物体 → cubemap 通道通。',
  '',
  '### 排障判据',
  '| 症状 | 判据 | 修复 |',
  '| :-- | :-- | :-- |',
  '| 反射是平色 | 无探针 | 加 Baked 探针并烘焙 |',
  '',
  '### 易错点',
  '- 改了主光没变化：间接光是烘死的。',
  '',
  '### 自测题',
  '- **Q1**：谁生产 SH 数据？ → 环境侧烘焙（答不出 → 回看 主干线）',
  '- **Q2**：为什么反射是平的？ → 没有探针（答不出 → 回看 排障判据）',
  '',
  '### 关联卡片',
  '- 前置：`间接光在实时渲染中的两个通道`（202609092139_2c27）',
].join('\n')

const TAGS = ['图形学-光照模型']

describe('lintrules 判定层', () => {
  test('scanResidue：路径/行号/第二人称/时间词/阶段代号/会话词命中', () => {
    const body = [
      '路径 T:/vault/Assets/PBR.shader 在这里。',
      '源码 RealtimeLights.hlsl L182 的写法。',
      '你的 shader 需要改。',
      '上次讲到附加光。',
      'P0 用默认 Forward 可规避。',
      '本工程实测发现。',
    ].join('\n')
    const hits = scanResidue(body)
    const rules = hits.map((h) => h.rule)
    expect(rules).toContain('path')
    expect(rules).toContain('line')
    expect(rules).toContain('person')
    expect(rules).toContain('time')
    expect(rules).toContain('phase')
    expect(rules).toContain('session')
    expect(hits[1].line).toBe(2)
    expect(hits[1].suggestion).toContain('行号')
  })

  test('scanResidue 白名单：L0/L1/L2 球谐带、LOD、讲义引用不误报', () => {
    const body = [
      'URP 的 SampleSH 只取 L0/L1/L2 三带。',
      'L2 正则化 = 高斯先验；L1 正则化 = 拉普拉斯先验。',
      'LOD 切换由 mip 决定。',
      '（来源：GAMES101 L15 讲解讨论）',
      '第 15 讲讲了蒙特卡洛积分。',
    ].join('\n')
    expect(scanResidue(body)).toEqual([])
  })

  test('scanResidue 白名单：代码块内与 <details> 历史块内不扫；引用块内第二人称不报', () => {
    const body = [
      '```hlsl',
      '// 你的 shader 在这里',
      '```',
      '<details>',
      '历史版本：本工程实测',
      '</details>',
      '> 定义句里的我们不算会话残留',
    ].join('\n')
    expect(scanResidue(body)).toEqual([])
  })

  test('checkCodeFences：统计未标语言块', () => {
    expect(checkCodeFences('```hlsl\nx\n```')).toEqual({ total: 1, unlabeled: 0, unlabeledIndexes: [] })
    expect(checkCodeFences('```\nx\n```\n```cpp\ny\n```')).toEqual({ total: 2, unlabeled: 1, unlabeledIndexes: [1] })
  })

  test('checkSelfTest：Qn 写法、答案缺失、数字编号漂移', () => {
    const ok = checkSelfTest(sec('### 自测题\n- **Q1**：a → 答\n- **Q2**：b → 答'))
    expect(ok).toMatchObject({ questions: 2, answered: 2, missing: [], usesQn: true, usesNumbered: false })
    const missing = checkSelfTest(sec('### 自测题\n- **Q1**：a → 答\n- **Q2**：b'))
    expect(missing.missing).toEqual([2])
    const drift = checkSelfTest(sec('### 自测题\n1. a → 答\n2. b → 答'))
    expect(drift.usesNumbered).toBe(true)
    expect(drift.questions).toBe(2)
  })

  test('checkLayers：4~6 层与序号连续', () => {
    const good = checkLayers(sec('### 阶梯式解剖\n**第 1 层**\n**第 2 层**\n**第 3 层**\n**第 4 层**'))
    expect(good).toMatchObject({ layers: [1, 2, 3, 4], inRange: true, sequential: true, hasNumbers: true })
    const many = checkLayers(sec('### 阶梯式解剖\n第 1 层\n第 2 层\n第 3 层\n第 4 层\n第 5 层\n第 6 层\n第 7 层'))
    expect(many.inRange).toBe(false)
    const gap = checkLayers(sec('### 阶梯式解剖\n第 1 层\n第 3 层\n第 4 层'))
    expect(gap.sequential).toBe(false)
    expect(checkLayers(sec('### 阶梯式解剖\n没有序号')).hasNumbers).toBe(false)
  })

  test('checkDomainTags：根域与子域混挂', () => {
    expect(checkDomainTags(['图形学-光照模型', 'PBR']).mixed).toBe(false)
    expect(checkDomainTags(['图形学', '图形学-光照模型']).mixed).toBe(true)
    expect(checkDomainTags(['图形学'], ['图形学', '图形学-光照模型']).mixed).toBe(false)
    expect(checkDomainTags(['图形学', '图形学-光照模型'], ['图形学', '图形学-光照模型']).mixed).toBe(true)
  })

  test('checkLinksBlock：归一格式与漂移行', () => {
    const ok = checkLinksBlock(sec('### 关联卡片\n- 前置：`A`（id1）\n- 后续：`B`（id2）'))
    expect(ok.malformed).toEqual([])
    // "前置知识：A" 是漂移写法；"后续：`B`" 虽无 ID 但格式合法（旧笔记用路径寻址）
    const bad = checkLinksBlock(sec('### 关联卡片\n- 前置知识：A\n- 后续：`B`'))
    expect(bad.malformed).toEqual(['- 前置知识：A'])
  })

  test('checkExperiments / countSection', () => {
    expect(checkExperiments(sec('### 验证实验\n1. a\n2. b\n3. c'))).toEqual({ present: true, steps: 3 })
    expect(checkExperiments(sec('### 验证实验\n就一句话'))).toEqual({ present: true, steps: 1 })
    expect(checkExperiments(sec('没有小节'))).toEqual({ present: false, steps: 0 })
    expect(countSection(sec('### 主干线\n一条'), '主干线')).toBe(1)
    expect(countSection(sec('### 主干线\n一\n### 主干线\n二'), '主干线')).toBe(2)
  })
})

describe('lint 引擎与评分', () => {
  test('合格工程卡：满分、无 error', () => {
    const report = lintCard({ title: 'IBL 接入', definition: 'IBL 接入 = 环境侧喂数据 + shader 两行采样。', body: GOOD_ENGINEERING, template: '工程型', tags: TAGS })
    expect(report.findings).toEqual([])
    expect(report.score).toBe(100)
    expect(report.template).toBe('工程型')
    expect(formatReport(report)).toContain('总分：100/100')
    expect(formatReport(report)).toContain('无问题')
  })

  test('会话残留分档扣分：硬信号 10 分、第二人称/会话口吻 3 分（BIZ-11i）', () => {
    const body = `${GOOD_ENGINEERING}\n\n本工程实测发现你的 shader 有问题。`
    const report = lintCard({ title: 'X', definition: '短定义', body, template: '工程型', tags: TAGS })
    const residue = report.findings.filter((f) => f.rule === 'session-residue')
    expect(residue.length).toBeGreaterThanOrEqual(2)
    expect(residue.every((f) => f.severity === 'warn')).toBe(true)
    const deducted = residue.reduce((sum, f) => sum + f.weight, 0)
    expect(deducted).toBe(3 + 3)
    expect(report.score).toBe(100 - deducted)
    // `实测` 单独出现不再命中（工程卡里"实测帧率 60fps"是正常表述）
    const measured = lintCard({ title: 'X', definition: '短定义', body: '### 核心思想\n实测帧率 60fps。', template: '理论型' })
    expect(measured.findings.filter((f) => f.rule === 'session-residue')).toEqual([])
    // 硬信号仍是 10 分：路径 + 行号
    const hard = lintCard({ title: 'X', definition: '短定义', body: '### 核心思想\nRealtimeLights.hlsl L182 的写法。', template: '理论型' })
    expect(hard.findings.filter((f) => f.rule === 'session-residue').map((f) => f.weight)).toEqual([10, 10])
  })

  test('residueLevel=off 关闭残留规则；rulesOff 关闭任意规则（passed 不含该键）', () => {
    const body = `${GOOD_ENGINEERING}\n\n本工程实测。`
    const off = lintCard({ title: 'X', definition: '短定义', body, template: '工程型', tags: TAGS }, { residueLevel: 'off' })
    expect(off.findings.filter((f) => f.rule === 'session-residue')).toEqual([])
    // N7：未执行 ≠ 通过——不进 passed，报告单列「⊘ 未执行」
    expect(off.passed['session-residue']).toBeUndefined()
    expect(off.notRun).toContain('会话残留')
    const offText = formatReport(off)
    expect(offText).toContain('⊘ 未执行（不计入通过）：会话残留')
    expect(offText).not.toContain('通过：会话残留')
    // 未关闭时照常进 passed
    const on = lintCard({ title: 'X', definition: '短定义', body, template: '工程型', tags: TAGS })
    expect(on.passed['session-residue']).toBe(false)
    expect(on.notRun).toEqual([])
    const disabled = lintCard({ title: 'X', definition: '短定义', body: '### 核心思想\n内容', template: '理论型' }, { rulesOff: ['layer-number', 'template-sections', 'mainline'] })
    expect(disabled.passed['layer-number']).toBeUndefined()
    expect(disabled.passed['template-sections']).toBeUndefined()
    expect(disabled.passed['definition-length']).toBe(true)
  })

  test('旧笔记（kind=note）只跑通用规则，不套模板（BIZ-4）', () => {
    const report = lintCard({ title: '随手笔记', definition: '短定义', body: '正文一句话', template: undefined }, { kind: 'note' })
    const rules = report.findings.map((f) => f.rule)
    expect(rules).not.toContain('template-sections')
    expect(rules).not.toContain('mainline')
    expect(report.passed['template-sections']).toBeUndefined()
    expect(report.passed['session-residue']).toBe(true)
    expect(report.kind).toBe('note')
    expect(formatReport(report)).toContain('旧笔记')
  })

  test('外部资源引用给出 info 级提示、不扣分（SEC-7）', () => {
    const body = `${GOOD_ENGINEERING}\n\n<img src="http://tracker.example.com/x.png">`
    const report = lintCard({ title: 'X', definition: '短定义', body, template: '工程型', tags: TAGS })
    const hit = report.findings.filter((f) => f.rule === 'external-resource')
    expect(hit).toHaveLength(1)
    expect(hit[0].severity).toBe('info')
    expect(hit[0].weight).toBe(0)
    expect(report.score).toBe(100)
  })

  test('主线小节重复只报一次（不再与缺节重复扣分，EXT-2）', () => {
    const dup = lintCard({ title: 'X', definition: '短定义', body: '### 核心思想\nx\n\n### 核心思想\ny', template: '理论型' })
    const mainline = dup.findings.filter((f) => f.rule === 'mainline')
    expect(mainline).toHaveLength(1)
    expect(mainline[0].message).toContain('核心思想')
    // 缺主干线由 template-sections 负责，mainline 不再报一次
    const missing = lintCard({ title: 'X', definition: '短定义', body: '### 核心思想\nx', template: '理论型' })
    expect(missing.findings.some((f) => f.rule === 'template-sections')).toBe(true)
    expect(missing.findings.some((f) => f.rule === 'mainline')).toBe(false)
  })

  test('对比型不再被要求「实例走查」（走查类小节由模板规格决定）', () => {
    const body = [
      '### 核心思想', 'x', '### 主干线', 'a',
      '### 对比表', '| A | B |\n| :-- | :-- |\n| 1 | 2 |',
      '### 选型口诀', '看场景', '### 场景走查', '场景一',
      '### 易错点', 'x', '### 自测题', '- **Q1**：a → b',
    ].join('\n')
    const report = lintCard({ title: 'X', definition: '短定义', body, template: '对比型' })
    expect(report.findings.map((f) => f.rule)).not.toContain('walkthrough')
    expect(report.findings.filter((f) => f.rule === 'template-sections')).toEqual([])
  })

  test('summarizeLint / formatBatch 汇总与分布', () => {
    const good = lintCard({ title: 'A', definition: '短定义', body: GOOD_ENGINEERING, template: '工程型', tags: TAGS })
    const bad = lintCard({ title: 'B', definition: '短定义', body: '### 核心思想\nx', template: '工程型' })
    const note = lintCard({ title: 'C', definition: '短定义', body: '旧笔记正文', template: undefined }, { kind: 'note' })
    const batch = summarizeLint([good, bad, note], ['A', 'B', 'C'])
    expect(batch.total).toBe(3)
    expect(batch.noteCount).toBe(1)
    expect(batch.averageScore).toBeLessThan(100)
    expect(batch.distribution.length).toBeGreaterThan(0)
    expect(batch.rules.some((r) => r.rule === 'template-sections')).toBe(true)
    const text = formatBatch(batch)
    expect(text).toContain('批量 lint：3 篇')
    expect(text).toContain('其中旧笔记 1 篇')
    expect(text).toContain('规则命中')
    expect(text).toContain('最低分')
  })

  // N10：满分区间不存在 109 分，报告数字不能自相矛盾
  test('N10：满分桶标签封顶 100（不再出现 100~109）', () => {
    const full = lintCard({ title: 'A', definition: '短定义', body: GOOD_ENGINEERING, template: '工程型', tags: TAGS })
    expect(full.score).toBe(100)
    const batch = summarizeLint([full], ['A'])
    expect(batch.distribution).toEqual([{ range: '100', count: 1 }])
    const text = formatBatch(batch)
    expect(text).toContain('分数分布：100 分 1 篇')
    expect(text).not.toContain('100~')
  })

  test('ruleIds / ruleTitle / ruleCatalog 覆盖全部规则', () => {
    expect(ruleIds().length).toBe(14)
    expect(ruleIds()).toContain('external-resource')
    // walkthrough 与 template-sections 重复（对比型还会误报），已合并删除
    expect(ruleIds()).not.toContain('walkthrough')
    expect(ruleTitle('session-residue')).toBe('会话残留')
    expect(ruleTitle('unknown-rule')).toBe('unknown-rule')
    const catalog = ruleCatalog()
    expect(catalog).toHaveLength(ruleIds().length)
    expect(catalog.find((r) => r.id === 'template-sections')?.scope).toBe('card')
    expect(catalog.find((r) => r.id === 'session-residue')?.scope).toBe('all')
  })

  test('residueLevel=error 时严重度升级并封顶', () => {
    const body = `${GOOD_ENGINEERING}\n\n本工程实测。`
    const report = lintCard({ title: 'X', definition: '短定义', body, template: '工程型' }, { residueLevel: 'error' })
    expect(report.findings.some((f) => f.severity === 'error')).toBe(true)
    expect(report.score).toBeLessThanOrEqual(59)
  })

  test('缺小节逐条扣分：工程型缺验证实验/排障判据', () => {
    const body = GOOD_ENGINEERING.replace(/### 验证实验[\s\S]*?### 排障判据[\s\S]*?### 易错点/, '### 易错点')
    const report = lintCard({ title: 'X', definition: '短定义', body, template: '工程型', tags: TAGS })
    const rules = report.findings.map((f) => f.rule)
    expect(rules).toContain('verify-experiment')
    expect(rules).toContain('troubleshoot-criteria')
    expect(report.score).toBeLessThan(100)
  })

  test('长卡缺重入点触发；有前置关联缺前置检查触发', () => {
    const long = GOOD_ENGINEERING.replace('### 重入点', '### 别的').replace('### 前置检查', '### 另一个') + `\n\n${'补充说明文字。'.repeat(400)}`
    const report = lintCard({ title: 'X', definition: '短定义', body: long, template: '工程型', tags: TAGS })
    const rules = report.findings.map((f) => f.rule)
    expect(rules).toContain('reentry-point')
    expect(rules).toContain('prereq-check')
  })

  test('主干线重复、层级越界、代码未标语言、自测题无答案、关联格式漂移', () => {
    const body = [
      '### 核心思想', 'x', '### 主干线', 'a', '### 主干线', 'b',
      '### 阶梯式解剖', '第 1 层\n第 2 层\n第 3 层\n第 4 层\n第 5 层\n第 6 层\n第 7 层',
      '### 实例走查', 'x', '### 易错点', 'x', '### 自测题', '- **Q1**：没有答案',
      '```', 'code', '```', '### 关联卡片', '- 前置知识：裸标题',
    ].join('\n')
    const report = lintCard({ title: 'X', definition: '短定义', body, template: '理论型' })
    const rules = report.findings.map((f) => f.rule)
    expect(rules).toContain('mainline')
    expect(rules).toContain('layer-number')
    expect(rules).toContain('code-language')
    expect(rules).toContain('selftest-answer')
    expect(rules).toContain('links-format')
  })
})
