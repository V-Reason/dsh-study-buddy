import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  atomicWrite, cardDirFor, mocPathFor, sanitizeFilename, uniqueCardPath, walk, withinRoot,
  type VaultLayout,
} from '../src/vault.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'study-buddy-vault-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const layout = (domainFolders?: Record<string, string>): VaultLayout => ({
  vaultRoot: dir,
  stateDir: '.study',
  fallbackDir: '未分类',
  mocDir: '目录',
  domainFolders: domainFolders ?? { 图形学与渲染: '游戏开发/图形学' },
})

describe('vault', () => {
  test('sanitizeFilename', () => {
    expect(sanitizeFilename('透视投影矩阵：三步/分解?')).toBe('透视投影矩阵：三步 分解')
    expect(sanitizeFilename('a'.repeat(200)).length).toBeLessThanOrEqual(80)
    expect(sanitizeFilename('///')).toBe('未命名')
  })

  test('withinRoot', () => {
    expect(withinRoot(dir, join(dir, 'a/b.md'))).toBe(true)
    expect(withinRoot(dir, join(dir, '..', 'escape.md'))).toBe(false)
    // 与根目录同级的文件（跨平台写法；Windows 盘符路径在 Linux 上不成立）
    expect(withinRoot(dir, join(tmpdir(), 'other.md'))).toBe(false)
  })

  test('cardDirForMappingAndFallback', () => {
    expect(cardDirFor(layout(), '图形学与渲染')).toBe(join(dir, '游戏开发/图形学'))
    expect(cardDirFor(layout(), '美术')).toBe(join(dir, '未分类', '美术'))
  })

  test('cardDirForRejectsTraversal', () => {
    expect(() => cardDirFor(layout({ 图形学与渲染: '../escape' }), '图形学与渲染')).toThrow('越界')
  })

  test('atomicWriteCreatesContent', async () => {
    const file = join(dir, '计算机/图形学/卡片.md')
    await atomicWrite(file, '内容')
    expect(await readFile(file, 'utf8')).toBe('内容')
    // 无残留临时文件
    const files = await readdir(join(dir, '计算机/图形学'))
    expect(files).toEqual(['卡片.md'])
  })

  test('uniqueCardPathAvoidsCollision', async () => {
    const d = join(dir, '计算机/图形学')
    await mkdir(d, { recursive: true })
    await writeFile(join(d, '同名卡片.md'), '一')
    const p = await uniqueCardPath(d, '同名卡片', '202608161430_ab12')
    expect(p).toBe(join(d, '同名卡片_ab12.md'))
  })

  test('walkSkipsHiddenDirs', async () => {
    await mkdir(join(dir, '.obsidian'), { recursive: true })
    await mkdir(join(dir, '.study'), { recursive: true })
    await mkdir(join(dir, '计算机/图形学'), { recursive: true })
    await writeFile(join(dir, '.obsidian/config.md'), 'x')
    await writeFile(join(dir, '.study/progress.md'), 'x')
    await writeFile(join(dir, '计算机/图形学/卡片.md'), 'x')
    const files = await walk(dir)
    expect(files.map((f) => f.rel.replace(/\\/g, '/'))).toEqual(['计算机/图形学/卡片.md'])
  })

  test('mocPathForUnderMocDir', () => {
    const p = mocPathFor(layout(), '知识目录', '2026-08-16')
    expect(p).toBe(join(dir, '目录', '2026-08-16_知识目录.md'))
  })
})
