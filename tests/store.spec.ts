import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { VaultStore } from '../src/index.ts'
import type { VaultLayout } from '../src/vault.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'study-buddy-e2e-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

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
  test('create→search→get→update→link→moc→progress 全链路', async () => {
    const store = new VaultStore(layout())

    // 建卡：映射目录落盘
    const created = await store.create({
      title: '透视投影矩阵的三步分解',
      domain: '图形学与渲染',
      source: 'GAMES101 L04',
      status: '草稿',
      definition: '透视投影矩阵可拆解为缩放、平移与齐次除三步',
      content: '推导正文\n\n```hlsl\nfloat4x4 m;\n```',
      tags: ['线性代数'],
    })
    expect(created.rel).toBe('游戏开发/图形学/透视投影矩阵的三步分解.md')
    expect(created.text).toContain('ID: ')
    const idMatch = /ID: (\d{12}_[0-9a-f]{4})/.exec(created.text)
    expect(idMatch).toBeTruthy()
    const id = idMatch![1]

    // 检索命中（含外部新建的旧笔记）
    await mkdir(join(dir, '计算机/编程/C++/基础C++'), { recursive: true })
    await writeFile(join(dir, '计算机/编程/C++/基础C++/迭代器 iterator _cpp.md'),
      '> 概念: 迭代器是一种设计模式\n# 迭代器主要方法\n- vector.begin()\n')
    const search = await store.search('投影矩阵')
    expect(search).toContain('透视投影矩阵的三步分解')
    // 定稿格式卡片检索结果展示一句话定义（extractDefinition 裸引用块回退）
    expect(search).toContain('- 定义：透视投影矩阵可拆解为缩放、平移与齐次除三步')
    const legacy = await store.search('迭代器')
    expect(legacy).toContain('迭代器主要方法')
    expect(legacy).toContain('目录: 计算机')

    // 读取整卡
    const got = await store.get(id)
    expect(got).toContain('> 透视投影矩阵可拆解')

    // 增量更新：版本更新，旧内容保留
    const updated = await store.update(id, {
      mode: 'append-version',
      source: 'GAMES101 L05',
      changes: '补充：w 分量来自视图空间深度。',
    })
    expect(updated).toContain('版本更新（来源：GAMES101 L05）')
    expect(updated).toContain('透视投影矩阵可拆解')

    // 关联
    const created2 = await store.create({
      title: '光栅化',
      domain: '图形学与渲染',
      source: 'GAMES101 L05',
      status: '草稿',
      definition: '光栅化把图元离散为屏幕像素',
      content: '采样与深度测试',
    })
    const id2 = /ID: (\d{12}_[0-9a-f]{4})/.exec(created2.text)![1]
    const linked = await store.link(id, id2, 'next')
    expect(linked).toContain('已建立关联')
    // 重复关联同一对（如标题变更后）：按 ID 判重，不重复添加
    const linkedAgain = await store.link(id, id2, 'next')
    expect(linkedAgain).toContain('已建立关联')
    const file1 = await readFile(join(dir, '游戏开发/图形学/透视投影矩阵的三步分解.md'), 'utf8')
    expect(file1.match(/- 后续：/g)?.length).toBe(1)
    expect(file1).toContain(`- 后续：光栅化（${id2}）`)
    const file2 = await readFile(join(dir, '游戏开发/图形学/光栅化.md'), 'utf8')
    expect(file2).toContain('- 前置：')

    // MOC（日期不硬编码，避免跨时区 CI 漂移）
    const moc = await store.moc({ title: '本次学习目录', cardIds: [id, id2] })
    expect(moc).toContain('MOC 已写入：目录/')
    expect(moc).toContain('_本次学习目录.md')
    expect(moc).toContain('## 图形学与渲染')
    expect(moc).toContain('[[光栅化]]')

    // 进度
    await store.progress('set', {
      material: 'GAMES101 L04',
      section: '投影矩阵·平移部分',
      pendingQuestions: ['为什么 w 要归一化？'],
      touchedCardIds: [id],
    })
    const progress = await store.progress('get', {})
    expect(progress).toContain('GAMES101 L04')
    expect(progress).toContain('为什么 w 要归一化？')
    await store.progress('clear', {})
    expect(await store.progress('get', {})).toContain('（未开始）')
  })

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

  test('createFallsBackForUnmappedDomain', async () => {
    const store = new VaultStore(layout())
    const created = await store.create({
      title: 'UV 展开',
      domain: '美术',
      source: '截图',
      status: '草稿',
      definition: 'UV 是把三维表面摊平到二维纹理空间',
      content: '接缝与拉伸',
    })
    expect(created.rel).toBe('未分类/美术/UV 展开.md')
  })

  test('createRejectsInvalidCard', async () => {
    const store = new VaultStore(layout())
    await expect(store.create({
      title: '',
      domain: '美术',
      source: 'x',
      status: '草稿',
      definition: '定义',
      content: '内容',
    })).rejects.toThrow('校验失败')
  })

  test('updateRejectsUnknownId', async () => {
    const store = new VaultStore(layout())
    await expect(store.update('不存在', { mode: 'append-version', changes: 'x' })).rejects.toThrow('找不到卡片')
  })

  test('updateReplacePreservesLinks', async () => {
    const store = new VaultStore(layout())
    const created = await store.create({
      title: '红黑树插入',
      domain: '数据结构与算法',
      source: '课件',
      status: '草稿',
      definition: '红黑树插入通过变色与旋转维持平衡',
      content: '插入流程',
    })
    const id = /ID: (\d{12}_[0-9a-f]{4})/.exec(created.text)![1]
    const updated = await store.update(id, {
      mode: 'replace',
      card: {
        title: '红黑树插入（修订版）',
        domain: '数据结构与算法',
        source: '课件',
        status: '已确认',
        definition: '修订后的定义',
        content: '新正文',
        links: { prev: ['二叉查找树'], conflict: ['AVL 树'] },
      },
    })
    expect(updated).toContain('红黑树插入（修订版）')
    expect(updated).toContain('- 前置：二叉查找树')
    expect(updated).toContain('- 易混淆：AVL 树')
    expect(updated).toContain('历史版本') // 旧版保留
  })

  test('searchOnMissingVaultThrowsClearError', async () => {
    const store = new VaultStore({ ...layout(), vaultRoot: join(dir, '不存在') })
    await expect(store.search('矩阵')).rejects.toThrow('vault 根目录不存在')
  })

  test('externalEditIsPickedUpByIndex', async () => {
    const store = new VaultStore(layout())
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
    expect(mixed).toContain('类型：卡片')
    expect(mixed).toContain('类型：旧笔记')
    expect(mixed).toContain(`- 路径：${basename(extra)}/图形学/投影矩阵旧笔记.md`)
    expect(mixed).toContain(`来源：vault / ${basename(extra)} / 工作目录`)

    const iter = await store.search('迭代器', {}, { sessionCwd: cwdDir })
    expect(iter).toContain('类型：旧笔记')
    expect(iter).toContain('- 路径：工作目录/CS/迭代器旧笔记.md')

    // 不传 cwd：工作目录不可见（vault 无此笔记）
    expect(await store.search('迭代器', {}, {})).toContain('未命中')
    // kind 过滤：只找卡片
    const onlyCards = await store.search('投影矩阵', { kind: 'card' }, { sessionCwd: cwdDir })
    expect(onlyCards).toContain('类型：卡片')
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

  test('card_link：卡↔旧笔记默认只写卡片侧；linkIntoNotes 时两侧都写；旧笔记↔旧笔记默认拒绝', async () => {
    await mkdir(join(extra, 'CS'), { recursive: true })
    const noteFile = join(extra, 'CS/迭代器笔记.md')
    await writeFile(noteFile, '> 概念: 迭代器是一种设计模式\n# 迭代器主要方法\n- vector.begin()\n')
    const store = new VaultStore({ ...layout(), searchRoots: [extra] })
    const created = await store.create({
      title: '红黑树插入',
      domain: '数据结构与算法',
      source: '课件',
      status: '草稿',
      definition: '红黑树插入通过变色与旋转维持平衡',
      content: '插入流程',
    })
    const id = /ID: (\d{12}_[0-9a-f]{4})/.exec(created.text)![1]
    const noteRef = `${basename(extra)}/CS/迭代器笔记.md`

    // 默认：旧笔记字节不变，卡片侧出现关联
    const before = await readFile(noteFile, 'utf8')
    const linked = await store.link(id, noteRef, 'next')
    expect(linked).toContain('单侧写入')
    expect(linked).toContain('未修改旧笔记')
    expect(await readFile(noteFile, 'utf8')).toBe(before)
    const cardFile = join(dir, '未分类/数据结构与算法/红黑树插入.md')
    expect(await readFile(cardFile, 'utf8')).toContain(`- 后续：迭代器主要方法（${basename(extra)}/CS/迭代器笔记.md）`)

    // 开启 linkIntoNotes：两侧都写
    const noteOnly = await mkdtemp(join(tmpdir(), 'study-buddy-note-'))
    try {
      await writeFile(join(noteOnly, 'AVL笔记.md'), '# AVL 笔记\n平衡因子\n')
      const store2 = new VaultStore({ ...layout(), linkIntoNotes: true, searchRoots: [noteOnly] })
      const linked2 = await store2.link(id, `${basename(noteOnly)}/AVL笔记.md`, 'prev')
      expect(linked2).toContain('已写入 2 侧')
      expect(await readFile(join(noteOnly, 'AVL笔记.md'), 'utf8')).toContain('### 关联卡片')

      // 旧笔记↔旧笔记：默认拒绝并给替代方案（两个旧笔记在同一批根内才能解析到）
      const store3 = new VaultStore({ ...layout(), searchRoots: [extra, noteOnly] })
      await expect(store3.link(noteRef, `${basename(noteOnly)}/AVL笔记.md`, 'next')).rejects.toThrow(/linkIntoNotes/)
    } finally {
      await rm(noteOnly, { recursive: true, force: true })
    }
  })

  test('card_moc 只收录卡片，旧笔记跳过并提示', async () => {
    await mkdir(join(extra, 'CS'), { recursive: true })
    await writeFile(join(extra, 'CS/迭代器笔记.md'), '# 迭代器主要方法\n正文')
    const store = new VaultStore({ ...layout(), searchRoots: [extra] })
    const created = await store.create({
      title: '红黑树插入',
      domain: '数据结构与算法',
      source: '课件',
      status: '草稿',
      definition: '红黑树插入通过变色与旋转维持平衡',
      content: '插入流程',
    })
    const id = /ID: (\d{12}_[0-9a-f]{4})/.exec(created.text)![1]
    const moc = await store.moc({ title: '本次学习目录', cardIds: [id, `${basename(extra)}/CS/迭代器笔记.md`] })
    expect(moc).toContain('旧笔记不收录')
    expect(moc).toContain('[[红黑树插入]]')
    expect(moc).not.toContain('[[迭代器主要方法]]')
  })
})

