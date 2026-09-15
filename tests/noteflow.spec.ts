import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { VaultStore } from '../src/index.ts'
import { buildPlanRecord, planFileFor, readPlan, writePlan } from '../src/planstore.ts'
import { readSession, sessionFileFor } from '../src/store.ts'

/**
 * 阶段 4b 端到端：**硬门禁在真实写入路径上的行为**。
 *
 * 这是需求 F2 / N1 的核心验收：门禁不只存在于 gate.ts 的单测里，而是真的挡住
 * `note_write`；并且每一条拒绝都必须**磁盘零改动**（断言文件不存在）。
 */

let dir = ''

const EXPECT_TEXT = [
  '# 笔记期望',
  '',
  '## 受众',
  '零基础能独立读完。',
  '',
  '## 文风',
  '书面技术体，短句，不用 emoji。',
  '',
  '- [检查] 禁止 🚀',
].join('\n')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'study-buddy-e2e-'))
  await writeFile(join(dir, '笔记期望.md'), EXPECT_TEXT, 'utf8')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function store(): VaultStore {
  return new VaultStore({ vaultRoot: dir, stateDir: '.study', fallbackDir: '未分类', mocDir: '目录' })
}

const ROOT = '计算机通识/计算方法/第2章 线性方程组数值解法'
const ITEMS = [
  { title: '高斯消元法', path: `${ROOT}/直接法/高斯消元法.md`, sourceSection: '《计算方法》第2章 线性方程组数值解法 / 2.1节', order: 1 },
  { title: '列主元消元', path: `${ROOT}/直接法/列主元消元.md`, sourceSection: '《计算方法》第2章 线性方程组数值解法 / 2.2节', order: 2 },
]

