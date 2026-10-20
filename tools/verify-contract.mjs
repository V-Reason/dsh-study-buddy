#!/usr/bin/env node
/**
 * 契约校验：本插件与「本机 DSH」之间的平台契约断言 + 交付形态断言。
 *
 * 为什么需要它（见 troubleshooting.md §六）：平台与插件之间的契约变更**不会以
 * 编译错误的形式暴露**——2026-09-15 的 DSH 更新就把 Typert strict codec 的
 * `schema` 换成了 `create()`，另一个插件整行未激活，而本仓库的 `pnpm run check`
 * （typecheck + vitest）永远绿：源码零 `@deepseek-ai/*` 运行时导入，也没有任何
 * 断言真的去碰宿主。
 *
 * 2026-09-24 又栽了一次，这次是**交付形态**：DSH 0.1.7-rc.1 删除了目录式预设
 * （提交 d1e22a7e24 / #4569），`$DSH_HOME/.agent-presets/` 再没有任何读者 ——
 * 预设整行从名单里消失、18 个工具一个不剩，而插件代码与其契约全绿。
 * 所以本脚本现在有**两类**断言：
 *
 *   A. 交付形态（文件级）：package.json 的 `dsh.bundle.patch` 指向的声明文件存在、
 *      可解析、含 `preset-study`（`@deepseek-ai/dsh-agent-preset`）且其 `study` 行的
 *      config 键 ⊆ 插件认得的键、且**不含** vaultRoot（机器路径不进包）；persona
 *      模板只引用 loop 注册的 `provider` / `model`（0.2.1-rc.2 起 `cwd` 已退场，
 *      strict 插值会在首个请求前抛 `unknown prompt variable`）。
 *   B. 平台契约（活符号）：产物导出的 `HOST_CONTRACTS` 逐点对**运行中的 DSH** 断言；
 *      外加"不得再假设已删 API"的负向断言（替身刻意不给 `settings`）。
 *      其中「注入消息的来源 kind」还有一条**额外**的活平台断言：把真实注入对象喂给
 *      平台自己的 v4 行编码器（`releasedV4SessionFormatCodec.encodeEvent`，就是线上
 *      写盘那条路径），必须收下；退场的 `{kind:'plugin'}` 包装必须被拒。
 *      平台包解析不到时按惯例跳过——规则本身由常跑断言（不依赖平台）兜住。
 *   C. peer 范围（两档）：
 *      C1. **平台门禁**（装了 DSH 才跑）：用平台自己的 `evaluatePluginCompatibility`
 *          判，语义与 profile 装载 100% 一致——这是权威判定。
 *      C2. **离线表**（任何机器都跑，CI 也有增量）：上面那条依赖本机 DSH，CI 上恒被跳过，
 *          而 `^0.1.7-rc.1` 被 0.2.0-rc.1 判为不兼容正是**只在装了 DSH 的机器上**才看得见
 *          （2026-09 的 v1.2.0 事故）。所以再加一档：声明的范围必须等于**复核过的那个字符串**，
 *          并且对一张钉死的版本表给出正确判定。范围写成别的形式（`^`/`~`/`*`/`||`/` - `）
 *          直接报错，不允许静默放过——一旦它变成 no-op，这档断言就失去意义。
 *          比较器只实现 `>= > <= < =` 的合取（即我们实际声明的形式），
 *          **不替代 C1**；语义已与平台 semver 逐格对齐（见 DSH_PEER_ACCEPTS/REJECTS）。
 *
 * 只读：不写仓库、不写 vault、不在 profile 里装任何东西。
 * 用法：
 *   node tools/verify-contract.mjs
 *   node tools/verify-contract.mjs --self-test   # 额外跑负向对照（改坏一个断言必须报错）
 *   node tools/verify-contract.mjs --verbose
 *   node tools/verify-contract.mjs --platform <dir>   # 手动指定平台包解析根（含 @deepseek-ai）
 * @module tools/verify-contract
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const VERBOSE = process.argv.includes('--verbose')
const SELF_TEST = process.argv.includes('--self-test')
/** 手动指定的平台包解析根（`--platform <dir>`：目录里直接含 `@deepseek-ai/`） */
const PLATFORM_OVERRIDE = (() => {
  const at = process.argv.indexOf('--platform')
  if (at < 0) return undefined
  const value = process.argv[at + 1]
  return value === undefined || value.startsWith('--') ? undefined : resolve(value)
})()
/** 仓库根（Windows 盘符路径也正确：用 fileURLToPath 而不是手撕 pathname） */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LIB = join(ROOT, 'lib', 'index.js')
const MANIFEST = join(ROOT, 'package.json')
/** 预设声明随包发的 patch 文件（package.json 的 dsh.bundle.patch 指过来） */
const DECLARATION = join(ROOT, 'presets', 'study.patch.yml')

/** 判定预算 */
let passed = 0
const failures = []
/**
 * 契约点说明表：从产物导出的 `HOST_CONTRACTS` 填充（**单一真相**在 src/host.ts）。
 * 断言失败时用它回显"平台源码坐标 + 失效后果 + 该改哪个文件"。
 */
const contractInfo = new Map()

function ok(label, detail) {
  passed += 1
  if (VERBOSE) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}

function bad(contract, message) {
  failures.push({ contract, message, info: contractInfo.get(contract) })
}

/**
 * 断言形状：回调**抛错**才算失败，返回 `{ note }` 表示通过（note 只用于回显）。
 *
 * 刻意不用「返回字符串=通过」那种宽松约定：契约校验的回调里常见分支是
 * "读到不对的东西 → return 一段中文诊断"，一旦把字符串当通过，**诊断本身会
 * 被算成绿灯**（本脚本的负向对照真的抓出过这个洞，别改回去）。
 */
