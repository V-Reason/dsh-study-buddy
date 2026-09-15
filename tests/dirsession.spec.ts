import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  DirIndex, EXPECT_FILE, MAX_NEST_HINT, TOC_FILE, assertDirPath, buildDirIndex, compareOrder,
  depthOf, dirOfRel, dirPathFor, expectPathFor, isTocRel, listDir, nestHint, normRel, parentDir,
  parseHeaderFields, readNoteHeader, resolveNoteDir, vaultRelOf,
} from '../src/dirs.ts'
import { clearExpectMark, markExpectRead, readSession, sessionFileFor, signatureOf, writeSession } from '../src/store.ts'
import type { WalkedFile } from '../src/vault.ts'

/**
 * 阶段 1 地基用例：目录模型（dirs）与门禁状态（store）。
 *
 * 断言口径沿用项目约定：用带引号的精确子串，白名单反例优先。
 */

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'study-dirs-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function walked(rel: string, root = 'vault'): WalkedFile {
  return {
    path: join(dir, rel),
    rel,
    root,
    writable: root === 'vault',
    mtimeMs: 1,
    ctimeMs: 1,
    size: 1,
  } as WalkedFile
}

describe('dirs 路径模型', () => {
  test('normRel 归一斜杠与空段', () => {
    expect(normRel('游戏开发\\图形学//技能系统/')).toBe('游戏开发/图形学/技能系统')
    expect(normRel('')).toBe('')
    expect(normRel('./a/./b')).toBe('a/b')
  })

  test('dirOfRel / parentDir / depthOf', () => {
    expect(dirOfRel('a/b/c.md')).toBe('a/b')
    expect(dirOfRel('顶层.md')).toBe('')
    expect(parentDir('a/b')).toBe('a')
    expect(parentDir('a')).toBe('')
    expect(depthOf('')).toBe(0)
    expect(depthOf('a/b/c')).toBe(3)
  })

  test('isTocRel 只认微目录文件名', () => {
    expect(isTocRel(`a/b/${TOC_FILE}`)).toBe(true)
    expect(isTocRel('a/b/微目录.md.bak')).toBe(false)
    expect(isTocRel('a/b/笔记.md')).toBe(false)
  })

  test('expectPathFor 固定在 vault 根，dirPathFor 拒绝越界', () => {
    expect(expectPathFor(dir)).toBe(join(dir, EXPECT_FILE))
    expect(dirPathFor(dir, 'a/b')).toBe(join(dir, 'a', 'b'))
    expect(dirPathFor(dir, '')).toBe(dir)
    expect(() => dirPathFor(dir, '../外面')).toThrow('目录路径不能包含相对段')
  })

  test('assertDirPath 拒绝非法字符、设备名、首尾空格', () => {
    expect(assertDirPath('正常/目录')).toBe('正常/目录')
    expect(() => assertDirPath('a/b:c')).toThrow('目录名含非法字符')
    expect(() => assertDirPath('a/nul')).toThrow('目录名与系统设备名冲突')
    expect(() => assertDirPath('a/ b')).toThrow('目录名首尾不能有空格')
  })

  test('nestHint 超过阈值才提示（软约束）', () => {
    expect(nestHint('a/b/c')).toBe('')
    const deep = Array.from({ length: MAX_NEST_HINT + 1 }, (_, i) => `d${i}`).join('/')
    expect(nestHint(deep)).toContain('已嵌套 7 层')
  })

  test('resolveNoteDir 三档优先级：规划 > 领域快捷方式 > 兜底', () => {
    const layout = { domainFolders: { 图形学: '游戏开发/图形学' }, fallbackDir: '未分类' }
    expect(resolveNoteDir(layout, { plannedDir: '计算机通识/计算方法', domain: '图形学' })).toBe('计算机通识/计算方法')
    expect(resolveNoteDir(layout, { domain: '图形学' })).toBe('游戏开发/图形学')
    expect(resolveNoteDir(layout, { domain: '未收录域' })).toBe('未分类/未收录域')
    expect(resolveNoteDir(layout, {})).toBe('')
  })

  test('vaultRelOf 拒绝 vault 外路径', () => {
    expect(vaultRelOf(dir, join(dir, 'a', 'b.md'))).toBe('a/b.md')
    expect(() => vaultRelOf(dir, join(dir, '..', 'x.md'))).toThrow('路径不在 vault 内')
  })
})

