import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { promises as fsp, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { todayLocal } from '../src/note.ts'
import { VaultStore } from '../src/index.ts'
import { SearchIndex } from '../src/search.ts'
import { MAX_WALK_DEPTH, type VaultLayout } from '../src/vault.ts'

/**
 * 测试替身：`walk` 只读取 dirent 的 `name` / `isDirectory()` / `isSymbolicLink()`。
 * 故意**只实现这三个**——`walk` 若改用别的成员，替身会当场抛错而不是静默失真。
 */
function fakeSymlinkDirent(name: string): Dirent {
  return {
    name,
    isDirectory: () => false,
    isSymbolicLink: () => true,
  } as unknown as Dirent
}

/**
 * fs 注入（未命中的路径一律直通真实实现），用于制造真实文件系统上造不出来的场景。
 *
 * 注入点是 `node:fs` 的 `promises` 对象——它是普通可写对象，`src/index.ts`（`fsp.push/readFile`）
 * 与 `src/vault.ts`（`fsp.readdir/stat`）用的是同一份引用，所以替换对它俩都可见（已实测）。
 * 注意**不能**改成 `vi.spyOn(await import('node:fs/promises'), …)`：ESM 命名空间不可配置，
 * 且静态/动态导入得到的命名空间可配置性还不一致（vitest 4 下时好时坏）。
 *
 * 存在的理由：`symlink()` 在无特权/无开发者模式的 Windows 上抛 EPERM，旧用例
 * `catch { return }` 直接空跑——**本地绿、CI（ubuntu）红的假绿**。这里让 walk 看到一个
 * 断链符号链接条目（`stat` 仍真实访问文件系统并抛 ENOENT），任何平台都能真正执行该路径。
 */
async function spyFs(extra: { entries?: Dirent[]; readFailures?: string[] }): Promise<() => void> {
  const realReaddir = fsp.readdir
  const realReadFile = fsp.readFile
  const failing = new Set((extra.readFailures ?? []).map((p) => resolve(p)))
  const added = extra.entries ?? []
  const spies = [
    vi.spyOn(fsp, 'readdir').mockImplementation((async (p: string, o?: object) => {
      const real = (o === undefined ? await realReaddir(p) : await realReaddir(p, o as never)) as unknown[]
      // 只对 vault 根注入（与真实断链所在层级一致）
      return added.length > 0 && resolve(String(p)) === resolve(dir) ? [...added, ...real] : real
    }) as typeof fsp.readdir),
    vi.spyOn(fsp, 'readFile').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      if (failing.has(resolve(String(p)))) {
        throw Object.assign(new Error(`ENOENT: 注入的读盘失败（${basename(String(p))}）`), { code: 'ENOENT' })
      }
      return await (realReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
    }) as typeof fsp.readFile),
  ]
  return () => spies.forEach((s) => s.mockRestore())
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'study-buddy-e2e-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 构造一张最小卡片（外部写入用，绕过 store.create） */
function rawCard(id: string, title: string, keyword: string): string {
  return `---\nID: ${id}\n标题: ${title}\n领域: #其它\n来源: 验证\n状态: 草稿\n---\n\n> ${keyword} 的定义\n`
}

function layout(): VaultLayout {
  return {
    vaultRoot: dir,
    stateDir: '.study',
    fallbackDir: '未分类',
    mocDir: '目录',
    domainFolders: { 图形学与渲染: '游戏开发/图形学' },
  }
}

