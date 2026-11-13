import { describe, expect, test, vi } from 'vitest'
import { validateMermaidReport } from '../src/mermaid.ts'

vi.mock('mermaid', () => ({
  default: {
    initialize() {},
    async parse() {
      throw new Error('parse exploded')
    },
  },
}))

describe('Mermaid 解析失败降级', () => {
  test('parse 抛错时转换成语法问题而不是击穿校验', async () => {
    const report = await validateMermaidReport('```mermaid\nflowchart LR\n  A --> B\n```')
    expect(report.warning).toBeUndefined()
    expect(report.issues).toEqual([{ line: 1, message: 'Mermaid 语法无效或该图型不受支持' }])
  })
})
