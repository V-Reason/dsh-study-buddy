/**
 * vault 适配层：目录扫描（含跳过清单）、路径安全、原子写、落盘目录解析。
 * 全部走 node:fs 直写（插件是可信 preset 代码，不经沙箱 fs）。
 * @module vault
 */

import { randomBytes } from 'node:crypto'
import { promises as fsp, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, basename } from 'node:path'

/** 扫描时跳过的通用目录（vault 特定目录如"资源"由 config.skipDirs 配置） */
export const SKIP_DIRS = new Set(['.obsidian', '.trash', '.study', '.git', 'node_modules'])

/** 合并内置通用目录与用户配置的额外跳过目录 */
export function skipSetFor(extra?: string[]): Set<string> {
  return new Set([...SKIP_DIRS, ...(extra ?? [])])
}

/** Windows 非法文件名字符清洗 + 长度上限。引号（ASCII/中文）直接移除不留空格，避免"标题↔文件名"脱节 */
export function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/["'“”‘’]/g, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const capped = cleaned.slice(0, 80).trim()
  return capped.length > 0 ? capped : '未命名'
}

/**
 * 领域键近似匹配：按字符重合度（共同字符 / 较长键长度）≥0.6 排序，取前 2。
 * 用于 card_create 领域键未精确命中时回显"最接近的已映射键"（如
 * "图形学-动画与特效" → "图形学-动画特效"），避免 agent 翻配置文件绕路。
 */
export function findSimilarDomainKeys(domain: string, keys: string[]): string[] {
  const d = String(domain ?? '').trim()
  if (!d) return []
  const scored: Array<{ key: string; score: number }> = []
  for (const raw of keys) {
    const key = String(raw)
    if (key === d) continue
    const common = [...new Set([...d])].filter((ch) => key.includes(ch)).length
    const score = common / Math.max(d.length, key.length)
    if (score >= 0.6) scored.push({ key, score })
  }
  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  return scored.slice(0, 2).map((s) => s.key)
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
  /** 来源根标签（vault / 工作目录 / searchRoots 目录名） */
  root: string
  mtimeMs: number
  /** inode 变更时间（rename/元数据变更也触发；与 mtime 互补防同毫秒同大小漏检） */
  ctimeMs: number
  size: number
}

/** 一个检索根：扫描目录 + 展示标签 */
export interface SearchRoot {
  path: string
  label: string
}

/** 递归收集 root 下所有 .md（跳过 skip 集合，默认内置通用目录）；rootLabel 标注来源 */
export async function walk(root: string, skip: Set<string> = skipSetFor(), rootLabel = 'vault'): Promise<WalkedFile[]> {
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
        if (skip.has(ent.name)) continue
        await rec(full)
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        try {
          const st = await fsp.stat(full)
          out.push({ path: full, rel: relative(root, full), root: rootLabel, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size })
        } catch {
          // 文件在遍历中被删/锁定：跳过
        }
      }
    }
  }
  await rec(root)
  return out
}

/** 跨根扫描：逐根 walk 后拼接（rel 为各根内相对路径，root 标注来源） */
export async function walkRoots(roots: SearchRoot[], skip: Set<string> = skipSetFor()): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  for (const r of roots) {
    out.push(...await walk(r.path, skip, r.label))
  }
  return out
}

/** 规范化路径键：Windows 下大小写不敏感，用于跨根去重（cwd 与 vault 相同时只索引一次） */
export function canonicalRootKey(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** outer 是否包含 inner（按规范化绝对路径前缀判断；同路径视为包含） */
export function containsRoot(outer: string, inner: string): boolean {
  const o = canonicalRootKey(outer)
  const i = canonicalRootKey(inner)
  const sep = o.includes('\\') ? '\\' : '/'
  return i === o || i.startsWith(o.endsWith(sep) ? o : `${o}${sep}`)
}

/**
 * 去重检索根：按规范化路径 + 包含关系裁剪——已被更早（优先）根覆盖的根直接丢弃，
 * 只保留真正贡献新文件的根（cwd == vaultRoot 或 cwd 在 vault 内时 cwd 不重复扫描）。
 */
export function dedupeRoots(roots: SearchRoot[]): SearchRoot[] {
  const kept: SearchRoot[] = []
  for (const r of roots) {
    if (kept.some((k) => containsRoot(k.path, r.path))) continue
    kept.push(r)
  }
  return kept
}

/** 文件级去重：同文件（规范化路径）只留首个（调用方把 vault 放最前，vault 标签优先） */
export function dedupeFiles(files: WalkedFile[]): WalkedFile[] {
  const seen = new Set<string>()
  const out: WalkedFile[] = []
  for (const f of files) {
    const key = canonicalRootKey(f.path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/** 校验额外检索根存在（fail-loud）并解析为绝对路径 + 唯一展示标签 */
export function resolveSearchRoots(vaultRoot: string, raw?: string[]): SearchRoot[] {
  const roots: SearchRoot[] = []
  const used = new Set(['vault', '工作目录'])
  for (const entry of raw ?? []) {
    const abs = resolve(vaultRoot, String(entry))
    if (canonicalRootKey(abs) === canonicalRootKey(resolve('/'))) {
      throw new Error(`searchRoots 不能是文件系统根：${abs}`)
    }
    const st = statSync(abs, { throwIfNoEntry: false })
    if (!st?.isDirectory()) {
      throw new Error(`searchRoots 目录不存在或不可读：${abs}（检查 preset 行 config.searchRoots）`)
    }
    const base = basename(abs) || 'root'
    let label = base
    let n = 2
    while (used.has(label)) label = `${base}(${n++})`
    used.add(label)
    roots.push({ path: abs, label })
  }
  return roots
}

export interface VaultLayout {
  vaultRoot: string
  stateDir: string
  fallbackDir: string
  mocDir: string
  domainFolders?: Record<string, string>
  /** 额外跳过扫描的顶层目录名（与内置通用目录合并） */
  skipDirs?: string[]
  /** 额外检索根（绝对路径，或相对 vaultRoot 的路径）：旧笔记库，只读 */
  searchRoots?: string[]
  /** 是否把会话工作目录（exec.agent.session.header.cwd）纳入检索，默认 false */
  includeSessionCwd?: boolean
  /** 是否允许把关联写入没有 ID 的旧笔记，默认 false（旧笔记不碰不动） */
  linkIntoNotes?: boolean
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
