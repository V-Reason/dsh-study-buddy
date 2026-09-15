/**
 * 历史存档：vault `.study/archive/<ID>/<时间戳>.md`。
 *
 * 取代旧的"把旧正文压进同文件 `<details>` 折叠块"（需求 R23）。理由是折叠块会
 * 让一篇笔记随时间越滚越长、正文与历史混在一起——正是"笔记被无脑堆叠"的另一种
 * 形态。新口径：**正文只保留最新版，旧版本另存**，需要时用 `note_history` 取回。
 *
 * 关键不变量（需求 N1 / 架构选型 §5.3）：
 * **先存档、后写正文**。任何一步失败都不允许出现"正文已改、历史已丢"的组合——
 * 所以 `writeArchive` 失败必须抛错，且调用方在它成功之前不能碰目标文件。
 *
 * 存档里保留**一字不改**的原文，便于人工比对；元信息写在它自己的 frontmatter 里。
 * @module archive
 */

import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { normRel } from './dirs.ts'
import { atomicWrite, ensureDir, withinRoot } from './vault.ts'

export interface ArchiveMeta {
  /** 存档来自哪个块（无 ID 的存量内容用 `legacy`） */
  fromId: string
  /** 存档时的原路径（vault 内相对路径） */
  oldRel: string
  /** 存档时间（本地时间，与文件名同源） */
  archivedAt: string
  /** 为什么被替换（用户可读的一句话） */
  reason: string
  /** 存档来源标题（便于人翻目录时认出来） */
  title?: string
}

export interface ArchiveEntry {
  /** 存档文件名（不含 `.md`），即时间戳；`note_restore` 用它寻址 */
  id: string
  file: string
  meta: ArchiveMeta
}

/** 存档文件名用的时间戳：`YYYYMMDDHHmmssSSS`（毫秒级，防同一秒多次替换互相覆盖） */
export function archiveStamp(now = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return [
    now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()),
    pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()), pad(now.getMilliseconds(), 3),
  ].join('')
}

/** 存档目录：`.study/archive/<ID>/`（越界或非法 id 即抛错） */
export function archiveDirFor(vaultRoot: string, fromId: string, stateDir = '.study'): string {
  const id = String(fromId ?? '').trim()
  if (!id || /[\\/:*?"<>|]/.test(id)) throw new Error(`存档 id 非法：${id || '(空)'}`)
  const p = join(vaultRoot, stateDir, 'archive', id)
  if (!withinRoot(vaultRoot, p)) throw new Error('存档目录路径越界')
  return p
}

/** 单行字段收敛（存档 frontmatter 是自渲染的，防注入折叠） */
function oneLine(value: unknown): string {
  return String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

export function renderArchive(meta: ArchiveMeta, original: string): string {
  const lines = [
    '---',
    `存档自: ${oneLine(meta.fromId)}`,
    `原路径: ${oneLine(meta.oldRel)}`,
    `存档时间: ${oneLine(meta.archivedAt)}`,
    `原因: ${oneLine(meta.reason)}`,
  ]
  if (meta.title) lines.push(`标题: ${oneLine(meta.title)}`)
  lines.push('---', '')
  return `${lines.join('\n')}\n${String(original ?? '')}`
}

/** 解析存档文件头（宽容：解析不出元信息时仍返回条目，避免历史"消失"） */
export function parseArchive(raw: string, fallbackId: string, file: string): ArchiveEntry {
  const meta: ArchiveMeta = { fromId: 'legacy', oldRel: '', archivedAt: '', reason: '', }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(raw ?? ''))
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const idx = line.indexOf(':')
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      if (key === '存档自') meta.fromId = value || 'legacy'
      else if (key === '原路径') meta.oldRel = value
      else if (key === '存档时间') meta.archivedAt = value
      else if (key === '原因') meta.reason = value
      else if (key === '标题') meta.title = value
    }
  }
  return { id: fallbackId, file, meta }
}

/** 存档正文（去掉存档头，用于恢复） */
export function archiveBody(raw: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(String(raw ?? ''))
  return m ? String(raw).slice(m[0].length).replace(/^\r?\n/, '') : String(raw ?? '')
}

/**
 * 写一份存档。返回存档条目；**失败即抛错**（调用方据此中止后续写入）。
 */
export async function writeArchive(
  vaultRoot: string,
  input: { fromId: string; oldRel: string; reason: string; title?: string; content: string; now?: Date; stateDir?: string },
): Promise<ArchiveEntry> {
  const dir = archiveDirFor(vaultRoot, input.fromId, input.stateDir)
  const stamp = archiveStamp(input.now ?? new Date())
  const file = join(dir, `${stamp}.md`)
  const meta: ArchiveMeta = {
    fromId: input.fromId,
    oldRel: normRel(input.oldRel),
    archivedAt: (input.now ?? new Date()).toISOString(),
    reason: String(input.reason ?? '').trim() || '未注明原因',
  }
  if (input.title) meta.title = input.title
  await ensureDir(dirname(file))
  await atomicWrite(file, renderArchive(meta, input.content))
  return { id: stamp, file, meta }
}

/** 列出某个块的全部存档（按时间倒序：最新在前） */
export async function listArchives(
  vaultRoot: string,
  fromId: string,
  stateDir = '.study',
): Promise<ArchiveEntry[]> {
  const dir = archiveDirFor(vaultRoot, fromId, stateDir)
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const out: ArchiveEntry[] = []
  for (const name of names.filter((n) => n.toLowerCase().endsWith('.md'))) {
    const file = join(dir, name)
    let raw: string
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch {
      continue
    }
    out.push(parseArchive(raw, name.replace(/\.md$/i, ''), file))
  }
  out.sort((a, b) => b.id.localeCompare(a.id))
  return out
}

/** 读一份存档的原始全文（含存档头）；找不到返回 `null` */
export async function readArchive(
  vaultRoot: string,
  fromId: string,
  archiveId: string,
  stateDir = '.study',
): Promise<{ entry: ArchiveEntry; raw: string } | null> {
  const id = String(archiveId ?? '').trim()
  if (!/^[0-9]{17}$/.test(id)) return null
  const dir = archiveDirFor(vaultRoot, fromId, stateDir)
  const file = join(dir, `${id}.md`)
  if (!withinRoot(dir, file)) return null
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return { entry: parseArchive(raw, id, file), raw }
  } catch {
    return null
  }
}

export interface ArchiveThenWriteInput {
  vaultRoot: string
  fromId: string
  oldRel: string
  reason: string
  title?: string
  /** 被替换的正文原文（一字不改地进存档） */
  oldContent: string
  /** 存档成功后才执行的写盘动作 */
  write: () => Promise<void>
  now?: Date
  stateDir?: string
}

/**
 * 「先存档、后写正文」的唯一执行入口（需求 N1 的关键不变量）。
 *
 * 把顺序**收在一个函数里**而不是散落在调用点：任何新增的替换路径只要走它，
 * 就不会写出"正文已改、历史已丢"的组合。存档失败 → 直接抛出，`write` 不被调用；
 * `write` 失败 → 存档已落盘（历史更全，不是数据损失），错误原样上抛由调用方处理。
 */
export async function archiveThenWrite(input: ArchiveThenWriteInput): Promise<ArchiveEntry> {
  const entry = await writeArchive(input.vaultRoot, {
    fromId: input.fromId,
    oldRel: input.oldRel,
    reason: input.reason,
    title: input.title,
    content: input.oldContent,
    now: input.now,
    stateDir: input.stateDir,
  })
  await input.write()
  return entry
}