describe('VaultStore 端到端', () => {
  test('memory 与 progress 相互独立：清空进度不影响记忆', async () => {
    const store = new VaultStore(layout())

    // 记忆：set → get → append → remove → clear
    expect(await store.memory('get', {})).toBe('暂无记忆。')
    const set = await store.memory('set', { key: 'prefs', value: '讲解多用 C++ 例子' })
    expect(set).toContain('已记忆 prefs')
    expect(set).toContain('记忆（1 条）')
    await store.memory('set', { key: 'lastSummary', value: '讲了透视投影矩阵' })
    const full = await store.memory('get', {})
    expect(full).toContain('上次小结：讲了透视投影矩阵')
    expect(full.indexOf('上次小结')).toBeLessThan(full.indexOf('prefs'))
    expect(await store.memory('get', { key: 'prefs' })).toBe('prefs：讲解多用 C++ 例子')
    expect(await store.memory('get', { key: '不存在' })).toContain('无此键')

    // append 追加新行
    await store.memory('append', { key: 'prefs', value: '公式少放' })
    expect(await store.memory('get', { key: 'prefs' })).toContain('讲解多用 C++ 例子\n公式少放')

    // 清空进度（study_progress clear）不动记忆
    await store.progress('set', { material: 'GAMES101 L04' })
    await store.progress('clear', {})
    expect(await store.progress('get', {})).toContain('（未开始）')
    expect(await store.memory('get', {})).toContain('上次小结：讲了透视投影矩阵')

    // remove / clear
    expect(await store.memory('remove', { key: 'prefs' })).toContain('已删除')
    expect(await store.memory('get', { key: 'prefs' })).toContain('无此键')
    // remove 不存在的键：明确提示，不写盘
    expect(await store.memory('remove', { key: '不存在的键' })).toContain('无此键')
    const memFile = join(dir, '.study', 'memory.json')
    const before = await readFile(memFile, 'utf8')
    await store.memory('remove', { key: '仍不存在' })
    expect(await readFile(memFile, 'utf8')).toBe(before)
    await store.memory('clear', {})
    expect(await store.memory('get', {})).toBe('暂无记忆。')
  })

  test('memory 拒绝非法键与超长值', async () => {
    const store = new VaultStore(layout())
    await expect(store.memory('set', { key: '  ', value: 'x' })).rejects.toThrow('不能为空')
    await expect(store.memory('set', { key: 'k'.repeat(65), value: 'x' })).rejects.toThrow('过长')
    await expect(store.memory('set', { key: 'prefs', value: 'x'.repeat(4001) })).rejects.toThrow('过长')
    await expect(store.memory('bogus', {})).rejects.toThrow('未知 action')
  })

  test('memory 自迭代开关：默认关闭、set 切换、get 显示、非法值 fail-loud', async () => {
    const store = new VaultStore(layout())
    // 缺省：无键即关闭，且不占用"记忆（N 条）"
    expect(await store.memory('get', { key: '_autoPrefs' })).toContain('默认')
    expect(await store.memory('get', {})).toBe('暂无记忆。')

    // 开启后：get 单键/全量置顶显示；开关不计入条数
    expect(await store.memory('set', { key: '_autoPrefs', value: 'on' })).toContain('已开启自迭代记忆')
    expect(await store.memory('get', { key: '_autoPrefs' })).toContain('开启')
    await store.memory('set', { key: 'prefs', value: '讲解多用 C++ 例子' })
    const full = await store.memory('get', {})
    expect(full.startsWith('自迭代记忆：开启')).toBe(true)
    expect(full).toContain('记忆（1 条）')

    // 关闭（值允许周围空白）
    expect(await store.memory('set', { key: '_autoPrefs', value: ' off ' })).toContain('已关闭自迭代记忆')
    expect(await store.memory('get', { key: '_autoPrefs' })).toContain('关闭')

    // 非法值 fail-loud；append 无意义直接拒绝
    await expect(store.memory('set', { key: '_autoPrefs', value: 'yes' })).rejects.toThrow('on/off')
    await expect(store.memory('append', { key: '_autoPrefs', value: 'on' })).rejects.toThrow('不支持 append')
  })

  test('memory 自迭代开关：remove 回默认、clear 彻底重置', async () => {
    const store = new VaultStore(layout())
    await store.memory('set', { key: '_autoPrefs', value: 'on' })
    await store.memory('set', { key: 'prefs', value: 'x' })
    // remove 开关键：回到默认关闭，其余记忆保留
    expect(await store.memory('remove', { key: '_autoPrefs' })).toContain('已关闭')
    expect(await store.memory('get', { key: '_autoPrefs' })).toContain('默认')
    expect(await store.memory('get', {})).toContain('prefs')
    // remove 不存在的开关键：明确提示，不写盘
    expect(await store.memory('remove', { key: '_autoPrefs' })).toContain('无需删除')
    // clear 连开关一起清
    await store.memory('set', { key: '_autoPrefs', value: 'on' })
    await store.memory('clear', {})
    expect(await store.memory('get', {})).toBe('暂无记忆。')
    expect(await store.memory('get', { key: '_autoPrefs' })).toContain('默认')
  })

  test('memory 容忍手改的异常开关键值：读不炸、set 可修复', async () => {
    const store = new VaultStore(layout())
    await mkdir(join(dir, '.study'), { recursive: true })
    await writeFile(join(dir, '.study', 'memory.json'), JSON.stringify({ notes: { _autoPrefs: 'yes-please' } }), 'utf8')
    expect(await store.memory('get', {})).toContain('异常值')
    expect(await store.memory('get', { key: '_autoPrefs' })).toContain('异常值')
    await store.memory('set', { key: '_autoPrefs', value: 'on' })
    expect(await store.memory('get', { key: '_autoPrefs' })).toContain('开启')
  })

  test('memory get 全量输出对疑似过期进度句提示（进度单一来源）', async () => {
    const store = new VaultStore(layout())
    await store.memory('set', { key: 'prefs.用户画像', value: '现学 GAMES101 L19' })
    const full = await store.memory('get', {})
    expect(full).toContain('⚠ 提示：上述记忆键含进度句')
    expect(full).toContain('prefs.用户画像')
    expect(full).toContain('study_progress 为准')
    // 移除过期进度句后不再提示
    await store.memory('remove', { key: 'prefs.用户画像' })
    await store.memory('set', { key: 'prefs.讲解偏好', value: '先直觉后机制' })
    expect(await store.memory('get', {})).not.toContain('⚠ 提示')
  })

  test('searchOnMissingVaultThrowsClearError', async () => {
    const store = new VaultStore({ ...layout(), vaultRoot: join(dir, '不存在') })
    await expect(store.search('矩阵')).rejects.toThrow('vault 根目录不存在')
  })

  test('externalEditIsPickedUpByIndex', async () => {
    // indexTtlMs: 0 → 每次调用都重扫，外部编辑立即可见（默认 2000ms 内有缓存窗口）
    const store = new VaultStore({ ...layout(), indexTtlMs: 0 })
    await mkdir(join(dir, '计算机/图形学'), { recursive: true })
    const file = join(dir, '计算机/图形学/外部新建.md')
    await writeFile(file, '# 外部新建概念\n正文')
    expect(await store.search('外部新建概念')).toContain('外部新建概念')
    // 外部修改标题（长度也变化，保证签名必然不同）后索引重建
    await writeFile(file, '# 外部改名概念\n正文内容更长以保证签名变化')
    expect(await store.search('外部改名概念')).toContain('外部改名概念')
    expect(await store.search('新建')).toContain('未命中')
  })
})

