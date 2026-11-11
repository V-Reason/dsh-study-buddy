export interface MermaidIssue {
  line: number
  message: string
}

export interface MermaidValidation {
  issues: MermaidIssue[]
  warning?: string
}

type MermaidParser = {
  initialize(options: Record<string, unknown>): void
  parse(text: string, options: { suppressErrors: true }): Promise<false | { diagramType?: string }>
}

let parserPromise: Promise<MermaidParser | null> | null = null
let parserFailure = ''

async function parser(): Promise<MermaidParser | null> {
  if (parserPromise) return parserPromise
  parserPromise = (async () => {
    try {
      const browser = globalThis as typeof globalThis & { window?: unknown; document?: unknown }
      if (!browser.window || !browser.document) {
        const { JSDOM } = await import('jsdom')
        const dom = new JSDOM('<!doctype html><html><body></body></html>')
        Object.assign(browser, { window: dom.window, document: dom.window.document })
      }
      const imported = await import('mermaid')
      const value = imported.default as unknown as MermaidParser
      value.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })
      return value
    } catch (error) {
      parserFailure = error instanceof Error ? error.message : String(error)
      return null
    }
  })()
  return parserPromise
}

/**
 * 提取并逐张校验 Mermaid；行号指向 fenced block 的 opener。
 *
 * 解析器不可用时返回可见 warning，让调用方明确知道门禁没有执行；不能把加载失败
 * 静默当作"没有语法问题"。
 */
export async function validateMermaidReport(body: string): Promise<MermaidValidation> {
  const text = String(body ?? '')
  const blocks: Array<{ source: string; line: number }> = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const opener = /^[ \t]*```mermaid[ \t]*$/i.exec(lines[index])
    if (!opener) continue
    const source: string[] = []
    let cursor = index + 1
    while (cursor < lines.length && !/^[ \t]*```[ \t]*$/.test(lines[cursor])) {
      source.push(lines[cursor])
      cursor++
    }
    if (cursor >= lines.length) continue
    blocks.push({ source: source.join('\n').trim(), line: index + 1 })
    index = cursor
  }
  if (blocks.length === 0) return { issues: [] }

  const engine = await parser()
  if (!engine) {
    return {
      issues: [],
      warning: `Mermaid 校验未执行：解析器在当前宿主中不可用，请先用预览确认图表语法（${parserFailure.slice(0, 300)}）`,
    }
  }
  const issues: MermaidIssue[] = []
  for (const block of blocks) {
    try {
      if (await engine.parse(block.source, { suppressErrors: true })) continue
      issues.push({ line: block.line, message: 'Mermaid 语法无效或该图型不受支持' })
    } catch {
      issues.push({ line: block.line, message: 'Mermaid 语法无效或该图型不受支持' })
    }
  }
  return { issues }
}

/** 兼容只需问题列表的调用方。 */
export async function validateMermaid(body: string): Promise<MermaidIssue[]> {
  return (await validateMermaidReport(body)).issues
}