async function check(label, contract, fn) {
  try {
    const result = await fn()
    if (result?.ok === false) bad(contract, `${label}：${result.message}`)
    else ok(label, result?.note)
  } catch (error) {
    bad(contract, `${label}：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 零依赖 YAML 子集扫描（只认本仓库写的那几种形状，不引解析器） ──────────────

/**
 * 扫描 patch 文件里的条目行：`- id: <id>` 及其同级 `name:`、`config:` 下的一级键。
 *
 * 只按**缩进**判定（`tests/preset.spec.ts` 同款口径，两个文件各扫各的、互相独立）：
 * 条目行的缩进是 R，则 `name` / `config` 在 R+2，config 的一级键在 R+4。
 * 深层嵌套（group 的子行、persona 正文）因缩进不等于 R+4 而自动排除。
 * @param text - patch 文件全文
 * @returns 每个条目的 id / 缩进 / 模块名 / config 键 / 行号
 */
export function scanEntryRows(text) {
  const lines = text.split(/\r?\n/)
  const rows = []
  let current = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trimStart().startsWith('#')) continue
    const rowMatch = /^(\s*)-\s*id:\s*(\S+)\s*$/.exec(line)
    if (rowMatch) {
      current = { id: rowMatch[2], indent: rowMatch[1].length, name: '', configKeys: [], line: i + 1, configIndent: null }
      rows.push(current)
      continue
    }
    if (current === null) continue
    const indent = /^\s*/.exec(line)[0].length
    if (line.trim() === '') continue
    if (indent <= current.indent) continue
    const propMatch = /^(\s*)name:\s*(\S+)/.exec(line)
    if (propMatch && propMatch[1].length === current.indent + 2) {
      current.name = propMatch[2].replace(/^['"]|['"]$/g, '')
      continue
    }
    const configMatch = /^(\s*)config:\s*$/.exec(line)
    if (configMatch && configMatch[1].length === current.indent + 2) {
      current.configIndent = current.indent + 4
      continue
    }
    if (current.configIndent !== null && indent === current.configIndent) {
      const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line.trim())
      if (keyMatch) current.configKeys.push(keyMatch[1])
    }
  }
  return rows
}

/**
 * loop 注册的提示词变量（**单一真相**：0.2.1-rc.2 的 `dsh-agent-loop`）。
 *
 * 上游提交 `79bd3d8d`（feat(session): centralize working directories and directory
 * context）删除了 `ctx.systemPrompt.variable('cwd', …)`；loop 只保留 provider/model。
 * 目录事实改由 `dsh-working-directory` 的 required 上下文
 * `Current working directory: …` 提供。自定义 persona 模板若还写 `{{cwd}}`，
 * `dsh-system-prompt` 的 strict 插值会在首个模型请求前抛
 * `unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix"`。
 */
export const LOOP_PROMPT_VARIABLES = ['provider', 'model']

/**
 * 扫描声明文件里**非注释行**的完整 `{{name}}` 引用。
 *
 * 注释只用于记录历史/迁移说明（例如“0.2.1 删除了 {{cwd}}”），不是模板；
 * 跳过注释才能既保留说明、又不把说明误判成运行时引用。
 * @param text - patch 文件全文
 * @returns 按出现顺序排列的变量名（可重复）
 */
export function scanPromptVariables(text) {
  const withoutComments = text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  return [...withoutComments.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map((match) => match[1])
}

// ── 窄范围 semver（只服务离线 peer 断言 C2） ────────────────────────────────

/**
 * 复核过的 DSH peer 范围（**单一真相**：`package.json` 必须逐字等于它）。
 *
 * 选它的理由（2026-09 的 v1.2.0 事故）：
 * - `^0.1.7-rc.1` 的上界是 `<0.2.0-0`，于是 `0.2.0-rc.1` 被判不兼容 → bundle 层被摘除、
 *   「学习伙伴」预设整行消失；
 * - 用 `^0.2.0-rc.1` 又会把仍在 0.1.7-rc.2 上的用户挡在门外（他们本来是能用的）；
 * - 下界必须带 `-rc.1`：不带的话 `0.1.7-rc.2` 这类前置版本不满足 `>=0.1.7`（semver 里
 *   前置版本低于同号正式版）；
 * - 上界用 `<0.3.0-0` 而不是 `<0.3.0`：前者能挡住 0.3 线的前置版本（0.3.0-alpha 之类），
 *   后者会被 `includePrerelease` 放进来——0.3 线没验证过。
 */
export const REVIEWED_DSH_PEER_RANGE = '>=0.1.7-rc.1 <0.3.0-0'

/** 复核过"必须接受"的运行版本（实际部署过的：0.1.7-rc.1/rc.2 → 0.2.0-rc.1 → 0.2.1-rc.2） */
export const DSH_PEER_ACCEPTS = [
  '0.1.7-rc.1', '0.1.7-rc.2', '0.1.7', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1-rc.2', '0.2.1',
]

/** 复核过"必须拒绝"的运行版本：0.1.6 没有声明式预设；0.3 线未验证 */
export const DSH_PEER_REJECTS = ['0.1.6', '0.3.0-0', '0.3.0-rc.1', '0.3.0', '1.0.0']

/** 一颗版本：`major.minor.patch` + 可选前置标识符（构建元数据忽略，semver §10 不参与比较） */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * 解析一颗严格 semver 版本。
 * @param value - 版本字符串（不接受 `v` 前缀、范围、通配符）
 * @returns `{ numbers, prerelease }`；不合法就抛错（宁可报错也不猜）
 */
export function parseVersion(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const match = VERSION_PATTERN.exec(text)
  if (match === null) throw new Error(`不是合法 semver 版本：${JSON.stringify(value)}`)
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * 按 semver §11 比较两颗版本（`includePrerelease` 语义）。
 * @param a - 左版本
 * @param b - 右版本
 * @returns `-1` / `0` / `1`
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] < right.numbers[i] ? -1 : 1
  }
  // 有前置标识符的一侧**更低**（0.2.0-rc.1 < 0.2.0）
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const count = Math.max(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < count; i += 1) {
    const l = left.prerelease[i]
    const r = right.prerelease[i]
    // 标识符少的更低（1.0.0-alpha < 1.0.0-alpha.1）
    if (l === undefined) return -1
    if (r === undefined) return 1
    const lNumeric = /^\d+$/.test(l)
    const rNumeric = /^\d+$/.test(r)
    if (lNumeric && rNumeric) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1
      continue
    }
    // 数字标识符**永远低于**字母标识符（1.0.0-1 < 1.0.0-alpha）
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/** 一个比较器：`>=1.2.3` / `>1.2.3` / `<=1.2.3` / `<1.2.3` / `=1.2.3` 或裸 `1.2.3`（= 精确） */
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?(.+)$/

/**
 * 解析合取式范围（空白分隔的比较器）。
 *
 * **刻意只认这一种形式**：`^` / `~` / `*` / `||` / ` - ` / `x` 通配一律抛错。写成本函数
 * 不认的形式时，离线断言必须**报错而不是静默通过**——否则"范围被改成别的写法"就等于
 * 把这档断言关掉了，而它正是为"CI 上也能发现 peer 范围过期"而存在的。
 * @param range - 范围字符串（如 `>=0.1.7-rc.1 <0.3.0-0`）
 * @returns 比较器数组
 */
export function parseRange(range) {
  const text = typeof range === 'string' ? range.trim() : ''
  if (text === '') throw new Error('范围为空')
  const tokens = text.split(/\s+/)
  if (tokens.some((token) => /[\^~*]|\|\||,/.test(token) || /^[vV]/.test(token) || /[xX](\.|$)/.test(token))) {
    throw new Error(`范围用了本断言不认的形式：${JSON.stringify(range)}（只支持 >= > <= < = 的空白合取，如 "${REVIEWED_DSH_PEER_RANGE}"）`)
  }
  return tokens.map((token) => {
    const match = COMPARATOR_PATTERN.exec(token)
    if (match === null || match[2].trim() === '') throw new Error(`比较器无法解析：${JSON.stringify(token)}`)
    parseVersion(match[2]) // 形状不合法立刻抛错
    return { operator: match[1] ?? '=', version: match[2] }
  })
}

/**
 * 合取式范围判定（与平台门禁的参数一致：`semver.satisfies(v, range, { includePrerelease: true })`）。
 *
 * `includePrerelease: true` 时前置版本不额外加"同号必须有前置比较器"的限制，判定就是
 * 逐比较器的先序比较合取——所以这里不需要那套限制逻辑。
 * @param version - 运行版本
 * @param range - 范围字符串
 * @returns 是否满足
 */
export function satisfiesRange(version, range) {
  return parseRange(range).every((comparator) => {
    const order = compareVersions(version, comparator.version)
    switch (comparator.operator) {
      case '>=': return order >= 0
      case '>': return order > 0
      case '<=': return order <= 0
      case '<': return order < 0
      default: return order === 0
    }
  })
}

/** 交付形态断言：package.json 的 bundle 声明 → patch 文件 → 预设声明 → study 行 */
async function checkDelivery(mod, log) {
  log('交付形态（directory preset 已删除：包必须是声明式 bundle）')
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const declared = manifest?.dsh?.bundle?.patch

  await check('package.json 声明 dsh.bundle.patch，且文件存在', 'bundleDeclared', () => {
    if (declared === undefined) {
      return {
        ok: false,
        message: '没有 dsh.bundle.patch —— DSH 0.1.7 起预设只能由 bundle patch 声明；'
          + '缺了它，装包后「学习伙伴」不会出现在预设名单里（行消失、不报错）',
      }
    }
    const files = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
    if (files.length === 0) return { ok: false, message: `dsh.bundle.patch 形状不对：${JSON.stringify(declared)}` }
    const missing = files.filter((file) => typeof file !== 'string' || !existsSync(resolve(ROOT, file)))
    if (missing.length > 0) return { ok: false, message: `patch 文件不存在：${missing.join('、')}` }
    return { note: files.join(' + ') }
  })

  await check('声明文件含 preset-study（@deepseek-ai/dsh-agent-preset）声明', 'bundleDeclared', () => {
    if (!existsSync(DECLARATION)) return { ok: false, message: `缺少 ${DECLARATION}` }
    const rows = scanEntryRows(readFileSync(DECLARATION, 'utf8'))
    const declaration = rows.find((row) => row.id === 'preset-study')
    if (declaration === undefined) return { ok: false, message: '没有 id: preset-study 的声明行' }
    if (declaration.name !== '@deepseek-ai/dsh-agent-preset') {
      return { ok: false, message: `preset-study 的模块名是 ${declaration.name}（应为 @deepseek-ai/dsh-agent-preset）` }
    }
    return { note: `preset-study → ${declaration.name}` }
  })

  await check('预设声明含 12 个组合行 + 3 个压缩子行，且 id 唯一', 'bundleDeclared', () => {
    const rows = scanEntryRows(readFileSync(DECLARATION, 'utf8'))
    const declaration = rows.find((row) => row.id === 'preset-study')
    if (declaration === undefined) return { ok: false, message: '没有 preset-study 声明行' }
    const topLevel = rows.filter((row) => row.indent === declaration.indent + 6)
    const expected = [
      'persona', 'agent-instructions', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'skill-filesystem',
      'tool-skill', 'compaction', 'study', 'tool-ask-user', 'tool-todo', 'tool-web',
    ]
    const ids = topLevel.map((row) => row.id)
    const missing = expected.filter((id) => !ids.includes(id))
    const extra = ids.filter((id) => !expected.includes(id))
    if (missing.length > 0 || extra.length > 0) {
      return { ok: false, message: `缺 ${missing.join('、') || '无'}；多 ${extra.join('、') || '无'}` }
    }
    if (new Set(ids).size !== ids.length) return { ok: false, message: `id 重复：${ids.join('、')}` }
    for (const nested of ['compaction-basic', 'command-compact', 'tool-result-pruner']) {
      if (!rows.some((row) => row.id === nested)) return { ok: false, message: `压缩组缺 ${nested}` }
    }
    return { note: `${ids.length} 行 + 3 个嵌套子行` }
  })

  await check('study 行的 config 键 ⊆ 插件认得的键，且不含 vaultRoot', 'bundleDeclared', () => {
    const rows = scanEntryRows(readFileSync(DECLARATION, 'utf8'))
    const study = rows.find((row) => row.id === 'study')
    if (study === undefined) return { ok: false, message: '组合里没有 study 插件行' }
    if (study.name !== 'dsh-study-buddy') return { ok: false, message: `study 行的模块名是 ${study.name}` }
    const known = new Set(mod.KNOWN_CONFIG_KEYS ?? [])
    const unknown = study.configKeys.filter((key) => !known.has(key))
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `含插件不认的键：${unknown.join('、')}（留在配置里 = 以为配了其实没配；已知键见 src/config.ts）`,
      }
    }
    if (study.configKeys.includes('vaultRoot')) {
      return {
        ok: false,
        message: 'vaultRoot 又写回包里了 —— 机器相关路径会随包发布（应留给 '
          + 'DSH_STUDY_VAULT / <DSH_HOME>/study-buddy.json / 部署侧覆盖）',
      }
    }
    return { note: `${study.configKeys.length} 个键，无 vaultRoot` }
  })

  await check('persona 模板只引用 loop 注册的变量（0.2.1 起 `cwd` 已退场）', 'bundleDeclared', () => {
    const variables = scanPromptVariables(readFileSync(DECLARATION, 'utf8'))
    const unknown = [...new Set(variables.filter((name) => !LOOP_PROMPT_VARIABLES.includes(name)))]
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `引用了 loop 未注册的变量：${unknown.join('、')}（允许：${LOOP_PROMPT_VARIABLES.join('、')}）`
          + ' —— 0.2.1-rc.2 删除了 cwd；strict 插值会在首个模型请求前抛 unknown prompt variable',
      }
    }
    if (!variables.includes('model')) {
      return { ok: false, message: 'persona 模板不再引用 {{model}} —— 应保留 loop 注册的模型事实' }
    }
    return { note: `${[...new Set(variables)].join(', ')}` }
  })

  log('零内部耦合（第三方包不得静态 import @deepseek-ai/*）')
  await check('src/ 与 lib/ 都没有 @deepseek-ai/* 的静态导入', 'noPlatformImports', () => {
    const offenders = []
    const sources = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.ts')).map((f) => [`src/${f}`, join(ROOT, 'src', f)])
    if (existsSync(LIB)) sources.push(['lib/index.js', LIB])
    const patterns = [/\bfrom\s+['"]@deepseek-ai\//, /\bimport\s*\(\s*['"]@deepseek-ai\//, /\brequire\s*\(\s*['"]@deepseek-ai\//]
    for (const [label, file] of sources) {
      const text = readFileSync(file, 'utf8')
      if (patterns.some((pattern) => pattern.test(text))) offenders.push(label)
    }
    if (offenders.length > 0) {
      return {
        ok: false,
        message: `这些文件静态导入了平台包：${offenders.join('、')}（宿主接触面只能走 src/host.ts 的特性探测）`,
      }
    }
    return { note: `${sources.length} 个文件` }
  })
}

