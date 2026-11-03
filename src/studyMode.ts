/**
 * 学习讲解模式：根据相关笔记、主题接触时间和用户覆盖选择快速或详细。
 *
 * 纯函数模块，不读写文件。无法确定时一律选择完整讲解，避免把陌生知识
 * 误当成“已经学过”而压缩掉必要机理。
 * @module studyMode
 */

export type StudyMode = 'quick' | 'full'
export type StudyModeOverride = StudyMode | 'auto'
export type ContactKind = 'lecture' | 'qa' | 'note-read' | 'note-write' | 'review'

export interface StudyModeArgs {
  topic?: string
  mode?: StudyModeOverride
  kind?: ContactKind
  relatedNotes?: string[]
}

export interface ModeInput {
  override?: StudyModeOverride
  hasRelatedNote: boolean
  lastContactAt?: string
  windowDays?: number
  now?: Date
}

export interface ModeDecision {
  mode: StudyMode
  reason: 'override' | 'no-note' | 'no-contact' | 'recent' | 'stale'
  ageDays: number | null
}

export const DEFAULT_MODE_WINDOW_DAYS = 30
export const MAX_MODE_WINDOW_DAYS = 3650

const DAY_MS = 24 * 60 * 60 * 1000
const MODE_WINDOW_RE = /^\s*-\s*\[设置\]\s*快节奏复习窗口\s*[：:]\s*(\d+)\s*天?\s*$/m

/** 把外部输入归一为工具支持的三档覆盖值。 */
export function normalizeStudyMode(value: unknown): StudyModeOverride {
  const mode = String(value ?? '').trim().toLowerCase()
  return mode === 'quick' || mode === 'full' ? mode : 'auto'
}

/** 从《笔记期望.md》读取可选的复习窗口，缺失或越界时使用 30 天。 */
export function parseModeWindowDays(expectText: string): number {
  const match = MODE_WINDOW_RE.exec(String(expectText ?? ''))
  if (!match) return DEFAULT_MODE_WINDOW_DAYS
  const value = Number(match[1])
  if (!Number.isInteger(value) || value < 1 || value > MAX_MODE_WINDOW_DAYS) {
    return DEFAULT_MODE_WINDOW_DAYS
  }
  return value
}

/** 解析完整时间；无效值返回 null，由调用方保守回退到详细模式。 */
function parseContactTime(value: string | undefined): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

/**
 * 选择讲解模式。
 *
 * 优先级：用户覆盖 > 相关笔记 > 实质接触记录 > 复习窗口。
 * “30 天以内”包含第 30 天；从第 31 天起退回完整讲解。
 */
export function resolveStudyMode(input: ModeInput): ModeDecision {
  const override = normalizeStudyMode(input.override)
  const contact = parseContactTime(input.lastContactAt)
  const now = input.now instanceof Date && Number.isFinite(input.now.getTime())
    ? input.now.getTime()
    : Date.now()
  const ageDays = contact === null ? null : Math.max(0, Math.floor((now - contact) / DAY_MS))

  if (override === 'quick' || override === 'full') {
    return { mode: override, reason: 'override', ageDays }
  }
  if (!input.hasRelatedNote) return { mode: 'full', reason: 'no-note', ageDays }
  if (contact === null) return { mode: 'full', reason: 'no-contact', ageDays }

  const requestedWindow = Number(input.windowDays)
  const windowDays = Number.isInteger(requestedWindow) && requestedWindow >= 1 && requestedWindow <= MAX_MODE_WINDOW_DAYS
    ? requestedWindow
    : DEFAULT_MODE_WINDOW_DAYS
  return ageDays! <= windowDays
    ? { mode: 'quick', reason: 'recent', ageDays }
    : { mode: 'full', reason: 'stale', ageDays }
}
