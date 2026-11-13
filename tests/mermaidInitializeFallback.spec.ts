import { describe, expect, test, vi } from 'vitest'
import { validateMermaidReport } from '../src/mermaid.ts'

vi.mock('mermaid', () => ({
  default: {
    initialize() {
      throw new Error('initialize exploded')
    },
    async parse() {
      return false
    },
  },
}))

describe('Mermaid 初始化失败降级', () => {
  test('initialize 抛错时返回可见 warning 而不是击穿校验', async () => {
    const report = await validateMermaidReport('```mermaid\nflowchart LR\n  A --> B\n```')
    expect(report.issues).toEqual([])
    expect(report.warning).toContain('Mermaid 校验未执行')
    expect(report.warning).toContain('initialize exploded')
  })
})