/**
 * 离线 peer 断言（C2）：声明的范围 == 复核过的字符串，且版本表全部命中。
 *
 * 为什么需要它：C1（平台门禁）依赖本机装过 DSH，CI 上恒被跳过；而
 * "`^0.1.7-rc.1` 被 0.2.0-rc.1 判为不兼容"这件事**只在装了 DSH 的机器上才看得见**，
 * 2026-09 的 v1.2.0 事故就是这么漏出去的（当初 `pnpm run check` 全绿）。
 *
 * 两个刻意的设计：
 * 1. **范围必须逐字等于复核值**：改 peer 范围就必须同时改本文件的复核值，
 *    不允许"悄悄放宽/收窄"。
 * 2. **不认的形式直接报错**（见 {@link parseRange}）：否则把 `^0.3.0` 这种写法塞进来
 *    就让这档断言变成 no-op —— 校验脚本一旦失去"能被改坏"的性质就没有意义。
 * @param manifest - 仓库 package.json（可由 `--self-test` 注入坏值）
 * @param log - 分组标题输出
 */
async function checkPeerRange(manifest, log) {
  log('peer 范围（离线表：平台门禁在 CI 上恒被跳过，这档是 CI 的唯一增量）')
  const declared = manifest?.peerDependencies?.['@deepseek-ai/dsh']

  await check('package.json 的 DSH peer 范围 == 复核过的范围', 'dshPeerRange', () => {
    if (manifest === undefined || manifest === null) {
      return { ok: false, message: 'package.json 无法解析（拿不到 peerDependencies）' }
    }
    if (declared !== REVIEWED_DSH_PEER_RANGE) {
      return {
        ok: false,
        message: `声明的是 ${JSON.stringify(declared)}，复核过的是 ${JSON.stringify(REVIEWED_DSH_PEER_RANGE)}`
          + ' —— 改这个范围要同时改 tools/verify-contract.mjs 的 REVIEWED_DSH_PEER_RANGE'
          + ' 与 DSH_PEER_ACCEPTS/REJECTS，并用平台门禁（C1）复核',
      }
    }
    return { note: declared }
  })

  await check('范围可被本断言解析，且接受/拒绝表全部命中', 'dshPeerRange', () => {
    if (typeof declared !== 'string') return { ok: false, message: `peer 范围不是字符串：${JSON.stringify(declared)}` }
    if (DSH_PEER_ACCEPTS.length < 4 || DSH_PEER_REJECTS.length < 3) {
      return {
        ok: false,
        message: `版本表被清空了（接受 ${DSH_PEER_ACCEPTS.length} / 拒绝 ${DSH_PEER_REJECTS.length}）`
          + ' —— 空表的断言恒真，等于没有断言',
      }
    }
    let comparators
    try {
      comparators = parseRange(declared)
    } catch (error) {
      return {
        ok: false,
        message: `${error instanceof Error ? error.message : String(error)}`
          + '（本断言只认 >= > <= < = 的空白合取；换成别的形式就等于把这档断言关掉）',
      }
    }
    if (comparators.length === 0) return { ok: false, message: '范围解析出 0 个比较器' }
    const wrong = []
    for (const version of DSH_PEER_ACCEPTS) {
      if (!satisfiesRange(version, declared)) wrong.push(`应接受却拒绝 ${version}`)
    }
    for (const version of DSH_PEER_REJECTS) {
      if (satisfiesRange(version, declared)) wrong.push(`应拒绝却接受 ${version}`)
    }
    if (wrong.length > 0) {
      return {
        ok: false,
        message: `${wrong.join('；')}（表见 tools/verify-contract.mjs 的 DSH_PEER_ACCEPTS/DSH_PEER_REJECTS）`,
      }
    }
    return { note: `接受 ${DSH_PEER_ACCEPTS.length} 个 / 拒绝 ${DSH_PEER_REJECTS.length} 个` }
  })
}

