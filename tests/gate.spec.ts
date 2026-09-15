import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  archiveBody, archiveDirFor, archiveStamp, archiveThenWrite, listArchives, parseArchive, readArchive,
  renderArchive, writeArchive,
} from '../src/archive.ts'
import {
  abandonPlan, buildPlanRecord, consumePlanItem, generatePlanId, isPlanExpired, pathInPlan,
  planFileFor, readPlan, writePlan,
} from '../src/planstore.ts'
import { checkExpect, checkPathInPlan, checkPlan, checkWrite, formatPlanProposal } from '../src/gate.ts'
import { readSession, sessionFileFor, writeSession } from '../src/store.ts'

/**
 * 阶段 2 用例：硬门禁（规划 / 期望）+ 历史存档。
 *
 * 重点不是"能不能写入"，而是**写在什么前提条件下才允许写入**，以及错误路径
 * 是否**零改动**。因此失败用例一律断言"文件不存在 / 内容未变"。
 */

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'study-gate-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const ITEMS = [
  { title: '高斯消元法', path: '计算方法/第2章/直接法/高斯消元法.md', sourceSection: '《计算方法》第2章 / 2.1节', order: 1 },
  { title: '列主元消元', path: '计算方法/第2章/直接法/列主元消元.md', sourceSection: '《计算方法》第2章 / 2.2节', order: 2 },
]

describe('planstore 规划存储', () => {
  test('generatePlanId 形如 时间戳_6位hex，planFileFor 拒绝非法 id', () => {
    expect(generatePlanId()).toMatch(/^[0-9]{12}_[0-9a-f]{6}$/)
    expect(() => planFileFor(dir, '../外面')).toThrow('规划 id 非法')
    expect(() => planFileFor(dir, '')).toThrow('规划 id 非法')
  })

  test('buildPlanRecord 校验路径必须在规划根之下、标题唯一、items 非空', () => {
    const record = buildPlanRecord({ rootPath: '计算方法/第2章', items: ITEMS })
    expect(record.confirmed).toBe(false)
    expect(record.items).toHaveLength(2)
    expect(record.items[0].sourceSection).toBe('《计算方法》第2章 / 2.1节')

    expect(() => buildPlanRecord({ rootPath: '计算方法', items: [] })).toThrow('items 不能为空')
    expect(() => buildPlanRecord({ rootPath: '其它', items: ITEMS })).toThrow('不在规划根之下')
    expect(() => buildPlanRecord({
      rootPath: '计算方法',
      items: [{ title: '甲', path: '计算方法/a.md' }, { title: '甲', path: '计算方法/b.md' }],
    })).toThrow('规划项标题重复')
  })

  test('读写往返；损坏或不存在返回 null（不抛错）', async () => {
    const file = planFileFor(dir, '202610241230_ab12cd')
    expect(await readPlan(file)).toBeNull()
    const record = buildPlanRecord({ rootPath: '计算方法', items: ITEMS }, '202610241230_ab12cd')
    await writePlan(file, record)
    const back = await readPlan(file)
    expect(back?.planId).toBe('202610241230_ab12cd')
    expect(back?.items.map((i) => i.title)).toEqual(['高斯消元法', '列主元消元'])

    await writeFile(file, '{坏 JSON', 'utf8')
    expect(await readPlan(file)).toBeNull()
    await writeFile(file, '{"planId":"x"}', 'utf8')
    expect(await readPlan(file)).toBeNull()
  })

  test('isPlanExpired：按 createdAt 与 TTL 判定；解析不出时间视为未过期', () => {
    const record = buildPlanRecord({ rootPath: 'a', items: [{ title: 'x', path: 'a/x.md' }], now: new Date('2026-10-24T10:00:00Z') })
    expect(isPlanExpired(record, 24, new Date('2026-10-24T20:00:00Z'))).toBe(false)
    expect(isPlanExpired(record, 24, new Date('2026-10-26T10:00:01Z'))).toBe(true)
    expect(isPlanExpired({ ...record, createdAt: '不是时间' }, 1, new Date('2030-01-01T00:00:00Z'))).toBe(false)
  })

  test('consumePlanItem 状态机：未确认 → 过期 → 标题不在规划 → 重复消费 → 成功', async () => {
    const planId = '202610241230_ab12cd'
    const file = planFileFor(dir, planId)
    await writePlan(file, buildPlanRecord({ rootPath: '计算方法', items: ITEMS }, planId))

    expect((await consumePlanItem(file, '高斯消元法', ITEMS[0].path)).reason).toContain('规划尚未确认')

    const confirmed = await readPlan(file)
    confirmed!.confirmed = true
    confirmed!.confirmedAt = new Date().toISOString()
    await writePlan(file, confirmed!)

    expect((await consumePlanItem(file, '不存在', 'x.md')).reason).toContain('标题不在本次规划内')
    const first = await consumePlanItem(file, '高斯消元法', ITEMS[0].path)
    expect(first.ok).toBe(true)
    const again = await consumePlanItem(file, '高斯消元法', ITEMS[0].path)
    expect(again.reason).toContain('该块已在本规划中写入过')

    // 另一个标题仍可消费
    expect((await consumePlanItem(file, '列主元消元', ITEMS[1].path)).ok).toBe(true)
    expect((await readPlan(file))?.consumed.map((c) => c.title)).toEqual(['高斯消元法', '列主元消元'])

    // 过期规划：即使已确认也拒绝
    const old = await readPlan(file)
    old!.createdAt = new Date(Date.now() - 48 * 3600_000).toISOString()
    await writePlan(file, old!)
    expect((await consumePlanItem(file, '列主元消元', ITEMS[1].path)).reason).toContain('规划已过期')
  })

  test('abandonPlan 幂等；pathInPlan 认规划根与其子路径', async () => {
    const planId = '202610241230_ab12cd'
    const file = planFileFor(dir, planId)
    await writePlan(file, buildPlanRecord({ rootPath: '计算方法/第2章', items: ITEMS }, planId))
    await abandonPlan(file)
    expect(await readPlan(file)).toBeNull()
    await abandonPlan(file) // 再删一次不抛错

    const record = buildPlanRecord({ rootPath: '计算方法/第2章', items: ITEMS }, planId)
    expect(pathInPlan(record, '计算方法/第2章/直接法/x.md')).toBe(true)
    expect(pathInPlan(record, '计算方法/第2章')).toBe(true)
    expect(pathInPlan(record, '计算方法/第3章/x.md')).toBe(false)
    // 前缀相近但不是子路径
    expect(pathInPlan(record, '计算方法/第2章补充/x.md')).toBe(false)
  })
})