describe('dirs DirIndex（目录索引）', () => {
  test('add/remove 增量维护，父目录计数按需累加', () => {
    const index = new DirIndex()
    index.add('游戏开发/技能系统设计/块A.md', 'block')
    index.add('游戏开发/技能系统设计/块B.md', 'block')
    index.add('游戏开发/技能系统设计/存量卡.md', 'legacy')
    index.add('游戏开发/Unity/块C.md', 'block')
    index.add(`游戏开发/技能系统设计/${TOC_FILE}`, 'note')
    index.add('旧笔记.md', 'note')

    expect(index.statOf('游戏开发/技能系统设计')).toEqual({ blocks: 2, legacy: 1, notes: 0, hasToc: true })
    expect(index.countAt('游戏开发').blocks).toBe(3)
    expect(index.countAt('').blocks).toBe(3)
    expect(index.countAt('').notes).toBe(1)
    // 子目录集合（顺序无关：localeCompare 对拉丁段与中文段的相对次序随 ICU 版本变化）
    expect([...index.childrenOf('游戏开发')].sort()).toEqual(['游戏开发/Unity', '游戏开发/技能系统设计'].sort())
    expect(index.childrenOf('')).toEqual(['游戏开发'])

    index.remove('游戏开发/技能系统设计/块B.md', 'block')
    expect(index.statOf('游戏开发/技能系统设计').blocks).toBe(1)
    // 移除最后一个文件且无微目录 → 目录从索引消失
    index.remove('游戏开发/技能系统设计/块A.md', 'block')
    index.remove('游戏开发/技能系统设计/存量卡.md', 'legacy')
    expect(index.statOf('游戏开发/技能系统设计').hasToc).toBe(true)
    index.remove(`游戏开发/技能系统设计/${TOC_FILE}`, 'note')
    expect(index.dirs()).not.toContain('游戏开发/技能系统设计')
  })

  test('buildDirIndex 只收 vault 根内的文件（只读根不参与导航）', () => {
    const files = [
      walked('a/块1.md', 'vault'),
      walked('b/旧笔记.md', '工作目录'),
      walked('c/块2.md', 'vault'),
    ]
    const kinds = new Map([['a/块1.md', 'block' as const], ['c/块2.md', 'block' as const]])
    const index = buildDirIndex(files, kinds)
    expect(index.dirs()).toEqual(['a', 'c'])
    expect(index.countAt('').blocks).toBe(2)
  })

  test('compareOrder：顺序键优先，其次标题字典序', () => {
    const mk = (title: string, order: number | null) => ({
      rel: `${title}.md`, fileName: `${title}.md`, title, summary: null, sourceSection: null, order,
      kind: 'block' as const, id: 'x',
    })
    const sorted = [mk('丙', null), mk('乙', 2), mk('甲', 1)].sort(compareOrder)
    expect(sorted.map((f) => f.title)).toEqual(['甲', '乙', '丙'])
  })
})

