import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  DSH_PEER_ACCEPTS, DSH_PEER_REJECTS, REVIEWED_DSH_PEER_RANGE,
  compareVersions, parseRange, satisfiesRange,
} from '../tools/verify-contract.mjs'

/**
 * DSH peer 范围（离线判定）。
 *
 * 为什么单测这一层：`peerDependencies["@deepseek-ai/dsh"]` 决定了 DSH 会不会装载本包——
 * 不兼容时**整个 bundle 层被摘除**，「学习伙伴」预设与 18 个工具一起消失。而这件事故的
 * 判定逻辑（`evaluatePluginCompatibility`）住在平台里，CI 上拿不到，于是曾经出现过
 * "`pnpm run check` 全绿、插件其实已经被拒绝装载"的状态（2026-09 的 v1.2.0）。
 *
 * 分工（与 `tools/verify-contract.mjs` 一致，别各写一份）：
 * - **平台门禁**（`dshPeerRange` 那条活断言）是权威判定，只在装了 DSH 的机器上跑；
 * - 本文件与探针里的离线断言管**CI 也能看见**的那半：声明的范围必须等于复核过的字符串，
 *   并对钉死的版本表给出正确判定。比较器只实现 `>= > <= < =` 的合取。
 *
 * 这里额外把比较器自身的**先序规则**钉住（前置版本、数字标识符、标识符个数），
 * 因为那是唯一"看起来对、错起来很安静"的部分：写错一条，范围判定会悄悄放行/拦下错版本。
 */

const ROOT = join(import.meta.dirname, '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  peerDependencies?: Record<string, string>
}

/** 形式守卫必须拦下的写法：本断言只认 `>= > <= < =` 的空白合取 */
const UNSUPPORTED_RANGES = [
  '*',
  '^0.1.7-rc.1',
  '^0.2.0-rc.1',
  '~0.2.0',
  '0.2.x',
  '>=0.1.7-rc.1 || >=0.2.0',
  '>=0.1.7-rc.1, <0.3.0-0',
  '>=0.1.7-rc.1 - 0.2.0',
  '>=0.1.7-rc.1 -',
  'v0.2.0-rc.1',
]

describe('DSH peer 范围（离线判定）', () => {
  test('package.json 的声明 == 复核过的范围（改动必须显式复核）', () => {
    expect(
      MANIFEST.peerDependencies?.['@deepseek-ai/dsh'],
      '范围变了：同时改 tools/verify-contract.mjs 的 REVIEWED_DSH_PEER_RANGE 与版本表，再用平台门禁复核',
    ).toBe(REVIEWED_DSH_PEER_RANGE)
  })

  test('接受表全部满足、拒绝表全部不满足', () => {
    expect(DSH_PEER_ACCEPTS.length, '接受表被清空 = 断言恒真').toBeGreaterThanOrEqual(4)
    expect(DSH_PEER_REJECTS.length, '拒绝表被清空 = 断言恒真').toBeGreaterThanOrEqual(3)
    for (const version of DSH_PEER_ACCEPTS) {
      expect(satisfiesRange(version, REVIEWED_DSH_PEER_RANGE), `${version} 应被接受`).toBe(true)
    }
    for (const version of DSH_PEER_REJECTS) {
      expect(satisfiesRange(version, REVIEWED_DSH_PEER_RANGE), `${version} 应被拒绝`).toBe(false)
    }
  })

  // 事故回归：v1.1.1 声明的 ^0.1.7-rc.1 上界是 <0.2.0-0，于是 0.2.0-rc.1 被判不兼容。
  test('事故回归：0.2.0-rc.1 必须被接受，而旧的 ^0.1.7-rc.1 会拒绝它', () => {
    expect(satisfiesRange('0.2.0-rc.1', REVIEWED_DSH_PEER_RANGE)).toBe(true)
    // 旧范围在本函数里认不出（`^` 是不支持的形式）——这正是"旧写法判不了 0.2 线"的可执行证据
    expect(() => satisfiesRange('0.2.0-rc.1', '^0.1.7-rc.1')).toThrow(/不认的形式/)
  })

  test('下界必须带 -rc.1：不带的话 0.1.7-rc.2 这类在用版本会被挡在门外', () => {
    expect(satisfiesRange('0.1.7-rc.2', '>=0.1.7 <0.3.0-0'), '≥0.1.7 不含前置版本').toBe(false)
    expect(satisfiesRange('0.1.7-rc.2', REVIEWED_DSH_PEER_RANGE)).toBe(true)
  })

  test('上界 <0.3.0-0 挡住 0.3 线的前置版本（<0.3.0 会放它们进来）', () => {
    expect(satisfiesRange('0.3.0-rc.1', REVIEWED_DSH_PEER_RANGE)).toBe(false)
    expect(satisfiesRange('0.3.0-alpha.1', REVIEWED_DSH_PEER_RANGE)).toBe(false)
    expect(satisfiesRange('0.3.0-rc.1', '>=0.1.7-rc.1 <0.3.0'), '<0.3.0 放行 0.3.0 前置版本').toBe(true)
  })

  test('先序规则：前置版本低于同号正式版', () => {
    expect(compareVersions('0.2.0-rc.1', '0.2.0')).toBe(-1)
    expect(compareVersions('0.2.0', '0.2.0-rc.1')).toBe(1)
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.1.6', '0.1.7-rc.1')).toBe(-1)
    expect(compareVersions('0.2.0-rc.1', '0.2.0-rc.2')).toBe(-1)
    // 构建元数据不参与比较（semver §10）
    expect(compareVersions('0.2.0+build.1', '0.2.0+build.2')).toBe(0)
  })

  test('先序规则：数字标识符低于字母标识符，标识符少者更低', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0-2', '1.0.0-10')).toBe(-1)
  })

  test('形式守卫：不认的范围写法必须抛错，不能静默通过', () => {
    for (const range of UNSUPPORTED_RANGES) {
      expect(() => parseRange(range), `${range} 应被拒绝`).toThrow()
    }
  })

  test('非法版本串必须抛错（宁可报错也不猜）', () => {
    for (const version of ['', '0.2', '0.2.0.1', 'v0.2.0', 'latest', '0.02.0']) {
      expect(() => satisfiesRange(version, REVIEWED_DSH_PEER_RANGE), `${JSON.stringify(version)} 应被拒绝`).toThrow()
    }
  })

  test('显式比较器逐条生效（>= / > / <= / < / =）', () => {
    expect(satisfiesRange('0.2.0', '>=0.2.0')).toBe(true)
    expect(satisfiesRange('0.2.0', '>0.2.0')).toBe(false)
    expect(satisfiesRange('0.2.0', '<=0.2.0')).toBe(true)
    expect(satisfiesRange('0.2.0', '<0.2.0')).toBe(false)
    expect(satisfiesRange('0.2.0', '0.2.0')).toBe(true)
    expect(satisfiesRange('0.2.0', '=0.2.0')).toBe(true)
    expect(satisfiesRange('0.2.0', '=0.2.1')).toBe(false)
    expect(parseRange(REVIEWED_DSH_PEER_RANGE).length, '复核范围应是两条比较器的合取').toBe(2)
  })
})
