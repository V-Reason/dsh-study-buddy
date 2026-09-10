/**
 * vault 适配层：目录扫描（含跳过清单）、路径安全、原子写、落盘目录解析。
 * 全部走 node:fs 直写（插件是可信 preset 代码，不经沙箱 fs）。
 * @module vault
 */

import { randomBytes } from 'node:crypto'
import { promises as fsp, statSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, basename } from 'node:path'
import type { TemplateHints } from './template.ts'

/** 扫描时跳过的通用目录（vault 特定目录如"资源"由 config.skipDirs 配置） */
export const SKIP_DIRS = new Set(['.obsidian', '.trash', '.study', '.git', 'node_modules'])

/** 文件名长度上限（标题↔文件名同口径的唯一来源，CPLX-7） */
export const MAX_FILENAME = 80

/** 单次扫描安全阀：文件数与递归深度上限（防跨盘符/异常根导致整盘扫描，SEC-2） */
export const MAX_WALK_FILES = 20000
export const MAX_WALK_DEPTH = 16

/** Windows 保留设备名（`NUL.md` 之类 `fsp.access` 恒为真，需前缀兜底） */
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 合并内置通用目录与用户配置的额外跳过目录 */
export function skipSetFor(extra?: string[]): Set<string> {
  return new Set([...SKIP_DIRS, ...(extra ?? [])])
}

/**
 * Windows 非法文件名字符清洗 + 长度上限。引号（ASCII/中文）直接移除不留空格，
 * 避免"标题↔文件名"脱节；`[` `]` 必须清洗——它们会让 MOC 的 `[[wikilink]]`
 * 断裂（SEC-3）；设备名加 `_` 前缀兜底。
 */
export function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/["'“”‘’]/g, '')
    .replace(/[\\/:*?"<>|[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const capped = cleaned.slice(0, MAX_FILENAME).trim()
  if (!capped) return '未命名'
  return DEVICE_NAME_RE.test(capped) ? `_${capped}` : capped
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
  /** 是否可写（只有 vault 根为 true；只读根不写入，EXT-5） */
  writable: boolean
  mtimeMs: number
  /** inode 变更时间（rename/元数据变更也触发；与 mtime 互补防同毫秒同大小漏检） */
  ctimeMs: number
  size: number
}

/** 一个检索根：扫描目录 + 展示标签 + 是否可写（EXT-5：可写性策略上移到根定义） */
export interface SearchRoot {
  path: string
  label: string
  /** vault=true；searchRoots 与工作目录=false（只读，绝不写入） */
  writable: boolean
}

/** 是否文件系统根（`resolve('/')` 在 Windows 上只等于当前盘根，跨盘符 cwd 会漏拦，SEC-2） */
export function isFsRoot(p: string): boolean {
  const abs = resolve(p)
  return canonicalRootKey(parse(abs).root) === canonicalRootKey(abs)
}

/** 扫描进度回调（读取失败/超限时收集，供工具返回文本回显，BIZ-7） */
export type SkipReporter = (entry: { path: string; reason: string }) => void

/** 条目判定结果：`st` 为普通文件的 stat；其余情况由 `reason` 说明（无 reason = 目录，本就不进索引） */
interface EntryKind {
  st?: Stats
  reason?: string
}

/**
 * 判定一个目录条目能否当普通文件读（BIZ-7），命中普通文件时**顺带回传 stat**
 * （命中路径每个文件只 stat 一次，与旧实现开销一致）。
 *
 * **绝不用 `dirent.isFile()` 直接当门禁**：断链符号链接的 dirent 是
 * `isSymbolicLink() === true` / `isFile() === false`，旧实现因此在过滤阶段就把它
 * 丢掉——它既不在索引里，也不在跳过清单里，`共检索 N 篇` 于是少算一篇而不自知
 * （设计文档 D18：报告必须与"实际处理了什么"一致）。
 */
async function resolveEntry(full: string, ent: { isSymbolicLink(): boolean }): Promise<EntryKind> {
  const linked = ent.isSymbolicLink()
  try {
    const st = await fsp.stat(full)
    if (st.isFile()) return { st }
    // 目录不是文件也不是失败：目录本来就不进索引，无需回显
    if (st.isDirectory()) return {}
    if (!linked) return { reason: '不是普通文件（跳过）' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '未知错误'
    return { reason: linked ? `符号链接目标不可达（${code}）` : `文件 stat 失败（${code}）` }
  }
  // 链接目标不是文件也不是目录：lstat 拿链接自身信息，供回显具体类型
  try {
    const lst = await fsp.lstat(full)
    return { reason: `符号链接目标不是普通文件（${describeType(lst)}）` }
  } catch {
    return {}
  }
}

/** 文件类型回显名（只用于给用户看的原因文本） */
function describeType(st: Stats): string {
  if (st.isFIFO()) return '命名管道'
  if (st.isSocket()) return '套接字'
  if (st.isBlockDevice()) return '块设备'
  if (st.isCharacterDevice()) return '字符设备'
  return '未知类型'
}

/**
 * 递归收集 root 下所有 .md（跳过 skip 集合，默认内置通用目录）；rootLabel 标注来源。
 * `onSkip` 覆盖：目录读取失败、**条目无法当文件读**（stat 失败 / 断链符号链接）、
 * 目录深度超限、文件数安全阀超限——全部上报，绝不静默吞掉（BIZ-7）。
 *
 * `maxFiles` 是**每根**的文件数安全阀（默认 `MAX_WALK_FILES`，可用
 * `config.maxWalkFiles` 调整）：超限时**截断扫描并上报**，不再抛错（N6）——
 * 安全阀的语义是"拦住异常根"，不是"让大型 vault 彻底不可用"。
 */
export async function walk(
  root: string,
  skip: Set<string> = skipSetFor(),
  rootLabel = 'vault',
  onSkip?: SkipReporter,
  writable = rootLabel === 'vault',
  maxFiles = MAX_WALK_FILES,
): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  let truncated = false
  async function rec(dir: string, depth: number): Promise<void> {
    if (truncated) return
    if (depth > MAX_WALK_DEPTH) {
      onSkip?.({ path: dir, reason: `目录深度超过 ${MAX_WALK_DEPTH} 层（用 config.skipDirs 排除或拆分 searchRoots）` })
      return
    }
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (error) {
      onSkip?.({ path: dir, reason: `目录读取失败（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）` })
      return
    }
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (skip.has(ent.name)) continue
        await rec(full, depth + 1)
        if (truncated) return
        continue
      }
      // 名字不像 .md 的一律不看；保留所有 .md 条目再做判定——
      // `isFile()` 直接当门禁会把断链符号链接静默丢掉（BIZ-7）
      if (!ent.name.toLowerCase().endsWith('.md')) continue
      const kind = await resolveEntry(full, ent)
      if (!kind.st) {
        if (kind.reason) onSkip?.({ path: full, reason: kind.reason })
        continue
      }
      if (out.length >= maxFiles) {
        // 每根只报一次，且停止继续遍历（避免为大库白跑完整趟 readdir）
        truncated = true
        onSkip?.({
          path: root,
          reason: `扫描文件数已达上限 ${maxFiles}，仅索引前 ${maxFiles} 个文件`
            + '（用 config.maxWalkFiles 提高上限，或用 config.skipDirs / searchRoots 缩小范围）',
        })
        return
      }
      const st = kind.st
      out.push({ path: full, rel: relative(root, full), root: rootLabel, writable, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size })
    }
  }
  await rec(root, 0)
  return out
}

