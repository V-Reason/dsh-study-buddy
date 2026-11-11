import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const probe = join(root, 'tests', 'fixtures', 'host-artifact-probe.mjs')

describe('发布产物可脱离 profile 依赖运行', () => {
  let temp = ''

  beforeAll(async () => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'pipe' })
    temp = await mkdtemp(join(tmpdir(), 'study-buddy-artifact-'))
  })

  afterAll(async () => {
    if (temp) await rm(temp, { recursive: true, force: true })
  })

  test('隔离 node_modules 时仍能执行真实 Mermaid 校验', async () => {
    const lib = join(temp, 'lib')
    const vault = join(temp, 'vault')
    await mkdir(lib, { recursive: true })
    await copyFile(join(root, 'lib', 'index.js'), join(lib, 'index.js'))

    const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }
    const result = spawnSync(process.execPath, [probe, join(lib, 'index.js'), vault], {
      cwd: temp,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.status, result.stderr).toBe(0)

    const report = JSON.parse(result.stdout) as { valid: string; invalid: string }
    expect(report.valid).not.toContain('Mermaid 校验未执行')
    expect(report.valid).not.toContain('Mermaid 语法')
    expect(report.invalid).toContain('Mermaid 语法')
  }, 60_000)
})
