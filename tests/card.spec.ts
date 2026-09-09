import { describe, expect, test } from 'vitest'
import {
  addLink, applyUpdate, generateId, renderCard, renderMoc, resolveTemplate, stripMocDatePrefix, todayLocal, validateCard, validateDefinition,
  type CardInput,
} from '../src/card.ts'
import { parseFrontmatter } from '../src/frontmatter.ts'

const base: CardInput = {
  title: '透视投影矩阵的三步分解',
  domain: '图形学与渲染',
  source: 'GAMES101 L04',
  status: '草稿',
  definition: '透视投影矩阵可拆解为缩放、平移与齐次除三步',
  template: '理论型',
  content: [
    '### 核心思想',
    '**一句话讲清**：先缩放后平移，最后齐次除，三步把透视世界变成矩形视口。',
    '**为什么**：透视投影的关键是 w 除，其余都是仿射铺垫。',
    '**记忆锚点**：先裁窗后贴到屏幕。',
    '',
    '### 主干线',
    '透视除法算不起 → 齐次坐标把平移线性化 → 一次矩阵乘法 + w 除 → 代价是 w=0 的无穷远点 → 验证看近大远小。',
    '',
    '### 阶梯式解剖',
    '**第 1 层 · 直觉**：近大远小 = 对 w 做除法。',
    '**第 2 层 · 机制**：矩阵乘法（见下）。',
    '**第 3 层 · 细节与推导**：齐次坐标代入后展开，第三行以 -1 填 w。',
    '**第 4 层 · 边界与反例**：w=0 对应无穷远点，透视除失效。',
    '',
    '### 实例走查',
    '输入 (0,0,1,1)：缩放 → 平移 → w 除 → 屏幕坐标。',
    '',
    '### 易错点',
    '- 忘记 w 归一化：四维坐标不能直接当三维用。',
    '',
    '### 自测题',
    '- **Q1**：平移为什么放进矩阵？ → 齐次坐标把平移变成线性变换。',
    '',
    '```hlsl\nfloat4x4 m;\n```',
  ].join('\n'),
  tags: ['线性代数'],
}

