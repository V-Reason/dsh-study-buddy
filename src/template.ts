/**
 * 模板注册表：理论型 / 工程型 / 对比型三套必填小节，以及自动推断。
 *
 * 一套模板硬套两类卡，必然一边臃肿一边空洞（2026-09 调研实证）。
 * 这里把"卡片该长什么样"变成可枚举、可校验、可测试的声明式数据，
 * 新增小节或新模板只改本文件，校验与 lint 自动跟随。
 * @module template
 */

import { hasSection, splitSections, type CardSection } from './cardmodel.ts'

export const TEMPLATE_TYPES = ['理论型', '工程型', '对比型'] as const
export type TemplateType = (typeof TEMPLATE_TYPES)[number]

export interface SectionSpec {
  /** 规范标题（`### ` 后的文本；允许括号后缀变体） */
  title: string
  /** 写作提示（校验警告文案里回显） */
  hint: string
  /** 是否属于「主线」（lint 检查主线小节不得折叠） */
  mainline?: boolean
}

const SEC = (title: string, hint: string, mainline = false): SectionSpec => ({ title, hint, mainline })

/** 三型共有的知识主干小节 */
export const COMMON_SECTIONS: SectionSpec[] = [
  SEC('核心思想', '一句话讲清 + 为什么重要 + 记忆锚点', true),
  SEC('主干线', '问题 → 关键约束 → 解法 → 代价 → 验证方式（一条因果链）', true),
  SEC('阶梯式解剖', '第 1 层直觉 → 第 2 层机制 → 第 3 层细节推导 → 第 4 层边界反例（4~6 层，带序号）', true),
  SEC('实例走查', '代入具体数字/代码逐步走完（理论型数值代入、工程型代码走查）'),
  SEC('易错点', '坑 + 为什么错'),
  SEC('自测题', '2~3 题，每题带 → 答案要点与「答不出 → 回看 X」指针'),
]

/** 面向零记忆读者的通用小节（三型均推荐，长卡/有前置卡时必填） */
export const REENTRY_SECTION = SEC('重入点', '30 秒 / 5 分钟 / 30 分钟三种读法，从任意起点重建')
export const PREREQ_SECTION = SEC('前置检查', '需要知道：概念 A（卡片 ID）…；不需要知道：明确排除')

/** 工程型专属（具名常量：lint 规则读标题，不再手抄字面量，EXT-2） */
export const VERIFY_EXPERIMENT_SECTION = SEC('验证实验', '可执行步骤 ≥3 步，每步一句"看到什么说明什么"')
export const TROUBLESHOOT_SECTION = SEC('排障判据', '表格：症状 | 判据 | 修复')
export const ENGINEERING_SECTIONS: SectionSpec[] = [VERIFY_EXPERIMENT_SECTION, TROUBLESHOOT_SECTION]

/** 对比型专属 */
export const COMPARISON_TABLE_SECTION = SEC('对比表', '≥2 个对象的对比；列数 ≤4，列名短')
export const CHOICE_RULE_SECTION = SEC('选型口诀', '一句话决策规则')
export const SCENARIO_WALKTHROUGH_SECTION = SEC('场景走查', '按场景代入：什么情况下选谁')
export const COMPARISON_SECTIONS: SectionSpec[] = [COMPARISON_TABLE_SECTION, CHOICE_RULE_SECTION, SCENARIO_WALKTHROUGH_SECTION]

export interface TemplateSpec {
  type: TemplateType
  /** 一句话说明这张模板回答什么问题 */
  answers: string
  /** 必填小节 */
  required: SectionSpec[]
  /** 推荐但非必填（缺失只提示，不计入"缺节"） */
  optional: SectionSpec[]
}

const SPECS: Record<TemplateType, TemplateSpec> = {
  理论型: {
    type: '理论型',
    answers: '为什么',
    required: COMMON_SECTIONS,
    optional: [REENTRY_SECTION, PREREQ_SECTION],
  },
  工程型: {
    type: '工程型',
    answers: '怎么做',
    required: [...COMMON_SECTIONS, ...ENGINEERING_SECTIONS],
    optional: [REENTRY_SECTION, PREREQ_SECTION],
  },
  对比型: {
    type: '对比型',
    answers: '怎么选',
    required: [
      SEC('核心思想', '一句话讲清 + 为什么重要 + 记忆锚点', true),
      SEC('主干线', '问题 → 关键约束 → 解法 → 代价 → 验证方式（一条因果链）', true),
      ...COMPARISON_SECTIONS,
      SEC('易错点', '坑 + 为什么错'),
      SEC('自测题', '2~3 题，每题带 → 答案要点与「答不出 → 回看 X」指针'),
    ],
    optional: [REENTRY_SECTION, PREREQ_SECTION],
  },
}

