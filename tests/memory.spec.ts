import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  checkMemoryValue, formatMemory, normalizeMemoryKey, readMemory, writeMemory,
} from '../src/memory.ts'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'study-buddy-memory-'))
  file = join(dir, '.study', 'memory.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeFileDirect(p: string, content: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, content, 'utf8')
}

describe('memory', () => {
  test('missingFileReadsEmpty', async () => {
    expect(await readMemory(file)).toEqual({ notes: {} })
  })

  test('roundtrip', async () => {
    await writeMemory(file, { notes: { prefs: '讲解多用 C++ 例子', lastSummary: '讲了透视投影矩阵' } })
    const state = await readMemory(file)
    expect(state.notes.prefs).toBe('讲解多用 C++ 例子')
    expect(state.notes.lastSummary).toBe('讲了透视投影矩阵')
    expect(state.updatedAt).toBeTruthy()
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('"lastSummary"')
  })

  test('dirtyTypesAreDropped', async () => {
    await writeFileDirect(file, JSON.stringify({
      notes: { 好键: '好值', 坏键: 42, 空键: '' },
      updatedAt: 123,
    }))
    const state = await readMemory(file)
    expect(state.notes).toEqual({ 好键: '好值', 空键: '' })
    expect(state.updatedAt).toBeUndefined()
  })

  test('nonObjectNotesAreDropped', async () => {
    await writeFileDirect(file, JSON.stringify({ notes: ['a', 'b'] }))
    expect((await readMemory(file)).notes).toEqual({})
  })

  test('corruptJsonThrows', async () => {
    await writeFileDirect(file, '{ 不是 JSON')
    await expect(readMemory(file)).rejects.toThrow('损坏')
  })

  test('keyValidation', () => {
    expect(normalizeMemoryKey('  prefs  ')).toBe('prefs')
    expect(() => normalizeMemoryKey('  ')).toThrow('不能为空')
    expect(() => normalizeMemoryKey('x'.repeat(65))).toThrow('过长')
    expect(() => normalizeMemoryKey('a\tb')).toThrow('控制字符')
  })

  test('valueValidation', () => {
    expect(checkMemoryValue('abc')).toBe('abc')
    expect(() => checkMemoryValue('x'.repeat(4001))).toThrow('过长')
  })

  test('appendJoinsWithNewline', async () => {
    await writeMemory(file, { notes: { prefs: '第一行' } })
    const state = await readMemory(file)
    state.notes.prefs = checkMemoryValue(`${state.notes.prefs}\n第二行`)
    await writeMemory(file, state)
    expect((await readMemory(file)).notes.prefs).toBe('第一行\n第二行')
  })

  test('formatMemoryPutsLastSummaryFirst', () => {
    const text = formatMemory({ notes: { prefs: 'C++', lastSummary: '讲了投影矩阵' } })
    expect(text.indexOf('上次小结')).toBeLessThan(text.indexOf('prefs'))
    expect(text).toContain('记忆（2 条）')
  })

  test('formatMemoryEmpty', () => {
    expect(formatMemory({ notes: {} })).toBe('暂无记忆。')
  })
})