describe('dirs 头部读取与 listDir', () => {
  test('parseHeaderFields 认六键 + 三个文档键，`定义` 作 `简介` 别名', () => {
    const head = parseHeaderFields([
      '---',
      'ID: 202609092139_92d2ab',
      '标题: 高斯消元法',
      '领域: #计算方法-线性方程组',
      '来源: 计算方法课件',
      '状态: 已确认',
      '来源章节: 《计算方法》第2章 线性方程组数值解法 / 2.1节',
      '顺序: 3',
      '简介: 初等行变换化上三角后回代',
      '模板: 理论型',
      '---',
      '正文',
    ].join('\n'))
    expect(head.id).toBe('202609092139_92d2ab')
    expect(head.title).toBe('高斯消元法')
    expect(head.summary).toBe('初等行变换化上三角后回代')
    expect(head.sourceSection).toBe('《计算方法》第2章 线性方程组数值解法 / 2.1节')
    expect(head.order).toBe(3)

    expect(parseHeaderFields('---\n定义: 旧卡的别名\n---\n').summary).toBe('旧卡的别名')
    expect(parseHeaderFields('---\n顺序: 不是数字\n---\n').order).toBeNull()
    expect(parseHeaderFields('没有 frontmatter').id).toBeNull()
  })

  test('readNoteHeader 头读失败（无换行巨行）时回退读全文（C4）', async () => {
    const long = `---\n标题: 巨行卡\n${'x'.repeat(5000)}\n---\n正文`
    const p = join(dir, '巨行.md')
    await writeFile(p, long, 'utf8')
    const head = await readNoteHeader(p, 128)
    expect(head.title).toBe('巨行卡')
    expect(await readNoteHeader(join(dir, '不存在.md'))).toEqual({
      id: null, title: null, summary: null, sourceSection: null, order: null,
    })
  })

  test('listDir 只读头、跳过微目录与自己、按顺序键排序', async () => {
    await mkdir(join(dir, '计算方法', '第2章 线性方程组数值解法'), { recursive: true })
    const chapter = join(dir, '计算方法', '第2章 线性方程组数值解法')
    await writeFile(join(chapter, '高斯消元法.md'), '---\nID: id1\n标题: 高斯消元法\n状态: 已确认\n来源章节: 《计算方法》第2章 / 2.1节\n顺序: 2\n简介: 化上三角\n---\n\n正文很长'.repeat(1), 'utf8')
    await writeFile(join(chapter, '列主元消元.md'), '---\nID: id2\n标题: 列主元消元\n状态: 已确认\n来源章节: 《计算方法》第2章 / 2.2节\n顺序: 1\n---\n', 'utf8')
    await writeFile(join(chapter, '存量卡.md'), '---\nID: id3\n标题: 存量卡\n状态: 草稿\n---\n', 'utf8')
    await writeFile(join(chapter, '旧笔记.md'), '# 旧笔记\n无 frontmatter\n', 'utf8')
    await writeFile(join(chapter, TOC_FILE), '# 微目录\n- [[高斯消元法]]\n', 'utf8')

    const listing = await listDir(dir, '计算方法/第2章 线性方程组数值解法')
    expect(listing.subdirs).toEqual([])
    expect(listing.files.map((f) => f.title)).toEqual(['列主元消元', '高斯消元法', '存量卡', '旧笔记'])
    expect(listing.files.map((f) => f.kind)).toEqual(['block', 'block', 'legacy', 'note'])
    expect(listing.files.find((f) => f.title === '高斯消元法')?.summary).toBe('化上三角')

    const rootListing = await listDir(dir, '')
    expect(rootListing.subdirs).toEqual(['计算方法'])

    await expect(listDir(dir, '不存在的目录')).rejects.toThrow('目录不存在或不可读')
  })
})

describe('store 门禁状态（.study/session.json）', () => {
  test('读写往返；已读标记与签名', async () => {
    const file = sessionFileFor(dir)
    expect(await readSession(file)).toEqual({})

    await markExpectRead(file, { signature: 'a|b|c', rel: EXPECT_FILE })
    const state = await readSession(file)
    expect(state.expect?.signature).toBe('a|b|c')
    expect(state.expect?.rel).toBe(EXPECT_FILE)
    expect(state.expect?.readAt).toBeTruthy()

    await writeSession(file, { activePlanId: 'plan-1' })
    const next = await readSession(file)
    expect(next.activePlanId).toBe('plan-1')
    // writeSession 会整体覆盖，expect 已不在（门禁要求重读一次）——这是有意的
    expect(next.expect).toBeUndefined()
  })

  test('损坏或不存在的文件一律回空态，不抛错（门禁退化而非整体不可用）', async () => {
    const file = sessionFileFor(dir)
    await mkdir(join(dir, '.study'), { recursive: true })
    await writeFile(file, '{ 这不是 JSON', 'utf8')
    expect(await readSession(file)).toEqual({})

    await writeFile(file, '[1,2,3]', 'utf8')
    expect(await readSession(file)).toEqual({})

    await writeFile(file, '{"expect":{"signature":123},"activePlanId":"  "}', 'utf8')
    expect(await readSession(file)).toEqual({})
  })

  test('clearExpectMark 清已读标记、保留规划指针', async () => {
    const file = sessionFileFor(dir)
    await writeSession(file, { activePlanId: 'plan-9' })
    await markExpectRead(file, { signature: 's', rel: EXPECT_FILE })
    await clearExpectMark(file)
    const state = await readSession(file)
    expect(state.expect).toBeUndefined()
    expect(state.activePlanId).toBe('plan-9')
  })

  test('signatureOf 对不存在文件返回 null，三要素随内容变化', async () => {
    const p = join(dir, 'x.md')
    expect(await signatureOf(p)).toBeNull()
    await writeFile(p, 'a', 'utf8')
    const first = await signatureOf(p)
    expect(first).toMatch(/^\d+(\.\d+)?\|\d+(\.\d+)?\|1$/)
    await writeFile(p, 'abc', 'utf8')
    expect(await signatureOf(p)).not.toBe(first)
  })

  test('sessionFileFor 拒绝越界 stateDir', () => {
    expect(() => sessionFileFor(dir, '../外面')).toThrow('路径越界')
  })
})