/** 假 ctx：只实现插件真的会用的入口，记录每次副作用以便断言可逆性 */
function fakeContext() {
  const registered = new Map()
  const sections = []
  const listeners = new Map()
  const effects = []
  return {
    registered,
    sections,
    listeners,
    effects,
    ctx: {
      tools: {
        register(def) {
          if (registered.has(def.name)) throw new Error(`duplicate tool ${def.name}`)
          registered.set(def.name, def)
          return () => registered.delete(def.name)
        },
      },
      effect(callback) {
        effects.push(callback)
        return () => {}
      },
      get(key) {
        if (key !== 'systemPrompt') return undefined
        return {
          section(entry) {
            sections.push(entry)
            return () => {
              const at = sections.indexOf(entry)
              if (at >= 0) sections.splice(at, 1)
            }
          },
        }
      },
      on(event, listener) {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
    },
  }
}

/**
 * 取「插件真实注入的那条消息」——假 ctx 跑一遍 apply，再走一遍 `agent/pre-step` 监听器。
 *
 * 断言返回的对象本身，而不是插件导出的常量：这样探针看的是**产物真的会发出去的东西**
 * （常量对、注入路径没接上也照样能骗过前者）。取**最后一条**消息——插件把提醒追加在末尾。
 * @param mod - 插件产物（lib/index.js）
 * @param vaultRoot - 假 vault 根（apply 的 config）
 * @returns 注入消息对象
 */
async function injectedReminder(mod, vaultRoot) {
  const fake = fakeContext()
  mod.apply(fake.ctx, { vaultRoot })
  const listener = fake.listeners.get('agent/pre-step')
  if (typeof listener !== 'function') throw new Error('未注册 agent/pre-step 监听器')
  const decision = await listener(
    { agent: { session: { snapshotEvents: () => [{ type: 'turn/start' }] } }, turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [{ id: 'user-1', role: 'user' }] }),
  )
  const messages = decision?.messages
  const injected = Array.isArray(messages) ? messages[messages.length - 1] : undefined
  if (injected === undefined) throw new Error('首轮首步未注入提醒（拿不到待断言的消息）')
  return injected
}

