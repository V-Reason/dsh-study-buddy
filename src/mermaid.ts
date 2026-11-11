export interface MermaidIssue {
  line: number
  message: string
}

type MermaidParser = {
  initialize(options: Record<string, unknown>): void
  parse(text: string, options: { suppressErrors: true }): Promise<false | { diagramType?: string }>
}

let parserPromise: Promise<MermaidParser> | null = null

async function parser(): Promise<MermaidParser> {
  if (parserPromise) return parserPromise
  parserPromise = (async () => {
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
  })()
  return parserPromise
}

/** 提取并逐张校验 Mermaid；行号指向 fenced block 的 opener。 */
export async function validateMermaid(body: string): Promise<MermaidIssue[]> {
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
  if (blocks.length === 0) return []

  const engine = await parser()
  const issues: MermaidIssue[] = []
  for (const block of blocks) {
    if (await engine.parse(block.source, { suppressErrors: true })) continue
    issues.push({ line: block.line, message: 'Mermaid 语法无效或该图型不受支持' })
  }
  return issues
}
