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
/** 保留控制键：自迭代记忆开关（on/off，缺省关闭）。「_」前缀键为控制键，不参与普通计数。 */
export const AUTO_PREFS_KEY = '_autoPrefs'
/** 自迭代开关的合法值 */
export const AUTO_PREFS_VALUES = ['on', 'off'] as const
/** 自迭代开关的缺省值（键不存在即视为该值） */
export const AUTO_PREFS_DEFAULT = 'off'

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

/** 进度句特征：正在学习/当前位置的表述（这类句子若存在偏好键里，很容易与 study_progress 过期不同步） */
const PROGRESS_SENTENCE_RE = /现学|正在学|当前学习|现在学到/

export interface StaleProgressHit {
  key: string
  snippet: string
}

/**
 * 检测记忆中疑似过期的进度句（进度位置应单一来源 study_progress；
 * prefs.* 只存偏好/惯例）。返回命中键与片段（≤3 条）。
 */
export function findProgressSentences(notes: Record<string, string>): StaleProgressHit[] {
  const hits: StaleProgressHit[] = []
  for (const [key, value] of Object.entries(notes)) {
    if (isControlKey(key)) continue
    if (!PROGRESS_SENTENCE_RE.test(value)) continue
    const m = PROGRESS_SENTENCE_RE.exec(value)
    const start = Math.max(0, (m?.index ?? 0) - 8)
    const snippet = value.slice(start, start + 40).replace(/\s+/g, ' ').trim()
    hits.push({ key, snippet })
    if (hits.length >= 3) break
  }
  return hits
}

/** 是否为保留控制键（「_」前缀）；控制键由插件维护，不计入普通记忆条数 */
export function isControlKey(key: string): boolean {
  return key.startsWith('_')
}

/** 校验自迭代开关值：trim 后必须为 on/off */
export function normalizeAutoPrefsValue(value: string): string {
  const v = String(value).trim()
  if (v !== 'on' && v !== 'off') {
    throw new Error(`自迭代开关只接受 on/off（收到 "${v.slice(0, 20)}"）；用 "开启自迭代" / "关闭自迭代" 切换`)
  }
  return v
}

/** 格式化开关状态行（供 get 单键与 formatMemory 复用） */
export function formatAutoPrefs(value: string | undefined): string {
  if (value === undefined) return `自迭代记忆：关闭（默认；"开启自迭代"打开）`
  if (!AUTO_PREFS_VALUES.includes(value as (typeof AUTO_PREFS_VALUES)[number])) {
    return `自迭代记忆：异常值（${value.slice(0, 40)}）——请重新设置为 on/off`
  }
  return `自迭代记忆：${value === 'on' ? '开启（自动记录偏好）' : '关闭'}`
}

/** 格式化整份记忆：开关状态行置顶（如有），lastSummary 置顶为"上次小结"，其余键按名排序 */
export function formatMemory(state: MemoryState): string {
  const entries = Object.entries(state.notes)
    .filter(([key]) => !isControlKey(key))
    .sort(([a], [b]) => (a === SUMMARY_KEY ? -1 : b === SUMMARY_KEY ? 1 : a.localeCompare(b)))
  const lines: string[] = []
  if (state.notes[AUTO_PREFS_KEY] !== undefined) lines.push(formatAutoPrefs(state.notes[AUTO_PREFS_KEY]))
  if (entries.length === 0) return lines.length > 0 ? lines.join('\n') : '暂无记忆。'
  lines.push(`记忆（${entries.length} 条）`)
  for (const [key, value] of entries) {
    lines.push(key === SUMMARY_KEY ? `上次小结：${value}` : `- ${key}：${value}`)
  }
  return lines.join('\n')
}