/** 解析本机 DSH：先看 `--platform` 覆盖，再优先 $DSH_HOME，退到 ~/.dsh；profile 目录按实际存在的挑 */
function locatePlatformModules() {
  if (PLATFORM_OVERRIDE !== undefined) {
    return existsSync(join(PLATFORM_OVERRIDE, '@deepseek-ai')) ? PLATFORM_OVERRIDE : undefined
  }
  const homes = [process.env.DSH_HOME, process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh') : undefined,
    process.env.HOME ? join(process.env.HOME, '.dsh') : undefined].filter(Boolean)
  for (const home of homes) {
    const profiles = join(home, 'profiles')
    if (!existsSync(profiles)) continue
    // profile 自己的 node_modules 优先（平台包按 profile 装），再退到共享布局与 pnpm 的 hoist 目录
    // （DSH 从源码树跑时平台包只在 `.pnpm/node_modules` 里可解析，见 --platform 用法）
    const candidates = [
      ...['web', 'tui', 'headless'].map((name) => join(profiles, name, 'node_modules')),
      ...['web', 'tui', 'headless'].map((name) => join(profiles, name, 'node_modules', '.pnpm', 'node_modules')),
      join(profiles, 'node_modules'),
      join(profiles, 'node_modules', '.pnpm', 'node_modules'),
    ]
    for (const dir of candidates) {
      if (existsSync(join(dir, '@deepseek-ai'))) return dir
    }
  }
  return undefined
}

/**
 * 按 profile 的 node_modules 解析平台包的 ESM 入口。
 *
 * `import('@deepseek-ai/dsh-tools')` 在本脚本里解析不到（脚本位于插件仓库，
 * 不在 profile 的解析链上），所以用 createRequire 从 profile 目录里解析
 * package.json，再按 `exports['.']` 取入口文件——就是在跑 DSH 本体时用的那份。
 */
async function tryImport(specifier, base) {
  const manifestPath = join(base, specifier, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    const require = createRequire(join(base, 'noop.cjs'))
    const manifest = require(manifestPath)
    const dot = manifest.exports?.['.'] ?? manifest.exports
    const entry = typeof dot === 'string'
      ? dot
      : dot?.import?.default ?? dot?.import ?? dot?.default ?? manifest.module ?? manifest.main
    if (typeof entry !== 'string') return undefined
    return await import(pathToFileURL(join(base, specifier, entry)).href)
  } catch {
    return undefined
  }
}

/**
 * 平台符号探针：把 HOST_CONTRACTS 的每个点在**运行中的 DSH** 上验一遍。
 *
 * 行号漂移不影响判定（断言按形状，不按行号），它是给你去平台源码核对用的。
 */
async function probePlatform(log) {
  const base = locatePlatformModules()
  if (base === undefined) {
    log('⏭ 平台符号探针：未找到 DSH 安装（$DSH_HOME/profiles/*/node_modules）——本机跑不到这层，跳过')
    return
  }
  log(`平台符号探针（${base}）`)
  const modules = {}
  for (const specifier of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-session-format-v3-to-v4']) {
    modules[specifier] = await tryImport(specifier, base)
    if (modules[specifier] === undefined) log(`  ⏭ ${specifier} 未安装，跳过其断言`)
  }

  const tools = modules['@deepseek-ai/dsh-tools']
  if (tools !== undefined) {
    await check('工具运行时导出且 register 仍是方法', 'toolsRegister', () => {
      const runtime = tools.ToolRuntime ?? tools.default
      if (typeof runtime !== 'function') return { ok: false, message: `未导出 ToolRuntime（导出：${Object.keys(tools).join(',')}）` }
      if (typeof runtime.prototype?.register !== 'function') return { ok: false, message: 'ToolRuntime.prototype.register 不是函数' }
      return { note: 'ToolRuntime.prototype.register ✓' }
    })
  }

  const session = modules['@deepseek-ai/dsh-session']
  if (session !== undefined) {
    await check('Session.snapshotEvents 仍在', 'sessionSnapshotEvents', () => {
      const ctor = session.Session ?? session.default
      if (typeof ctor?.prototype?.snapshotEvents !== 'function') {
        return { ok: false, message: 'Session.prototype.snapshotEvents 不存在（开场门禁降级，需改读平台新 API）' }
      }
      return { note: 'Session.prototype.snapshotEvents ✓' }
    })
    await check('Session 实例可读 header.cwd', 'sessionHeaderCwd', () => {
      // header 是构造期必填字段：用最小合法 header 真造一个 Session，
      // 验证 `payload.agent.session.header.cwd` 这条读取路径没变形状。
      const ctor = session.Session ?? session.default
      const sessionId = session.SessionId?.('contract-probe') ?? 'contract-probe'
      const instance = ctor.create(sessionId, [], {
        version: session.SESSION_FORMAT_VERSION,
        id: sessionId,
        createdAt: Date.now(),
        isSeeded: false,
        cwd: 'T:\\probe',
      })
      const cwd = instance?.header?.cwd
      if (cwd !== 'T:\\probe') return { ok: false, message: `session.header.cwd 读到 ${JSON.stringify(cwd)}` }
      return { note: 'session.header.cwd ✓' }
    })
  }

  const prompt = modules['@deepseek-ai/dsh-system-prompt']
  if (prompt !== undefined) {
    await check('SystemPrompt.section 仍是方法', 'systemPromptSection', () => {
      const ctor = prompt.SystemPrompt ?? prompt.default
      if (typeof ctor?.prototype?.section !== 'function') {
        return { ok: false, message: 'SystemPrompt.prototype.section 不是函数' }
      }
      return { note: 'SystemPrompt.prototype.section ✓' }
    })
  }

  const format = modules['@deepseek-ai/dsh-session-format-v3-to-v4']
  if (format !== undefined) {
    await check('活平台收下真实注入消息（v4 写盘路径），且拒绝退场的 plugin 包装', 'messageSourceKind', async () => {
      const codec = format.releasedV4SessionFormatCodec
      if (codec === undefined || typeof codec.encodeEvent !== 'function') {
        return { ok: false, message: `未导出 releasedV4SessionFormatCodec.encodeEvent（导出：${Object.keys(format).join(',')}）` }
      }
      const mod = await import(pathToFileURL(LIB).href)
      const tempVault = await mkdtemp(join(tmpdir(), 'study-buddy-source-'))
      try {
        const reminder = await injectedReminder(mod, tempVault)
        const row = { type: 'user/message', seq: 0, time: 1, data: reminder }
        try {
          codec.encodeEvent(row)
        } catch (error) {
          return {
            ok: false,
            message: `平台拒绝了真实注入消息：${error instanceof Error ? error.message : String(error)}`
              + '（这就是「本轮运行失败」的形态：source.kind 必须是生产者自有的非空 kind 且 ≠ plugin）',
          }
        }
        // 负向对照：退场的包装必须被平台拒——否则本断言失去意义（两边一起改错也不会被发现）
        const retired = { ...row, data: { ...reminder, source: { kind: 'plugin', plugin: 'dsh-study-buddy' } } }
        try {
          codec.encodeEvent(retired)
        } catch (error) {
          if (/producer-owned source kind/.test(String(error?.message))) return { note: '真实消息通过 / 退场包装被拒' }
          throw error
        }
        return {
          ok: false,
          message: '退场的 {kind:"plugin"} 包装竟然被平台接受了 —— 本断言已失去意义（两边一起改错也不会被发现）',
        }
      } finally {
        await rm(tempVault, { recursive: true, force: true })
      }
    })
  }

  // peer 范围：**用平台自己的门禁**判（不手搓 semver，语义与 DSH 完全一致）
  const boot = modules['@deepseek-ai/dsh-app-boot']
  if (boot !== undefined && typeof boot.evaluatePluginCompatibility === 'function') {
    await check('package.json 的 DSH peer 范围接受本机运行时', 'dshPeerRange', () => {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
      const runtime = boot.getDshRuntimeVersion()
      const issue = boot.evaluatePluginCompatibility(manifest, {}, runtime)
      if (issue !== undefined) {
        return {
          ok: false,
          message: `dsh ${runtime} 判为不兼容：${JSON.stringify(issue.peers)}`
            + '（DSH 会拒绝装载本插件；随 DSH minor 升级时提 package.json 的 peer 范围）',
        }
      }
      return { note: `dsh ${runtime} ✓（${JSON.stringify(manifest.peerDependencies?.['@deepseek-ai/dsh']) }）` }
    })
  } else if (boot !== undefined) {
    log('  ⏭ dsh-app-boot 没导出 evaluatePluginCompatibility，跳过 peer 范围断言')
  }
}

