import { describe, expect, test } from 'vitest'
import { buildToolDefs, VaultStore } from '../src/index.ts'

// 构造不触盘：VaultStore 仅持有 layout，fs 操作都在工具方法里
const store = new VaultStore({
  vaultRoot: 'T:/vault',
  stateDir: '.study',
  fallbackDir: '未分类',
  mocDir: '目录',
})

const TOOL_NAMES = [
  'card_search', 'card_get', 'card_id', 'card_create', 'card_update',
  'card_link', 'card_moc', 'study_progress', 'study_memory',
]

function defOf(name: string) {
  const def = buildToolDefs(store).find((d) => d.name === name)
  if (!def) throw new Error(`工具 ${name} 未注册`)
  return def
}

describe('buildToolDefs（工具 schema 契约）', () => {
  test('注册 9 个工具，名字集合正确', () => {
    const names = buildToolDefs(store).map((d) => d.name)
    expect(names.sort()).toEqual([...TOOL_NAMES].sort())
  })

  test('每个工具都有 description 与 output schema', () => {
    for (const def of buildToolDefs(store)) {
      expect(def.description, def.name).toBeTruthy()
      expect(def.output.schema.type, def.name).toBe('string')
    }
  })

  test('card_create：status 带 enum、required 完整', () => {
    const def = defOf('card_create')
    const props = def.parameters.properties as Record<string, { enum?: string[] }>
    expect(props.status?.enum).toEqual(['草稿', '已确认', '需更新'])
    const required = def.parameters.required as string[]
    expect(required).toEqual(expect.arrayContaining(['title', 'domain', 'source', 'status', 'definition', 'content']))
  })

  test('card_update：required=[id,mode]，definition 模式参数存在', () => {
    const def = defOf('card_update')
    expect(def.parameters.required).toEqual(['id', 'mode'])
    const props = def.parameters.properties as Record<string, { type?: string; enum?: string[]; properties?: Record<string, unknown>; description?: string }>
    expect(props.status?.enum).toEqual(['草稿', '已确认', '需更新'])
    expect(props.links?.type).toBe('object')
    expect(props.links?.properties?.prev).toBeTruthy()
    expect(props.links?.properties?.next).toBeTruthy()
    expect(props.links?.properties?.conflict).toBeTruthy()
    // definition 模式（字段级修定义，不产生历史折叠）
    expect(props.definition?.description).toContain('definition/replace')
    expect(def.description).toContain('definition=')
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

  test('card_create 定义参数注明 60 字硬上限；description 含领域映射回显', () => {
    const def = defOf('card_create')
    const props = def.parameters.properties as Record<string, { description?: string }>
    expect(props.definition?.description).toContain('60')
    expect(def.description).toContain('领域映射')
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

  test('study_progress / study_memory：未知 action 抛错而非静默', async () => {
    await expect(defOf('study_progress').execute({ action: 'bogus' })).rejects.toThrow(/未知 action/)
    await expect(defOf('study_memory').execute({ action: 'bogus' })).rejects.toThrow(/未知 action/)
  })
})
