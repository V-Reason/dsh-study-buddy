import { describe, expect, test } from 'vitest'
import {
  PROBLEM_BUCKET, RULES, formatBatch, formatReport, lintNote, parseExpectRules, ruleCatalog, ruleIds, ruleTitle,
  summarizeLint,
} from '../src/lint.ts'
import { checkCodeFences, scanResidue } from '../src/lintrules.ts'

/**
 * 阶段 3 用例：lint 瘦身版（4 条规则、无分值）。
 *
 * 白名单反例优先于正例（沿用项目约定）：这些反例是用真实 vault 校准出来的，
 * 删掉它们等于把"误伤控制"重新交回给运气。模板类规则的用例已随模板一起删除。
 */

const CLEAN = [
  '> 一句话定位',
  '',
  '## 误差与有效数字',
  '',
  '把 $x$ 的绝对误差控制在 $10^{-6}$ 以内。',
  '',
  '```python',
  'x = 1 / 3',
  '```',
].join('\n')

describe('lint 规则注册表', () => {
  test('规则集含数据卫生与围栏闭合，模板类规则已彻底退场', () => {
    expect(ruleIds()).toEqual([
      'session-residue', 'fence-balance', 'mermaid-syntax', 'code-language', 'diagram-budget',
      'engineering-source-map', 'engineering-evidence', 'source-reference', 'course-anchor', 'external-resource', 'expect-rule',
    ])
    expect(RULES).toHaveLength(11)
    expect(ruleCatalog().map((r) => r.severity)).toEqual([
      'warn', 'error', 'error', 'warn', 'warn', 'warn', 'warn', 'error', 'error', 'info', 'info',
    ])
    expect(ruleTitle('session-residue')).toBe('会话残留')
    expect(ruleTitle('不存在的规则')).toBe('不存在的规则')
  })

  test('干净正文：全部规则通过，无 finding', () => {
    const report = lintNote({ title: '甲', body: CLEAN })
    expect(report.findings).toEqual([])
    expect(report.passed['session-residue']).toBe(true)
    expect(report.passed['code-language']).toBe(true)
    expect(report.chars).toBeGreaterThan(0)
    // 期望检查项没提供 -> 明确列为"未执行"，而不是当成通过（N7）
    expect(report.notRun).toContain('期望检查项')
    expect(report.passed['expect-rule']).toBeUndefined()
  })

  test('会话残留：命中并带行号；residueLevel=off 时列为未执行', () => {
    const body = '正文\n\n在 D:\\work\\Game\\Player.cs 里改了逻辑，你上次说的是对的。\n'
    const report = lintNote({ title: '甲', body })
    const hits = report.findings.filter((f) => f.rule === 'session-residue')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].line).toBe(3)
    expect(hits.some((h) => h.message.includes('本机路径'))).toBe(true)

    const off = lintNote({ title: '甲', body }, { residueLevel: 'off' })
    expect(off.findings.filter((f) => f.rule === 'session-residue')).toEqual([])
    expect(off.notRun).toContain('会话残留')
    expect(off.passed['session-residue']).toBeUndefined()
  })

  test('会话残留不把 http/https 外链误报成本机盘符路径', () => {
    const report = lintNote({
      title: '外链',
      body: '[资料](https://example.com/a) 与 [论文](http://example.com/b)',
    })
    expect(report.findings.filter((finding) => finding.rule === 'session-residue')).toEqual([])
  })

  test('会话残留：residueLevel=error 时严重度升级（但仍不阻塞写盘）', () => {
    const report = lintNote({ title: '甲', body: '见 D:\\a\\b.cs' }, { residueLevel: 'error' })
    expect(report.findings.every((f) => f.severity === 'error')).toBe(true)
  })

  test('仓库相对源码地图不是本机路径，盘符绝对路径仍然命中', () => {
    const portabilityBreak = lintNote({
      title: '工程笔记',
      body: '实现入口：`Assets/Scripts/Presentation/Root/CombatRoot.cs · Assemble()`。',
    })
    expect(portabilityBreak.findings.filter((f) => f.rule === 'session-residue')).toEqual([])

    const absolutePathBreak = lintNote({
      title: '工程笔记',
      body: '实现入口：`T:\\GAMES\\deepseaoil\\Assets\\Scripts\\Presentation\\Root\\CombatRoot.cs`。',
    })
    expect(absolutePathBreak.findings.some((f) => f.message.includes('本机路径'))).toBe(true)
  })

  test('白名单反例：球谐带 / LOD / 讲义的 L 编号 / 代码块与折叠块内都不算残留', () => {
    const body = [
      '球谐用 L0/L1/L2 三带表示。',
      'LOD 切换按距离判定。',
      'GAMES101 L15 讲了阴影贴图。',
      '第 15 讲提到过。',
      '',
      '```cpp',
      '// D:\\work\\secret\\A.cpp L42',
      '```',
      '',
      '<details><summary>历史</summary>',
      '你上次说的 D:\\old\\x.cs',
      '</details>',
    ].join('\n')
    expect(scanResidue(body)).toEqual([])
  })

  test('rulesOff 关闭任意规则：该规则不进 passed，也不产生 finding', () => {
    const report = lintNote({ title: '甲', body: '见 D:\\a\\b.cs' }, { rulesOff: ['session-residue'] })
    expect(report.findings).toEqual([])
    expect(report.passed['session-residue']).toBeUndefined()
    expect(report.notRun).toContain('会话残留')
  })

  test('代码块语言：未标语言的块同时报告 opener 行号与块序号', () => {
    const report = lintNote({ title: '甲', body: '```\nplain\n```\n\n```python\nx=1\n```' })
    const finding = report.findings.find((f) => f.rule === 'code-language')
    expect(finding?.message).toContain('第 1 行')
    expect(finding?.message).toContain('第 1 块')
    expect(finding?.line).toBe(1)
    expect(checkCodeFences('```python\nx\n```').unlabeled).toBe(0)
    expect(report.passed['code-language']).toBeUndefined()
  })

  test('未闭合代码围栏是 error，完整围栏不受影响', () => {
    const broken = lintNote({ title: '甲', body: '```mermaid\nflowchart LR\n  A --> B' })
    const finding = broken.findings.find((f) => f.rule === 'fence-balance')
    expect(finding?.severity).toBe('error')
    expect(finding?.message).toContain('未闭合')

    const valid = lintNote({ title: '甲', body: '```mermaid\nflowchart LR\n  A --> B\n```' })
    expect(valid.findings.some((f) => f.rule === 'fence-balance')).toBe(false)
  })

  test('external-resource 是 info 级且只提示（SEC-7）', () => {
    const report = lintNote({ title: '甲', body: '<img src="https://example.com/a.png">' })
    const finding = report.findings.find((f) => f.rule === 'external-resource')
    expect(finding?.severity).toBe('info')
    expect(finding?.message).toContain('外部资源')
  })

  test('工程路径缺源码地图或证据级时告警，路径外不触发工程规则', () => {
    const noMap = lintNote({
      title: '装配',
      body: '这里只有装配结论。\n\n证据：源码已核对。',
    }, { engineering: true })
    expect(noMap.findings.find((f) => f.rule === 'engineering-source-map')?.severity).toBe('warn')
    expect(noMap.findings.some((f) => f.rule === 'engineering-evidence')).toBe(false)

    const noEvidence = lintNote({
      title: '装配',
      body: '入口：`Assets/Scripts/Presentation/Root/CombatRoot.cs · Assemble()`。',
    }, { engineering: true })
    expect(noEvidence.findings.find((f) => f.rule === 'engineering-evidence')?.severity).toBe('warn')
    expect(noEvidence.findings.some((f) => f.rule === 'engineering-source-map')).toBe(false)

    const generic = lintNote({ title: '定义', body: '幂等表示重复执行结果不变。' })
    expect(generic.findings.some((f) => f.rule.startsWith('engineering-'))).toBe(false)
  })

  test('一篇文章超过一张 Mermaid 主图时告警', () => {
    const body = [
      '```mermaid', 'flowchart LR', '  A --> B', '```',
      '', '```mermaid', 'sequenceDiagram', '  A->>B: step', '```',
    ].join('\n')
    const report = lintNote({ title: '装配', body })
    expect(report.findings.find((f) => f.rule === 'diagram-budget')?.severity).toBe('warn')
  })

  test('课程笔记锚点：标记后必须写清运行链、位置、上一输出与本步输出', () => {
    const missing = lintNote({
      title: '输入缓冲',
      body: '<!-- course-anchor -->\n- 运行链：R2\n- 课程位置：R2.3\n',
    })
    const hit = missing.findings.find((finding) => finding.rule === 'course-anchor')
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('上一输出')
    expect(hit?.message).toContain('本步输出')

    const valid = lintNote({
      title: '输入缓冲',
      body: [
        '<!-- course-anchor -->',
        '- 运行链：R2',
        '- 课程位置：R2.3',
        '- 上一输出：采样帧留下按下沿',
        '- 本步输出：缓冲中保留有效时刻',
      ].join('\n'),
    })
    expect(valid.findings.some((finding) => finding.rule === 'course-anchor')).toBe(false)
  })

  test('源码地图在已知根下不存在时是 error，未提供根时只提示待验证', () => {
    const body = '入口：`Assets/Scripts/Presentation/Root/CombatRoot.cs · Assemble()`。\n\n源码已核对。'
    const missing = lintNote({ title: '装配', body }, {
      engineering: true,
      sourceReferenceStatus: { 'Assets/Scripts/Presentation/Root/CombatRoot.cs': false },
    })
    const missingHit = missing.findings.find((f) => f.rule === 'source-reference')
    expect(missingHit?.severity).toBe('error')
    expect(missingHit?.message).toContain('不存在')

    const unverified = lintNote({ title: '装配', body }, { engineering: true })
    const unverifiedHit = unverified.findings.find((f) => f.rule === 'source-reference')
    expect(unverifiedHit?.severity).toBe('info')
    expect(unverifiedHit?.message).toContain('无法验证')

    const known = lintNote({ title: '装配', body }, {
      engineering: true,
      sourceReferenceStatus: { 'Assets/Scripts/Presentation/Root/CombatRoot.cs': true },
    })
    expect(known.findings.some((f) => f.rule === 'source-reference' && f.severity !== 'info')).toBe(false)
  })
})

