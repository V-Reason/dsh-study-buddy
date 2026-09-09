import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { todayLocal } from '../src/card.ts'
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
    expect(file1).toContain(`- 后续：\`光栅化\`（${id2}）`)
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

  test('create 标题非法字符/引号清洗并回显；领域映射行回显', async () => {
    const store = new VaultStore(layout())
    const created = await store.create({
      title: 'PBD/Verlet 积分与约束投影的实现',
      domain: '图形学与渲染',
      source: '课件',
      status: '草稿',
      definition: 'PBD 通过约束投影迭代满足约束',
      content: '约束求解',
    })
    expect(created.rel).toBe('游戏开发/图形学/PBD Verlet 积分与约束投影的实现.md')
    expect(created.text).toContain('已清洗为文件名「PBD Verlet 积分与约束投影的实现」')
    expect(created.text).toContain('领域映射：图形学与渲染 → 游戏开发/图形学')
  })

  test('create 未映射领域回显可用键与近似键建议（含"与"字差异）', async () => {
    const store = new VaultStore({
      ...layout(),
      domainFolders: { '图形学-动画特效': '游戏开发/图形学/动画与特效' },
    })
    const created = await store.create({
      title: 'PBD 约束投影',
      domain: '图形学-动画与特效',
      source: '课件',
      status: '草稿',
      definition: 'PBD 迭代投影满足约束',
      content: '约束求解',
    })
    expect(created.rel).toBe('未分类/图形学-动画与特效/PBD 约束投影.md')
    expect(created.text).toContain('未在 domainFolders 映射表中')
    expect(created.text).toContain('近似键建议：图形学-动画特效 → 游戏开发/图形学/动画与特效')
    expect(created.text).toContain('重启 DSH 后生效')
  })

  test('moc 标题日期前缀自动剥离并回显 文件名/标题/日期（双前缀根治）', async () => {
    const store = new VaultStore(layout())
    const created = await store.create({
      title: '透视投影矩阵',
      domain: '图形学与渲染',
      source: 'GAMES101 L04',
      status: '草稿',
      definition: '三步分解成的投影矩阵',
      content: '正文',
    })
    const id = /ID: (\d{12}_[0-9a-f]{4})/.exec(created.text)![1]
    const date = todayLocal()
    const moc = await store.moc({ title: '2026-09-02_图形学 MOC 目录（测试）', cardIds: [id] })
    expect(moc).toContain(`MOC 已写入：目录/${date}_图形学 MOC 目录（测试）.md`)
    expect(moc).toContain(`（标题：图形学 MOC 目录（测试），日期：${date}）`)
    expect(moc).not.toContain('2026-09-02_2026-09-02')
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

  test('card_update definition 字段级修定义：只改引用块、不产生历史折叠', async () => {
    const store = new VaultStore(layout())
    const created = await store.create({
      title: '红黑树插入',
      domain: '数据结构与算法',
      source: '课件',
      status: '草稿',
      definition: '旧定义旧定义旧定义旧定义旧定义旧定义旧定义旧定义旧定义',
      content: '### 核心思想\n一句话\n\n### 阶梯式解剖\n第 1 层\n\n### 实例走查\n数字\n\n### 易错点\n- 坑\n\n### 自测题\n- **Q1**',
    })
    const id = /ID: (\d{12}_[0-9a-f]{4})/.exec(created.text)![1]
    const updated = await store.update(id, { mode: 'definition', definition: '新定义：通过变色旋转维持平衡' })
    expect(updated).toContain('> 新定义：通过变色旋转维持平衡')
    expect(updated).not.toContain('旧定义旧定义')
    expect(updated).not.toContain('历史版本')
    expect(updated).not.toContain('<details>')
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
    expect(await readFile(cardFile, 'utf8')).toContain(`- 后续：\`迭代器主要方法\`（${basename(extra)}/CS/迭代器笔记.md）`)

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

  test('card_lint：单卡报告 + 批量汇总 + 规则过滤', async () => {
    const store = new VaultStore(layout())
    const created = await store.create({
      title: 'IBL 接入',
      domain: '图形学与渲染',
      source: 'URP 文档',
      status: '已确认',
      definition: 'IBL 接入 = 环境侧喂数据 + shader 两行采样',
      content: [
        '### 核心思想',
        '环境侧喂数据。',
        '',
        '### 主干线',
        '间接光算不起 → 预计算 → 采样 → 验证暗部。',
        '',
        '### 阶梯式解剖',
        '**第 1 层 · 直觉**：查表。',
        '**第 2 层 · 机制**：SampleSH。',
        '**第 3 层 · 细节**：签名。',
        '**第 4 层 · 边界**：烘死的。',
        '',
        '### 实例走查',
        'r=0.31 → mip≈2.76。',
        '',
        '### 验证实验',
        '1. 主光归零：暗部仍亮 → SH 通。',
        '2. 环境归零：整体塌黑 → 数据源确认。',
        '3. 金属球 + 探针：映出物体 → cubemap 通。',
        '',
        '### 排障判据',
        '| 症状 | 判据 | 修复 |',
        '| :-- | :-- | :-- |',
        '| 反射平色 | 无探针 | 加探针 |',
        '',
        '### 易错点',
        '- 改了主光没变化：间接光是烘死的。',
        '',
        '### 自测题',
        '- **Q1**：谁生产 SH？ → 环境侧烘焙。',
        '',
        '### 关联卡片',
        '- 前置：`间接光`（202609092139_2c27）',
      ].join('\n'),
    })
    const id = /ID: (\d{12}_[0-9a-f]{4})/.exec(created.text)![1]
    // 工程型由领域目录族推断
    expect(created.text).toContain('模板：工程型')
    const single = await store.lint({ ref: id })
    expect(single).toContain('模板：工程型')
    expect(single).toContain('总分：')
    expect(single).toContain('正文')
    // 该卡有前置关联但缺前置检查 → 命中 prereq-check
    const byRule = await store.lint({ ref: id, rule: 'prereq-check' })
    expect(byRule).toContain('prereq-check')
    expect(byRule).toContain('前置检查')
    const batch = await store.lint({ scope: 'vault' })
    expect(batch).toContain('批量 lint：1 张卡')
    expect(batch).toContain('规则命中')
    const ruleBatch = await store.lint({ scope: 'vault', rule: 'template-sections' })
    expect(ruleBatch).toContain('规则 template-sections')
  })

  test('card_lint：会话残留规则与白名单（端到端）', async () => {
    const store = new VaultStore(layout())
    const created = await store.create({
      title: '残留样本',
      domain: '图形学与渲染',
      source: 'X',
      status: '草稿',
      definition: '会话残留样本卡',
      content: '### 核心思想\n本工程实测发现你的 shader 在 L182 行有问题。\n\n### 主干线\nx\n\n### 阶梯式解剖\n第 1 层\n第 2 层\n第 3 层\n第 4 层\n\n### 实例走查\nx\n\n### 易错点\nx\n\n### 自测题\n- **Q1**：a → b',
    })
    const id = /ID: (\d{12}_[0-9a-f]{4})/.exec(created.text)![1]
    const report = await store.lint({ ref: id, rule: 'session-residue' })
    expect(report).toContain('未通过')
    expect(report).toContain('本工程')
    // 白名单：球谐带 L0/L1/L2 与讲义引用不报
    const clean = await store.create({
      title: '白名单样本',
      domain: '图形学与渲染',
      source: 'X',
      status: '草稿',
      definition: '白名单样本卡',
      content: '### 核心思想\nURP 的 SampleSH 只取 L0/L1/L2 三带（来源：GAMES101 L15）。\n\n### 主干线\nx\n\n### 阶梯式解剖\n第 1 层\n第 2 层\n第 3 层\n第 4 层\n\n### 实例走查\nx\n\n### 易错点\nx\n\n### 自测题\n- **Q1**：a → b',
    })
    const cleanId = /ID: (\d{12}_[0-9a-f]{4})/.exec(clean.text)![1]
    expect(await store.lint({ ref: cleanId, rule: 'session-residue' })).toContain('✓ 通过')
  })

  test('card_history：list / dryRun / strip 端到端（版本块在关联卡片之前）', async () => {
    const store = new VaultStore(layout())
    const created = await store.create({
      title: '版本块样本',
      domain: '图形学与渲染',
      source: 'X',
      status: '草稿',
      definition: '版本块样本卡',
      content: '### 核心思想\nx\n\n### 关联卡片\n- 前置：`A`（id1）',
    })
    const id = /ID: (\d{12}_[0-9a-f]{4})/.exec(created.text)![1]
    const updated = await store.update(id, { mode: 'append-version', source: 'L16', changes: '补充：A' })
    expect(updated.indexOf('### 版本更新')).toBeLessThan(updated.indexOf('### 关联卡片'))
    const file = join(dir, '游戏开发/图形学/版本块样本.md')
    expect(await readFile(file, 'utf8')).toContain('### 版本更新（来源：L16）')

    const listed = await store.history(id, 'list')
    expect(listed).toContain('历史块 1 个')
    expect(listed).toContain('[版本更新]')
    const dry = await store.history(id, 'strip', { dryRun: true })
    expect(dry).toContain('[dryRun]')
    expect(await readFile(file, 'utf8')).toContain('### 版本更新（来源：L16）') // dryRun 不写盘
    const stripped = await store.history(id, 'strip', {})
    expect(stripped).toContain('已清除')
    const after = await readFile(file, 'utf8')
    expect(after).not.toContain('版本更新')
    expect(after).toContain('- 前置：`A`（id1）')
    // 无历史块时幂等
    expect(await store.history(id, 'strip', {})).toContain('无历史块可清除')
  })

  test('card_rename：改标题 + 同步文件名 + 全库入链重写 + dryRun', async () => {
    const store = new VaultStore(layout())
    const a = await store.create({
      title: 'URP IBL 接入',
      domain: '图形学与渲染',
      source: 'X',
      status: '草稿',
      definition: 'IBL 接入 = 环境侧喂数据 + shader 采样',
      content: '### 核心思想\nx',
    })
    const idA = /ID: (\d{12}_[0-9a-f]{4})/.exec(a.text)![1]
    const b = await store.create({
      title: '间接光通道',
      domain: '图形学与渲染',
      source: 'X',
      status: '草稿',
      definition: '间接光分漫反射与镜面两个通道',
      content: '### 核心思想\nx',
      links: { next: [`\`URP IBL 接入\`（${idA}）`] },
    })
    const idB = /ID: (\d{12}_[0-9a-f]{4})/.exec(b.text)![1]
    const bFile = join(dir, '游戏开发/图形学/间接光通道.md')
    expect(await readFile(bFile, 'utf8')).toContain(`\`URP IBL 接入\`（${idA}）`)

    // dryRun：不写盘
    const dry = await store.rename(idA, 'URP IBL 接入与探针', { dryRun: true })
    expect(dry).toContain('[dryRun]')
    expect(dry).toContain('URP IBL 接入.md → URP IBL 接入与探针.md')
    expect(await readFile(bFile, 'utf8')).toContain('`URP IBL 接入`')
    expect(await readFile(join(dir, '游戏开发/图形学/URP IBL 接入.md'), 'utf8')).toContain('标题: URP IBL 接入')

    const result = await store.rename(idA, 'URP IBL 接入与探针', {})
    expect(result).toContain('已写入：游戏开发/图形学/URP IBL 接入与探针.md')
    expect(result).toContain('断链检测：无')
    const renamed = await readFile(join(dir, '游戏开发/图形学/URP IBL 接入与探针.md'), 'utf8')
    expect(renamed).toContain('标题: URP IBL 接入与探针')
    expect(renamed).toContain(`ID: ${idA}`)
    expect(await readFile(bFile, 'utf8')).toContain(`\`URP IBL 接入与探针\`（${idA}）`)
    // 旧文件已移除，检索到新标题
    await expect(readFile(join(dir, '游戏开发/图形学/URP IBL 接入.md'), 'utf8')).rejects.toThrow()
    const search = await store.search('URP IBL 接入与探针')
    expect(search).toContain('URP IBL 接入与探针')
    // 同标题冲突检测
    await expect(store.rename(idB, 'URP IBL 接入与探针')).rejects.toThrow(/已存在同名卡片/)
    // 同标题无改动
    expect(await store.rename(idB, '间接光通道')).toContain('无改动')
  })

  test('card_rename：旧笔记（无 ID）拒绝改名', async () => {
    await mkdir(join(extra, 'CS'), { recursive: true })
    await writeFile(join(extra, 'CS/迭代器笔记.md'), '# 迭代器主要方法\n正文')
    const store = new VaultStore({ ...layout(), searchRoots: [extra] })
    await expect(store.rename(`${basename(extra)}/CS/迭代器笔记.md`, '新标题')).rejects.toThrow(/旧笔记/)
  })

  test('card_lint 跨卡洞察：cross 冲突 / trend 趋势 / rating 可执行性', async () => {
    const store = new VaultStore(layout())
    const make = (title: string, content: string) => store.create({
      title,
      domain: '图形学与渲染',
      source: 'X',
      status: '草稿',
      definition: `${title} 的一句话定义`,
      content,
    })
    await make('圆周率用法一', '### 阶梯式解剖\n| 常量 | 取值 |\n| :-- | :-- |\n| 圆周率 π | 3.14 |')
    await make('圆周率用法二', '### 阶梯式解剖\n| 常量 | 取值 |\n| :-- | :-- |\n| 圆周率 π | 3.1416 |')
    const cross = await store.lint({ scope: 'vault', cross: true })
    expect(cross).toContain('跨卡一致性')
    expect(cross).toContain('圆周率 π')
    expect(cross).toContain('3.1416')
    const trend = await store.lint({ scope: 'vault', trend: true })
    expect(trend).toContain('质量趋势')
    expect(trend).toContain('2026-W')
    const rated = await store.lint({ scope: 'vault', rating: true })
    expect(rated).toContain('可执行性分布')
    // 单卡默认带可执行性评级
    const single = await store.lint({ ref: '圆周率用法一' })
    expect(single).toContain('可执行性：')
  })
})