/**
 * 载入 lib/index.js 并跑全部断言；被 --self-test 复用（可注入损坏的产物或坏的清单）。
 * @param log - 分组标题输出
 * @param load - 产物加载器（`--self-test` 注入改坏的模块）
 * @param manifestOf - 仓库清单读取器（`--self-test` 注入坏 peer 范围）
 */
export async function runChecks(
  log,
  load = async () => import(pathToFileURL(LIB).href),
  manifestOf = () => JSON.parse(readFileSync(MANIFEST, 'utf8')),
) {
  const mod = await load()
  let manifest
  try {
    manifest = manifestOf()
  } catch {
    manifest = undefined
  }

  // 契约点说明表：单一真相在 src/host.ts 的 HOST_CONTRACTS（经产物导出）
  contractInfo.clear()
  for (const contract of mod.HOST_CONTRACTS ?? []) contractInfo.set(contract.key, contract)

  log(`产物出口（${LIB}）`)
  await check('apply 是函数、inject 声明 tools', 'toolsRegister', () => {
    if (typeof mod.apply !== 'function') return { ok: false, message: 'lib/index.js 没有导出 apply' }
    if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) {
      return { ok: false, message: `inject 声明异常：${JSON.stringify(mod.inject)}` }
    }
    return { note: `inject=${JSON.stringify(mod.inject)}` }
  })

  await check('宿主契约表完整（每个点都有 ref/what/breaks，供失败回显）', 'hostContracts', () => {
    const contracts = mod.HOST_CONTRACTS ?? []
    if (contracts.length < 6) return { ok: false, message: `HOST_CONTRACTS 只有 ${contracts.length} 条（应覆盖 6 个接触点）` }
    const keys = contracts.map((item) => item.key)
    const missing = ['toolsRegister', 'systemPromptSection', 'preStep', 'messageSourceKind', 'sessionSnapshotEvents', 'sessionHeaderCwd']
      .filter((key) => !keys.includes(key))
    if (missing.length > 0) return { ok: false, message: `契约表缺 ${missing.join('、')}` }
    for (const item of contracts) {
      if (!item.ref || !item.what || !item.breaks) return { ok: false, message: `${item.key} 缺少 ref/what/breaks` }
    }
    return { note: `${contracts.length} 条` }
  })

  await checkDelivery(mod, log)
  await checkPeerRange(manifest, log)

  const tempVault = await mkdtemp(join(tmpdir(), 'study-buddy-contract-'))
  try {
    const expected = [
      'note_library', 'note_expect_get', 'note_list', 'note_get', 'note_search', 'note_overview',
      'note_plan', 'note_write', 'note_update', 'note_toc', 'note_link', 'note_unlink',
      'note_rename', 'note_history', 'note_restore', 'note_lint', 'study_progress', 'study_memory',
    ]

    log('工具面（18 个 note_* / study_*）')
    await check('工具数量与名字与仓库约定一致', 'toolsRegister', () => {
      const defs = mod.buildToolDefs({})
      const names = defs.map((def) => def.name)
      const missing = expected.filter((name) => !names.includes(name))
      const extra = names.filter((name) => !expected.includes(name))
      if (missing.length > 0 || extra.length > 0) {
        return {
          ok: false,
          message: `缺失 ${missing.join('、') || '无'}；多出 ${extra.join('、') || '无'}`
            + '（退场工具会让 persona 教模型调不存在的工具）',
        }
      }
      return { note: `${names.length} 个` }
    })

    await check('每个工具只声明宿主认识的字段', 'toolsRegister', () => {
      const allowed = new Set(['name', 'description', 'parameters', 'output', 'isConcurrencySafe', 'execute'])
      const offenders = []
      for (const def of mod.buildToolDefs({})) {
        const unknown = Object.keys(def).filter((key) => !allowed.has(key))
        if (unknown.length > 0) offenders.push(`${def.name}: ${unknown.join('、')}`)
      }
      if (offenders.length > 0) return { ok: false, message: `多余字段：${offenders.join('；')}` }
      return { note: '无多余字段' }
    })

    await check('output 契约（schema.type=string + render→text 块）', 'toolsRegister', () => {
      for (const def of mod.buildToolDefs({})) {
        const { schema, render } = def.output ?? {}
        if (schema?.type !== 'string') return { ok: false, message: `${def.name}: output.schema.type=${JSON.stringify(schema?.type)}（应 'string'）` }
        if (typeof render !== 'function') return { ok: false, message: `${def.name}: output.render 不是函数` }
        const rendered = render({}, 'x')
        if (!Array.isArray(rendered) || rendered[0]?.type !== 'text' || rendered[0]?.text !== 'x') {
          return { ok: false, message: `${def.name}: render 返回 ${JSON.stringify(rendered)}（应 [{type:'text',text}]）` }
        }
      }
      return { note: '18 个工具全部符合' }
    })

    await check('工具定义可无损 JSON 序列化（注册表会快照参数与输出）', 'toolsRegister', () => {
      for (const def of mod.buildToolDefs({})) {
        if (JSON.stringify(def) === undefined) return { ok: false, message: `${def.name} 无法 JSON 序列化` }
      }
      return { note: 'ok' }
    })

    log('宿主接线（apply → 注册 / 系统提示段 / 预步监听）')
    await check('apply 注册 18 个工具且 effect 卸载后全部注销', 'toolsRegister', () => {
      const fake = fakeContext()
      mod.apply(fake.ctx, { vaultRoot: tempVault })
      if (fake.registered.size !== expected.length) {
        return { ok: false, message: `注册了 ${fake.registered.size} 个（应 ${expected.length}）` }
      }
      for (const callback of fake.effects) callback()()
      if (fake.registered.size !== 0) return { ok: false, message: 'effect 执行后仍有残留注册（生命周期不可逆）' }
      return { note: '注册 18 / 注销 18' }
    })

    // 负向断言（迁移指南铁律 3）：替身刻意**不提供** settings —— DSH 0.1.7-rc.1 删掉了
    // `ctx.settings.register`，任何"只有 settings 在才工作"的写法会整行未激活。
    await check('负向：假 ctx 不给 settings（0.1.7 已删 register），apply 仍注册 18 个工具', 'toolsRegister', () => {
      const fake = fakeContext()
      if (typeof fake.ctx.get('settings') !== 'undefined') return { ok: false, message: '替身意外提供了 settings' }
      mod.apply(fake.ctx, { vaultRoot: tempVault })
      if (fake.registered.size !== expected.length) {
        return { ok: false, message: `注册了 ${fake.registered.size} 个（应 ${expected.length}）—— 说明依赖了已删 API` }
      }
      return { note: '不依赖 settings / 已删方法' }
    })

    await check('负向：dsh-loader 报错时退到直接服务，不影响注册', 'toolsRegister', () => {
      const fake = fakeContext()
      const inner = fake.ctx.get.bind(fake.ctx)
      fake.ctx.get = (key) => {
        if (key === 'dshLoader') return { services: { get() { throw new Error('adapter broken') } } }
        return inner(key)
      }
      mod.apply(fake.ctx, { vaultRoot: tempVault })
      if (fake.registered.size !== expected.length) {
        return { ok: false, message: `注册了 ${fake.registered.size} 个（应 ${expected.length}）` }
      }
      return { note: '可选兼容层坏了也不拖垮插件' }
    })

    await check('系统提示段条目形状（name/order 有限数/text）', 'systemPromptSection', () => {
      const fake = fakeContext()
      mod.apply(fake.ctx, { vaultRoot: tempVault })
      if (fake.sections.length !== 1) return { ok: false, message: `注册了 ${fake.sections.length} 个提示段（应 1）` }
      const entry = fake.sections[0]
      if (typeof entry.name !== 'string' || !Number.isFinite(Number(entry.order)) || typeof entry.text !== 'string') {
        return { ok: false, message: `条目形状异常：${JSON.stringify({ name: entry.name, order: entry.order })}` }
      }
      return { note: `${entry.name} order=${entry.order}` }
    })

    await check('agent/pre-step：注入 / 恢复会话 / reject / 非首步 四条分支', 'preStep', async () => {
      const fake = fakeContext()
      mod.apply(fake.ctx, { vaultRoot: tempVault })
      const listener = fake.listeners.get('agent/pre-step')
      if (typeof listener !== 'function') return { ok: false, message: '未注册 agent/pre-step 监听器' }
      const base = { kind: 'enter', messages: [{ id: 'user-1', role: 'user' }] }
      const next = async () => base
      const payload = (events, turn = 1, step = 1) => ({ agent: { session: { snapshotEvents: () => events } }, turn, step })

      const injected = await listener(payload([{ type: 'turn/start' }]), next)
      if (injected.messages?.length !== 2) return { ok: false, message: '全新会话未注入提醒（应 2 条消息）' }
      const restored = await listener(payload([{ type: 'user/message' }]), next)
      if (restored !== base) return { ok: false, message: '已有 user/message 的会话被重复注入' }
      const laterStep = await listener(payload([], 1, 2), next)
      if (laterStep !== base) return { ok: false, message: '非首步被注入' }
      const rejected = await listener(payload([]), async () => ({ kind: 'reject' }))
      if (rejected.kind !== 'reject') return { ok: false, message: 'reject 决策被改写' }
      return { note: '4/4 分支正确' }
    })

    await check('注入消息的来源满足 v4 准入（常跑：不依赖平台包）', 'messageSourceKind', async () => {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
      const reminder = await injectedReminder(mod, tempVault)
      const source = reminder?.source
      if (source === null || typeof source !== 'object') {
        return { ok: false, message: `注入消息没有 source：${JSON.stringify(reminder)}` }
      }
      if (typeof source.kind !== 'string' || source.kind.length === 0) {
        return {
          ok: false,
          message: `source.kind 不是非空字符串：${JSON.stringify(source.kind)}`
            + '（平台 v4 准入要求生产者自有 kind；空 kind 会被 v4 校验拒绝）',
        }
      }
      if (source.kind === 'plugin') {
        return {
          ok: false,
          message: "source.kind 还是退场的 'plugin' 包装 —— 平台 v4 写盘会拒绝它，整轮失败"
            + '（"本轮运行失败 format v4 message requires a producer-owned source kind"）；改用 plugin:<包名>',
        }
      }
      if (source.kind !== `plugin:${manifest.name}`) {
        return {
          ok: false,
          message: `source.kind=${source.kind}，但平台 V3→V4 迁移给本插件的是 plugin:${manifest.name}`
            + '（第三方插件名的规范 kind；不同名会让同一插件的新旧行分裂成两个生产者身份）',
        }
      }
      if (Object.hasOwn(source, 'plugin')) {
        return { ok: false, message: 'source 仍带退场的 plugin 字段（准入只认 kind，留着会误导后来人）' }
      }
      if (source.form !== undefined) {
        const known = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']
        if (!known.includes(source.form)) {
          return { ok: false, message: `source.form=${source.form} 不在平台 ContextFormed 的六种形态里` }
        }
        if (source.form === 'notice' && (typeof source.summary !== 'string' || source.summary.length === 0)) {
          return { ok: false, message: 'form=notice 必须带非空 summary（否则对话里退回不透明展开体）' }
        }
      }
      return { note: `${source.kind}${source.form === undefined ? '' : ` form=${source.form}`}` }
    })

    await check('旧平台形状（session.events 数组）已消失时只多注入一次，不抛错', 'sessionSnapshotEvents', async () => {
      const fake = fakeContext()
      mod.apply(fake.ctx, { vaultRoot: tempVault })
      const listener = fake.listeners.get('agent/pre-step')
      const base = { kind: 'enter', messages: [] }
      const bare = await listener({ agent: { session: {} }, turn: 1, step: 1 }, async () => base)
      if (bare === undefined) return { ok: false, message: '载荷缺 snapshotEvents 时返回了 undefined（应原样透传）' }
      const throwing = await listener({
        agent: { session: { snapshotEvents() { throw new Error('宿主 API 变了') } } },
        turn: 1, step: 1,
      }, async () => base)
      if (throwing === undefined) return { ok: false, message: 'snapshotEvents 抛错时逸出了异常（会变成步骤级失败）' }
      return { note: '两条降级路径都安全' }
    })
  } finally {
    await rm(tempVault, { recursive: true, force: true })
  }
}