async function exists(rel: string): Promise<boolean> {
  try {
    await readFile(join(dir, rel), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 走到"规划已确认"这一步（门禁第二环通过），返回 planId */
async function planAndConfirm(s: VaultStore): Promise<string> {
  const proposal = await s.notePlan({ rootPath: ROOT, items: ITEMS, material: '《计算方法》' })
  const planId = /planId：([0-9]{12}_[0-9a-f]{6})/.exec(proposal)?.[1] as string
  // 用户拍板：把记录标记为已确认（真实会话里由用户回复确认后由工具写入）
  const file = planFileFor(dir, planId, '.study')
  const record = await readPlan(file)
  record!.confirmed = true
  record!.confirmedAt = new Date().toISOString()
  await writePlan(file, record!)
  return planId
}

describe('阶段 4b 端到端：门禁与闭环', () => {
  test('note_library：期望文件缺失 → 明确指引；未读 → 提示；读后 → 已读', async () => {
    const s = store()
    const unread = await s.noteLibrary('check')
    expect(unread).toContain('笔记库状态')
    expect(unread).toContain('笔记期望尚未读取')
    await s.noteExpectGet()
    expect(await s.noteLibrary('check')).toContain('笔记期望：已读')
    await rm(join(dir, '笔记期望.md'), { force: true })
    const missing = await s.noteLibrary('check')
    expect(missing).toContain('笔记期望文件不存在')
    expect(missing).toContain('复制到 vault 根')
  })

  test('硬门禁①：未读期望 → note_write 拒绝且磁盘零改动', async () => {
    const s = store()
    const planId = await planAndConfirm(s)
    await expect(s.noteWrite({
      planId, title: '高斯消元法', path: ITEMS[0].path, source: '《计算方法》', content: '正文',
    })).rejects.toThrow(/未读取笔记期望/)
    expect(await exists(ITEMS[0].path)).toBe(false)
  })

  test('硬门禁①续：读过期望后用户又改了期望 → 必须重读（签名失效）', async () => {
    const s = store()
    await s.noteExpectGet()
    const planId = await planAndConfirm(s)
    // 模拟用户中途改了期望
    await writeFile(join(dir, '笔记期望.md'), `${EXPECT_TEXT}\n\n## 追加条款\n多写例子。\n`, 'utf8')
    await expect(s.noteWrite({
      planId, title: '高斯消元法', path: ITEMS[0].path, source: '《计算方法》', content: '正文',
    })).rejects.toThrow(/已更新/)
    expect(await exists(ITEMS[0].path)).toBe(false)
    // 重读后即可写入
    await s.noteExpectGet()
    const out = await s.noteWrite({
      planId, title: '高斯消元法', path: ITEMS[0].path, source: '《计算方法》', content: '正文内容。',
    })
    expect(out).toContain('已写入：')
    expect(await exists(ITEMS[0].path)).toBe(true)
  })

  test('硬门禁②：无规划 → 拒绝；未确认规划 → 拒绝', async () => {
    const s = store()
    await s.noteExpectGet()
    await expect(s.noteWrite({
      planId: '202610241200_abcdef', title: '高斯消元法', path: ITEMS[0].path, source: 'x', content: '正文',
    })).rejects.toThrow(/没有已确认的文件夹规划/)

    const proposal = await s.notePlan({ rootPath: ROOT, items: ITEMS })
    const planId = /planId：([0-9]{12}_[0-9a-f]{6})/.exec(proposal)?.[1] as string
    await expect(s.noteWrite({
      planId, title: '高斯消元法', path: ITEMS[0].path, source: 'x', content: '正文',
    })).rejects.toThrow(/规划尚未确认/)
    expect(await exists(ITEMS[0].path)).toBe(false)
  })

  test('硬门禁③：越界路径 → 拒绝并回显规划根', async () => {
    const s = store()
    await s.noteExpectGet()
    const planId = await planAndConfirm(s)
    await expect(s.noteWrite({
      planId, title: '高斯消元法', path: '游戏开发/别处/高斯消元法.md', source: 'x', content: '正文',
    })).rejects.toThrow(/不在本次规划范围/)
    expect(await exists('游戏开发/别处/高斯消元法.md')).toBe(false)
  })

  test('门禁④：标题不在规划里 / 同一规划内重复写入 → 拒绝', async () => {
    const s = store()
    await s.noteExpectGet()
    const planId = await planAndConfirm(s)
    await expect(s.noteWrite({
      planId, title: '没规划过的标题', path: ITEMS[0].path, source: 'x', content: '正文',
    })).rejects.toThrow(/不在本次规划内/)
    await s.noteWrite({ planId, title: '高斯消元法', path: ITEMS[0].path, source: '《计算方法》', content: '正文。' })
    await expect(s.noteWrite({
      planId, title: '高斯消元法', path: ITEMS[1].path, source: 'x', content: '正文',
    })).rejects.toThrow(/已在本规划中写入过/)
  })

  test('闭环：期望 → 规划 → 落块 → 微目录 → 覆盖度（含 dryRun 不落盘）', async () => {
    const s = store()
    await s.noteExpectGet()
    const planId = await planAndConfirm(s)
    const first = await s.noteWrite({
      planId, title: '高斯消元法', path: ITEMS[0].path, source: '《计算方法》',
      content: '## 直接法\n\n用初等行变换把系数矩阵化为上三角。',
    })
    // 缺微目录时提醒（需求 F3：每个主题目录都要有微目录）
    expect(first).toContain('还没有微目录')
    await s.noteWrite({
      planId, title: '列主元消元', path: ITEMS[1].path, source: '《计算方法》',
      content: '## 直接法\n\n主元过小时换行使算法稳定。',
    })

    const dry = await s.noteToc(`${ROOT}/直接法`, { dryRun: true })
    expect(dry).toContain('[dryRun]')
    expect(await exists(`${ROOT}/直接法/微目录.md`)).toBe(false)

    const toc = await s.noteToc(`${ROOT}/直接法`)
    expect(toc).toContain('已生成：')
    expect(toc).toContain('收录 2 块')
    const tocText = await readFile(join(dir, `${ROOT}/直接法/微目录.md`), 'utf8')
    expect(tocText).toContain('1. [[高斯消元法]]')
    expect(tocText).toContain('2. [[列主元消元]]')
    expect(tocText).toContain('note_toc:begin')

    // 微目录生成段可重跑（幂等），用户手写段保留（标题按目录名归一）
    await writeFile(join(dir, `${ROOT}/直接法/微目录.md`), `# 我的导读\n\n先看这两篇。\n\n${tocText.slice(tocText.indexOf('<!-- note_toc:begin -->'))}`, 'utf8')
    const again = await s.noteToc(`${ROOT}/直接法`)
    expect(again).toContain('先看这两篇。')
    expect(again).toContain('# 直接法')
    expect(again).not.toContain('我的导读')

    const overview = await s.noteOverview({ path: '计算机通识' })
    expect(overview).toContain('《计算方法》第2章 线性方程组数值解法——2 篇')
    expect(overview).toContain('节：2.1、2.2')
    expect(overview).toContain('已记录第 2 章')
  })

  test('note_list：不读正文即可导航，并标出缺微目录', async () => {
    const s = store()
    await s.noteExpectGet()
    const planId = await planAndConfirm(s)
    await s.noteWrite({ planId, title: '高斯消元法', path: ITEMS[0].path, source: '《计算方法》', content: '正文。' })
    const root = await s.noteList({})
    expect(root).toContain('计算机通识/')
    const dirList = await s.noteList({ path: `${ROOT}/直接法` })
    expect(dirList).toContain('高斯消元法 · 块')
    expect(dirList).toContain('2.1节')
    // 叶子目录缺微目录：由父级列出时标出（叶子层自己列不出"缺"，因为还没有子目录行）
    const parentList = await s.noteList({ path: ROOT })
    expect(parentList).toContain('⚠ 缺微目录')
  })

  test('note_update：append 不需规划；replace 先存档（旧正文可 history/restore）', async () => {
    const s = store()
    await s.noteExpectGet()
    const planId = await planAndConfirm(s)
    await s.noteWrite({
      planId, title: '高斯消元法', path: ITEMS[0].path, source: '《计算方法》',
      content: '## 直接法\n\n第一版正文。',
    })

    const appended = await s.noteUpdate({ ref: '高斯消元法', action: 'append', changes: '补充一句。' })
    expect(appended).toContain('第一版正文。')
    expect(appended).toContain('补充一句。')

    const replaced = await s.noteUpdate({ ref: '高斯消元法', action: 'replace', newContent: '## 直接法\n\n第二版正文。' })
    expect(replaced).toContain('第二版正文。')
    expect(replaced).toContain('旧正文已存档')
    const fileText = await readFile(join(dir, ITEMS[0].path), 'utf8')
    expect(fileText).toContain('第二版正文。')
    expect(fileText).not.toContain('第一版正文。')
    // 正文里不留历史块（需求 R23）
    expect(fileText).not.toContain('<details>')

    const history = await s.noteHistory('高斯消元法')
    expect(history).toContain('历史存档（1 份')
    expect(history).toContain('replace 替换正文')

    const restored = await s.noteRestore('高斯消元法')
    expect(restored).toContain('已恢复')
    expect(await readFile(join(dir, ITEMS[0].path), 'utf8')).toContain('第一版正文。')
    // 恢复前的那一版也已存档，可来回
    expect(await s.noteHistory('高斯消元法')).toContain('历史存档（2 份')
  })

  test('note_link / note_unlink：两侧都写 wikilink，重复关联不重复添加', async () => {
    const s = store()
    await s.noteExpectGet()
    const planId = await planAndConfirm(s)
    await s.noteWrite({ planId, title: '高斯消元法', path: ITEMS[0].path, source: '《计算方法》', content: '正文。' })
    await s.noteWrite({ planId, title: '列主元消元', path: ITEMS[1].path, source: '《计算方法》', content: '正文。' })

    const linked = await s.noteLink('高斯消元法', '列主元消元', 'next')
    expect(linked).toContain('已建立关联')
    expect(linked).toContain('改动 2 侧')
    const a = await readFile(join(dir, ITEMS[0].path), 'utf8')
    const b = await readFile(join(dir, ITEMS[1].path), 'utf8')
    expect(a).toContain('- 后续：[[列主元消元]]')
    expect(b).toContain('- 前置：[[高斯消元法]]')

    expect(await s.noteLink('高斯消元法', '列主元消元', 'next')).toContain('无改动')
    const removed = await s.noteLink('高斯消元法', '列主元消元', 'next', true)
    expect(removed).toContain('已移除关联')
    expect(await readFile(join(dir, ITEMS[0].path), 'utf8')).not.toContain('列主元消元')
  })

  test('note_lint：会话残留与期望检查项都能报出（无分值）', async () => {
    const s = store()
    await s.noteExpectGet()
    const planId = await planAndConfirm(s)
    await s.noteWrite({
      planId, title: '高斯消元法', path: ITEMS[0].path, source: '《计算方法》',
      content: '见 D:\\work\\a.cs，另外这一版带 🚀 表情。',
    })
    const report = await s.lint({ ref: '高斯消元法' })
    expect(report).toContain('会话残留')
    expect(report).toContain('本机路径')
    expect(report).not.toContain('总分')
  })

  test('note_plan(action=abandon)：放弃规划后写入被拒（门禁可解，不死锁）', async () => {
    const s = store()
    await s.noteExpectGet()
    const proposal = await s.notePlan({ rootPath: ROOT, items: ITEMS })
    const planId = /planId：([0-9]{12}_[0-9a-f]{6})/.exec(proposal)?.[1] as string
    expect((await readSession(sessionFileFor(dir, '.study'))).activePlanId).toBe(planId)
    await s.notePlan({ action: 'abandon', rootPath: planId })
    expect((await readSession(sessionFileFor(dir, '.study'))).activePlanId).toBeUndefined()
    await expect(s.noteWrite({
      planId, title: '高斯消元法', path: ITEMS[0].path, source: 'x', content: '正文',
    })).rejects.toThrow(/没有已确认的文件夹规划/)
  })

  test('note_write(dryRun)：只回显不落盘', async () => {
    const s = store()
    await s.noteExpectGet()
    const planId = await planAndConfirm(s)
    const out = await s.noteWrite({
      planId, title: '高斯消元法', path: ITEMS[0].path, source: '《计算方法》', content: '正文。', dryRun: true,
    })
    expect(out).toContain('[dryRun]')
    expect(await exists(ITEMS[0].path)).toBe(false)
    // plan 未被消费：正式写入仍然可以
    expect((await s.noteWrite({ planId, title: '高斯消元法', path: ITEMS[0].path, source: '《计算方法》', content: '正文。' })))
      .toContain('已写入：')
  })

  test('buildPlanRecord 之外：规划里已存在的目录算"复用"不算新建', async () => {
    const s = store()
    await mkdir(join(dir, `${ROOT}/直接法`), { recursive: true })
    const proposal = await s.notePlan({ rootPath: ROOT, items: ITEMS })
    expect(proposal).toContain(`复用已有目录：${ROOT}/直接法`)
    const record = buildPlanRecord({ rootPath: ROOT, items: ITEMS })
    expect(record.confirmed).toBe(false)
  })
})
