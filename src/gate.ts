/**
 * 写入硬门禁：三连校验（架构选型 §5.1）。
 *
 * 需求 R25 明确要求"未读期望 / 未确认规划 / 越界路径 → 拒绝写入"，且**由工具强制**
 * 而不是写进 persona 靠模型自觉。原因很直接：persona 是提示词，模型可能忘；
 * 而门禁一旦落成进程内状态，DSH 重启就凭空失效。所以状态落 `.study/`（磁盘），
 * 校验放工具里（每次写入前跑一遍）。
 *
 * 三条校验各自的"可修复性"同样重要——每条失败都带**具体到调用的修复步骤**，
 * 否则门禁会把用户永久锁在外面（需求 §十 风险 4）。
 * @module gate
 */

import { EXPECT_FILE, expectPathFor } from './dirs.ts'
import {
  DEFAULT_PLAN_TTL_HOURS, isPlanExpired, pathInPlan, planFileFor, readPlan, type PlanRecord,
} from './planstore.ts'
import type { SessionState } from './store.ts'

export interface GateOk {
  ok: true
  /** 本次写入所属的规划（未要求规划时为 null，如 `note_update`） */
  plan: PlanRecord | null
}

export interface GateBlocked {
  ok: false
  /** 失败原因（中文一句话，供工具直接抛错） */
  reason: string
}

export type GateResult = GateOk | GateBlocked

export interface GateInput {
  vaultRoot: string
  stateDir: string
  /** 当前会话状态（已读期望签名 + 待消费规划 id） */
  session: SessionState
  /** 当前《笔记期望.md》的文件签名；`null` = 文件不存在 */
  expectSignature: string | null
  /** 是否要求必须先读完期望（`note_write` 要求，`note_update` / `note_toc` 不要求） */
  requireExpect?: boolean
  /** 本次写入目标（vault 内相对路径）；`note_write` 要求 */
  targetRel?: string
  /** 是否要求必须有已确认的规划（`note_write` 要求） */
  requirePlan?: boolean
  /** 规划有效期（小时） */
  planTtlHours?: number
}

/** 组合一条报错：第一句说清怎么了，第二句给出可执行的下一步 */
function blocked(reason: string, fix?: string): GateBlocked {
  return { ok: false, reason: fix ? `${reason}——${fix}` : reason }
}

/**
 * 校验一：笔记期望已读且未过期。
 *
 * 用**文件签名**而非"读过一次"的布尔值：用户中途改了期望，签名就变，下次写入
 * 前必须重读（需求 F1 要求热配置立即生效）。文件缺失时**不回退**到内建默认写法
 * （架构选型 A14）——回退会让"约束只从期望文件来"重新变成两处口径。
 */
export function checkExpect(input: GateInput): GateResult {
  const expectPath = expectPathFor(input.vaultRoot)
  if (input.expectSignature === null) {
    return blocked(
      `笔记期望文件不存在：${EXPECT_FILE}（期望路径 ${expectPath}）`,
      `请先把 presets/study/assets/笔记期望.md 复制到 vault 根并改成你的写法，再调用 note_expect_get`,
    )
  }
  const mark = input.session.expect
  if (!mark) {
    return blocked('未读取笔记期望', `请先调用 note_expect_get 读取 vault 根的 ${EXPECT_FILE}`)
  }
  if (mark.signature !== input.expectSignature) {
    return blocked(
      `${EXPECT_FILE} 已更新（内容变了）`,
      '请重新调用 note_expect_get 读取最新期望后再写入',
    )
  }
  return { ok: true, plan: null }
}

/** 校验二：存在已确认且未过期的规划 */
export async function checkPlan(input: GateInput): Promise<GateResult> {
  const planId = input.session.activePlanId
  if (!planId) {
    return blocked('本次会话没有已确认的文件夹规划', '请先调用 note_plan 输出提案，让用户拍板确认后再写入')
  }
  let file: string
  try {
    file = planFileFor(input.vaultRoot, planId, input.stateDir)
  } catch (error) {
    return blocked(`会话记录的规划 id 无法解析：${planId}（${(error as Error).message}）`, '请重新调用 note_plan 提案')
  }
  const record = await readPlan(file)
  if (!record) {
    return blocked(`规划记录不存在或已损坏（planId：${planId}）`, '请重新调用 note_plan 提案并确认')
  }
  if (!record.confirmed) {
    return blocked(`规划尚未确认（planId：${planId}）`, '请让用户拍板后用 note_plan(action=confirm) 确认')
  }
  const ttl = input.planTtlHours ?? DEFAULT_PLAN_TTL_HOURS
  if (isPlanExpired(record, ttl)) {
    return blocked(
      `规划已过期（超过 ${ttl} 小时，planId：${planId}）`,
      '请重新调用 note_plan 提案并确认',
    )
  }
  return { ok: true, plan: record }
}

/** 校验三：目标路径在规划范围内 */
export function checkPathInPlan(record: PlanRecord, targetRel: string): GateResult {
  if (pathInPlan(record, targetRel)) return { ok: true, plan: record }
  return blocked(
    `"${targetRel}" 不在本次规划范围（规划根：${record.rootPath || 'vault 根'}）`,
    '请重新规划（note_plan）把该目录纳入范围，或改写到规划内的路径',
  )
}

/**
 * 三连校验（按序短路）。返回第一个失败原因——一次只说一个问题，
 * 比一次性抛出三条更利于模型自我纠正。
 */
export async function checkWrite(input: GateInput): Promise<GateResult> {
  if (input.requireExpect !== false) {
    const expect = checkExpect(input)
    if (!expect.ok) return expect
  }
  if (input.requirePlan === false) return { ok: true, plan: null }
  const plan = await checkPlan(input)
  if (!plan.ok) return plan
  if (input.targetRel !== undefined) {
    const inRange = checkPathInPlan(plan.plan as PlanRecord, input.targetRel)
    if (!inRange.ok) return inRange
  }
  return plan
}

/**
 * 规划提案的对话呈现文本（**只在对话里给**，需求 R11：不落盘、vault 不新增文件）。
 * 结构固定为「目标根 → 新建/复用目录 → 块清单 → 下一步」，便于用户逐行批注。
 */
export function formatPlanProposal(record: PlanRecord, opts: { reusedDirs?: string[] } = {}): string {
  const lines: string[] = []
  lines.push(`## 文件夹规划提案（planId：${record.planId}）`)
  lines.push('')
  lines.push(`- 规划根：${record.rootPath || '（vault 根）'}`)
  if (record.material) lines.push(`- 资料：${record.material}`)
  if (record.notes) lines.push(`- 备注：${record.notes}`)
  const newDirs = [...new Set(record.items.map((it) => it.path.split('/').slice(0, -1).join('/')))]
  const reused = opts.reusedDirs ?? []
  if (reused.length > 0) lines.push(`- 复用已有目录：${reused.join('、')}`)
  const toCreate = newDirs.filter((d) => d && !reused.includes(d))
  if (toCreate.length > 0) lines.push(`- 本次将新建目录：${toCreate.join('、')}`)
  lines.push('')
  lines.push('| # | 块 | 落盘路径 | 来源章节 | 顺序 |')
  lines.push('| --: | :-- | :-- | :-- | --: |')
  record.items.forEach((it, i) => {
    lines.push(`| ${i + 1} | ${it.title} | ${it.path} | ${it.sourceSection ?? '—'} | ${it.order ?? '—'} |`)
  })
  lines.push('')
  lines.push('确认后我再逐个落盘；结构与顺序要改，直接说改哪里。')
  return lines.join('\n')
}
