import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readProgress, writeProgress } from '../src/state.ts'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'study-buddy-state-'))
  file = join(dir, '.study', 'progress.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeFileDirect(p: string, content: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, content, 'utf8')
}

describe('state', () => {
  test('missingFileReadsEmpty', async () => {
    expect(await readProgress(file)).toEqual({})
  })

  test('roundtrip', async () => {
    await writeProgress(file, {
      currentMaterial: 'GAMES101 L04',
      currentSection: '透视投影·平移部分',
      pendingQuestions: ['为什么 w 要归一化？'],
      touchedCardIds: ['202608161430_ab12'],
    })
    const state = await readProgress(file)
    expect(state.currentMaterial).toBe('GAMES101 L04')
    expect(state.pendingQuestions).toEqual(['为什么 w 要归一化？'])
    expect(state.updatedAt).toBeTruthy()
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('"currentSection"')
  })

  test('dirtyTypesAreDropped', async () => {
    await writeFileDirect(file, JSON.stringify({
      currentMaterial: 123,
      pendingQuestions: ['好问题', 42],
      touchedCardIds: 'not-array',
    }))
    const state = await readProgress(file)
    expect(state.currentMaterial).toBeUndefined()
    expect(state.pendingQuestions).toEqual(['好问题'])
    expect(state.touchedCardIds).toBeUndefined()
  })

  test('corruptJsonThrows', async () => {
    await writeFileDirect(file, '{ 不是 JSON')
    await expect(readProgress(file)).rejects.toThrow('损坏')
  })
})
