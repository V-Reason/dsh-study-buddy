/**
 * 规划存储：vault `.study/plans/<planId>.json`。
 *
 * 这是"文件夹规划"这条硬门禁的凭据（需求 F2 / 架构选型 §4.3）。先规划后落盘，
 * 是为了解决旧模型"笔记被无脑堆进同一目录"的老问题——目录结构由用户在写之前
 * 拍板，而不是由领域键在写之时被动决定。
 *
 * 三条设计约束：
 * - **提案只在对话里**（需求 R11）：vault 里不出现可见的规划文件；这里存的只是
 *   凭据与消费记录，删掉不影响任何笔记。
 * - **凭据可放弃、会过期**：用户改主意 → `abandonPlan`；搁置太久 → `planTtlHours`
 *   之后失效。门禁必须可解，否则一次误操作会把笔记写入永久锁死。
 * - **消费按标题记账**：同一规划里同一个标题只能写一次，防止"边写边改结构"
 *   （写入路径必须在提案范围内，且不能借同一条目反复写不同内容）。
 * @module planstore
 */

import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertDirPath, normRel } from './dirs.ts'
import { atomicWrite, ensureDir, withinRoot } from './vault.ts'

/** 规划项：一个待落的块 */
export interface PlanItem {
  title: string
  /** vault 内相对路径（含文件名） */
  path: string
  /** 来源章节（`《资料》第N章 标题 / N.N节`），可省略 */
  sourceSection?: string
  /** 同目录阅读顺序 */
  order?: number
}

export interface ConsumedItem {
  title: string
  rel: string
  at: string
}

export interface PlanRecord {
  planId: string
  createdAt: string
  confirmed: boolean
  confirmedAt?: string
  /** 规划根：所有 `items[].path` 必须落在它之下 */
  rootPath: string
  material?: string
  notes?: string
  items: PlanItem[]
  /** 本次规划将新建的目录（仅用于回显与确认，不预创建） */
  createdDirs: string[]
  consumed: ConsumedItem[]
}

/** 默认有效期（小时）：超过则规划失效，必须重新提案 */
export const DEFAULT_PLAN_TTL_HOURS = 24

/** 两位补零（月份/日期/小时/分钟都是 1 位或 2 位，必须补满才凑得齐 12 位时间戳） */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 规划 id：与笔记 ID 同源格式，便于人工核对（`YYYYMMDDHHmm` + 6 位随机）。
 *
 * **每个两位字段都要补零**：`planFileFor` 的校验式要求恰好 12 位时间戳。
 * 只要有一处漏补，00:00~09:59（或每月 1~9 日）生成的 id 就只有 11 位，
 * 同一个 id 传给 confirm / note_write 会被自己的合法性校验拒绝——
 * "凭据刚发出去就读不回来"，正是门禁最该避免的死锁（实测于 23:05，漏的是小时位）。
 */
