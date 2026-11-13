import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [bundlePath, vaultRoot] = process.argv.slice(2)
if (!bundlePath || !vaultRoot) throw new Error('usage: host-artifact-probe.mjs <bundle> <vault>')

const { VaultStore } = await import(pathToFileURL(bundlePath).href)
await mkdir(vaultRoot, { recursive: true })

const note = (id, title, body) => [
  '---',
  `ID: ${id}`,
  `标题: ${title}`,
  `简介: ${title}的 Mermaid 回归样本`,
  '---',
  '',
  body,
].join('\n')

await writeFile(join(vaultRoot, 'valid.md'), note('valid-id', '合法图', [
  '```mermaid',
  'flowchart LR',
  '  A --> B',
  '```',
].join('\n')), 'utf8')

await writeFile(join(vaultRoot, 'invalid.md'), note('invalid-id', '坏图', [
  '```mermaid',
  'flowchart LR',
  '  A -->',
  '```',
].join('\n')), 'utf8')

const store = new VaultStore({ vaultRoot, stateDir: '.study', fallbackDir: '未分类' })
const library = await store.noteLibrary('check')
const valid = await store.lint({ ref: '合法图' })
const invalid = await store.lint({ ref: '坏图' })
process.stdout.write(JSON.stringify({ library, valid, invalid }))
