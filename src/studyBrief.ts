/**
 * 学习简报：把持久化进度整理成计划入口所需的紧凑上下文。
 *
 * 这里只做文本归一与渲染，不推断用户是否完成，也不生成复习提醒。
 * @module studyBrief
 */

import type { ProgressState } from './state.ts'

export const MAX_BRIEF_TEXT = 500
export const MAX_PARALLEL_LINES = 10
export const MAX_PARALLEL_CHARS = 200

export function normalizeBriefText(value: string, label: string): string {
  const text = String(value ?? '').trim()
  if (/[\r\n]/.test(text)) throw new Error(`${label} 不能包含换行`)
  if (text.length > MAX_BRIEF_TEXT) {
    throw new Error(`${label} 过长（≤${MAX_BRIEF_TEXT} 字符）`)
  }
  return text
}

export function normalizeParallelLines(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  const lines = [...new Set(values.map((v) => normalizeBriefText(v, 'parallelLines 项')).filter(Boolean))]
  if (lines.length > MAX_PARALLEL_LINES) {
    throw new Error(`parallelLines 最多 ${MAX_PARALLEL_LINES} 条`)
  }
  for (const line of lines) {
    if (line.length > MAX_PARALLEL_CHARS) {
      throw new Error(`parallelLines 单项不能超过 ${MAX_PARALLEL_CHARS} 字符`)
    }
  }
  return lines
}

export function formatStudyBrief(state: ProgressState): string {
  const lines: string[] = []
  if (state.planRef) lines.push(`计划：${state.planRef}`)
  if (state.phase) lines.push(`阶段：${state.phase}`)
  const position = [state.currentMaterial, state.currentSection].filter(Boolean).join(' / ')
  if (position) lines.push(`当前位置：${position}`)
  if (state.nextAction) lines.push(`下一步：${state.nextAction}`)
  if (state.doneWhen) lines.push(`完成判据：${state.doneWhen}`)
  if (state.lastOutcome) lines.push(`最近结果：${state.lastOutcome}`)
  if (state.parallelLines?.length) lines.push(`并行进度：${state.parallelLines.join('；')}`)
  if (state.pendingQuestions?.length) lines.push(`待解决问题：${state.pendingQuestions.join('；')}`)
  if (state.updatedAt) lines.push(`进度更新：${state.updatedAt}`)
  return lines.length > 0 ? lines.join('\n') : '尚未记录学习计划上下文。'
}