export function generatePlanId(now = new Date()): string {
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}`
  return `${stamp}_${randomBytes(3).toString('hex')}`
}

/** `.study/plans/<planId>.json` 的绝对路径（越界或非法 id 即抛错） */
export function planFileFor(vaultRoot: string, planId: string, stateDir = '.study'): string {
  const id = String(planId ?? '').trim()
  if (!/^[0-9]{12}_[0-9a-f]{6}$/.test(id)) throw new Error(`规划 id 非法：${id || '(空)'}`)
  const p = join(vaultRoot, stateDir, 'plans', `${id}.json`)
  if (!withinRoot(vaultRoot, p)) throw new Error('规划文件路径越界')
  return p
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** 宽容读取：文件不存在或损坏返回 `null`（调用方判定"规划无效"，不抛错阻断） */
export async function readPlan(file: string): Promise<PlanRecord | null> {
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.planId !== 'string' || typeof obj.rootPath !== 'string' || !Array.isArray(obj.items)) return null
  const items: PlanItem[] = []
  for (const raw of obj.items) {
    if (raw === null || typeof raw !== 'object') continue
    const it = raw as Record<string, unknown>
    if (typeof it.title !== 'string' || typeof it.path !== 'string') continue
    const item: PlanItem = { title: it.title.trim(), path: normRel(it.path) }
    if (typeof it.sourceSection === 'string' && it.sourceSection.trim()) item.sourceSection = it.sourceSection.trim()
    if (typeof it.order === 'number' && Number.isFinite(it.order)) item.order = it.order
    if (item.title && item.path) items.push(item)
  }
  const consumed: ConsumedItem[] = []
  for (const raw of Array.isArray(obj.consumed) ? obj.consumed : []) {
    if (raw === null || typeof raw !== 'object') continue
    const c = raw as Record<string, unknown>
    if (typeof c.title === 'string' && typeof c.rel === 'string') {
      consumed.push({ title: c.title, rel: normRel(c.rel), at: typeof c.at === 'string' ? c.at : '' })
    }
  }
  const record: PlanRecord = {
    planId: obj.planId,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : '',
    confirmed: obj.confirmed === true,
    rootPath: assertDirPath(obj.rootPath),
    items,
    createdDirs: asStringArray(obj.createdDirs).map((d) => normRel(d)),
    consumed,
  }
  if (typeof obj.confirmedAt === 'string') record.confirmedAt = obj.confirmedAt
  if (typeof obj.material === 'string' && obj.material.trim()) record.material = obj.material.trim()
  if (typeof obj.notes === 'string' && obj.notes.trim()) record.notes = obj.notes.trim()
  return record
}

export async function writePlan(file: string, record: PlanRecord): Promise<void> {
  await ensureDir(dirname(file))
  await atomicWrite(file, `${JSON.stringify(record, null, 2)}\n`)
}

export interface CreatePlanInput {
  rootPath: string
  items: PlanItem[]
  material?: string
  notes?: string
  now?: Date
}

/**
 * 建规划记录（提案即落凭据，但 **`confirmed` 恒为 false**）。
 *
 * 置位只发生在 `notePlan(action=confirm)`：门禁的第二环要求"用户显式拍板"，
 * 而这一步由工具的 confirm 分支完成（覆盖写同一条记录并盖 `confirmedAt`）。
 * 提案与确认是同一条记录的两次写，因此用户改结构时直接重提一次即可。
 */
export function buildPlanRecord(input: CreatePlanInput, planId = generatePlanId(input.now)): PlanRecord {
  const rootPath = assertDirPath(input.rootPath)
  const items: PlanItem[] = []
  const seen = new Set<string>()
  for (const raw of input.items ?? []) {
    const title = String(raw?.title ?? '').trim()
    const path = normRel(raw?.path ?? '')
    if (!title || !path) throw new Error('规划项必须同时给出 title 与 path')
    if (seen.has(title)) throw new Error(`规划项标题重复：${title}（同一规划内标题必须唯一，消费按标题记账）`)
    if (!path.startsWith(rootPath === '' ? '' : `${rootPath}/`)) {
      throw new Error(`规划项 "${title}" 的路径不在规划根之下（${rootPath || 'vault 根'}）：${path}`)
    }
    seen.add(title)
    const item: PlanItem = { title, path }
    if (raw.sourceSection && String(raw.sourceSection).trim()) item.sourceSection = String(raw.sourceSection).trim()
    if (typeof raw.order === 'number' && Number.isFinite(raw.order)) item.order = raw.order
    items.push(item)
  }
  if (items.length === 0) throw new Error('规划至少需要一个待落块（items 不能为空）')
  const record: PlanRecord = {
    planId,
    createdAt: (input.now ?? new Date()).toISOString(),
    confirmed: false,
    rootPath,
    items,
    createdDirs: [],
    consumed: [],
  }
  if (input.material?.trim()) record.material = input.material.trim()
  if (input.notes?.trim()) record.notes = input.notes.trim()
  return record
}

/** 是否已过期（`createdAt` 解析不出时按"未过期"处理：宁可多问一次，不可误判失效） */
export function isPlanExpired(record: PlanRecord, ttlHours = DEFAULT_PLAN_TTL_HOURS, now = new Date()): boolean {
  const created = Date.parse(record.createdAt)
  if (!Number.isFinite(created)) return false
  return now.getTime() - created > ttlHours * 3600_000
}

export interface ConsumeResult {
  ok: boolean
  /** 失败原因（中文，供门禁拼装修复提示）；`ok === true` 时为空 */
  reason?: string
}

/**
 * 消费一个规划项并落盘消费记录。
 *
 * 校验（顺序即优先级）：未确认 → 已过期 → 标题不在规划里 → 该标题已消费。
 * 通过后把 `consumed` 追加一条并写盘；**写盘失败即视为失败**——宁可让调用方
 * 重试，也不要出现"文件写了、记录没记"从而可以重复写的口子。
 */
export async function consumePlanItem(
  file: string,
  title: string,
  rel: string,
  opts: { ttlHours?: number; now?: Date } = {},
): Promise<ConsumeResult> {
  const record = await readPlan(file)
  if (!record) return { ok: false, reason: '规划记录不存在' }
  if (!record.confirmed) return { ok: false, reason: '规划尚未确认；请先用 note_plan(action=confirm) 确认后再提交' }
  if (isPlanExpired(record, opts.ttlHours ?? DEFAULT_PLAN_TTL_HOURS, opts.now)) {
    return { ok: false, reason: '规划已过期；请重新提案并确认（确认后有效期重新起算）' }
  }
  const wanted = String(title ?? '').trim()
  const item = record.items.find((it) => it.title === wanted)
  if (!item) return { ok: false, reason: `标题不在本次规划内：${wanted}` }
  if (record.consumed.some((c) => c.title === wanted)) {
    return { ok: false, reason: `该块已在本规划中写入过：${wanted}（如需重写，请重新规划或改用 note_update）` }
  }
  record.consumed.push({ title: wanted, rel: normRel(rel), at: (opts.now ?? new Date()).toISOString() })
  await writePlan(file, record)
  return { ok: true }
}

/** 放弃规划：删除记录（幂等，文件不存在也成功） */
export async function abandonPlan(file: string): Promise<void> {
  await fsp.rm(file, { force: true })
}

/** 规划根下的目标路径是否在范围内 */
export function pathInPlan(record: PlanRecord, rel: string): boolean {
  const path = normRel(rel)
  const root = record.rootPath
  if (root === '') return true
  return path === root || path.startsWith(`${root}/`)
}
