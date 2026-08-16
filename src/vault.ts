/**
 * vault 适配层：目录扫描（含跳过清单）、路径安全、原子写、落盘目录解析。
 * 全部走 node:fs 直写（插件是可信 preset 代码，不经沙箱 fs）。
 * @module vault
 */

import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, basename } from 'node:path'

/** 扫描时跳过的目录 */
export const SKIP_DIRS = new Set(['.obsidian', '.trash', '.study', '.git', 'node_modules', '资源'])

/** Windows 非法文件名字符清洗 + 长度上限 */
export function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const capped = cleaned.slice(0, 80).trim()
  return capped.length > 0 ? capped : '未命名'
}

export function withinRoot(root: string, p: string): boolean {
  const r = relative(root, p)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

export async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true })
}

/** 临时文件 + rename 原子写；失败清理临时文件，不留下半成品 */
export async function atomicWrite(file: string, content: string): Promise<void> {
  await ensureDir(dirname(file))
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
  await fsp.writeFile(tmp, content, 'utf8')
  try {
    await fsp.rename(tmp, file)
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

export interface WalkedFile {
  path: string
  rel: string
  mtimeMs: number
  size: number
}

/** 递归收集 vault 下所有 .md（跳过 SKIP_DIRS） */
export async function walk(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  async function rec(dir: string): Promise<void> {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        await rec(full)
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        try {
          const st = await fsp.stat(full)
          out.push({ path: full, rel: relative(root, full), mtimeMs: st.mtimeMs, size: st.size })
        } catch {
          // 文件在遍历中被删/锁定：跳过
        }
      }
    }
  }
  await rec(root)
  return out
}

export interface VaultLayout {
  vaultRoot: string
  stateDir: string
  fallbackDir: string
  mocDir: string
  domainFolders?: Record<string, string>
}

/** 解析某领域卡片的落盘目录：优先映射表，未映射落入 fallbackDir/<领域名> */
export function cardDirFor(layout: VaultLayout, domain: string): string {
  const mapped = layout.domainFolders?.[domain]
  const rel = mapped ?? join(layout.fallbackDir, sanitizeFilename(domain))
  const abs = resolve(layout.vaultRoot, rel)
  if (!withinRoot(layout.vaultRoot, abs)) {
    throw new Error(`卡片目录越界：${rel} 不在 vault 根目录内`)
  }
  return abs
}

/** 生成唯一文件名：`标题.md`，冲突时追加 ID 后缀，再冲突用完整 ID */
export async function uniqueCardPath(dir: string, title: string, id: string): Promise<string> {
  const base = sanitizeFilename(title)
  const first = join(dir, `${base}.md`)
  if (!(await exists(first))) return first
  const second = join(dir, `${base}_${id.slice(-4)}.md`)
  if (!(await exists(second))) return second
  const third = join(dir, `${base}_${id}.md`)
  if (!(await exists(third))) return third
  throw new Error(`卡片文件名冲突：${base}.md 已有多个同名文件，请改标题`)
}

export function fileNameOf(p: string): string {
  return basename(p)
}

/** MOC 落盘路径：mocDir/日期_标题.md */
export function mocPathFor(layout: VaultLayout, title: string, date: string): string {
  const rel = join(layout.mocDir, `${sanitizeFilename(`${date}_${title}`)}.md`)
  const abs = resolve(layout.vaultRoot, rel)
  if (!withinRoot(layout.vaultRoot, abs)) throw new Error('MOC 路径越界')
  return abs
}