describe('gate 三连校验', () => {
  const expectPath = () => join(dir, '笔记期望.md')

  test('校验一：期望文件缺失 → 明确指引创建（不回退内建写法）', async () => {
    const result = checkExpect({
      vaultRoot: dir, stateDir: '.study', session: {}, expectSignature: null,
    })
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('笔记期望文件不存在')
    expect((result as { reason: string }).reason).toContain('复制到 vault 根')
  })

  test('校验一：未读 → 提示先读；签名变化 → 要求重读；一致 → 通过', async () => {
    await writeFile(expectPath(), '期望内容', 'utf8')
    const sessionFile = sessionFileFor(dir)

    const unread = checkExpect({ vaultRoot: dir, stateDir: '.study', session: {}, expectSignature: 'a|b|1' })
    expect(unread.ok).toBe(false)
    expect((unread as { reason: string }).reason).toContain('未读取笔记期望')
    expect((unread as { reason: string }).reason).toContain('note_expect_get')

    await writeSession(sessionFile, { expect: { signature: 'a|b|1', rel: '笔记期望.md' } })
    const stale = checkExpect({
      vaultRoot: dir, stateDir: '.study',
      session: await readSession(sessionFile), expectSignature: 'a|b|2',
    })
    expect(stale.ok).toBe(false)
    expect((stale as { reason: string }).reason).toContain('已更新')

    await writeSession(sessionFile, { expect: { signature: 'a|b|2', rel: '笔记期望.md' } })
    const ok = checkExpect({
      vaultRoot: dir, stateDir: '.study',
      session: await readSession(sessionFile), expectSignature: 'a|b|2',
    })
    expect(ok.ok).toBe(true)
  })

  test('校验二：无规划 → 未确认 → 已过期 → 通过', async () => {
    const noPlan = await checkPlan({ vaultRoot: dir, stateDir: '.study', session: {}, expectSignature: 's' })
    expect((noPlan as { reason: string }).reason).toContain('没有已确认的文件夹规划')
    expect((noPlan as { reason: string }).reason).toContain('note_plan')

    const planId = '202610241230_ab12cd'
    const file = planFileFor(dir, planId)
    await writePlan(file, buildPlanRecord({ rootPath: '计算方法', items: ITEMS }, planId))
    const unconfirmed = await checkPlan({
      vaultRoot: dir, stateDir: '.study', session: { activePlanId: planId }, expectSignature: 's',
    })
    expect((unconfirmed as { reason: string }).reason).toContain('规划尚未确认')

    const record = await readPlan(file)
    record!.confirmed = true
    await writePlan(file, record!)
    const expired = await checkPlan({
      vaultRoot: dir, stateDir: '.study', session: { activePlanId: planId }, expectSignature: 's', planTtlHours: 0,
    })
    expect((expired as { reason: string }).reason).toContain('规划已过期')

    const ok = await checkPlan({
      vaultRoot: dir, stateDir: '.study', session: { activePlanId: planId }, expectSignature: 's',
    })
    expect(ok.ok).toBe(true)
    expect(ok.plan?.planId).toBe(planId)
  })

  test('校验三：越界路径报错并回显规划根', () => {
    const record = buildPlanRecord({ rootPath: '计算方法/第2章', items: ITEMS })
    const bad = checkPathInPlan(record, '游戏开发/x.md')
    expect(bad.ok).toBe(false)
    expect((bad as { reason: string }).reason).toContain('不在本次规划范围')
    expect((bad as { reason: string }).reason).toContain('规划根：计算方法/第2章')
  })

  test('checkWrite 按序短路：先期望、再规划、再路径', async () => {
    // 期望未读：只报期望问题，不报规划问题
    const first = await checkWrite({
      vaultRoot: dir, stateDir: '.study', session: {}, expectSignature: 'a|b|1', targetRel: 'x.md',
    })
    expect((first as { reason: string }).reason).toContain('未读取笔记期望')

    // 期望通过但无规划
    await writeSession(sessionFileFor(dir), { expect: { signature: 'a|b|1', rel: '笔记期望.md' } })
    const session = await readSession(sessionFileFor(dir))
    const second = await checkWrite({
      vaultRoot: dir, stateDir: '.study', session, expectSignature: 'a|b|1', targetRel: 'x.md',
    })
    expect((second as { reason: string }).reason).toContain('没有已确认的文件夹规划')

    // 规划已确认但目标越界
    const planId = '202610241230_ab12cd'
    const file = planFileFor(dir, planId)
    const record = buildPlanRecord({ rootPath: '计算方法', items: ITEMS }, planId)
    record.confirmed = true
    await writePlan(file, record)
    await writeSession(sessionFileFor(dir), {
      expect: { signature: 'a|b|1', rel: '笔记期望.md' }, activePlanId: planId,
    })
    const session2 = await readSession(sessionFileFor(dir))
    const third = await checkWrite({
      vaultRoot: dir, stateDir: '.study', session: session2, expectSignature: 'a|b|1', targetRel: '游戏开发/x.md',
    })
    expect((third as { reason: string }).reason).toContain('不在本次规划范围')

    // 全部通过
    const pass = await checkWrite({
      vaultRoot: dir, stateDir: '.study', session: session2, expectSignature: 'a|b|1', targetRel: ITEMS[0].path,
    })
    expect(pass.ok).toBe(true)
    expect(pass.plan?.planId).toBe(planId)

    // requireExpect=false（note_update / note_toc 场景）：不要求期望，但仍要求规划
    const relaxed = await checkWrite({
      vaultRoot: dir, stateDir: '.study', session: {}, expectSignature: null,
      requireExpect: false, requirePlan: false, targetRel: '任意/路径.md',
    })
    expect(relaxed.ok).toBe(true)
  })

  test('formatPlanProposal 输出提案表格与下一步（只在对话里给）', () => {
    const rootPath = '计算机通识/计算方法/第2章 线性方程组数值解法'
    const record = buildPlanRecord({
      rootPath,
      material: '《计算方法》',
      items: [
        { title: '高斯消元法', path: `${rootPath}/直接法/高斯消元法.md`, sourceSection: '《计算方法》第2章 / 2.1节', order: 1 },
        { title: '列主元消元', path: `${rootPath}/直接法/列主元消元.md`, sourceSection: '《计算方法》第2章 / 2.2节', order: 2 },
      ],
    })
    const text = formatPlanProposal(record, { reusedDirs: [`${rootPath}/直接法`] })
    expect(text).toContain(`规划提案（planId：${record.planId}）`)
    expect(text).toContain('- 资料：《计算方法》')
    expect(text).toContain(`复用已有目录：${rootPath}/直接法`)
    expect(text).toContain('| 1 | 高斯消元法 |')
    expect(text).toContain('确认后我再逐个落盘')
    // 提案不落盘
    expect(text).not.toContain('.json')
  })
})

