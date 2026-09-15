import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { DirIndex } from '../src/dirs.ts'
import { compareText } from '../src/order.ts'
import { summarizeOverview, type OverviewNote } from '../src/overview.ts'

/**
 * 排序口径（v1.0.0 CI 故障的回归）。
 *
 * 故障现场：`tests/overview.spec.ts` 的"同资料多章、多资料各自分组"在本机（zh-CN）绿、
 * 在 GitHub runner（en-US）红——因为实现用的是不带 locale 的 `localeCompare`，
 * 比较结果**跟着宿主环境走**（本机拼音 `计 ji < 算 suan`，runner 根排序按部首）。
 *
 * 这里用两条互补的守卫把它钉住：
 * 1. **源码扫描**：`src/` 里除了 `order.ts` 不许再出现裸 `localeCompare` / `Intl.Collator`；
 * 2. **换 locale 复现**：把 `String.prototype.localeCompare` 临时换成 en-US 实现，
 *    聚合与目录顺序必须一个字都不变——等于在 zh 机器上重演 CI 环境。
 */

/** 把宿主 locale 换成 en-US（CI 的真实环境）执行一段代码，结束后必定还原 */
function withHostLocale<T>(run: () => T): T {
  const original = String.prototype.localeCompare
  String.prototype.localeCompare = function (
    this: string,
    that: string,
    locales?: string | string[],
    options?: Intl.CollatorOptions,
  ): number {
    return new Intl.Collator(locales ?? 'en-US', options).compare(String(this), String(that))
  }
  try {
    return run()
  } finally {
    String.prototype.localeCompare = original
  }
}

const SRC = join(import.meta.dirname, '..', 'src')
const SRC_FILES = readdirSync(SRC).filter((f) => f.endsWith('.ts'))
const SRC_TEXTS = new Map(SRC_FILES.map((f) => [f, readFileSync(join(SRC, f), 'utf8')]))

/** 手写符号函数：`Math.sign(-0)` 是 `-0`，`toBe` 用 `Object.is` 会把它和 `0` 判成不等 */
function signOf(n: number): -1 | 0 | 1 {
  return n === 0 ? 0 : n < 0 ? -1 : 1
}

describe('compareText 排序口径', () => {
  test('中文按拼音排序（根排序会给出相反结果）', () => {
    // 计 jì < 算 suàn；概 gài < 高 gāo；数 shù < 线 xiàn
    expect(compareText('计算方法', '算法设计与分析')).toBeLessThan(0)
    expect(compareText('概率论', '高等数学')).toBeLessThan(0)
    expect(compareText('数据结构', '线性代数')).toBeLessThan(0)
    // 反向必须对称（下面还有全序性用例）
    expect(compareText('算法设计与分析', '计算方法')).toBeGreaterThan(0)
  })

  test('数字按数值排序：第2章 在 第10章 之前（插件推荐的目录命名）', () => {
    expect(compareText('第2章 线性方程组数值解法', '第10章 特征值')).toBeLessThan(0)
    expect(compareText('2.md', '10.md')).toBeLessThan(0)
    expect(compareText('第10章 特征值', '第2章 线性方程组数值解法')).toBeGreaterThan(0)
  })

  test('是严格全序：反对称 + 传递（挡住"ASCII 走码位、其余走排序器"的混合快路径）', () => {
    const samples = ['a', 'A', 'B', 'ä', '计算方法', '算法设计与分析', '概率论', '第2章', '第10章', '2.1']
    for (const x of samples) expect(compareText(x, x)).toBe(0)
    for (const x of samples) {
      for (const y of samples) {
        // 反对称：交换参数必须翻号（0 只允许出现在完全相同的串上；用和判断避开 -0）
        expect(signOf(compareText(x, y)) + signOf(compareText(y, x)), `${x} vs ${y}`).toBe(0)
        for (const z of samples) {
          // 传递：x≤y 且 y≤z 时 x≤z（若存在环，sort 结果不再确定）
          if (compareText(x, y) <= 0 && compareText(y, z) <= 0) {
            expect(compareText(x, z), `${x} ≤ ${y} ≤ ${z} 但 ${x} > ${z}`).toBeLessThanOrEqual(0)
          }
        }
      }
    }
  })
})

describe('宿主 locale 不影响结果（v1.0.0 CI 故障回归）', () => {
  const note = (title: string, sourceSection: string, rel: string): OverviewNote => ({
    title,
    sourceSection,
    kind: 'block',
    rel,
  })

  test('换 en-US 后覆盖度聚合顺序不变（CI 上红的那一条）', () => {
    const notes = [
      note('误差', '《计算方法》第1章 误差与有效数字 / 1.1节', 'a/误差.md'),
      note('高斯消元法', '《计算方法》第2章 线性方程组数值解法 / 2.1节', 'a/高斯消元法.md'),
      note('递归', '《算法设计与分析》第3章 递归 / 3.1节', 'b/递归.md'),
    ]
    const expected = ['计算方法-1', '计算方法-2', '算法设计与分析-3']
    const plain = summarizeOverview(notes)
    expect(plain.chapters.map((c) => `${c.material}-${c.chapter}`)).toEqual(expected)

    const underEnUs = withHostLocale(() => summarizeOverview(notes))
    expect(underEnUs.chapters.map((c) => `${c.material}-${c.chapter}`)).toEqual(expected)
    expect(underEnUs.materials).toEqual(plain.materials)
  })

  test('换 en-US 后目录顺序不变', () => {
    const build = (): string[] => {
      const index = new DirIndex()
      index.add('算法设计与分析/第3章 递归/递归.md', 'block')
      index.add('计算方法/第2章 线性方程组数值解法/高斯消元法.md', 'block')
      return index.dirs()
    }
    expect(build()).toEqual(['计算方法/第2章 线性方程组数值解法', '算法设计与分析/第3章 递归'])
    expect(withHostLocale(build)).toEqual(build())
  })
})

describe('排序口径的源码守卫', () => {
  test('src/ 中除 order.ts 外不得出现裸 localeCompare / Intl.Collator', () => {
    expect(SRC_FILES.length).toBeGreaterThan(15) // 防止目录找错导致"零命中即通过"
    const offenders: string[] = []
    for (const [file, text] of SRC_TEXTS) {
      if (file === 'order.ts') continue
      for (const [i, line] of text.split(/\r?\n/).entries()) {
        if (/\.localeCompare\(/.test(line)) offenders.push(`${file}:${i + 1} 裸 localeCompare → 改用 order.ts 的 compareText`)
        if (/new Intl\.Collator\(/.test(line)) offenders.push(`${file}:${i + 1} 裸 Intl.Collator → 改用 order.ts 的 compareText`)
      }
    }
    expect(offenders, `发现 ${offenders.length} 处宿主 locale 依赖`).toEqual([])
  })
})