/** 取模板规格（未知类型回退理论型） */
export function templateSpec(type: string | undefined): TemplateSpec {
  const key = String(type ?? '').trim() as TemplateType
  return SPECS[key] ?? SPECS['理论型']
}

/** 全部模板规格（文档与 lint 报告用） */
export function allTemplates(): TemplateSpec[] {
  return TEMPLATE_TYPES.map((t) => SPECS[t])
}

/** 是否为合法模板类型名 */
export function isTemplateType(value: string): value is TemplateType {
  return (TEMPLATE_TYPES as readonly string[]).includes(value)
}

/** 工程型领域特征（默认值；可用 config.templateHints 覆盖，EXT-3） */
export const DEFAULT_ENGINEERING_DOMAINS = ['图形学', 'Unity', 'Shader', 'URP', '渲染']
export const DEFAULT_ENGINEERING_TITLES = ['接入', '配置', '参数', '坑', '实现', '源码', '变体']
export const DEFAULT_COMPARISON_TITLES = ['对比', '谱系', '选型', '取舍', '差异', '之争', 'vs']

/** 模板自动推断的提示词表（配置项 `templateHints`，缺省用上面的默认值） */
export interface TemplateHints {
  /** 工程型领域键：精确命中或以 `${键}-` 前缀命中（不再用子串包含，避免「渲染数学」被判工程型） */
  engineeringDomains?: string[]
  /** 工程型标题特征词 */
  engineeringTitles?: string[]
  /** 对比型标题特征词 */
  comparisonTitles?: string[]
}

export interface InferInput {
  title: string
  domain: string
  /** domainFolders[domain] 解析出的落盘目录（相对 vaultRoot），按"路径段精确等于领域键"补充判断 */
  mappedFolder?: string
  /** 提示词表（缺省用内置默认值） */
  hints?: TemplateHints
}

/** 领域键命中：精确相等，或以 `${hint}-` 开头（子域键）；目录按路径段精确比对 */
function matchesDomainHint(domain: string, folder: string, hint: string): boolean {
  if (!hint) return false
  if (domain === hint || domain.startsWith(`${hint}-`)) return true
  return folder.split(/[\\/]/).some((seg) => seg === hint)
}

/**
 * 自动推断模板类型（显式传 template 时以显式为准）：
 * 标题含对比/谱系/选型/取舍 → 对比型；
 * 领域键命中工程族（或标题含接入/配置/参数/坑/实现）→ 工程型；
 * 其余 → 理论型。
 */
export function inferTemplate(input: InferInput): TemplateType {
  const title = String(input.title ?? '')
  const domain = String(input.domain ?? '')
  const folder = String(input.mappedFolder ?? '')
  const hints = input.hints ?? {}
  const comparison = hints.comparisonTitles ?? DEFAULT_COMPARISON_TITLES
  const engineeringDomains = hints.engineeringDomains ?? DEFAULT_ENGINEERING_DOMAINS
  const engineeringTitles = hints.engineeringTitles ?? DEFAULT_ENGINEERING_TITLES
  if (comparison.some((h) => title.includes(h))) return '对比型'
  if (engineeringDomains.some((h) => matchesDomainHint(domain, folder, h))) return '工程型'
  if (engineeringTitles.some((h) => title.includes(h))) return '工程型'
  return '理论型'
}

export interface TemplateCheck {
  type: TemplateType
  /** 已具备的必填小节 */
  present: string[]
  /** 缺失的必填小节 */
  missing: SectionSpec[]
  /** 缺失的推荐小节 */
  missingOptional: SectionSpec[]
}

/** 按模板校验正文小节齐备度（兼容括号后缀变体） */
export function checkTemplate(type: string | undefined, body: string): TemplateCheck {
  const spec = templateSpec(type)
  const text = String(body ?? '')
  const sections: CardSection[] = splitSections(text).sections
  const has = (title: string): boolean => hasSection(sections, title)
  const present = spec.required.filter((s) => has(s.title)).map((s) => s.title)
  return {
    type: spec.type,
    present,
    missing: spec.required.filter((s) => !has(s.title)),
    missingOptional: spec.optional.filter((s) => !has(s.title)),
  }
}

/** 生成小节写作提示（校验警告与工具描述共用） */
export function sectionHints(specs: SectionSpec[]): string {
  return specs.map((s) => `### ${s.title}（${s.hint}）`).join(' / ')
}

/** 模板速览表（文档与工具描述共用） */
export function templateTable(): string[] {
  return allTemplates().map((s) => `${s.type}（回答"${s.answers}"）：必填 ${s.required.map((r) => r.title).join(' / ')}`)
}
