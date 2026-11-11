import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { VaultStore } from '../src/index.ts'

vi.mock('mermaid', () => {
  throw new Error('createRequire.resolve.paths is not a function or its return value is not iterable')
})

describe('Mermaid 解析器加载失败', () => {
  let vault = ''
  let store: VaultStore

  beforeAll(async () => {
    vault = await mkdtemp(join(tmpdir(), 'study-buddy-mermaid-fallback-'))
    store = new VaultStore({ vaultRoot: vault, stateDir: '.study', fallbackDir: '未分类' })
    await writeFile(join(vault, 'fallback.md'), [
      '---',
      'ID: fallback-id',
      '标题: 降级样本',
      '简介: 解析器不可用时的回归样本',
      '---',
      '',
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
    ].join('\n'), 'utf8')
  })

  afterAll(async () => {
    if (vault) await rm(vault, { recursive: true, force: true })
  })

  test('note_lint 返回可见告警而不是抛异常', async () => {
    const report = await store.lint({ ref: '降级样本' })
    expect(report).toContain('Mermaid 校验未执行')
  })
})
