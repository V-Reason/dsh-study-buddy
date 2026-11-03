import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  MAX_LEARNING_TOPICS,
  emptyLearningState,
  normalizeTopicKey,
  readLearningState,
  touchLearningState,
  writeLearningState,
} from '../src/learningState.ts'

const dirs: string[] = []

async function tempFile(name = 'learning.json'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'study-buddy-learning-'))
  dirs.push(dir)
  return join(dir, '.study', name)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('learning state', () => {
  test('主题键做 NFKC、大小写与空白归一', () => {
    expect(normalizeTopicKey('  ＰＢＲ   IBL  ')).toBe('pbr ibl')
  })

  test('空主题拒绝记录', () => {
    expect(() => normalizeTopicKey('   ')).toThrow(/主题/)
  })

  test('首次接触创建足迹并去重相关笔记', () => {
    const next = touchLearningState(emptyLearningState(), {
      topic: 'PBR',
      kind: 'lecture',
      mode: 'full',
      relatedNotes: ['id-b', 'id-a', 'id-a'],
      now: new Date('2026-11-03T02:00:00.000Z'),
    })
    expect(next.topics.pbr).toEqual({
      label: 'PBR',
      lastContactAt: '2026-11-03T02:00:00.000Z',
      lastMode: 'full',
      contactCount: 1,
      relatedNotes: ['id-a', 'id-b'],
    })
  })

  test('重复接触更新同一条记录且递增计数', () => {
    const first = touchLearningState(emptyLearningState(), {
      topic: 'PBR',
      kind: 'lecture',
      mode: 'full',
      now: new Date('2026-11-01T00:00:00.000Z'),
    })
    const next = touchLearningState(first, {
      topic: ' pbr ',
      kind: 'review',
      mode: 'quick',
      relatedNotes: ['id-b'],
      now: new Date('2026-11-03T00:00:00.000Z'),
    })
    expect(next.topics.pbr).toMatchObject({
      lastMode: 'quick',
      contactCount: 2,
      relatedNotes: ['id-b'],
    })
  })

  test('无效当前时间拒绝写入', () => {
    expect(() => touchLearningState(emptyLearningState(), {
      topic: 'PBR',
      kind: 'qa',
      mode: 'quick',
      now: new Date('invalid'),
    })).toThrow(/时间/)
  })

  test('容量超过上限时淘汰最久未接触主题', () => {
    const topics = emptyLearningState().topics
    for (let i = 0; i < MAX_LEARNING_TOPICS; i += 1) {
      topics[`topic-${String(i).padStart(4, '0')}`] = {
        label: `Topic ${i}`,
        lastContactAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        lastMode: 'full',
        contactCount: 1,
        relatedNotes: [],
      }
    }
    const next = touchLearningState({ version: 1, topics }, {
      topic: 'new-topic',
      kind: 'lecture',
      mode: 'full',
      now: new Date('2026-12-01T00:00:00.000Z'),
    })
    expect(Object.keys(next.topics)).toHaveLength(MAX_LEARNING_TOPICS)
    expect(next.topics['topic-0000']).toBeUndefined()
    expect(next.topics['new-topic']).toBeDefined()
  })

  test('原子写入后可以完整读回', async () => {
    const file = await tempFile()
    const state = touchLearningState(emptyLearningState(), {
      topic: 'PBR',
      kind: 'note-write',
      mode: 'full',
      relatedNotes: ['202611030900_ab12cd'],
      now: new Date('2026-11-03T02:00:00.000Z'),
    })
    await writeLearningState(file, state)
    expect(await readLearningState(file)).toEqual(state)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, topics: { pbr: { label: 'PBR' } } })
  })

  test('不存在的状态文件返回空状态', async () => {
    expect(await readLearningState(await tempFile())).toEqual(emptyLearningState())
  })

  test('损坏 JSON 和错误版本 fail-loud', async () => {
    const file = await tempFile()
    await writeLearningState(file, emptyLearningState())
    await writeFile(file, '{bad json', 'utf8')
    await expect(readLearningState(file)).rejects.toThrow(/学习足迹文件损坏/)
    await writeFile(file, '{"version":2,"topics":{}}', 'utf8')
    await expect(readLearningState(file)).rejects.toThrow(/版本/)
  })
})
