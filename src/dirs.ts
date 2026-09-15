/**
 * vault 目录模型：路径归一、微目录约定、层级校验、目录索引（DirIndex），
 * 以及"块该落到哪个目录"的三档解析。
 *
 * 2026-10 文档式笔记重构新增：旧模型用「领域键 → 目录」映射被动生成目录，
 * 于是笔记被无脑堆进同一个目录、彼此没有阅读顺序。新模型把**目录路径**升为
 * 主键（由用户确认的文件夹规划给出），领域映射降级为语法糖。
 *
 * 纯函数为主；`walk` 是唯一的 IO。
 * @module dirs
 */

import { promises as fsp } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { sanitizeFilename, withinRoot, type WalkedFile } from './vault.ts'

/** 微目录固定文件名：每个主题目录都有一份（需求 R12） */
export const TOC_FILE = '微目录.md'

/** 嵌套层数提示阈值：超过只提示不拒绝 */
export const MAX_NEST_HINT = 6

/** 笔记期望文件名（vault 根固定位置，需求 A4） */
export const EXPECT_FILE = '笔记期望.md'

/** 路径归一：反斜杠 → 正斜杠、去掉首尾斜杠、折叠重复斜杠 */
export function normRel(rel: string): string {
  return String(rel ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/')
}

/** 相对路径所在的目录（顶层文件返回 `''`） */
export function dirOfRel(rel: string): string {
  const norm = normRel(rel)
  const idx = norm.lastIndexOf('/')
  return idx === -1 ? '' : norm.slice(0, idx)
}

/** 父目录（顶层目录 / 根返回 `''`） */
export function parentDir(dir: string): string {
  const norm = normRel(dir)
  const idx = norm.lastIndexOf('/')
  return idx === -1 ? '' : norm.slice(0, idx)
}

/** 目录的路径段 */
export function dirSegments(dir: string): string[] {
  const norm = normRel(dir)
  return norm === '' ? [] : norm.split('/')
}

/** 是否为微目录文件（按相对路径判断） */
export function isTocRel(rel: string): boolean {
  return normRel(rel).split('/').at(-1) === TOC_FILE
}

/** 目录嵌套层数（根 = 0） */
export function depthOf(dir: string): number {
  return dirSegments(dir).length
}

/** 笔记期望文件的绝对路径 */
export function expectPathFor(vaultRoot: string): string {
  const p = resolve(vaultRoot, EXPECT_FILE)
  if (!withinRoot(vaultRoot, p)) throw new Error(`笔记期望路径越界：${EXPECT_FILE}`)
  return p
}

/** 目标目录的绝对路径（`dir` 为空/`.` 时就是 vault 根） */
export function dirPathFor(vaultRoot: string, dir: string): string {
  // 先跑结构校验（相对段/非法字符），错误信息才指向真正的原因；
  // 只靠 withinRoot 兜底会把 `../外面` 报成含糊的"目录越界"
  const norm = assertDirPath(dir)
  const p = norm === '' ? resolve(vaultRoot) : resolve(vaultRoot, norm)
  if (!withinRoot(vaultRoot, p)) throw new Error(`目录越界：${norm || '.'} 不在 vault 根目录内`)
  return p
}

/**
 * 目录名校验：拒绝空段、Windows 非法字符与设备名。
 * 失败即抛错（fail-loud）：目录是落盘主键，静默改名会让规划与磁盘对不上。
 */
const ILLEGAL_SEG_RE = /[\\/:*?"<>|]/
const DEVICE_SEG_RE = /^(?:nul|con|prn|aux|com[0-9]|lpt[0-9])(?:\.|$)/i

export function assertDirPath(dir: string): string {
  const norm = normRel(dir)
  if (norm === '') return norm
  for (const seg of norm.split('/')) {
    if (seg === '..' || seg === '.') throw new Error(`目录路径不能包含相对段：${norm}`)
    if (ILLEGAL_SEG_RE.test(seg)) throw new Error(`目录名含非法字符（${seg}）：${norm}`)
    if (DEVICE_SEG_RE.test(seg)) throw new Error(`目录名与系统设备名冲突（${seg}）：${norm}`)
    if (seg !== seg.trim()) throw new Error(`目录名首尾不能有空格：${norm}`)
  }
  return norm
}

/** 层级提示（软约束，不拒绝）：超过阈值时给人文案，由调用方回显 */
export function nestHint(dir: string): string {
  const depth = depthOf(dir)
  if (depth <= MAX_NEST_HINT) return ''
  return `提示：目标目录已嵌套 ${depth} 层（建议 ≤${MAX_NEST_HINT} 层）——层级过深时"资料/章/节/块"会退化成难以导航的树`
}

export interface DirStat {
  /** 该目录下的块数（有 ID 且有来源章节） */
  blocks: number
  /** 该目录下的存量卡数（有 ID、无来源章节） */
  legacy: number
  /** 该目录下的旧笔记数（无 ID） */
  notes: number
  /** 是否已有微目录 */
  hasToc: boolean
}

const EMPTY_STAT: DirStat = { blocks: 0, legacy: 0, notes: 0, hasToc: false }

export interface DirBuildInput {
  /** vault 内相对路径 */
  rel: string
  kind: 'block' | 'legacy' | 'note'
  /** 是否属于 vault 根（只读检索根的文件不参与目录导航） */
  inVault: boolean
}/**
 * 目录索引：路径 → 计数。**只统计承载文件的目录本身**，父目录计数按需累加
 * （`countAt`）——这样 `add`/`remove` 都是 O(1)，无需向上逐级更新。
 *
 * 索引重建时整体构建；写入后增量维护（与 `titleHints` 同手法，N2）。
 */
export class DirIndex {
  private stats = new Map<string, DirStat>()

  get size(): number {
    return this.stats.size
  }

  /** 全部含文件的目录路径（升序，未归一：调用方按需 normRel） */
  dirs(): string[] {
    return [...this.stats.keys()].sort((a, b) => a.localeCompare(b))
  }

  /** 单目录自身的计数（不递归） */
  statOf(dir: string): DirStat {
    return this.stats.get(normRel(dir)) ?? EMPTY_STAT
  }

  /** 目录及其子树的累加计数（含子目录） */
  countAt(dir: string): DirStat {
    const base = normRel(dir)
    const acc: DirStat = { blocks: 0, legacy: 0, notes: 0, hasToc: false }
    for (const [dirPath, stat] of this.stats) {
      // 根（base === ''）统计全部；否则统计自身与 `base/` 前缀的子树
      if (base !== '' && dirPath !== base && !dirPath.startsWith(`${base}/`)) continue
      acc.blocks += stat.blocks
      acc.legacy += stat.legacy
      acc.notes += stat.notes
      if (stat.hasToc) acc.hasToc = true
    }
    return acc
  }

  /** 目录的直接子目录（含文件的那些） */
  childrenOf(dir: string): string[] {
    const base = normRel(dir)
    const prefix = base === '' ? '' : `${base}/`
    const out = new Set<string>()
    for (const dirPath of this.stats.keys()) {
      if (dirPath === '' || dirPath === base || !dirPath.startsWith(prefix)) continue
      const rest = dirPath.slice(prefix.length)
      if (!rest) continue
      const seg = rest.split('/')[0]
      out.add(base === '' ? seg : `${base}/${seg}`)
    }
    return [...out].sort((a, b) => a.localeCompare(b))
  }

  /** 该目录下是否有文件直接落在这里 */
  hasFiles(dir: string): boolean {
    const s = this.statOf(dir)
    return s.blocks + s.legacy + s.notes > 0
  }

  /** 目录自身或子树里是否存在微目录（父级判断"该子树有入口"用） */
  hasTocIn(dir: string): boolean {
    return this.countAt(dir).hasToc
  }

  add(rel: string, kind: DirBuildInput['kind']): void {
    const key = dirOfRel(rel)
    const stat = this.stats.get(key) ?? { ...EMPTY_STAT }
    if (isTocRel(rel)) stat.hasToc = true
    else if (kind === 'block') stat.blocks += 1
    else if (kind === 'legacy') stat.legacy += 1
    else stat.notes += 1
    this.stats.set(key, stat)
  }

  remove(rel: string, kind: DirBuildInput['kind']): void {
    const key = dirOfRel(rel)
    const stat = this.stats.get(key)
    if (!stat) return
    if (isTocRel(rel)) stat.hasToc = false
    else if (kind === 'block') stat.blocks = Math.max(0, stat.blocks - 1)
    else if (kind === 'legacy') stat.legacy = Math.max(0, stat.legacy - 1)
    else stat.notes = Math.max(0, stat.notes - 1)
    if (stat.blocks + stat.legacy + stat.notes === 0 && !stat.hasToc) this.stats.delete(key)
    else this.stats.set(key, stat)
  }

  clear(): void {
    this.stats.clear()
  }
}

/** 从已扫描文件构建目录索引（只收 vault 根内的文件） */
export function buildDirIndex(files: WalkedFile[], kinds: Map<string, DirBuildInput['kind']>): DirIndex {
  const index = new DirIndex()
  for (const f of files) {
    if (f.root !== 'vault') continue
    const rel = normRel(f.rel)
    if (rel === '') continue
    const kind = kinds.get(rel) ?? 'note'
    index.add(rel, isTocRel(rel) ? 'note' : kind)
  }
  return index
}

/** 目录扫描结果（`note_list` 的数据源）：子目录 + 直接落在该层的文件 */
export interface DirListing {
  /** 归一化后的目录路径（根为 `''`） */
  dir: string
  /** 直接子目录（相对 vault 根的路径） */
  subdirs: string[]
  /** 该目录下的文件（含富化后的元数据） */
  files: DirListFile[]
}

export interface DirListFile {
  rel: string
  fileName: string
  title: string
  summary: string | null
  sourceSection: string | null
  order: number | null
  kind: 'block' | 'legacy' | 'note'
  id: string | null
}

/**
 * 列出某目录的直接子目录与文件。
 *
 * **不读正文**：只读每个文件前 `headerBytes` 字节拿 frontmatter，因此目录里
 * 有几十篇长笔记也不影响导航速度（架构选型 A4 / §2.3）。
 */
export async function listDir(
  vaultRoot: string,
  dir: string,
  opts: { headerBytes?: number } = {},
): Promise<DirListing> {
  const norm = assertDirPath(dir)
  const abs = dirPathFor(vaultRoot, norm)
  let entries
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true })
  } catch (error) {
    throw new Error(`目录不存在或不可读：${norm || '.'}（${(error as Error).message}）`)
  }
  const subdirs: string[] = []
  const files: DirListFile[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const childRel = norm === '' ? entry.name : `${norm}/${entry.name}`
    if (entry.isDirectory()) {
      subdirs.push(childRel)
      continue
    }
    if (!entry.name.toLowerCase().endsWith('.md')) continue
    if (isTocRel(childRel)) continue
    const parsed = await readNoteHeader(join(abs, entry.name), opts.headerBytes)
    files.push({
      rel: childRel,
      fileName: entry.name,
      title: parsed.title ?? entry.name.replace(/\.md$/i, ''),
      summary: parsed.summary,
      sourceSection: parsed.sourceSection,
      order: parsed.order,
      kind: parsed.id ? (parsed.sourceSection ? 'block' : 'legacy') : 'note',
      id: parsed.id,
    })
  }
  subdirs.sort((a, b) => a.localeCompare(b))
  files.sort((a, b) => compareOrder(a, b))
  return { dir: norm, subdirs, files }
}

