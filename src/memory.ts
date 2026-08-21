/**
 * 跨会话记忆：vault `.study/memory.json`，键值笔记 + 保留键 `lastSummary`
 * （上次会话小结）。与 progress.json（临时进度位置）相互独立——
 * "清空进度"不触碰记忆，彻底重来才 study_memory(clear)。
 * @module memory
 */

import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWrite, ensureDir } from './vault.ts'

/** 单条记忆值的长度上限（字符） */
export const MAX_MEMORY_VALUE = 4000
/** 记忆键名长度上限（字符） */
export const MAX_MEMORY_KEY = 64
/** 保留键：上次会话小结（get 时置顶显示） */
export const SUMMARY_KEY = 'lastSummary'

export interface MemoryState {
  notes: Record<string, string>
  updatedAt?: string
}

export async function readMemory(file: string): Promise<MemoryState> {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { notes: {} }
    const notes: Record<string, string> = {}
    if (parsed.notes && typeof parsed.notes === 'object' && !Array.isArray(parsed.notes)) {
      for (const [key, value] of Object.entries(parsed.notes as Record<string, unknown>)) {
        if (typeof key === 'string' && typeof value === 'string' && key.length > 0) notes[key] = value
      }
    }
    const state: MemoryState = { notes }
    if (typeof parsed.updatedAt === 'string') state.updatedAt = parsed.updatedAt
    return state
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { notes: {} }
    throw new Error(`记忆文件损坏：${(error as Error).message}`)
  }
}

export async function writeMemory(file: string, state: MemoryState): Promise<void> {
  await ensureDir(dirname(file))
  const next = { ...state, updatedAt: new Date().toISOString() }
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`)
}

/** 校验并规范化记忆键名：trim 后非空、≤64 字符、不含控制字符 */
export function normalizeMemoryKey(key: string): string {
  const k = String(key).trim()
  if (!k) throw new Error('记忆键名不能为空')
  if (k.length > MAX_MEMORY_KEY) throw new Error(`记忆键名过长（≤${MAX_MEMORY_KEY} 字符）：${k.slice(0, 20)}…`)
  if (/[\u0000-\u001f]/.test(k)) throw new Error('记忆键名不能包含控制字符')
  return k
}

/** 校验记忆值：字符串且 ≤4000 字符 */
export function checkMemoryValue(value: string): string {
  const v = String(value)
  if (v.length > MAX_MEMORY_VALUE) {
    throw new Error(`记忆内容过长（≤${MAX_MEMORY_VALUE} 字符，当前 ${v.length}），请精简后再记`)
  }
  return v
}

/** 格式化整份记忆：lastSummary 置顶为"上次小结"，其余键按名排序 */
export function formatMemory(state: MemoryState): string {
  const entries = Object.entries(state.notes).sort(([a], [b]) => (a === SUMMARY_KEY ? -1 : b === SUMMARY_KEY ? 1 : a.localeCompare(b)))
  if (entries.length === 0) return '暂无记忆。'
  const lines = entries.map(([key, value]) => {
    if (key === SUMMARY_KEY) return `上次小结：${value}`
    return `- ${key}：${value}`
  })
  return `记忆（${entries.length} 条）\n${lines.join('\n')}`
}
