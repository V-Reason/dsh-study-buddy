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

  test('旧版 progress.json 缺少计划字段时仍可读取', async () => {
    await writeFileDirect(file, JSON.stringify({
      currentMaterial: 'Unity',
      currentSection: 'W1',
      updatedAt: '2026-10-28T00:00:00.000Z',
    }))
    await expect(readProgress(file)).resolves.toMatchObject({
      currentMaterial: 'Unity',
      currentSection: 'W1',
    })
  })

  test('计划上下文可往返且不丢旧字段', async () => {
    const state = {
      currentMaterial: '求职主线',
      currentSection: 'W1',
      planRef: 'plan.md',
      phase: 'B 3D 数学与流程',
      nextAction: '四元数验证',
      doneWhen: '闭卷解释万向锁',
      lastOutcome: '相机投影完成',
      parallelLines: ['算法：链表'],
    }
    await writeProgress(file, state)
    expect(await readProgress(file)).toMatchObject(state)
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