/** 排序：顺序键 → 标题字典序（缺顺序键的排在有顺序键之后，按标题排） */
export function compareOrder(a: DirListFile, b: DirListFile): number {
  const ao = a.order === null ? Number.POSITIVE_INFINITY : a.order
  const bo = b.order === null ? Number.POSITIVE_INFINITY : b.order
  if (ao !== bo) return ao - bo
  return a.title.localeCompare(b.title)
}

/** 头部解析结果（`listDir` 用；字段名与 frontmatter 模块解耦，避免循环依赖） */
export interface NoteHeader {
  id: string | null
  title: string | null
  summary: string | null
  sourceSection: string | null
  order: number | null
}

/**
 * 只读文件头（默认前 4KB）取 frontmatter。
 *
 * 头读失败（frontmatter 超长 / 无换行巨行）时**回退读全文一次**（架构选型 C4）：
 * 宁可慢一次，不可让索引缺字段——缺字段会让检索与导航静默错位。
 */
export async function readNoteHeader(absPath: string, headerBytes = 4096): Promise<NoteHeader> {
  let text: string
  let truncated = false
  try {
    const handle = await fsp.open(absPath, 'r')
    try {
      const buf = Buffer.alloc(Math.max(1, headerBytes))
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      text = buf.subarray(0, bytesRead).toString('utf8')
      truncated = bytesRead === buf.length
    } finally {
      await handle.close()
    }
  } catch {
    return { id: null, title: null, summary: null, sourceSection: null, order: null }
  }
  // 头被截断且还没读到 frontmatter 结束标记：回退读全文
  if (truncated && !/^---\r?\n[\s\S]*?\r?\n---/.test(text)) {
    try {
      text = await fsp.readFile(absPath, 'utf8')
    } catch {
      // 读不到全文时用头读结果继续（尽力而为，不抛错阻断整目录列举）
    }
  }
  return parseHeaderFields(text)
}