describe('VaultStore 多根检索（工作目录与额外根的旧笔记）', () => {
  let extra: string
  let cwdDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'study-buddy-e2e-'))
    extra = await mkdtemp(join(tmpdir(), 'study-buddy-extra-'))
    cwdDir = await mkdtemp(join(tmpdir(), 'study-buddy-cwd-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(extra, { recursive: true, force: true })
    await rm(cwdDir, { recursive: true, force: true })
  })

  test('search 覆盖 searchRoots 与 sessionCwd 旧笔记，标注类型与根路径', async () => {
    await mkdir(join(extra, '图形学'), { recursive: true })
    await writeFile(join(extra, '图形学/投影矩阵旧笔记.md'), '# 投影矩阵旧笔记\n透视投影讲解\n')
    await mkdir(join(cwdDir, 'CS'), { recursive: true })
    await writeFile(join(cwdDir, 'CS/迭代器旧笔记.md'), '> 概念: 迭代器设计模式\n# 迭代器\nvector.begin()\n')
    await mkdir(join(dir, '计算机/图形学'), { recursive: true })
    await writeFile(join(dir, '计算机/图形学/透视卡片.md'),
      '---\nID: 202608161430_ab12\n标题: 透视投影矩阵的三步分解\n领域: #图形学与渲染\n来源: GAMES101 L04\n状态: 草稿\n---\n\n> 透视投影矩阵可拆解为三步\n\n正文')
    const store = new VaultStore({ ...layout(), searchRoots: [extra], includeSessionCwd: true })

    const mixed = await store.search('投影矩阵', {}, { sessionCwd: cwdDir })
    expect(mixed).toContain('类型：存量卡')
    expect(mixed).toContain('类型：旧笔记')
    expect(mixed).toContain(`- 路径：${basename(extra)}/图形学/投影矩阵旧笔记.md`)
    expect(mixed).toContain(`来源：vault / ${basename(extra)} / 工作目录`)

    const iter = await store.search('迭代器', {}, { sessionCwd: cwdDir })
    expect(iter).toContain('类型：旧笔记')
    expect(iter).toContain('- 路径：工作目录/CS/迭代器旧笔记.md')

    // 不传 cwd：工作目录不可见（vault 无此笔记）
    expect(await store.search('迭代器', {}, {})).toContain('未命中')
    // kind 过滤：只找有 ID 的笔记（存量卡）
    const onlyCards = await store.search('投影矩阵', { kind: 'legacy' }, { sessionCwd: cwdDir })
    expect(onlyCards).toContain('类型：存量卡')
    expect(onlyCards).not.toContain('类型：旧笔记')
  })

  test('get 跨根读取旧笔记全文（根限定路径与唯一文件名）', async () => {
    await mkdir(join(extra, '图形学'), { recursive: true })
    await writeFile(join(extra, '图形学/投影矩阵旧笔记.md'), '# 投影矩阵旧笔记\n透视投影讲解\n')
    const store = new VaultStore({ ...layout(), searchRoots: [extra] })
    expect(await store.get('投影矩阵旧笔记.md')).toContain('透视投影讲解')
    expect(await store.get(`${basename(extra)}/图形学/投影矩阵旧笔记.md`)).toContain('# 投影矩阵旧笔记')
  })

  test('cwd 与 vault 相同或嵌套时不重复索引', async () => {
    await mkdir(join(dir, '计算机/图形学'), { recursive: true })
    await writeFile(join(dir, '计算机/图形学/卡片.md'), '# 卡片\n内容')
    const store = new VaultStore({ ...layout(), includeSessionCwd: true })
    const same = await store.search('卡片', {}, { sessionCwd: dir })
    expect(same).toContain('命中 1')
    // cwd 在 vault 内：为 vault 子集，同样不重复（vault 标签优先）
    const nested = await store.search('卡片', {}, { sessionCwd: join(dir, '计算机') })
    expect(nested).toContain('命中 1')
  })

  test('同名文件跨根产生路径歧义时明确报错', async () => {
    await mkdir(join(dir, '笔记'), { recursive: true })
    await writeFile(join(dir, '笔记/同名.md'), '# vault 同名')
    await mkdir(join(extra, '笔记'), { recursive: true })
    await writeFile(join(extra, '笔记/同名.md'), '# extra 同名')
    const store = new VaultStore({ ...layout(), searchRoots: [extra] })
    await expect(store.get('同名.md')).rejects.toThrow(/路径歧义/)
    expect(await store.get('vault/笔记/同名.md')).toContain('vault 同名')
    expect(await store.get(`${basename(extra)}/笔记/同名.md`)).toContain('extra 同名')
  })

  test('searchRoots 不存在时构造即抛错（fail-loud）', () => {
    expect(() => new VaultStore({ ...layout(), searchRoots: [join(tmpdir(), '不存在')] })).toThrow(/不存在或不可读/)
  })
})

