import { describe, expect, test } from 'vitest'
import { validateMermaid } from '../src/mermaid.ts'

describe('Mermaid 运行时语法校验', () => {
  test.each([
    ['flowchart', 'flowchart LR\n  A --> B'],
    ['mindmap', 'mindmap\n  root((Root))\n    Child'],
    ['sequenceDiagram', 'sequenceDiagram\n  A->>B: hello'],
    ['stateDiagram-v2', 'stateDiagram-v2\n  [*] --> Ready'],
    ['timeline', 'timeline\n  title Steps\n  0 : Start\n  1 : End'],
    ['classDiagram', 'classDiagram\n  class Root\n  Root : +Run()'],
    ['erDiagram', 'erDiagram\n  USER ||--o{ NOTE : owns'],
  ])('接受合法 %s 图', async (_name, diagram) => {
    const issues = await validateMermaid(`正文\n\n\`\`\`mermaid\n${diagram}\n\`\`\``)
    expect(issues).toEqual([])
  })

  test('坏图返回 opener 行号，无图返回空', async () => {
    const body = ['正文', '', '```mermaid', 'sequenceDiagram', '  A->>: missing', '```'].join('\n')
    expect(await validateMermaid(body)).toEqual([{
      line: 3,
      message: 'Mermaid 语法无效或该图型不受支持',
    }])
    expect(await validateMermaid('没有图')).toEqual([])
  })
})