/**
 * 从（可能被截断的）文本里提取头部字段。
 * 解析口径与 `frontmatter.ts` 保持一致：只认标量 `key: value` 行。
 */
export function parseHeaderFields(text: string): NoteHeader {
  const out: NoteHeader = { id: null, title: null, summary: null, sourceSection: null, order: null }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''))
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (value === '') continue
    if (key === 'ID') out.id = value
    else if (key === '标题') out.title = value
    else if (key === '简介' || key === '定义') out.summary = value
    else if (key === '来源章节') out.sourceSection = value
    else if (key === '顺序') {
      const n = Number(value)
      out.order = Number.isFinite(n) ? n : null
    }
  }
  return out
}

/**
 * 解析块的落盘目录，优先级（架构选型 §4.2 / 需求 R30）：
 * ① 规划显式给出的目录 → ② `domainFolders` 快捷方式 → ③ `fallbackDir/<领域名>`
 */
export function resolveNoteDir(
  layout: { domainFolders?: Record<string, string>; fallbackDir: string },
  opts: { plannedDir?: string; domain?: string },
): string {
  const planned = String(opts.plannedDir ?? '').trim()
  if (planned) return assertDirPath(planned)
  const domain = String(opts.domain ?? '').trim()
  const mapped = domain ? layout.domainFolders?.[domain] : undefined
  if (mapped) return assertDirPath(mapped)
  if (!domain) return ''
  return assertDirPath(join(layout.fallbackDir, sanitizeFilename(domain)))
}

/** 绝对路径 → vault 内相对路径（不在 vault 内时抛错） */
export function vaultRelOf(vaultRoot: string, absPath: string): string {
  const root = resolve(vaultRoot)
  const abs = resolve(absPath)
  if (!withinRoot(root, abs)) throw new Error(`路径不在 vault 内：${absPath}`)
  const rel = abs.slice(root.length).replace(new RegExp(`^\\${sep}`), '')
  return normRel(rel)
}