/** 负向对照（troubleshooting.md §六）：断言必须真的会失败 */
async function selfTest() {
  const log = VERBOSE ? console.log : () => {}
  log('负向对照（把断言改坏，必须报错）')
  const real = await import(pathToFileURL(LIB).href)
  const cases = [
    {
      name: '删掉一个工具 → 工具面断言报错',
      mutate: (mod) => ({ ...mod, buildToolDefs: () => mod.buildToolDefs({}).slice(1) }),
    },
    {
      name: '把 output.schema.type 改成 object → output 断言报错',
      mutate: (mod) => ({
        ...mod,
        buildToolDefs: (store) => mod.buildToolDefs(store).map((def, index) => (
          index === 0 ? { ...def, output: { ...def.output, schema: { type: 'object' } } } : def
        )),
      }),
    },
    {
      name: 'apply 不注册工具 → 接线断言报错',
      mutate: (mod) => ({ ...mod, apply: () => {} }),
    },
    {
      name: 'apply 抛错 → 接线断言报错（整行未激活形态）',
      mutate: (mod) => ({ ...mod, apply: () => { throw new Error('strict codec has no create() factory') } }),
    },
    {
      name: '契约表被清空 → 契约表断言报错',
      mutate: (mod) => ({ ...mod, HOST_CONTRACTS: [] }),
    },
    {
      name: '声明一行都不认得的 config 键 → 交付形态断言报错',
      mutate: (mod) => ({
        ...mod,
        // 只改"认得的键"，等价于把 patch 里的 study 行全部标成未知键
        KNOWN_CONFIG_KEYS: [],
      }),
    },
    {
      // v1.1.1 事故形态：把注入消息的来源退回 {kind:'plugin', plugin:…}
      name: '注入消息退回 {kind:"plugin"} 包装 → 来源准入断言报错',
      mutate: (mod) => ({
        ...mod,
        apply: (ctx, config) => {
          const originalOn = typeof ctx?.on === 'function' ? ctx.on.bind(ctx) : undefined
          if (originalOn !== undefined) {
            ctx.on = (event, listener) => originalOn(event, async (payload, next) => {
              const decision = await listener(payload, next)
              const messages = decision?.messages
              if (event !== 'agent/pre-step' || decision?.kind !== 'enter' || !Array.isArray(messages)) return decision
              return {
                ...decision,
                messages: messages.map((message, index) => (index === messages.length - 1 && message?.source?.kind !== 'user'
                  ? { ...message, source: { kind: 'plugin', plugin: 'dsh-study-buddy' } }
                  : message)),
              }
            })
          }
          return mod.apply(ctx, config)
        },
      }),
    },
    {
      // v1.2.0 事故形态：把 DSH peer 范围收回 ^0.1.7-rc.1（不覆盖 0.2.0-rc.1）→ bundle 层被摘除
      name: 'DSH peer 范围改回 ^0.1.7-rc.1 → 离线 peer 断言报错',
      mutate: (mod) => mod,
      manifest: (manifest) => ({
        ...manifest,
        peerDependencies: { ...manifest.peerDependencies, '@deepseek-ai/dsh': '^0.1.7-rc.1' },
      }),
    },
    {
      // 形式守卫：范围写成 * 就等于把"CI 也能拦 peer 过期"这档断言关掉
      name: 'DSH peer 范围改成 * → 离线 peer 断言报错（形式守卫）',
      mutate: (mod) => mod,
      manifest: (manifest) => ({
        ...manifest,
        peerDependencies: { ...manifest.peerDependencies, '@deepseek-ai/dsh': '*' },
      }),
    },
  ]

  let caught = 0
  for (const item of cases) {
    // 每次都从零开始：把负向对照的断言结果收进临时数组，判断"有没有真的报错"
    const collected = []
    const sink = (line) => collected.push(line)
    const before = failures.length
    try {
      await runChecks(
        sink,
        async () => item.mutate(real),
        item.manifest === undefined
          ? () => JSON.parse(readFileSync(MANIFEST, 'utf8'))
          : () => item.manifest(JSON.parse(readFileSync(MANIFEST, 'utf8'))),
      )
    } catch {
      // 断言之外的意外异常也算"被抓住"
    }
    const added = failures.length - before
    failures.length = before // 负向对照的失败不计入正式退出码
    if (added > 0) {
      caught += 1
      if (VERBOSE) console.log(`  ✓ ${item.name}（${added} 条断言报错）`)
    } else {
      failures.push({
        contract: 'toolsRegister',
        message: `负向对照未报错：${item.name}——校验脚本已失去意义（两边一起改错也不会被发现）`,
      })
    }
  }
  return caught === cases.length
}