describe('card', () => {
  test('generateIdFormatAndUniqueness', () => {
    // 用本地时间构造，避免 CI（UTC）与开发机时区差异导致时间戳偏移
    const now = new Date(2026, 7, 16, 14, 30)
    const ids = new Set(Array.from({ length: 20 }, () => generateId(now)))
    expect(ids.size).toBe(20)
    for (const id of ids) {
      expect(id).toMatch(/^202608161430_[0-9a-f]{6}$/)
    }
  })

  test('validateCard', () => {
    expect(validateCard(base).errors).toEqual([])
    // 模板已分型：只应有"推荐小节（重入点/前置检查）"这类提示，不得有必填缺节警告
    expect(validateCard(base).warnings.join()).not.toContain('必填')

    const bad = { ...base, status: '奇怪状态' }
    expect(validateCard(bad).errors.join()).toContain('status')

    const longDef = { ...base, definition: '这'.repeat(31) }
    expect(validateCard(longDef).warnings.join()).toContain('30')

    const missing = { ...base, content: '' }
    expect(validateCard(missing).errors.join()).toContain('content')
  })

  test('定义长度分级：31-45 一级警告、46-60 二级警告、>60 硬报错', () => {
    // ≤30：无警告
    expect(validateCard({ ...base, definition: '三'.repeat(30) }).warnings.filter(w => w.includes('字，'))).toEqual([])
    // 31~45：允许放行的一级警告
    const tier1 = validateCard({ ...base, definition: '这'.repeat(31) })
    expect(tier1.errors).toEqual([])
    expect(tier1.warnings.join()).toContain('稍长')
    expect(tier1.warnings.join()).toContain('允许放行')
    // 46~60：接近上限的二级警告，仍允许
    const tier2 = validateCard({ ...base, definition: '这'.repeat(46) })
    expect(tier2.errors).toEqual([])
    expect(tier2.warnings.join()).toContain('偏长')
    expect(tier2.warnings.join()).toContain('允许放行')
    // >60：硬拒绝（fail-loud）
    const hard = validateCard({ ...base, definition: '这'.repeat(61) })
    expect(hard.errors.join()).toContain('60 字硬上限')
    // validateDefinition 与 validateCard 同一规则
    expect(validateDefinition('').errors.join()).toContain('不能为空')
    expect(validateDefinition('x'.repeat(61)).errors.join()).toContain('60 字硬上限')
  })

  test('todayLocal 为本地时区日期（凌晨会话不回退到 UTC 前一天）', () => {
    // 2026-09-02 00:30 本地时间：UTC 仍为 09-01，本地日期必须 09-02
    expect(todayLocal(new Date(2026, 8, 2, 0, 30))).toBe('2026-09-02')
    expect(todayLocal(new Date(2026, 8, 2, 23, 59))).toBe('2026-09-02')
  })

  test('stripMocDatePrefix 剥离旧惯例写入标题的日期前缀', () => {
    expect(stripMocDatePrefix('2026-09-02_图形学 MOC 目录（第22讲）')).toBe('图形学 MOC 目录（第22讲）')
    expect(stripMocDatePrefix('2026-09-02 知识目录')).toBe('知识目录')
    expect(stripMocDatePrefix('图形学 MOC 目录')).toBe('图形学 MOC 目录')
    expect(stripMocDatePrefix('')).toBe('')
    expect(stripMocDatePrefix('  ')).toBe('')
  })

  test('validateCard 警告缺失的模板必填小节（不阻塞）', () => {
    // 少了 主干线 / 实例走查 / 易错点 / 自测题
    const partial = { ...base, content: '### 核心思想\n一句话。\n\n### 阶梯式解剖\n第 1 层。' }
    const result = validateCard(partial)
    expect(result.errors).toEqual([])
    const warnings = result.warnings.join()
    expect(warnings).toContain('"### 主干线"')
    expect(warnings).toContain('"### 实例走查"')
    expect(warnings).toContain('"### 易错点"')
    expect(warnings).toContain('"### 自测题"')
    expect(warnings).toContain('理论型必填')
    expect(warnings).not.toContain('"### 核心思想"')
    expect(warnings).not.toContain('"### 阶梯式解剖"')
    // 小节齐全则不产生模板警告
    expect(validateCard(base).warnings.filter(w => w.includes('必填'))).toEqual([])
    // content 为空时已有 error，不再叠加模板警告
    expect(validateCard({ ...base, content: '' }).warnings.join()).not.toContain('必填')
  })

  test('validateCard 模板分型：工程型要求验证实验与排障判据；非法 template 报错', () => {
    const eng = validateCard({ ...base, template: '工程型' })
    const warnings = eng.warnings.join()
    expect(warnings).toContain('"### 验证实验"')
    expect(warnings).toContain('"### 排障判据"')
    expect(warnings).toContain('工程型必填')
    // 推荐小节单独提示（不算必填）
    expect(warnings).toContain('推荐')
    const bad = validateCard({ ...base, template: '随笔型' })
    expect(bad.errors.join()).toContain('template 必须是')
  })

  test('resolveTemplate：显式优先、非法值报错、缺省按领域推断', () => {
    expect(resolveTemplate({ title: 'IBL 接入', domain: '图形学-光照模型', template: '工程型' }).type).toBe('工程型')
    expect(resolveTemplate({ title: '红黑树插入', domain: '数据结构与算法' }).type).toBe('理论型')
    expect(resolveTemplate({ title: '光传输算法谱系对比', domain: '图形学' }).type).toBe('对比型')
    expect(resolveTemplate({ title: 'x', domain: 'y', template: '乱写' }).error).toContain('理论型/工程型/对比型')
    // 领域目录族参与推断（mappedFolder）
    expect(resolveTemplate({ title: 'URP 变体', domain: 'Unity' }, { mappedFolder: '游戏开发/Unity' }).type).toBe('工程型')
  })

  test('renderCardMatchesFinalFormat', () => {
    const text = renderCard({ ...base, id: '202608161430_ab12', links: { prev: ['正交投影'] } })
    expect(text).toContain('ID: 202608161430_ab12')
    expect(text).toContain('领域: #图形学与渲染 #线性代数')
    // frontmatter 后空一行，定义是裸引用块；模板字段写在状态之后（可选字段）
    expect(text).toContain('状态: 草稿\n模板: 理论型\n---\n\n> 透视投影矩阵可拆解')
    // 无固定"核心内容"包裹标题、无尾部标签行
    expect(text).not.toContain('### 核心内容')
    expect(text).not.toContain('#Doing')
    expect(text).toContain('### 关联卡片')
    expect(text).toContain('- 前置：正交投影')
  })

  test('applyUpdateAppendVersionKeepsOldContent', () => {
    const raw = renderCard({ ...base, id: '202608161430_ab12' })
    const result = applyUpdate(raw, '202608161430_ab12', {
      mode: 'append-version',
      source: 'GAMES101 L05',
      changes: '补充：除法的 w 分量来自视图空间深度。',
    })
    expect(result.text).toContain('透视投影矩阵可拆解')
    expect(result.text).toContain('### 版本更新（来源：GAMES101 L05）')
    expect(result.text).toContain('除法的 w 分量来自视图空间深度')
  })

  test('applyUpdateErrataKeepsOldConclusion', () => {
    const raw = renderCard({ ...base, id: 'x' })
    const result = applyUpdate(raw, 'x', {
      mode: 'errata',
      changes: '纠正原因：旧结论把缩放与平移顺序写反了。\n正确顺序：先缩放后平移。',
    })
    expect(result.text).toContain('### 勘误')
    expect(result.text).toContain('纠正原因')
    expect(result.text).toContain('透视投影矩阵可拆解') // 旧内容保留
  })

  test('applyUpdateDefinition只替换定义：不产生历史折叠、正文与关联保留', () => {
    const raw = renderCard({ ...base, id: 'd1', links: { prev: ['正交投影'] } })
    const result = applyUpdate(raw, 'd1', { mode: 'definition', definition: '透视投影矩阵三步拆解成缩放平移与齐次除' })
    expect(result.text).toContain('> 透视投影矩阵三步拆解成缩放平移与齐次除')
    expect(result.text).not.toContain('透视投影矩阵可拆解为缩放、平移与齐次除三步')
    // 不产生历史折叠（只有 replace 才折叠）
    expect(result.text).not.toContain('历史版本')
    expect(result.text).not.toContain('<details>')
    // 正文与关联小节原样保留
    expect(result.text).toContain('### 阶梯式解剖')
    expect(result.text).toContain('- 前置：正交投影')
  })

  test('applyUpdateDefinition 字段级校验：空/超限报错、非引用块引导 replace', () => {
    const raw = renderCard({ ...base, id: 'd2' })
    expect(() => applyUpdate(raw, 'd2', { mode: 'definition', definition: '' })).toThrow(/definition 模式校验失败/)
    expect(() => applyUpdate(raw, 'd2', { mode: 'definition', definition: 'x'.repeat(61) })).toThrow(/60 字硬上限/)
    // 正文首行不是引用块（旧笔记/自由格式）→ 报错并引导 replace
    const plain = '# 普通笔记\n正文'
    expect(() => applyUpdate(plain, 'n', { mode: 'definition', definition: '短定义' })).toThrow(/replace/)
  })

  test('applyUpdateReplaceKeepsHistoryBlock', () => {
    const raw = renderCard({ ...base, id: 'y' })
    const result = applyUpdate(raw, 'y', {
      mode: 'replace',
      card: {
        ...base, title: '透视投影矩阵（修订版）', status: '已确认',
        definition: '修订后的三十字内定义', links: { prev: ['正交投影'], next: ['光栅化'] },
      },
    })
    expect(result.text).toContain('透视投影矩阵（修订版）')
    expect(result.text).toContain('历史版本')
    expect(result.text).toContain('透视投影矩阵可拆解') // 旧正文进折叠块
    expect(result.text).toContain('状态: 已确认')
    // replace 可重建关联卡片（links 透传渲染）
    expect(result.text).toContain('### 关联卡片')
    expect(result.text).toContain('- 前置：正交投影')
    expect(result.text).toContain('- 后续：光栅化')
  })

  test('applyUpdateReplaceRejectsInvalidCard', () => {
    const raw = renderCard({ ...base, id: 'z' })
    expect(() => applyUpdate(raw, 'z', {
      mode: 'replace',
      card: { ...base, title: '' },
    })).toThrow('校验失败')
  })

  test('applyUpdateRejectsUnknownMode', () => {
    expect(() => applyUpdate('raw', 'id', { mode: 'boom' as never })).toThrow('未知更新模式')
  })

  test('addLinkCreatesSectionWhenAbsent', () => {
    const raw = '# 标题\n正文'
    const text = addLink(raw, 'prev', '前置卡片（id1）')
    expect(text).toContain('### 关联卡片')
    expect(text).toContain('- 前置：`前置卡片`（id1）')
    expect(text).toContain('正文')
  })

  test('addLinkAppendsUnderExistingSection', () => {
    const raw = '# 标题\n\n### 关联卡片\n- 前置：旧卡片\n\n正文尾'
    const text = addLink(raw, 'next', '延伸卡片（id2）')
    const idxNext = text.indexOf('- 后续：`延伸卡片`（id2）')
    const idxOld = text.indexOf('- 前置：旧卡片')
    expect(idxNext).toBeGreaterThan(-1)
    expect(idxNext).toBeLessThan(idxOld)
    expect(text).toContain('正文尾')
  })

  test('addLinkSkipsExistingTarget', () => {
    const raw = '# 标题\n\n### 关联卡片\n- 前置：已有（id3）'
    const text = addLink(raw, 'prev', '已有（id3）')
    expect(text.match(/已有/g)?.length).toBe(1)
  })

  // 回归（BIZ-6）：判重只限「关联卡片」小节——别的小节里的 `- 前置：X` 不算已关联
  test('addLink 判重范围限定关联卡片小节（BIZ-6）', () => {
    const raw = '# 标题\n\n### 前置检查\n- 前置：甲（id1）\n'
    const text = addLink(raw, 'prev', '甲（id1）', 'id1')
    expect(text).toContain('### 关联卡片')
    expect(text.match(/- 前置：/g)?.length).toBe(2)
    // 真的已在「关联卡片」里时仍然跳过
    const again = addLink(text, 'prev', '甲（id1）', 'id1')
    expect(again).toBe(text)
  })

  test('addLinkDedupesByIdAcrossTitleChanges', () => {
    const raw = '# 标题\n\n### 关联卡片\n- 后续：旧标题（202608161430_ab12）\n'
    // 目标卡标题已改，但 ID 相同：按 ID 判重，不重复添加
    const text = addLink(raw, 'next', '新标题（202608161430_ab12）', '202608161430_ab12')
    expect(text.match(/- 后续：/g)?.length).toBe(1)
    expect(text).toContain('旧标题（202608161430_ab12）')
  })

  test('addLinkDedupesByTitleWhenIdDiffersOrMissing（P0-6 双向去重）', () => {
    // 标题相同、ID 不同（或没写 ID）：仍视为同一目标，不重复添加
    const raw = '# 标题\n\n### 关联卡片\n- 前置：`投影矩阵`（id-old）\n'
    const byTitle = addLink(raw, 'prev', '投影矩阵（id-new）', 'id-new')
    expect(byTitle.match(/投影矩阵/g)?.length).toBe(1)
    const noId = addLink(raw, 'prev', '`投影矩阵`')
    expect(noId.match(/投影矩阵/g)?.length).toBe(1)
    // 不同标题、不同 ID：正常追加
    const other = addLink(raw, 'prev', '光栅化（id-other）', 'id-other')
    expect(other.match(/- 前置：/g)?.length).toBe(2)
  })

  test('addLink 归一为 `标题`（ID） 写法', () => {
    const text = addLink('# 标题\n正文', 'next', '光栅化（id9）')
    expect(text).toContain('- 后续：`光栅化`（id9）')
    // 已带反引号时不重复加
    expect(addLink('# 标题\n正文', 'next', '`光栅化`（id9）')).toContain('- 后续：`光栅化`（id9）')
    // 旧笔记按路径寻址（无 ID）：保留路径括号
    expect(addLink('# 标题\n正文', 'next', '旧笔记标题（工作目录/旧笔记.md）')).toContain('- 后续：`旧笔记标题`（工作目录/旧笔记.md）')
  })

  test('addLinkFallsBackToLabelDedupWithoutId', () => {
    // 旧笔记无 ID：回退为按标签文本判重
    const raw = '# 标题\n\n### 关联卡片\n- 后续：`旧笔记`（计算机/图形学/旧.md）\n'
    const text = addLink(raw, 'next', '旧笔记（计算机/图形学/旧.md）')
    expect(text.match(/- 后续：/g)?.length).toBe(1)
  })

  test('addLinkPreservesFrontmatter', () => {
    const raw = `---\nID: 202608161430_ab12\n标题: 投影矩阵\n---\n\n> 定义\n`
    const text = addLink(raw, 'prev', '前置（x）')
    expect(text).toContain('---\nID: 202608161430_ab12')
    expect(text).toContain('### 关联卡片')
    expect(text).toContain('- 前置：`前置`（x）')
    expect(text).toContain('> 定义')
  })

  test('renderMocGroupsByDomain', () => {
    const text = renderMoc('知识目录', '2026-08-16', [
      { id: 'a', title: '投影矩阵', domain: '图形学与渲染', fileName: '投影矩阵.md' },
      { id: 'b', title: '红黑树插入', domain: '数据结构与算法', fileName: '红黑树.md' },
    ])
    expect(text).toContain('## 图形学与渲染')
    expect(text).toContain('- [[投影矩阵]]（a）')
    expect(text).toContain('## 数据结构与算法')
    expect(text).toContain('- [[红黑树]]（b）· 红黑树插入')
  })

  // ── SEC-1：换行 / `---` 注入 ──────────────────────────────────────────────
  test('SEC-1：标题/定义/来源含换行一律拒绝（不静默截断 frontmatter）', () => {
    expect(validateCard({ ...base, title: '正常标题\n---\n注入: x' }).errors.join()).toContain('换行')
    expect(validateCard({ ...base, definition: '第一行\n### 关联卡片' }).errors.join()).toContain('换行')
    expect(validateDefinition('第一行\n第二行').errors.join()).toContain('换行')
    expect(validateCard({ ...base, source: 'a\nb' }).errors.join()).toContain('换行')
    expect(validateCard({ ...base, status: '草稿\n' }).errors.join()).toContain('换行')
    // 领域标签含空白会被 frontmatter 拆成两个标签（BIZ-11c）
    expect(validateCard({ ...base, tags: ['带 空格'] }).errors.join()).toContain('空白')
  })

  test('SEC-1：渲染兜底把换行折成空格，frontmatter 不被截断', () => {
    const text = renderCard({ ...base, id: 'id1', title: 'A\n---\n注入: x', definition: '一行\n两行' })
    const parsed = parseFrontmatter(text)
    expect(parsed.meta?.title).toBe('A --- 注入: x')
    expect(parsed.meta?.domain).toBe('#图形学与渲染 #线性代数')
    expect(parsed.meta?.status).toBe('草稿')
    expect(parsed.meta?.template).toBe('理论型')
    expect(parsed.body).toContain('> 一行 两行')
  })

  test('SEC-3：MOC wikilink 目标清洗 `[`/`]`（链接不被打断）', () => {
    const text = renderMoc('目录', '2026-08-16', [
      { id: 'a', title: 'A]]B', domain: '领域', fileName: 'A]]B.md' },
    ])
    expect(text).toContain('- [[A B]]（a）')
    expect(text).not.toContain('[[A]]B]]')
  })

  test('BIZ-11d：MOC 标题日期前缀支持 / 与 年月 写法', () => {
    expect(stripMocDatePrefix('2026-09-02_图形学')).toBe('图形学')
    expect(stripMocDatePrefix('2026/09/10 图形学')).toBe('图形学')
    expect(stripMocDatePrefix('2026年9月 图形学')).toBe('图形学')
    expect(stripMocDatePrefix('2026年9月10日 图形学')).toBe('图形学')
    expect(stripMocDatePrefix('图形学')).toBe('图形学')
  })
})
