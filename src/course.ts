/**
 * 课程编译器数据模型：可见课程蓝图、来源清单与覆盖校验。
 *
 * 课程正文留在 vault 的 Markdown 里；本模块只定义能被工具可靠校验的结构。
 * @module course
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { compareText } from './order.ts'

export const COURSE_SCHEMA_VERSION = 1

export type CourseDepth = 'deep' | 'index' | 'reference' | 'deferred'
export type ConceptPriority = 'core' | 'support' | 'implementation' | 'deferred'

export interface CourseCoverage {
  scope: string
  depth: CourseDepth
  reason: string
}

export interface CourseConcept {
  id: string
  name: string
  priority: ConceptPriority
  definition: string
  introducedIn: string
  prerequisites: string[]
  sources: string[]
}

export interface CourseLesson {
  id: string
  title: string
  previousOutput: string
  output: string
  prerequisites: string[]
  evidence: string[]
  boundary: string
}

export interface CourseRun {
  id: string
  title: string
  goal: string
  entryState: string
  endState: string
  evidence: string[]
  lessons: CourseLesson[]
}

export interface CourseBlueprint {
  version: typeof COURSE_SCHEMA_VERSION
  courseId: string
  title: string
  outcomes: string[]
  sourceRoots: string[]
  coverage: CourseCoverage[]
  concepts: CourseConcept[]
  runs: CourseRun[]
}

export interface CourseInventoryRoot {
  label: string
  path: string
}

export interface CourseInventoryFile {
  root: string
  path: string
  extension: string
  size: number
  mtimeMs: number
  ctimeMs: number
}

export interface CourseInventorySkip {
  path: string
  reason: string
}

export interface CourseInventory {
  version: typeof COURSE_SCHEMA_VERSION
  courseId: string
  createdAt: string
  roots: CourseInventoryRoot[]
  files: CourseInventoryFile[]
  skipped: CourseInventorySkip[]
}

export type CourseStatus = 'preparing' | 'review' | 'active' | 'stale'

export interface CourseState {
  version: typeof COURSE_SCHEMA_VERSION
  status: CourseStatus
  courseId: string
  title: string
  blueprintPath: string
  blueprintHash: string
  inventoryPath: string
  inventorySignature: string
  activatedAt?: string
  currentRun?: string
  currentLesson?: string
  previousOutput?: string
  mapSlice?: string
  updatedAt: string
}

export interface CourseValidationReport {
  errors: string[]
  warnings: string[]
}

const DEPTHS = new Set<CourseDepth>(['deep', 'index', 'reference', 'deferred'])
const PRIORITIES = new Set<ConceptPriority>(['core', 'support', 'implementation', 'deferred'])

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串`)
  return value.trim()
}

function stringArrayOf(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是字符串数组`)
  return value.map((item, index) => stringOf(item, `${label}[${index}]`))
}

function parseCoverage(value: unknown): CourseCoverage[] {
  if (!Array.isArray(value)) throw new Error('coverage 必须是数组')
  return value.map((item, index) => {
    const raw = recordOf(item, `coverage[${index}]`)
    const depth = stringOf(raw.depth, `coverage[${index}].depth`) as CourseDepth
    if (!DEPTHS.has(depth)) throw new Error(`coverage[${index}].depth 非法：${depth}`)
    return {
      scope: stringOf(raw.scope, `coverage[${index}].scope`),
      depth,
      reason: stringOf(raw.reason, `coverage[${index}].reason`),
    }
  })
}

function parseConcepts(value: unknown): CourseConcept[] {
  if (!Array.isArray(value)) throw new Error('concepts 必须是数组')
  return value.map((item, index) => {
    const raw = recordOf(item, `concepts[${index}]`)
    const priority = stringOf(raw.priority, `concepts[${index}].priority`) as ConceptPriority
    if (!PRIORITIES.has(priority)) throw new Error(`concepts[${index}].priority 非法：${priority}`)
    return {
      id: stringOf(raw.id, `concepts[${index}].id`),
      name: stringOf(raw.name, `concepts[${index}].name`),
      priority,
      definition: stringOf(raw.definition, `concepts[${index}].definition`),
      introducedIn: stringOf(raw.introducedIn, `concepts[${index}].introducedIn`),
      prerequisites: stringArrayOf(raw.prerequisites ?? [], `concepts[${index}].prerequisites`),
      sources: stringArrayOf(raw.sources ?? [], `concepts[${index}].sources`),
    }
  })
}

function parseLessons(value: unknown, runIndex: number): CourseLesson[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`runs[${runIndex}].lessons 必须是非空数组`)
  return value.map((item, lessonIndex) => {
    const raw = recordOf(item, `runs[${runIndex}].lessons[${lessonIndex}]`)
    return {
      id: stringOf(raw.id, `runs[${runIndex}].lessons[${lessonIndex}].id`),
      title: stringOf(raw.title, `runs[${runIndex}].lessons[${lessonIndex}].title`),
      previousOutput: stringOf(raw.previousOutput, `runs[${runIndex}].lessons[${lessonIndex}].previousOutput`),
      output: stringOf(raw.output, `runs[${runIndex}].lessons[${lessonIndex}].output`),
      prerequisites: stringArrayOf(raw.prerequisites ?? [], `runs[${runIndex}].lessons[${lessonIndex}].prerequisites`),
      evidence: stringArrayOf(raw.evidence, `runs[${runIndex}].lessons[${lessonIndex}].evidence`),
      boundary: stringOf(raw.boundary, `runs[${runIndex}].lessons[${lessonIndex}].boundary`),
    }
  })
}

function parseRuns(value: unknown): CourseRun[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('runs 必须是非空数组')
  return value.map((item, index) => {
    const raw = recordOf(item, `runs[${index}]`)
    return {
      id: stringOf(raw.id, `runs[${index}].id`),
      title: stringOf(raw.title, `runs[${index}].title`),
      goal: stringOf(raw.goal, `runs[${index}].goal`),
      entryState: stringOf(raw.entryState, `runs[${index}].entryState`),
      endState: stringOf(raw.endState, `runs[${index}].endState`),
      evidence: stringArrayOf(raw.evidence, `runs[${index}].evidence`),
      lessons: parseLessons(raw.lessons, index),
    }
  })
}

/** 从课程母图的围栏代码块中读取结构化数据。 */
export function parseCourseBlueprint(markdown: string): CourseBlueprint {
  const match = /```course-json\s*\r?\n([\s\S]*?)\r?\n```/.exec(markdown)
  if (!match) throw new Error('课程蓝图缺少 ```course-json 围栏')
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch (error) {
    throw new Error(`course-json 不是合法 JSON：${(error as Error).message}`)
  }
  const raw = recordOf(parsed, 'course-json')
  if (raw.version !== COURSE_SCHEMA_VERSION) {
    throw new Error(`课程蓝图版本不受支持：${String(raw.version)}（当前 ${COURSE_SCHEMA_VERSION}）`)
  }
  return {
    version: COURSE_SCHEMA_VERSION,
    courseId: stringOf(raw.courseId, 'courseId'),
    title: stringOf(raw.title, 'title'),
    outcomes: stringArrayOf(raw.outcomes, 'outcomes'),
    sourceRoots: stringArrayOf(raw.sourceRoots, 'sourceRoots'),
    coverage: parseCoverage(raw.coverage),
    concepts: parseConcepts(raw.concepts ?? []),
    runs: parseRuns(raw.runs),
  }
}

