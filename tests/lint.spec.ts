import { describe, expect, test } from 'vitest'
import {
  checkCodeFences, checkDomainTags, checkExperiments, checkLayers, checkLinksBlock, checkMainline,
  checkSelfTest, scanResidue,
} from '../src/lintrules.ts'
import { formatBatch, formatReport, lintCard, ruleIds, ruleTitle, summarizeLint } from '../src/lint.ts'

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
    const ok = checkSelfTest('### 自测题\n- **Q1**：a → 答\n- **Q2**：b → 答')
    expect(ok).toMatchObject({ questions: 2, answered: 2, missing: [], usesQn: true, usesNumbered: false })
    const missing = checkSelfTest('### 自测题\n- **Q1**：a → 答\n- **Q2**：b')
    expect(missing.missing).toEqual([2])
    const drift = checkSelfTest('### 自测题\n1. a → 答\n2. b → 答')
    expect(drift.usesNumbered).toBe(true)
    expect(drift.questions).toBe(2)
  })

  test('checkLayers：4~6 层与序号连续', () => {
    const good = checkLayers('### 阶梯式解剖\n**第 1 层**\n**第 2 层**\n**第 3 层**\n**第 4 层**')
    expect(good).toMatchObject({ layers: [1, 2, 3, 4], inRange: true, sequential: true, hasNumbers: true })
    const many = checkLayers('### 阶梯式解剖\n第 1 层\n第 2 层\n第 3 层\n第 4 层\n第 5 层\n第 6 层\n第 7 层')
    expect(many.inRange).toBe(false)
    const gap = checkLayers('### 阶梯式解剖\n第 1 层\n第 3 层\n第 4 层')
    expect(gap.sequential).toBe(false)
    expect(checkLayers('### 阶梯式解剖\n没有序号').hasNumbers).toBe(false)
  })

  test('checkDomainTags：根域与子域混挂', () => {
    expect(checkDomainTags(['图形学-光照模型', 'PBR']).mixed).toBe(false)
    expect(checkDomainTags(['图形学', '图形学-光照模型']).mixed).toBe(true)
    expect(checkDomainTags(['图形学'], ['图形学', '图形学-光照模型']).mixed).toBe(false)
    expect(checkDomainTags(['图形学', '图形学-光照模型'], ['图形学', '图形学-光照模型']).mixed).toBe(true)
  })

  test('checkLinksBlock：归一格式与漂移行', () => {
    const ok = checkLinksBlock('### 关联卡片\n- 前置：`A`（id1）\n- 后续：`B`（id2）')
    expect(ok.malformed).toEqual([])
    // "前置知识：A" 是漂移写法；"后续：`B`" 虽无 ID 但格式合法（旧笔记用路径寻址）
    const bad = checkLinksBlock('### 关联卡片\n- 前置知识：A\n- 后续：`B`')
    expect(bad.malformed).toEqual(['- 前置知识：A'])
  })

  test('checkExperiments / checkMainline', () => {
    expect(checkExperiments('### 验证实验\n1. a\n2. b\n3. c')).toEqual({ present: true, steps: 3 })
    expect(checkExperiments('### 验证实验\n就一句话')).toEqual({ present: true, steps: 1 })
    expect(checkExperiments('没有小节')).toEqual({ present: false, steps: 0 })
    expect(checkMainline('### 主干线\n一条')).toEqual({ count: 1 })
    expect(checkMainline('### 主干线\n一\n### 主干线\n二')).toEqual({ count: 2 })
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

  test('会话残留每处扣 10 分（warn 级，不封顶）', () => {
    const body = `${GOOD_ENGINEERING}\n\n本工程实测发现你的 shader 有问题。`
    const report = lintCard({ title: 'X', definition: '短定义', body, template: '工程型', tags: TAGS })
    const residue = report.findings.filter((f) => f.rule === 'session-residue')
    expect(residue.length).toBeGreaterThanOrEqual(2)
    expect(residue.every((f) => f.severity === 'warn')).toBe(true)
    expect(report.score).toBe(100 - residue.length * 10)
  })

  test('residueLevel=off 关闭残留规则；rulesOff 关闭任意规则', () => {
    const body = `${GOOD_ENGINEERING}\n\n本工程实测。`
    const off = lintCard({ title: 'X', definition: '短定义', body, template: '工程型', tags: TAGS }, { residueLevel: 'off' })
    expect(off.findings.filter((f) => f.rule === 'session-residue')).toEqual([])
    const noWalk = lintCard({ title: 'X', definition: '短定义', body: '### 核心思想\n内容', template: '理论型' }, { rulesOff: ['walkthrough', 'template-sections', 'mainline', 'layer-number', 'selftest-answer'] })
    expect(noWalk.passed.walkthrough).toBeUndefined()
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

  test('summarizeLint / formatBatch 汇总与分布', () => {
    const good = lintCard({ title: 'A', definition: '短定义', body: GOOD_ENGINEERING, template: '工程型', tags: TAGS })
    const bad = lintCard({ title: 'B', definition: '短定义', body: '### 核心思想\nx', template: '工程型' })
    const batch = summarizeLint([good, bad], ['A', 'B'])
    expect(batch.total).toBe(2)
    expect(batch.averageScore).toBeLessThan(100)
    expect(batch.distribution.length).toBeGreaterThan(0)
    expect(batch.rules.some((r) => r.rule === 'template-sections')).toBe(true)
    const text = formatBatch(batch)
    expect(text).toContain('批量 lint：2 张卡')
    expect(text).toContain('规则命中')
    expect(text).toContain('最低分')
  })

  test('ruleIds / ruleTitle 覆盖全部规则', () => {
    expect(ruleIds().length).toBeGreaterThanOrEqual(14)
    expect(ruleTitle('session-residue')).toBe('会话残留')
    expect(ruleTitle('unknown-rule')).toBe('unknown-rule')
  })
})
