import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildToolDefs, VaultStore } from '../src/index.ts'
import { RULES } from '../src/lint.ts'

// 构造不触盘：VaultStore 仅持有 layout，fs 操作都在工具方法里
const store = new VaultStore({
  vaultRoot: 'T:/vault',
  stateDir: '.study',
  fallbackDir: '未分类',
  mocDir: '目录',
})

const TOOL_NAMES = [
  'card_search', 'card_get', 'card_id', 'card_create', 'card_update',
  'card_link', 'card_moc', 'card_lint', 'card_history', 'card_rename',
  'study_progress', 'study_memory',
]

function defOf(name: string) {
  const def = buildToolDefs(store).find((d) => d.name === name)
  if (!def) throw new Error(`工具 ${name} 未注册`)
  return def
}

describe('buildToolDefs（工具 schema 契约）', () => {
  test('注册 12 个工具，名字集合正确', () => {
    const names = buildToolDefs(store).map((d) => d.name)
    expect(names.sort()).toEqual([...TOOL_NAMES].sort())
  })

  test('每个工具都有 description 与 output schema', () => {
    for (const def of buildToolDefs(store)) {
      expect(def.description, def.name).toBeTruthy()
      expect(def.output.schema.type, def.name).toBe('string')
    }
  })

  test('card_create：status 带 enum、required 完整、template 可选枚举', () => {
    const def = defOf('card_create')
    const props = def.parameters.properties as Record<string, { enum?: string[] }>
    expect(props.status?.enum).toEqual(['草稿', '已确认', '需更新'])
    expect(props.template?.enum).toEqual(['理论型', '工程型', '对比型'])
    const required = def.parameters.required as string[]
    expect(required).toEqual(expect.arrayContaining(['title', 'domain', 'source', 'status', 'definition', 'content']))
    expect(required).not.toContain('template')
  })

  test('card_update：required=[id,mode]，definition 模式参数存在', () => {
    const def = defOf('card_update')
    expect(def.parameters.required).toEqual(['id', 'mode'])
    const props = def.parameters.properties as Record<string, { type?: string; enum?: string[]; properties?: Record<string, unknown>; description?: string }>
    expect(props.status?.enum).toEqual(['草稿', '已确认', '需更新'])
    expect(props.template?.enum).toEqual(['理论型', '工程型', '对比型'])
    expect(props.links?.type).toBe('object')
    expect(props.links?.properties?.prev).toBeTruthy()
    expect(props.links?.properties?.next).toBeTruthy()
    expect(props.links?.properties?.conflict).toBeTruthy()
    // definition 模式（字段级修定义，不产生历史折叠）
    expect(props.definition?.description).toContain('definition/replace')
    expect(def.description).toContain('definition=')
    // 版本块插入位置写进描述（P0-3 的用户可见口径）
    expect(def.description).toContain('关联卡片')
  })

  test('card_id 工具描述注明"card_create 不消费预取值"', () => {
    expect(defOf('card_id').description).toContain('不消费')
    expect(defOf('card_id').description).toContain('card_create')
  })

  test('card_moc 工具描述注明"title 只传主题名、日期自动生成"', () => {
    const desc = defOf('card_moc').description
    expect(desc).toContain('title 只传主题名')
    expect(desc).toContain('日期前缀与文件名由工具自动生成')
    const titleParam = (defOf('card_moc').parameters.properties as Record<string, { description?: string }>).title
    expect(titleParam?.description).toContain('只写主题')
  })

  test('card_create 定义参数注明 60 字硬上限；description 含领域映射与分型回显', () => {
    const def = defOf('card_create')
    const props = def.parameters.properties as Record<string, { description?: string }>
    expect(props.definition?.description).toContain('60')
    expect(def.description).toContain('领域映射')
    expect(props.template?.description).toContain('推断')
    // 正文小节要求写进 content 描述（正文不设字数上限）
    expect(props.content?.description).toContain('主干线')
    expect(props.content?.description).toContain('正文长度不设限')
  })

  test('card_lint：ref/scope/rule 参数与规则枚举，P2 三开关', () => {
    const def = defOf('card_lint')
    const props = def.parameters.properties as Record<string, { enum?: string[]; type?: string; description?: string }>
    expect(props.scope?.enum).toEqual(['vault', 'all'])
    expect(props.rule?.enum).toEqual(expect.arrayContaining(['session-residue', 'template-sections', 'code-language']))
    expect(def.description).toContain('会话残留')
    expect(def.description).toContain('警告级')
    expect(def.parameters.required).toBeUndefined()
    // P2：跨卡一致性 / 质量趋势 / 可执行性评级
    expect(props.cross?.type).toBe('boolean')
    expect(props.trend?.type).toBe('boolean')
    expect(props.rating?.type).toBe('boolean')
    expect(def.description).toContain('跨卡一致性')
    // EXT-1：描述由规则注册表生成，新增规则不会漏改文案
    expect(props.rule?.enum).toEqual(RULES.map((r) => r.id))
    for (const rule of RULES) expect(def.description, rule.id).toContain(rule.title)
    // BIZ-4：scope=all 的口径写进描述
    expect(props.scope?.description).toContain('旧笔记仅体检通用规则')
  })

  test('card_history：action 枚举与 kinds', () => {
    const def = defOf('card_history')
    expect(def.parameters.required).toEqual(['ref', 'action'])
    const props = def.parameters.properties as Record<string, { enum?: string[]; items?: { enum?: string[] } }>
    expect(props.action?.enum).toEqual(['list', 'strip'])
    expect(props.kinds?.items?.enum).toEqual(['version', 'errata', 'details'])
  })

  test('card_rename：ref + newTitle 必填、dryRun 可选', () => {
    const def = defOf('card_rename')
    expect(def.parameters.required).toEqual(['ref', 'newTitle'])
    const props = def.parameters.properties as Record<string, { type?: string; description?: string }>
    expect(props.dryRun?.type).toBe('boolean')
    expect(def.description).toContain('旧笔记')
  })

  test('card_id execute：count 上限 20、下限 1', async () => {
    const def = defOf('card_id')
    expect((await def.execute({ count: 25 })).split('\n')).toHaveLength(20)
    expect((await def.execute({ count: 0 })).split('\n')).toHaveLength(1)
    expect((await def.execute({})).split('\n')).toHaveLength(1)
  })

  test('card_link execute：非法 kind 抛错（同步）', () => {
    const def = defOf('card_link')
    expect(() => def.execute({ fromId: 'a', toId: 'b', kind: 'sideways' })).toThrow(/kind/)
  })

  test('card_history execute：非法 action 抛错（经 store 校验）', async () => {
    await expect(defOf('card_history').execute({ ref: 'x', action: 'boom' })).rejects.toThrow()
  })

  test('study_progress / study_memory：未知 action 抛错而非静默', async () => {
    await expect(defOf('study_progress').execute({ action: 'bogus' })).rejects.toThrow(/未知 action/)
    await expect(defOf('study_memory').execute({ action: 'bogus' })).rejects.toThrow(/未知 action/)
  })

  test('card_history：非法 kinds 抛错（BIZ-11e，不再静默变成"无块可清除"）', () => {
    expect(() => defOf('card_history').execute({ ref: 'x', action: 'strip', kinds: ['versions'] }))
      .toThrow(/kinds 只接受/)
  })

  // BIZ-3 工具侧：card_update 必须把会话 cwd 透传给 store，否则 card_search 回显的路径用不了
  test('card_update：透传会话 cwd（引用解析不再"找不到卡片"）', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'study-buddy-tool-vault-'))
    const cwd = await mkdtemp(join(tmpdir(), 'study-buddy-tool-cwd-'))
    try {
      await writeFile(join(cwd, 'note.md'), '> 概念: x\n# note\n正文', 'utf8')
      const store = new VaultStore({
        vaultRoot: vault, stateDir: '.study', fallbackDir: '未分类', mocDir: '目录', includeSessionCwd: true,
      })
      const update = buildToolDefs(store).find((d) => d.name === 'card_update')!
      let message = ''
      try {
        await update.execute({ id: '工作目录/note.md', mode: 'append-version', changes: 'x' }, { agent: { session: { header: { cwd } } } })
      } catch (error) {
        message = (error as Error).message
      }
      // 只读根拒绝写入，但绝不能是"找不到卡片"
      expect(message).not.toContain('找不到卡片')
      expect(message).toContain('只读检索根')
    } finally {
      await rm(vault, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
