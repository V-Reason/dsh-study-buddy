/**
 * 会话门禁状态：vault `.study/session.json`。
 *
 * 记录两件事，都只为**硬门禁**服务（需求 F2 / 架构选型 §6.1）：
 * ① 用户已读过的《笔记期望.md》是哪一版（按**正文 SHA-1** 签名）；
 * ② 当前已确认、待消费的规划 id。
 *
 * 三条设计约束：
 * - **它是过程状态，不是笔记**：文件损坏或手删都不该让笔记读写不可用，因此
 *   读取一律宽容（坏值丢弃、解析失败回空态），写入仍走原子写。
 * - **不缓存期望内容**：只存签名。期望文件一改，签名就变，下次写入前必须重读
 *   （需求 F1 的"热配置立即生效"）。
 * - **签名只认正文哈希**：`mtime` / `ctime` / `size` 都会被权限刷新、复制、改名
 *   等元数据操作改写；只有正文内容变化才应该让"已读"失效。
 * @module store
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWrite, ensureDir, withinRoot } from './vault.ts'

/** 期望文件的已读标记 */
export interface ExpectMark {
  /** `sha1:<40位hex>`（正文内容）；与当前文件不一致 = 期望已更新，须重读 */
  signature: string
  /** 相对 vault 根的路径（当前固定为 笔记期望.md，留字段以便未来可配） */
  rel: string
  readAt?: string
}

export interface SessionState {
  expect?: ExpectMark
  /** 已确认、待消费的规划 id（由 plan 存储写、由门禁读） */
  activePlanId?: string
  updatedAt?: string
}

/** `.study/session.json` 的绝对路径（越界即抛错） */
export function sessionFileFor(vaultRoot: string, stateDir = '.study'): string {
  const p = join(vaultRoot, stateDir, 'session.json')
  if (!withinRoot(vaultRoot, p)) throw new Error('会话状态文件路径越界')
  return p
}

/**
 * 读会话状态。**永不抛错**：文件不存在、JSON 损坏、字段类型不对都退化为空态——
 * 退化的后果只是"门禁要求用户重做一步"，而抛错会让所有笔记操作不可用。
 */
export async function readSession(file: string): Promise<SessionState> {
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const obj = parsed as Record<string, unknown>
  const out: SessionState = {}
  const expect = obj.expect
  if (expect !== null && typeof expect === 'object' && !Array.isArray(expect)) {
    const e = expect as Record<string, unknown>
    if (typeof e.signature === 'string' && typeof e.rel === 'string') {
      out.expect = { signature: e.signature, rel: e.rel }
      if (typeof e.readAt === 'string') out.expect.readAt = e.readAt
    }
  }
  if (typeof obj.activePlanId === 'string' && obj.activePlanId.trim()) out.activePlanId = obj.activePlanId
  if (typeof obj.updatedAt === 'string') out.updatedAt = obj.updatedAt
  return out
}

/** 写会话状态（原子写；`updatedAt` 由本函数盖时间戳） */
export async function writeSession(file: string, state: SessionState): Promise<void> {
  await ensureDir(dirname(file))
  const next: SessionState = { ...state, updatedAt: new Date().toISOString() }
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`)
}

/**
 * 期望文件签名：正文 SHA-1（`sha1:<40位hex>`）。
 * 文件不存在/不可读返回 `null`（调用方据此判定"期望文件缺失"）。
 *
 * 刻意不含 `mtime` / `ctime` / `size`：权限刷新（icacls）、复制、改名都会刷新
 * `ctime`，但正文没变；若把元数据算进签名，用户会被误判成"没读过期望"。
 */
export async function signatureOf(file: string): Promise<string | null> {
  let content: Buffer
  try {
    content = await fsp.readFile(file)
  } catch {
    return null
  }
  return `sha1:${createHash('sha1').update(content).digest('hex')}`
}

/** 标记已读期望（读一次写一次 session.json） */
export async function markExpectRead(
  file: string,
  mark: { signature: string; rel: string },
): Promise<SessionState> {
  const state = await readSession(file)
  const next: SessionState = {
    ...state,
    expect: { signature: mark.signature, rel: mark.rel, readAt: new Date().toISOString() },
  }
  await writeSession(file, next)
  return next
}

/** 清除期望已读标记（换 vault / 改期望路径时用） */
export async function clearExpectMark(file: string): Promise<SessionState> {
  const state = await readSession(file)
  delete state.expect
  await writeSession(file, state)
  return state
}
