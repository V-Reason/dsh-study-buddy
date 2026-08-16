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