/** 跨根扫描：逐根 walk 后拼接（rel 为各根内相对路径，root 标注来源）；`maxFiles` 为每根上限 */
export async function walkRoots(
  roots: SearchRoot[],
  skip: Set<string> = skipSetFor(),
  onSkip?: SkipReporter,
  maxFiles = MAX_WALK_FILES,
): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  for (const r of roots) {
    out.push(...await walk(r.path, skip, r.label, onSkip, r.writable, maxFiles))
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

/**
 * 校验额外检索根存在（fail-loud）并解析为绝对路径 + 唯一展示标签。
 * 额外根默认只读；`config.linkIntoNotes: true` 时允许写入（此时根标记可写）。
 */
export function resolveSearchRoots(vaultRoot: string, raw?: string[], writable = false): SearchRoot[] {
  const roots: SearchRoot[] = []
  const used = new Set(['vault', '工作目录'])
  for (const entry of raw ?? []) {
    const abs = resolve(vaultRoot, String(entry))
    if (isFsRoot(abs)) {
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
    roots.push({ path: abs, label, writable })
  }
  return roots
}

/** lint 口径配置（具名接口，供 StudyConfig 与 VaultLayout 共用，EXT-6） */
export interface LintConfig {
  /** 会话残留级别：off 关闭 / warn 扣分 / error 扣分并封顶 59（默认 warn） */
  residueLevel?: 'off' | 'warn' | 'error'
  /** 禁用的规则 id 列表 */
  rulesOff?: string[]
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
  /** lint 口径（可选）：会话残留级别与禁用规则 */
  lint?: LintConfig
  /** 索引缓存 TTL（毫秒）：默认 2000；0 = 每次调用都重扫全库（外部编辑立即可见） */
  indexTtlMs?: number
  /** 每根扫描文件数上限（默认 20000）：超限截断扫描并回显警告，不再让工具整体失败（N6） */
  maxWalkFiles?: number
  /** 模板推断提示词表（缺省用内置默认值） */
  templateHints?: TemplateHints
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

/** 生成唯一文件名：`标题.md`，冲突时追加 ID 后缀（末 6 位），再冲突用完整 ID */
export async function uniqueCardPath(dir: string, title: string, id: string): Promise<string> {
  const base = sanitizeFilename(title)
  const first = join(dir, `${base}.md`)
  if (!(await exists(first))) return first
  // ID 已是 6 位 hex（BIZ-11b），回退后缀同步取末 6 位（N14）
  const second = join(dir, `${base}_${id.slice(-6)}.md`)
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