async function main() {
  const log = console.log
  log('dsh-study-buddy 契约校验（只读）\n')
  log('── 契约断言 ──')
  await runChecks(log)
  await probePlatform(log)
  /** 正式断言数（负向对照会重置 passed，最后要报的是这一轮的） */
  const contractPassed = passed

  let selfTestOk = false
  if (SELF_TEST) {
    log('── 负向对照（把断言改坏，必须报错）──')
    selfTestOk = await selfTest()
  }

  log('')
  if (failures.length === 0) {
    log(`✓ 全部通过（${contractPassed} 条契约断言${SELF_TEST && selfTestOk ? ' + 负向对照全部命中' : ''}）`)
    return 0
  }
  for (const failure of failures) {
    console.error(`✗ [${failure.contract}] ${failure.message}`)
    if (failure.info) {
      console.error(`    契约点：${failure.info.ref} — ${failure.info.what}`)
      console.error(`    失效后果：${failure.info.breaks}`)
    }
  }
  console.error(`\n✗ ${failures.length} 条断言失败（通过 ${contractPassed} 条）`)
  console.error('  下一步：对照上面的「契约点」去 DSH 工作树 HEAD 读现行定义，'
    + '或直接跑 node tools/verify-contract.mjs --verbose 看全部断言。')
  return 1
}

// 作为脚本直接运行时才执行（被 import 时只暴露 runChecks / scanEntryRows）
if (process.argv[1] !== undefined
  && fileURLToPath(pathToFileURL(process.argv[1])) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
