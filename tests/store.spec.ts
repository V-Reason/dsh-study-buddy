import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const file1 = await readFile(join(dir, '游戏开发/图形学/透视投影矩阵的三步分解.md'), 'utf8')
    expect(file1).toContain(`- 后续：光栅化（${id2}）`)
    const file2 = await readFile(join(dir, '游戏开发/图形学/光栅化.md'), 'utf8')
    expect(file2).toContain('- 前置：')

    // MOC
    const moc = await store.moc({ title: '本次学习目录', cardIds: [id, id2] })
    expect(moc).toContain('MOC 已写入：目录/2026-08-16_本次学习目录.md')
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

