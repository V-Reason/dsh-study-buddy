/**
 * 主题学习足迹：`<vault>/.study/learning.json`。
 *
 * 只记录“何时实质接触过哪个主题”，不复制笔记正文。主题数设硬上限，
 * 防止长期使用后状态文件无限增长。
 * @module learningState
 */

import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import type { ContactKind, StudyMode } from './studyMode.ts'
import { atomicWrite, ensureDir } from './vault.ts'

export const LEARNING_STATE_VERSION = 1
export const MAX_LEARNING_TOPICS = 2000

export interface TopicFootprint {
  label: string
  lastContactAt: string
  lastMode: StudyMode
  contactCount: number
  relatedNotes: string[]
}

export interface LearningState {
  version: typeof LEARNING_STATE_VERSION
  topics: Record<string, TopicFootprint>
}

export interface TouchLearningInput {
  topic: string
  kind: ContactKind
  mode: StudyMode
  relatedNotes?: string[]
  now?: Date
}

const CONTACT_KINDS = new Set<ContactKind>(['lecture', 'qa', 'note-read', 'note-write', 'review'])

export function emptyLearningState(): LearningState {
  return { version: LEARNING_STATE_VERSION, topics: {} }
}

/**
 * 主题标识只做确定性文本归一，不做语义合并。
 * 调用方应使用同一标题或用户确认后的规范主题名，避免近义词各记一条。
 */
export function normalizeTopicKey(topic: string): string {
  const key = String(topic ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  if (!key) throw new Error('主题不能为空')
  return key
}

function validFootprint(value: unknown): value is TopicFootprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.label === 'string'
    && entry.label.trim().length > 0
    && typeof entry.lastContactAt === 'string'
    && Number.isFinite(Date.parse(entry.lastContactAt))
    && (entry.lastMode === 'quick' || entry.lastMode === 'full')
    && Number.isInteger(entry.contactCount)
    && Number(entry.contactCount) > 0
    && Array.isArray(entry.relatedNotes)
    && entry.relatedNotes.every((note) => typeof note === 'string')
}

function parseLearningState(raw: string): LearningState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`学习足迹文件损坏，无法解析 JSON：${(error as Error).message}（修复或删除 .study/learning.json 后重试）`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('学习足迹文件损坏：顶层必须是对象（修复或删除 .study/learning.json 后重试）')
  }
  const value = parsed as Record<string, unknown>
  if (value.version !== LEARNING_STATE_VERSION) {
    throw new Error(`学习足迹文件版本不受支持：${String(value.version)}（当前只支持 ${LEARNING_STATE_VERSION}）`)
  }
  if (!value.topics || typeof value.topics !== 'object' || Array.isArray(value.topics)) {
    throw new Error('学习足迹文件损坏：topics 必须是对象（修复或删除 .study/learning.json 后重试）')
  }
  const topics: Record<string, TopicFootprint> = {}
  for (const [key, entry] of Object.entries(value.topics as Record<string, unknown>)) {
    if (!key || !validFootprint(entry)) {
      throw new Error(`学习足迹文件损坏：主题 "${key}" 字段不完整（修复或删除 .study/learning.json 后重试）`)
    }
    topics[key] = {
      ...entry,
      relatedNotes: [...entry.relatedNotes],
    }
  }
  return { version: LEARNING_STATE_VERSION, topics }
}

export async function readLearningState(file: string): Promise<LearningState> {
  try {
    return parseLearningState(await fsp.readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyLearningState()
    throw error
  }
}

export async function writeLearningState(file: string, state: LearningState): Promise<void> {
  await ensureDir(dirname(file))
  await atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`)
}

function pruneTopics(topics: Record<string, TopicFootprint>): Record<string, TopicFootprint> {
  const entries = Object.entries(topics)
  if (entries.length <= MAX_LEARNING_TOPICS) return topics
  entries.sort(([keyA, a], [keyB, b]) => {
    const diff = Date.parse(b.lastContactAt) - Date.parse(a.lastContactAt)
    return diff !== 0 ? diff : keyA < keyB ? -1 : keyA > keyB ? 1 : 0
  })
  return Object.fromEntries(entries.slice(0, MAX_LEARNING_TOPICS))
}

/**
 * 形成新的足迹状态；不修改入参。
 *
 * 所有五种实质接触都会刷新时间并递增计数。`kind` 在此参与输入校验，
 * 具体类型保留在调用边界，不复制进长期状态。
 */
export function touchLearningState(state: LearningState, input: TouchLearningInput): LearningState {
  const key = normalizeTopicKey(input.topic)
  if (!CONTACT_KINDS.has(input.kind)) throw new Error(`未知接触类型：${String(input.kind)}`)
  if (input.mode !== 'quick' && input.mode !== 'full') throw new Error(`未知讲解模式：${String(input.mode)}`)
  const now = input.now ?? new Date()
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('学习足迹时间无效')
  }
  const previous = state.topics[key]
  const relatedNotes = [...new Set((input.relatedNotes ?? []).map((note) => String(note).trim()).filter(Boolean))].sort()
  const topics: Record<string, TopicFootprint> = {
    ...state.topics,
    [key]: {
      label: String(input.topic).trim(),
      lastContactAt: now.toISOString(),
      lastMode: input.mode,
      contactCount: (previous?.contactCount ?? 0) + 1,
      relatedNotes,
    },
  }
  return { version: LEARNING_STATE_VERSION, topics: pruneTopics(topics) }
}