function normalizedScope(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '')
}

function inventoryKey(file: CourseInventoryFile): string {
  return `${normalizedScope(file.root)}/${normalizedScope(file.path)}`
}

export function validateCourseBlueprint(
  blueprint: CourseBlueprint,
  inventory?: CourseInventory,
): CourseValidationReport {
  const errors: string[] = []
  const warnings: string[] = []
  const lessonIds = new Set<string>()
  const conceptIds = new Set<string>()

  if (blueprint.outcomes.length === 0) errors.push('课程至少需要一个目标能力')
  if (blueprint.sourceRoots.length === 0) errors.push('课程至少需要一个来源根')
  if (blueprint.coverage.length === 0) errors.push('课程缺少覆盖矩阵')

  for (const concept of blueprint.concepts) {
    if (conceptIds.has(concept.id)) errors.push(`概念 ID 重复：${concept.id}`)
    conceptIds.add(concept.id)
  }

  const runIds = new Set<string>()
  for (const run of blueprint.runs) {
    if (runIds.has(run.id)) errors.push(`运行链 ID 重复：${run.id}`)
    runIds.add(run.id)
    if (run.evidence.length === 0) errors.push(`运行链 ${run.id} 缺少证据`)
    for (const lesson of run.lessons) {
      if (lessonIds.has(lesson.id)) errors.push(`讲次 ID 重复：${lesson.id}`)
      lessonIds.add(lesson.id)
      if (lesson.evidence.length === 0) errors.push(`课程 ${lesson.id} 缺少证据`)
    }
  }

  const conceptById = new Map(blueprint.concepts.map((concept) => [concept.id, concept]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  let cycleReported = false
  const visitConcept = (id: string, path: string[]): void => {
    if (cycleReported || visited.has(id)) return
    if (visiting.has(id)) {
      const start = path.indexOf(id)
      errors.push(`概念前置依赖成环：${[...path.slice(Math.max(0, start)), id].join(' -> ')}`)
      cycleReported = true
      return
    }
    visiting.add(id)
    for (const prerequisite of conceptById.get(id)?.prerequisites ?? []) {
      if (conceptById.has(prerequisite)) visitConcept(prerequisite, [...path, id])
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const concept of blueprint.concepts) visitConcept(concept.id, [])

  for (const concept of blueprint.concepts) {
    if (!lessonIds.has(concept.introducedIn)) {
      errors.push(`概念 ${concept.id} 的 introducedIn 不存在：${concept.introducedIn}`)
    }
    for (const prerequisite of concept.prerequisites) {
      if (!conceptIds.has(prerequisite)) {
        errors.push(`概念 ${concept.id} 依赖未定义概念 ${prerequisite}`)
      }
      if (prerequisite === concept.id) errors.push(`概念 ${concept.id} 不能依赖自身`)
    }
  }

  for (const run of blueprint.runs) {
    for (const lesson of run.lessons) {
      for (const prerequisite of lesson.prerequisites) {
        if (!conceptIds.has(prerequisite)) {
          errors.push(`课程 ${lesson.id} 依赖未定义概念 ${prerequisite}`)
        }
      }
    }
  }

  const scopes = blueprint.coverage.map((entry) => normalizedScope(entry.scope))
  if (inventory) {
    if (inventory.courseId !== blueprint.courseId) {
      errors.push(`来源清单课程 ID 不一致：${inventory.courseId} ≠ ${blueprint.courseId}`)
    }
    const blueprintRoots = blueprint.sourceRoots.map((root) => resolve(root)).sort()
    const inventoryRoots = inventory.roots.map((root) => resolve(root.path)).sort()
    if (blueprintRoots.join('\n') !== inventoryRoots.join('\n')) {
      errors.push('课程来源根与已生成清单不一致')
    }
    for (const file of inventory.files) {
      const key = inventoryKey(file)
      const sourcePath = normalizedScope(file.path)
      if (!scopes.some((scope) => (
        (scope === '.' && !sourcePath.includes('/'))
        ||
        key === scope || key.startsWith(`${scope}/`)
        || sourcePath === scope || sourcePath.startsWith(`${scope}/`)
      ))) {
        errors.push(`来源未被覆盖矩阵覆盖：${key}`)
      }
    }
    if (inventory.skipped.length > 0) {
      warnings.push(`来源清单有 ${inventory.skipped.length} 个跳过项，激活前需确认原因`)
    }
  }

  if (!blueprint.concepts.some((concept) => concept.priority === 'core')) {
    warnings.push('课程没有标记任何 core 主轴概念')
  }

  return { errors, warnings }
}

/** 来源签名只由稳定元数据组成，不受遍历顺序影响。 */
export function courseInventorySignature(inventory: CourseInventory): string {
  const rows = inventory.files
    .map((file) => [inventoryKey(file), file.size, file.mtimeMs, file.ctimeMs] as const)
    .sort((a, b) => compareText(a[0], b[0]))
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

export function findLesson(
  blueprint: CourseBlueprint,
  runId: string,
  lessonId: string,
): { run: CourseRun; lesson: CourseLesson } | undefined {
  const run = blueprint.runs.find((entry) => entry.id === runId)
  const lesson = run?.lessons.find((entry) => entry.id === lessonId)
  return run && lesson ? { run, lesson } : undefined
}

const COURSE_SKIP_DIRS = new Set([
  '.git', '.study', 'node_modules', 'Library', 'Temp', 'Logs', 'obj', 'bin',
])

function uniqueRootLabels(paths: string[]): CourseInventoryRoot[] {
  const used = new Set<string>()
  return paths.map((path) => {
    const base = basename(path) || 'root'
    let label = base
    let n = 2
    while (used.has(label)) label = `${base}(${n++})`
    used.add(label)
    return { label, path }
  })
}

/** 为课程建立全文件来源清单；只读来源根并保存文件元数据。 */
export async function buildCourseInventory(
  courseId: string,
  roots: string[],
  options: { maxFiles?: number; skipDirs?: string[]; now?: Date } = {},
): Promise<CourseInventory> {
  const id = courseId.trim()
  if (!id) throw new Error('courseId 不能为空')
  if (roots.length === 0) throw new Error('课程来源根不能为空')
  const resolved = [...new Set(roots.map((root) => resolve(root)))]
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 20000))
  const skip = new Set([...COURSE_SKIP_DIRS, ...(options.skipDirs ?? [])])
  const rootDefs = uniqueRootLabels(resolved)
  const files: CourseInventoryFile[] = []
  const skipped: CourseInventorySkip[] = []

  for (const root of rootDefs) {
    let truncated = false
    async function rec(dir: string): Promise<void> {
      if (truncated) return
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch (error) {
        skipped.push({ path: dir, reason: `目录读取失败（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）` })
        return
      }
      entries.sort((a, b) => compareText(a.name, b.name))
      for (const entry of entries) {
        if (truncated) return
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue
          await rec(join(dir, entry.name))
          continue
        }
        if (entry.isSymbolicLink()) {
          skipped.push({ path: join(dir, entry.name), reason: '符号链接未纳入课程来源清单' })
          continue
        }
        if (!entry.isFile()) continue
        if (files.length >= maxFiles) {
          truncated = true
          skipped.push({ path: root.path, reason: `来源文件数达到上限 ${maxFiles}，清单已截断` })
          return
        }
        const full = join(dir, entry.name)
        try {
          const stat = await fsp.stat(full)
          files.push({
            root: root.label,
            path: relative(root.path, full).replace(/\\/g, '/'),
            extension: extname(entry.name).toLowerCase(),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
          })
        } catch (error) {
          skipped.push({ path: full, reason: `文件 stat 失败（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）` })
        }
      }
    }
    await rec(root.path)
  }

  files.sort((a, b) => compareText(inventoryKey(a), inventoryKey(b)))
  return {
    version: COURSE_SCHEMA_VERSION,
    courseId: id,
    createdAt: (options.now ?? new Date()).toISOString(),
    roots: rootDefs,
    files,
    skipped,
  }
}

export function resolveCourseRoot(value: string, cwd?: string): string {
  const raw = value.trim()
  if (!raw) throw new Error('来源根不能为空')
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd ?? process.cwd(), raw)
}