describe('期望检查项（热配置驱动的规则）', () => {
  test('parseExpectRules：只认 `- [检查] 禁止/必须 …`，支持级别与理由', () => {
    const rules = parseExpectRules([
      '# 笔记期望',
      '平时自由写，但下面几条要检查：',
      '- [检查] 禁止 🚀',
      '- [检查] 禁止 本机绝对路径 理由：要能换机器读 严重：error',
      '- [检查] 必须 ## 目录',
      '- 这是普通列表项，不是检查项',
      '- [x] 也不是',
    ].join('\n'))
    expect(rules).toEqual([
      { pattern: '🚀', mode: 'forbid', severity: 'info' },
      { pattern: '本机绝对路径', mode: 'forbid', severity: 'error', reason: '要能换机器读' },
      { pattern: '## 目录', mode: 'require', severity: 'info' },
    ])
    expect(parseExpectRules('没有任何检查项')).toEqual([])
  })

  test('lintNote 带 expectRules 时：禁止项命中、必须项缺失各报一条', () => {
    const rules = parseExpectRules(['- [检查] 禁止 🚀', '- [检查] 必须 ## 目录'].join('\n'))
    const report = lintNote({ title: '甲', body: '正文 🚀 带表情' }, { expectRules: rules })
    const hits = report.findings.filter((f) => f.rule === 'expect-rule')
    expect(hits).toHaveLength(2)
    expect(hits.some((h) => h.message.includes('禁止项：🚀'))).toBe(true)
    expect(hits.some((h) => h.message.includes('必须项：## 目录'))).toBe(true)
    expect(report.notRun).not.toContain('期望检查项')
  })
})

