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

  test('card_update：required=[id,mode]，replace 支持 links 与 status enum', () => {
    const def = defOf('card_update')
    expect(def.parameters.required).toEqual(['id', 'mode'])
    const props = def.parameters.properties as Record<string, { type?: string; enum?: string[]; properties?: Record<string, unknown> }>
    expect(props.status?.enum).toEqual(['草稿', '已确认', '需更新'])
    expect(props.links?.type).toBe('object')
    expect(props.links?.properties?.prev).toBeTruthy()
    expect(props.links?.properties?.next).toBeTruthy()
    expect(props.links?.properties?.conflict).toBeTruthy()
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
