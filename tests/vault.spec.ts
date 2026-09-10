import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  atomicWrite, cardDirFor, containsRoot, dedupeFiles, dedupeRoots, findSimilarDomainKeys, isFsRoot, mocPathFor,
  resolveSearchRoots, sanitizeFilename, skipSetFor, uniqueCardPath, walk, withinRoot, MAX_WALK_DEPTH,
  type VaultLayout,
} from '../src/vault.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'study-buddy-vault-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const layout = (domainFolders?: Record<string, string>): VaultLayout => ({
  vaultRoot: dir,
  stateDir: '.study',
  fallbackDir: '未分类',
  mocDir: '目录',
  domainFolders: domainFolders ?? { 图形学与渲染: '游戏开发/图形学' },
})

describe('vault', () => {
  test('sanitizeFilename', () => {
    expect(sanitizeFilename('透视投影矩阵：三步/分解?')).toBe('透视投影矩阵：三步 分解')
    expect(sanitizeFilename('a'.repeat(200)).length).toBeLessThanOrEqual(80)
    expect(sanitizeFilename('///')).toBe('未命名')
    // 引号（ASCII 与中文）直接移除、不留空格：标题 ↔ 文件名不脱节
    expect(sanitizeFilename('SPD 谱功率密度与"颜色是感知"')).toBe('SPD 谱功率密度与颜色是感知')
    expect(sanitizeFilename('全屏后处理的成本本质与“是否后处理”判据')).toBe('全屏后处理的成本本质与是否后处理判据')
  })

  test('sanitizeFilename：方括号与 Windows 设备名（SEC-3）', () => {
    // `[` `]` 会打断 MOC 的 [[wikilink]]
    expect(sanitizeFilename('A]]B[[C')).toBe('A B C')
    expect(sanitizeFilename('nul')).toBe('_nul')
    expect(sanitizeFilename('COM1')).toBe('_COM1')
    expect(sanitizeFilename('concept')).toBe('concept')
  })

  test('isFsRoot：真正的文件系统根判定（SEC-2）', () => {
    expect(isFsRoot(resolve('/'))).toBe(true)
    expect(isFsRoot(dir)).toBe(false)
    expect(isFsRoot(join(dir, '子目录'))).toBe(false)
  })

  test('walk 深度安全阀：超限上报而不是继续递归（SEC-2）', async () => {
    let deep = dir
    for (let i = 0; i <= MAX_WALK_DEPTH + 1; i++) deep = join(deep, `d${i}`)
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, '深处.md'), 'x')
    const skipped: string[] = []
    const files = await walk(dir, skipSetFor(), 'vault', (entry) => skipped.push(entry.reason))
    expect(files).toEqual([])
    expect(skipped.join()).toContain('目录深度超过')
  })

  test('findSimilarDomainKeys 近似键建议（"与"字差异也能命中）', () => {
    const keys = ['图形学', '图形学-后处理', '图形学-动画特效', '动画', '数学']
    expect(findSimilarDomainKeys('图形学-动画与特效', keys)).toEqual(['图形学-动画特效'])
    expect(findSimilarDomainKeys('图形学-动画特效', keys)).toEqual([]) // 精确键不参与建议
    expect(findSimilarDomainKeys('美术', keys)).toEqual([]) // 无明显近似
    expect(findSimilarDomainKeys('', keys)).toEqual([])
  })

  test('withinRoot', () => {
    expect(withinRoot(dir, join(dir, 'a/b.md'))).toBe(true)
    expect(withinRoot(dir, join(dir, '..', 'escape.md'))).toBe(false)
    // 与根目录同级的文件（跨平台写法；Windows 盘符路径在 Linux 上不成立）
    expect(withinRoot(dir, join(tmpdir(), 'other.md'))).toBe(false)
  })

  test('cardDirForMappingAndFallback', () => {
    expect(cardDirFor(layout(), '图形学与渲染')).toBe(join(dir, '游戏开发/图形学'))
    expect(cardDirFor(layout(), '美术')).toBe(join(dir, '未分类', '美术'))
  })

  test('cardDirForRejectsTraversal', () => {
    expect(() => cardDirFor(layout({ 图形学与渲染: '../escape' }), '图形学与渲染')).toThrow('越界')
  })

  test('atomicWriteCreatesContent', async () => {
    const file = join(dir, '计算机/图形学/卡片.md')
    await atomicWrite(file, '内容')
    expect(await readFile(file, 'utf8')).toBe('内容')
    // 无残留临时文件
    const files = await readdir(join(dir, '计算机/图形学'))
    expect(files).toEqual(['卡片.md'])
  })

  test('uniqueCardPathAvoidsCollision', async () => {
    const d = join(dir, '计算机/图形学')
    await mkdir(d, { recursive: true })
    await writeFile(join(d, '同名卡片.md'), '一')
    // ID 为 6 位 hex（BIZ-11b）：回退后缀同步取末 6 位（N14）
    const p = await uniqueCardPath(d, '同名卡片', '202608161430_ab12cd')
    expect(p).toBe(join(d, '同名卡片_ab12cd.md'))
    // 第三张同名卡才用完整 ID
    await writeFile(join(d, '同名卡片_ab12cd.md'), '二')
    const p3 = await uniqueCardPath(d, '同名卡片', '202608161430_ab12cd')
    expect(p3).toBe(join(d, '同名卡片_202608161430_ab12cd.md'))
  })

  test('walkSkipsHiddenDirs', async () => {
    await mkdir(join(dir, '.obsidian'), { recursive: true })
    await mkdir(join(dir, '.study'), { recursive: true })
    await mkdir(join(dir, '计算机/图形学'), { recursive: true })
    await writeFile(join(dir, '.obsidian/config.md'), 'x')
    await writeFile(join(dir, '.study/progress.md'), 'x')
    await writeFile(join(dir, '计算机/图形学/卡片.md'), 'x')
    const files = await walk(dir)
    expect(files.map((f) => f.rel.replace(/\\/g, '/'))).toEqual(['计算机/图形学/卡片.md'])
  })

  test('walkSkipsCustomDirsViaConfig', async () => {
    await mkdir(join(dir, '资源'), { recursive: true })
    await mkdir(join(dir, '计算机'), { recursive: true })
    await writeFile(join(dir, '资源/素材说明.md'), 'x')
    await writeFile(join(dir, '计算机/卡片.md'), 'x')
    // 默认不再跳过"资源"（vault 特定目录由 config.skipDirs 决定）
    const def = await walk(dir)
    expect(def.map((f) => f.rel.replace(/\\/g, '/'))).toEqual(expect.arrayContaining(['资源/素材说明.md']))
    // 配置 skipDirs 后跳过
    const custom = await walk(dir, skipSetFor(['资源']))
    expect(custom.map((f) => f.rel.replace(/\\/g, '/'))).toEqual(['计算机/卡片.md'])
    // 内置通用目录始终跳过
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'node_modules/x.md'), 'x')
    const merged = await walk(dir, skipSetFor(['资源']))
    expect(merged.map((f) => f.rel.replace(/\\/g, '/'))).toEqual(['计算机/卡片.md'])
  })

  test('mocPathForUnderMocDir', () => {
    const p = mocPathFor(layout(), '知识目录', '2026-08-16')
    expect(p).toBe(join(dir, '目录', '2026-08-16_知识目录.md'))
  })

  // N6：文件数安全阀超限时截断 + 上报原因（旧实现直接 throw，让大库用户整体不可用）
  test('N6：walk 超过 maxFiles 时截断并上报（不抛错）', async () => {
    for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(dir, `${name}.md`), 'x')
    const skipped: Array<{ path: string; reason: string }> = []
    const files = await walk(dir, skipSetFor(), 'vault', (entry) => skipped.push(entry), true, 2)
    expect(files).toHaveLength(2)
    expect(skipped).toHaveLength(1)
    expect(skipped[0].reason).toContain('扫描文件数已达上限 2')
    expect(skipped[0].reason).toContain('config.maxWalkFiles')
    // 未超限时不受影响
    const all = await walk(dir, skipSetFor(), 'vault', undefined, true, 10)
    expect(all).toHaveLength(4)
  })

  test('containsRoot 判定包含关系', () => {
    expect(containsRoot(dir, join(dir, '子目录'))).toBe(true)
    expect(containsRoot(dir, dir)).toBe(true)
    expect(containsRoot(join(dir, '子目录'), dir)).toBe(false)
    expect(containsRoot(dir, join(tmpdir(), '其他/目录'))).toBe(false)
    // 相似前缀不是包含（/a/bc 不包含 /a/b）
    expect(containsRoot(join(dir, 'ab'), join(dir, 'a'))).toBe(false)
  })

  test('dedupeRoots 裁剪被覆盖的根（vault 优先）', () => {
    const vault = { path: dir, label: 'vault', writable: true }
    const inside = { path: join(dir, '子目录'), label: '工作目录', writable: false }
    const outside = { path: join(tmpdir(), '外部笔记'), label: '外部笔记', writable: false }
    // cwd 在 vault 内：丢弃（vault 已覆盖）
    expect(dedupeRoots([vault, inside, outside]).map((r) => r.label)).toEqual(['vault', '外部笔记'])
    // vault 在 cwd 内：两者都保留（cwd 可能有 vault 之外的笔记）
    const cwd = { path: tmpdir(), label: '工作目录', writable: false }
    expect(dedupeRoots([vault, cwd]).map((r) => r.label)).toEqual(['vault', '工作目录'])
    // 完全相同的根：只留首个
    expect(dedupeRoots([vault, { path: dir, label: 'dup', writable: false }]).map((r) => r.label)).toEqual(['vault'])
  })

  test('dedupeFiles 同文件只留首个（嵌套根重复扫描防重）', () => {
    const a = { path: join(dir, 'a.md'), rel: 'a.md', root: 'vault', writable: true, mtimeMs: 1, ctimeMs: 1, size: 1 }
    const b = { path: join(dir, 'a.md'), rel: 'a.md', root: '工作目录', writable: false, mtimeMs: 1, ctimeMs: 1, size: 1 }
    const c = { path: join(dir, 'b.md'), rel: 'b.md', root: 'vault', writable: true, mtimeMs: 2, ctimeMs: 2, size: 2 }
    const out = dedupeFiles([a, b, c])
    expect(out.map((f) => f.root)).toEqual(['vault', 'vault'])
  })

  test('resolveSearchRoots 解析绝对/相对路径并生成唯一标签', async () => {
    await mkdir(join(dir, 'ext-note-a'), { recursive: true })
    const roots = resolveSearchRoots(dir, ['ext-note-a', 'ext-note-a'])
    expect(roots.map((r) => r.label)).toEqual(['ext-note-a', 'ext-note-a(2)'])
    expect(roots[0].path.endsWith('ext-note-a')).toBe(true)
    // 与保留标签冲突时加序号
    await mkdir(join(dir, 'vault'), { recursive: true })
    const cwdLike = resolveSearchRoots(dir, ['vault'])
    expect(cwdLike[0].label).toBe('vault(2)')
    // 不存在 → fail-loud
    expect(() => resolveSearchRoots(dir, [join(tmpdir(), '不存在')])).toThrow(/不存在或不可读/)
    // 文件系统根被拒绝
    expect(() => resolveSearchRoots(dir, [resolve('/')])).toThrow(/文件系统根/)
  })
})