describe('报告与批量汇总（无分值）', () => {
  test('formatReport：问题清单 + 未执行提示，不出现"总分"', () => {
    const report = lintNote({ title: '高斯消元法', body: '见 D:\\a\\b.cs' })
    const text = formatReport(report)
    expect(text).toContain('## 高斯消元法（块，正文')
    expect(text).toContain('| ⚠ | 会话残留 |')
    expect(text).toContain('⊘ 未执行（不计入通过）：期望检查项')
    expect(text).not.toContain('总分')
    expect(text).not.toContain('/100')
  })

  test('formatReport：无问题时明确写"未发现问题"', () => {
    expect(formatReport(lintNote({ title: '甲', body: CLEAN }))).toContain('未发现问题。')
  })

  test('summarizeLint / formatBatch：按问题数分布，不给均分', () => {
    const reports = [
      lintNote({ title: '干净', body: CLEAN }),
      lintNote({ title: '一处', body: '见 D:\\a\\b.cs' }),
      lintNote({ title: '两处', body: '见 D:\\a\\b.cs\n\n```\n未标语言\n```' }),
    ]
    const batch = summarizeLint(reports)
    expect(batch.total).toBe(3)
    expect(batch.problemCount).toBe(2)
    // 没有均分字段（架构选型 A9：分值制随模板退场，平均问题数同属残留口径）
    expect('average' in batch).toBe(false)
    expect(batch.distribution.find((d) => d.label === '0 条')?.count).toBe(1)
    expect(batch.rules[0].id).toBe('session-residue')
    expect(batch.rules[0].count).toBe(2)
    expect(batch.worst[0].title).toBe('两处')

    const text = formatBatch(batch)
    expect(text).toContain('## 批量体检（共 3 篇）')
    expect(text).toContain('有问题的文档：2 篇（共 3 篇）')
    expect(text).toContain('规则命中：')
    expect(text).toContain('问题最多的文档')
    expect(text).not.toContain('均分')
    expect(text).not.toContain('平均')
    expect(PROBLEM_BUCKET).toBe(2)
  })

  test('旧笔记（kind=note）参与体检但被单独计数', () => {
    const batch = summarizeLint([
      lintNote({ title: '块', body: CLEAN }),
      lintNote({ title: '旧笔记', body: CLEAN }, { kind: 'note' }),
      lintNote({ title: '存量卡', body: CLEAN }, { kind: 'legacy' }),
    ])
    expect(batch.noteCount).toBe(1)
    expect(batch.legacyCount).toBe(1)
    expect(formatBatch(batch)).toContain('其中旧笔记 1 篇、存量卡 1 篇')
  })
})