describe('archive 历史存档', () => {
  test('renderArchive / parseArchive / archiveBody 往返（原文一字不改）', () => {
    const original = '---\nID: id1\n标题: 旧\n---\n\n旧正文第一行\n旧正文第二行\n'
    const raw = renderArchive({
      fromId: 'id1', oldRel: '计算方法/第2章/高斯消元法.md',
      archivedAt: '2026-10-24T12:00:00.000Z', reason: '推翻：主元为 0 的处理有误', title: '高斯消元法',
    }, original)
    const entry = parseArchive(raw, '20261024120000000', 'x.md')
    expect(entry.meta.fromId).toBe('id1')
    expect(entry.meta.oldRel).toBe('计算方法/第2章/高斯消元法.md')
    expect(entry.meta.reason).toContain('推翻')
    expect(archiveBody(raw)).toBe(original)
  })

  test('writeArchive / listArchives / readArchive：多版本共存，时间倒序', async () => {
    const first = await writeArchive(dir, {
      fromId: 'id1', oldRel: 'a/b.md', reason: '第一次替换', content: '旧正文 1', now: new Date('2026-10-24T10:00:00Z'),
    })
    const second = await writeArchive(dir, {
      fromId: 'id1', oldRel: 'a/b.md', reason: '第二次替换', content: '旧正文 2', now: new Date('2026-10-24T11:00:00Z'),
    })
    expect(first.id).toMatch(/^[0-9]{17}$/)
    expect(first.id).not.toBe(second.id)

    const list = await listArchives(dir, 'id1')
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(second.id)
    expect(list[0].meta.reason).toBe('第二次替换')

    const read = await readArchive(dir, 'id1', second.id)
    expect(read?.raw).toContain('旧正文 2')
    expect(await readArchive(dir, 'id1', '不存在')).toBeNull()
    expect(await readArchive(dir, 'id1', '123')).toBeNull()
    expect(await listArchives(dir, '没有存档的 id')).toEqual([])
    expect(() => archiveDirFor(dir, 'a/b')).toThrow('存档 id 非法')
  })

  test('先存档后写正文：存档失败时正文一个字都不动（先红后绿的关键不变量）', async () => {
    const target = join(dir, '计算方法', '块.md')
    await mkdir(join(dir, '计算方法'), { recursive: true })
    await writeFile(target, '原始正文', 'utf8')

    // 让存档写入失败：把 .study/archive 位置占成文件，ensureDir 会报错
    await mkdir(join(dir, '.study'), { recursive: true })
    await writeFile(join(dir, '.study', 'archive'), '占位文件，挡住目录创建', 'utf8')

    await expect(archiveThenWrite({
      vaultRoot: dir, fromId: 'id1', oldRel: '计算方法/块.md', reason: '替换',
      oldContent: '原始正文',
      write: async () => { await writeFile(target, '新正文', 'utf8') },
    })).rejects.toThrow()

    // 正文未被修改——这正是"正文已改、历史已丢"的反例闸门
    expect(await readFile(target, 'utf8')).toBe('原始正文')
  })

  test('先存档后写正文：存档成功后才写；写失败时存档仍在（历史更全不丢数据）', async () => {
    const target = join(dir, '计算方法', '块2.md')
    await mkdir(join(dir, '计算方法'), { recursive: true })
    await writeFile(target, '原始正文 2', 'utf8')

    const entry = await archiveThenWrite({
      vaultRoot: dir, fromId: 'id2', oldRel: '计算方法/块2.md', reason: '替换', oldContent: '原始正文 2',
      write: async () => { await writeFile(target, '新正文 2', 'utf8') },
    })
    expect(await readFile(target, 'utf8')).toBe('新正文 2')
    expect((await readArchive(dir, 'id2', entry.id))?.raw).toContain('原始正文 2')

    await expect(archiveThenWrite({
      vaultRoot: dir, fromId: 'id2', oldRel: '计算方法/块2.md', reason: '替换', oldContent: '新正文 2',
      write: async () => { throw new Error('写盘失败') },
    })).rejects.toThrow('写盘失败')
    expect(await listArchives(dir, 'id2')).toHaveLength(2)
    expect(await readFile(target, 'utf8')).toBe('新正文 2')
  })

  test('archiveStamp 毫秒级，同一秒内两次调用不撞名', () => {
    const a = archiveStamp(new Date('2026-10-24T10:00:00.001Z'))
    const b = archiveStamp(new Date('2026-10-24T10:00:00.002Z'))
    expect(a).not.toBe(b)
    expect(a).toHaveLength(17)
  })
})
