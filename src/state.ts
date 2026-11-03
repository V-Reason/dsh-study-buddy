/**
 * 学习进度状态：vault `.study/progress.json`，跨会话/跨重启持久。
 * @module state
 */

import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWrite, ensureDir } from './vault.ts'

export interface ProgressState {
  currentMaterial?: string
  currentSection?: string
  pendingQuestions?: string[]
  touchedCardIds?: string[]
  /** 当前完整计划文档的笔记引用（路径/标题/ID） */
  planRef?: string
  /** 当前主阶段，如 `B 3D 数学与流程` */
  phase?: string
  /** 当前真正应做的下一动作 */
  nextAction?: string
  /** 该动作的完成判据 */
  doneWhen?: string
  /** 最近已完成结果 */
  lastOutcome?: string
  /** 八股/算法/投递等并行线的简短状态 */
  parallelLines?: string[]
  updatedAt?: string
}

export async function readProgress(file: string): Promise<ProgressState> {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const state: ProgressState = {}
    if (typeof parsed.currentMaterial === 'string') state.currentMaterial = parsed.currentMaterial
    if (typeof parsed.currentSection === 'string') state.currentSection = parsed.currentSection
    if (Array.isArray(parsed.pendingQuestions)) {
      state.pendingQuestions = parsed.pendingQuestions.filter((q: unknown) => typeof q === 'string')
    }
    if (Array.isArray(parsed.touchedCardIds)) {
      state.touchedCardIds = parsed.touchedCardIds.filter((q: unknown) => typeof q === 'string')
    }
    if (typeof parsed.planRef === 'string') state.planRef = parsed.planRef
    if (typeof parsed.phase === 'string') state.phase = parsed.phase
    if (typeof parsed.nextAction === 'string') state.nextAction = parsed.nextAction
    if (typeof parsed.doneWhen === 'string') state.doneWhen = parsed.doneWhen
    if (typeof parsed.lastOutcome === 'string') state.lastOutcome = parsed.lastOutcome
    if (Array.isArray(parsed.parallelLines)) {
      state.parallelLines = parsed.parallelLines.filter((line: unknown) => typeof line === 'string')
    }
    if (typeof parsed.updatedAt === 'string') state.updatedAt = parsed.updatedAt
    return state
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    throw new Error(`学习进度文件损坏：${(error as Error).message}`)
  }
}

export async function writeProgress(file: string, state: ProgressState): Promise<void> {
  await ensureDir(dirname(file))
  const next = { ...state, updatedAt: new Date().toISOString() }
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`)
}
