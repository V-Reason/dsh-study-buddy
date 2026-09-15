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
})

/**
 * 阶段 4b：18 个工具的名字集合与 schema 契约。
 *
 * 这一层是"文档化契约"的守卫：工具描述本身就是提示词资产，schema 漂移
 * （少一个必填项、枚举写错、描述与注册表脱节）在运行期没有任何信号。
 */
const TOOL_NAMES = [
  'note_library', 'note_expect_get', 'note_list', 'note_get', 'note_search', 'note_overview',
  'note_plan', 'note_write', 'note_update', 'note_toc', 'note_link', 'note_unlink',
  'note_rename', 'note_history', 'note_restore', 'note_lint',
  'study_progress', 'study_memory',
]

function defOf(name: string) {
  const def = buildToolDefs(store).find((d) => d.name === name)
  if (!def) throw new Error(`工具 ${name} 未注册`)
  return def
}

describe('buildToolDefs（18 个工具的 schema 契约）', () => {
  test('注册 18 个工具，名字集合正确，card_* 整族退场', () => {
    const names = buildToolDefs(store).map((d) => d.name)
    expect(names).toHaveLength(18)
    expect(names.sort()).toEqual([...TOOL_NAMES].sort())
    for (const gone of ['card_search', 'card_create', 'card_update', 'card_link', 'card_moc', 'card_id', 'card_history', 'card_rename', 'card_lint', 'card_get']) {
      expect(names, `${gone} 应已退场（需求 R18）`).not.toContain(gone)
    }
  })

  test('每个工具都有 description 与 output schema（返回纯文本）', () => {
    for (const def of buildToolDefs(store)) {
      expect(def.description, def.name).toBeTruthy()
      expect(def.output.schema.type, def.name).toBe('string')
      expect(def.parameters.type, def.name).toBe('object')
    }
  })

  test('只读工具声明 isConcurrencySafe，写入工具不声明（避免并发写同一库）', () => {
    const readOnly = ['note_library', 'note_expect_get', 'note_list', 'note_get', 'note_search', 'note_overview', 'note_plan', 'note_history', 'note_lint']
    const write = ['note_write', 'note_update', 'note_toc', 'note_link', 'note_unlink', 'note_rename', 'note_restore', 'study_progress', 'study_memory']
    for (const name of readOnly) expect(defOf(name).isConcurrencySafe?.(), name).toBe(true)
    for (const name of write) expect(defOf(name).isConcurrencySafe, name).toBeUndefined()
  })

  test('note_write 必填含 planId（硬门禁的凭据）；无模板/无字数类参数', () => {
    const def = defOf('note_write')
    expect(def.parameters.required).toEqual(expect.arrayContaining(['planId', 'title', 'path', 'source', 'content']))
    const props = def.parameters.properties as Record<string, { enum?: string[]; description?: string }>
    expect(props.planId?.description).toContain('规划')
    expect(props.status?.enum).toEqual(['草稿', '已确认', '需更新'])
    // 需求 R6/R7：模板参数不存在，正文描述指向《笔记期望.md》且不再限制字数
    expect(props.template).toBeUndefined()
    expect(props.content?.description).toContain('笔记期望')
    expect(props.content?.description).toContain('不设限')
    expect(props.summary?.description).toContain('无长度限制')
    // 门禁三条件写进描述（模型据此自我纠正）
    expect(def.description).toContain('note_expect_get')
    expect(def.description).toContain('planId')
  })

  test('note_plan：rootPath + items 必填（confirm/abandon 复用 rootPath 传 planId），items 项契约完整', () => {
    const def = defOf('note_plan')
    // 三个动作共用同一组必填：confirm / abandon 把 rootPath 当 planId 传，schema 不随动作漂移
    expect(def.parameters.required).toEqual(['rootPath', 'items'])
    const props = def.parameters.properties as Record<string, { items?: { items?: { required?: string[] } }; enum?: string[]; description?: string }>
    expect(props.action?.enum).toEqual(['create', 'confirm', 'abandon'])
    expect(props.rootPath?.description).toContain('planId')
    expect(props.items?.items?.required).toEqual(['title', 'path'])
    // 确认这一步必须写在描述里：模型据此知道"提案之后还有一步"，而不是去找不存在的入口
    expect(def.description).toContain('action=confirm')
    expect(def.description).toContain('会被 note_write 拒绝')
    expect(def.description).toContain('有效期从确认时刻起算')
  })

  test('note_update：ref + action 必填，四动作枚举完整', () => {
    const def = defOf('note_update')
    expect(def.parameters.required).toEqual(['ref', 'action'])
    const props = def.parameters.properties as Record<string, { enum?: string[] }>
    expect(props.action?.enum).toEqual(['append', 'replace', 'move', 'definition'])
    // 先存档后写正文这条不变量写进用户可见描述
    expect(def.description).toContain('.study/archive')
    expect(def.description).toContain('绝不丢')
  })

  test('note_link / note_unlink：kind 枚举为 prev/next/sibling（不再是 conflict）', () => {
    const link = defOf('note_link')
    expect(link.parameters.required).toEqual(['from', 'to', 'kind'])
    const props = link.parameters.properties as Record<string, { enum?: string[] }>
    expect(props.kind?.enum).toEqual(['prev', 'next', 'sibling'])
    expect(defOf('note_unlink').parameters.required).toEqual(['from', 'to'])
    expect(defOf('note_link').description).toContain('wikilink')
  })

  test('note_search：kind 三态枚举与 path 目录过滤', () => {
    const props = defOf('note_search').parameters.properties as Record<string, { enum?: string[]; description?: string }>
    expect(props.kind?.enum).toEqual(['block', 'legacy', 'note'])
    expect(props.path?.description).toContain('目录')
    expect(defOf('note_search').parameters.required).toEqual(['query'])
  })

  test('note_lint：rule 枚举与注册表同源；无分值、无 P2 开关', () => {
    const def = defOf('note_lint')
    const props = def.parameters.properties as Record<string, { enum?: string[] }>
    expect(props.rule?.enum).toEqual(RULES.map((r) => r.id))
    for (const rule of RULES) expect(def.description, rule.id).toContain(rule.title)
    expect(def.description).toContain('不给分数')
    expect(props.cross).toBeUndefined()
    expect(props.trend).toBeUndefined()
    expect(props.rating).toBeUndefined()
  })

  test('note_history / note_restore / note_toc：枚举与 dryRun 契约', () => {
    const histProps = defOf('note_history').parameters.properties as Record<string, { enum?: string[] }>
    expect(histProps.action?.enum).toEqual(['list', 'read'])
    expect(defOf('note_history').parameters.required).toEqual(['ref'])
    const restoreProps = defOf('note_restore').parameters.properties as Record<string, { type?: string }>
    expect(restoreProps.dryRun?.type).toBe('boolean')
    expect(defOf('note_toc').parameters.required).toEqual(['dir'])
    expect(defOf('note_rename').parameters.required).toEqual(['ref', 'title'])
  })

  test('note_library / note_expect_get：门禁前两环的形状', () => {
    expect(defOf('note_library').parameters.required).toEqual(['action'])
    const props = defOf('note_library').parameters.properties as Record<string, { enum?: string[] }>
    expect(props.action?.enum).toEqual(['check'])
    expect(defOf('note_expect_get').parameters.properties).toEqual({})
    expect(defOf('note_expect_get').description).toContain('已读')
  })

  test('study_progress / study_memory：未知 action 抛错而非静默', async () => {
    await expect(Promise.resolve(defOf('study_progress').execute({ action: 'bogus' }))).rejects.toThrow(/未知 action/)
    await expect(Promise.resolve(defOf('study_memory').execute({ action: 'bogus' }))).rejects.toThrow(/未知 action/)
    // touchedIds 是笔记语义下的参数名（旧名 touchedCardIds）
    const props = defOf('study_progress').parameters.properties as Record<string, unknown>
    expect(props.touchedIds).toBeTruthy()
  })

  test('note_update / note_history 透传会话 cwd（引用解析不再"找不到笔记"）', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'study-buddy-tool-vault-'))
    const cwd = await mkdtemp(join(tmpdir(), 'study-buddy-tool-cwd-'))
    try {
      await writeFile(join(cwd, 'note.md'), '> 概念: x\n# note\n正文', 'utf8')
      const localStore = new VaultStore({
        vaultRoot: vault, stateDir: '.study', fallbackDir: '未分类', mocDir: '目录', includeSessionCwd: true,
      })
      const defs = buildToolDefs(localStore)
      const update = defs.find((d) => d.name === 'note_update')!
      let message = ''
      try {
        await update.execute(
          { ref: '工作目录/note.md', action: 'append', changes: 'x' },
          { agent: { session: { header: { cwd } } } },
        )
      } catch (error) {
        message = (error as Error).message
      }
      // 只读根拒绝写入，但绝不能是"找不到笔记"
      expect(message).not.toContain('找不到')
      expect(message).toContain('只读检索根')

      // 不传 cwd 时解析不到（对照：说明上面命中的是 cwd 透传）
      const history = defs.find((d) => d.name === 'note_history')!
      await expect(Promise.resolve(history.execute({ ref: '工作目录/note.md', action: 'list' })))
        .rejects.toThrow(/找不到/)
      const listed = await history.execute(
        { ref: '工作目录/note.md', action: 'list' },
        { agent: { session: { header: { cwd } } } },
      ) as string
      expect(listed).toContain('没有历史存档')
    } finally {
      await rm(vault, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
