/**
 * 工具定义注册表（模型可见的 `card_*` / `study_*` 工具）。
 *
 * 从 index.ts 抽出的原因：工具 schema 本身是"提示词资产"（描述即文档），
 * 2026-09 重设计后从 9 个增至 12 个，与 VaultStore 业务逻辑分文件后各自
 * 演进更清晰。工具只做参数解析与委派，业务在 VaultStore。
 * @module tools
 */

import { generateId, VALID_STATUS, type LinkKind, type UpdatePayload } from './card.ts'
import { REENTRY_CHARS, RULES, ruleIds } from './lint.ts'
import { PREREQ_SECTION, REENTRY_SECTION, TEMPLATE_TYPES, templateTable } from './template.ts'
import type { HistoryKind } from './history.ts'
import type { VaultStore } from './index.ts'

/** `card_history` 支持的块类型（BIZ-11e：非法值必须报错，不能静默变成"无块可清除"） */
export const HISTORY_KINDS: HistoryKind[] = ['version', 'errata', 'details']

function historyKinds(value: unknown): HistoryKind[] | undefined {
  const list = stringList(value)
  if (list === undefined) return undefined
  const invalid = list.filter((k) => !HISTORY_KINDS.includes(k as HistoryKind))
  if (invalid.length > 0) {
    throw new Error(`kinds 只接受 ${HISTORY_KINDS.join('/')}，收到：${invalid.join('、')}`)
  }
  return list as HistoryKind[]
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: { type: string }
    render: (_args: unknown, value: string) => Array<{ type: string; text: string }>
  }
  isConcurrencySafe?: () => boolean
  /** exec 由 DSH 工具注册表注入：调用方会话信息（agent.session.header.cwd） */
  execute: (args: Record<string, unknown>, exec?: ToolExecLike) => Promise<string> | string
}

/** 工具方会话信息的最小结构类型（不引入 @deepseek-ai 类型，保持构建 external） */
export interface ToolExecLike {
  agent?: { session?: { header?: { cwd?: string } } }
}

const renderText = (_args: unknown, value: string) => [{ type: 'text', text: value }]
const output = { schema: { type: 'string' as const }, render: renderText }

export function sessionCwdOf(exec?: ToolExecLike): string | undefined {
  const cwd = exec?.agent?.session?.header?.cwd
  return cwd && String(cwd).trim() ? String(cwd) : undefined
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined
}

/** 解析 links 参数（card_create / card_update replace 共用） */
function linksOf(value: unknown): { prev?: string[]; next?: string[]; conflict?: string[] } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  return { prev: stringList(raw.prev), next: stringList(raw.next), conflict: stringList(raw.conflict) }
}

export function buildToolDefs(store: VaultStore): ToolDef[] {
  return [
    {
      name: 'card_search',
      description:
        '全库检索 vault 卡片与旧笔记（含配置 searchRoots 与工作目录旧笔记——旧笔记=无 ID 的 .md）。'
        + '摄入新资料、引用旧卡、增量更新判断前必查重叠。'
        + '返回候选的标题/ID/类型（卡片或旧笔记）/路径/领域/状态/来源/定义/片段；召回由插件做，语义判断由你完成。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词（概念/术语/标题片段）' },
          domain: { type: 'string', description: '领域过滤（如 图形学）' },
          status: { type: 'string', description: '状态过滤：草稿/已确认/需更新' },
          kind: { type: 'string', enum: ['card', 'note'], description: '类型过滤：card=卡片，note=旧笔记' },
          limit: { type: 'number', description: '返回条数，默认 5' },
        },
        required: ['query'],
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args, exec) => store.search(String(args.query ?? ''), {
        domain: args.domain ? String(args.domain) : undefined,
        status: args.status ? String(args.status) : undefined,
        kind: args.kind === 'card' || args.kind === 'note' ? args.kind : undefined,
        limit: Number(args.limit) > 0 ? Number(args.limit) : undefined,
      }, { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'card_get',
      description: '按 ID、标题、根限定路径（如 "工作目录/子目录/笔记.md"）、相对路径或文件名读取一篇文档的**完整原文**（卡片或旧笔记，无截断）。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '卡片 ID、标题或路径/文件名（跨根路径歧义时用"根/相对路径"）' },
        },
        required: ['ref'],
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args, exec) => store.get(String(args.ref ?? ''), { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'card_id',
      description:
        '生成卡片 ID（YYYYMMDDHHmm_随机6位hex）。注意：card_create 会自动生成 ID，不消费本工具的预取值——'
        + '需要引用时以 card_create 返回的 ID 为准；本工具仅用于查看 ID 格式。',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: '数量，默认 1，上限 20' },
        },
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args) => {
        const n = Math.min(Math.max(1, Math.trunc(Number(args?.count) || 1)), 20)
        return Array.from({ length: n }, () => generateId()).join('\n')
      },
    },
    {
      name: 'card_create',
      description:
        '把一张原子卡片写入 vault 对应分类目录（领域→目录映射；未映射落"未分类"并回显可用领域键与近似键建议）。知识即卡片：与旧笔记同库。'
        + '自动生成唯一 ID、写 frontmatter（ID/标题/领域/来源/状态/模板）；正文=裸引用块定义+分型小节（理论型/工程型/对比型，自动推断，可用 template 覆盖）+关联卡片。'
        + '返回整卡；返回文本含"领域映射"行（键 → 目录）与标题清洗提示（非法字符/引号会被清洗，文件名以返回的 rel 为准）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '概念名称，如"光线与表面的两种交互：散射与吸收"（避免 / \\ : * ? " < > | 与引号；会被自动清洗）' },
          domain: { type: 'string', description: '领域键，决定落盘目录（键名表见 card-format 技能；未映射会回显可用键与近似键）' },
          tags: { type: 'array', items: { type: 'string' }, description: '额外中文领域标签' },
          source: { type: 'string', description: '资料名称' },
          status: { type: 'string', enum: [...VALID_STATUS], description: '草稿/已确认/需更新' },
          definition: { type: 'string', description: '一句话定义：≤30 字最佳，≤60 字硬上限（31~60 字仅提示精简）' },
          template: { type: 'string', enum: [...TEMPLATE_TYPES], description: '卡片模板：理论型（为什么）/工程型（怎么做）/对比型（怎么选）；不传则按领域与标题自动推断' },
          content: {
            type: 'string',
            description: `正文 Markdown。三型模板（自动推断，可用 template 覆盖）：${templateTable().join('；')}。`
              + `长卡（>${REENTRY_CHARS} 字）补「${REENTRY_SECTION.title}」，有前置卡时补「${PREREQ_SECTION.title}」。`
              + '正文长度不设限，按信息完备性写。',
          },
          links: {
            type: 'object',
            description: '关联卡片（可预格式化，如"`漫反射模型`（ID）"）',
            properties: {
              prev: { type: 'array', items: { type: 'string' }, description: '前置' },
              next: { type: 'array', items: { type: 'string' }, description: '后续' },
              conflict: { type: 'array', items: { type: 'string' }, description: '易混淆' },
            },
          },
        },
        required: ['title', 'domain', 'source', 'status', 'definition', 'content'],
      },
      output,
      execute: (args, exec) => store.create({
        title: String(args.title ?? ''),
        domain: String(args.domain ?? ''),
        source: String(args.source ?? ''),
        status: String(args.status ?? ''),
        definition: String(args.definition ?? ''),
        template: args.template ? String(args.template) : undefined,
        content: String(args.content ?? ''),
        tags: stringList(args.tags),
        links: linksOf(args.links),
      }, { sessionCwd: sessionCwdOf(exec) }).then((r) => r.text),
    },
    {
      name: 'card_update',
      description:
        '增量更新：append-version=加"版本更新（来源）"（补充不推翻旧结论，插在「关联卡片」之前）；errata=保留旧内容加"勘误"（changes 含纠正原因）；'
        + 'definition=只替换一句话定义（字段级微调：不重传正文、不产生历史折叠，不算知识更新）；'
        + 'replace=整卡替换（旧版入历史折叠块，可传 links 重建关联卡片）。先给用户新旧对比、确认后才调用；决定权在用户。返回整卡。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '卡片 ID/标题/路径' },
          mode: { type: 'string', description: 'append-version/errata/definition/replace' },
          changes: { type: 'string', description: 'append/errata 的追加内容' },
          source: { type: 'string', description: '版本更新来源（append-version 用）' },
          title: { type: 'string', description: 'replace：新标题' },
          domain: { type: 'string', description: 'replace：领域键' },
          tags: { type: 'array', items: { type: 'string' }, description: 'replace：额外领域标签' },
          template: { type: 'string', enum: [...TEMPLATE_TYPES], description: 'replace：卡片模板（不传则沿用原卡或按标题推断）' },
          status: { type: 'string', enum: [...VALID_STATUS], description: 'replace：草稿/已确认/需更新' },
          definition: { type: 'string', description: 'definition/replace：一句话定义（≤30 字最佳，≤60 字硬上限）' },
          content: { type: 'string', description: 'replace：新正文 Markdown（小节要求同 card_create）' },
          links: {
            type: 'object',
            description: 'replace：新关联卡片（可选；不传则新卡无关联小节，旧关联留在历史折叠块）',
            properties: {
              prev: { type: 'array', items: { type: 'string' }, description: '前置' },
              next: { type: 'array', items: { type: 'string' }, description: '后续' },
              conflict: { type: 'array', items: { type: 'string' }, description: '易混淆' },
            },
          },
        },
        required: ['id', 'mode'],
      },
      output,
      execute: (args, exec) => {
        const mode = String(args.mode ?? '')
        const payload: UpdatePayload = { mode: mode as UpdatePayload['mode'] }
        if (mode === 'append-version' || mode === 'errata') {
          payload.changes = args.changes ? String(args.changes) : undefined
          if (mode === 'append-version' && args.source) payload.source = String(args.source)
        }
        if (mode === 'definition') {
          payload.definition = args.definition ? String(args.definition) : undefined
        }
        if (mode === 'replace') {
          payload.card = {
            title: String(args.title ?? ''),
            domain: String(args.domain ?? ''),
            source: String(args.source ?? ''),
            status: String(args.status ?? ''),
            definition: String(args.definition ?? ''),
            template: args.template ? String(args.template) : undefined,
            content: String(args.content ?? ''),
            tags: stringList(args.tags),
            links: linksOf(args.links),
          }
        }
        return store.update(String(args.id ?? ''), payload, { sessionCwd: sessionCwdOf(exec) })
      },
    },
    {
      name: 'card_link',
      description:
        '维护两篇文档的关联（前置/后续/易混淆），双向写入卡片侧；关联行归一为 `- 标签：`标题`（ID）`，同一目标按"标题或 ID 任一命中"去重（不产生重复行）。'
        + '无 ID 的旧笔记默认不写入（旧笔记不碰不动）：卡片↔旧笔记只写卡片侧；旧笔记↔旧笔记需 config.linkIntoNotes 开启。',
      parameters: {
        type: 'object',
        properties: {
          fromId: { type: 'string', description: '卡片 ID/标题/路径（旧笔记用"工作目录/相对路径"）' },
          toId: { type: 'string', description: '卡片 ID/标题/路径' },
          kind: { type: 'string', description: 'prev=toId 是 fromId 的前置 / next=后续 / conflict=易混淆' },
        },
        required: ['fromId', 'toId', 'kind'],
      },
      output,
      execute: (args, exec) => {
        const kind = String(args.kind ?? '') as LinkKind
        if (!['prev', 'next', 'conflict'].includes(kind)) throw new Error('kind 必须是 prev / next / conflict')
        return store.link(String(args.fromId ?? ''), String(args.toId ?? ''), kind, { sessionCwd: sessionCwdOf(exec) })
      },
    },
    {
      name: 'card_moc',
      description:
        '生成 MOC（领域分组 + Obsidian wikilink）写入"目录"目录并返回文本。归档收尾时用：传本次涉及的卡片 ID。'
        + '只收录有 ID 的卡片，旧笔记自动跳过。'
        + 'title 只传主题名（如 "图形学 MOC 目录"）——日期前缀与文件名由工具自动生成（文件名 = 日期_标题.md），'
        + '返回文本回显 文件名/标题/日期；标题带日期前缀会被自动剥离，勿再手写日期。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'MOC 主题名，只写主题（如 图形学 MOC 目录；默认 知识目录，日期由工具自动生成）' },
          cardIds: { type: 'array', items: { type: 'string' }, description: '本次涉及的卡片 ID/标题' },
          domain: { type: 'string', description: '可选：只收录该领域' },
        },
        required: ['cardIds'],
      },
      output,
      execute: (args, exec) => store.moc({
        title: args.title ? String(args.title) : undefined,
        cardIds: stringList(args.cardIds) ?? [],
        domain: args.domain ? String(args.domain) : undefined,
      }, { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'card_lint',
      description:
        `卡片质量体检（2026-09 重设计新增）：按 ${RULES.length} 条规则打分并给出改写建议——${RULES.map((r) => r.title).join('、')}。`
        + '全部为警告级（不阻塞落盘）；会话残留含白名单（L0/L1/L2 球谐带、讲义引用、代码块与历史折叠块内不扫）。'
        + 'ref 给单卡；scope="vault" 批量体检卡片，scope="all" 含旧笔记（旧笔记仅体检通用规则，不套模板）。limit 控制明细条数（默认 20）。'
        + 'cross=true 做跨卡一致性检查（同一符号/常量/口径在多卡取值冲突）；trend=true 按周统计质量趋势；rating=true 输出可执行性分布（能跑/能查/只能读）。'
        + '归档后自检、或用户问"卡片质量/有没有写歪/口径是否一致"时用。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '单卡：卡片 ID/标题/路径（与 scope 二选一）' },
          scope: { type: 'string', enum: ['vault', 'all'], description: '批量：vault=只体检卡片，all=含旧笔记（旧笔记仅体检通用规则，不套模板）' },
          limit: { type: 'number', description: '批量时返回的最低分明细条数，默认 20' },
          rule: { type: 'string', enum: ruleIds(), description: '只看某条规则（如 session-residue）' },
          cross: { type: 'boolean', description: '跨卡一致性检查：同键（表格首列/公式左侧）在多卡取值不一致时列出冲突' },
          trend: { type: 'boolean', description: '质量趋势：按卡片 ID 日期分周输出均分与短板分布' },
          rating: { type: 'boolean', description: '可执行性评级：能跑（代码+验证实验）/能查（排障判据或对比表）/只能读' },
        },
      },
      output,
      isConcurrencySafe: () => true,
      execute: (args, exec) => store.lint({
        ref: args.ref ? String(args.ref) : undefined,
        scope: args.scope === 'vault' || args.scope === 'all' ? args.scope : undefined,
        limit: Number(args.limit) > 0 ? Number(args.limit) : undefined,
        rule: args.rule ? String(args.rule) : undefined,
        cross: args.cross === true,
        trend: args.trend === true,
        rating: args.rating === true,
      }, { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'card_history',
      description:
        '管理卡片的版本更新 / 勘误 / 历史折叠块：action="list" 列出各块（类型/行号/摘要）；'
        + 'action="strip" 清除历史块（正文与关联保留，先校验 <details> 配对，不配对只警告不删；'
        + '删除是整块语义的，报告里的行号为删除前位置）。'
        + '用户说"清掉历史版本/这张卡太长了/只留最新版"时用；dryRun=true 只看会删什么。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '卡片 ID/标题/路径' },
          action: { type: 'string', enum: ['list', 'strip'], description: 'list=列出；strip=清除' },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: HISTORY_KINDS },
            description: 'strip 时只清指定类型（默认全部：version=版本更新，errata=勘误，details=历史折叠块）',
          },
          dryRun: { type: 'boolean', description: 'strip 时只报告将删除的块，不写盘' },
        },
        required: ['ref', 'action'],
      },
      output,
      execute: (args) => store.history(String(args.ref ?? ''), String(args.action ?? '') as 'list' | 'strip', {
        kinds: historyKinds(args.kinds),
        dryRun: args.dryRun === true,
      }),
    },
    {
      name: 'card_rename',
      description:
        '改卡片标题并同步一切引用（2026-09 重设计新增）：frontmatter 标题 + 文件名（仅当文件名与旧标题一致时）+ 全库入链（`标题`（ID）与 [[wikilink]]）+ 断链检测。'
        + 'dryRun=true 只预演。用户说"这张卡标题改成 X/名字写错了"时用；旧笔记（无 ID）不支持改名。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '卡片 ID/标题/路径' },
          newTitle: { type: 'string', description: '新标题（非法字符会被清洗为文件名）' },
          dryRun: { type: 'boolean', description: '只预演：返回将改动的文件清单与断链，不写盘' },
        },
        required: ['ref', 'newTitle'],
      },
      output,
      execute: (args, exec) => store.rename(String(args.ref ?? ''), String(args.newTitle ?? ''), {
        dryRun: args.dryRun === true,
        sessionCwd: sessionCwdOf(exec),
      }),
    },
    {
      name: 'study_progress',
      description:
        '读写学习进度（持久，跨会话有效）：资料/小节/未答追问/触及卡片。'
        + '"接着讲"前 get；小节推进 set；归档（整理笔记）前检查 pendingQuestions。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'get/set/clear' },
          material: { type: 'string', description: 'set：资料名' },
          section: { type: 'string', description: 'set：小节' },
          pendingQuestions: { type: 'array', items: { type: 'string' }, description: 'set：追问队列（整体替换）' },
          touchedCardIds: { type: 'array', items: { type: 'string' }, description: 'set：触及卡片 ID（整体替换）' },
        },
        required: ['action'],
      },
      output,
      execute: (args) => store.progress(String(args.action ?? 'get'), {
        material: args.material ? String(args.material) : undefined,
        section: args.section ? String(args.section) : undefined,
        pendingQuestions: stringList(args.pendingQuestions),
        touchedCardIds: stringList(args.touchedCardIds),
      }),
    },
    {
      name: 'study_memory',
      description:
        '读写跨会话记忆（vault .study/memory.json，持久有效，重启不丢）：键值笔记。'
        + '新会话开场先 get（配合 study_progress(get) 给衔接提示）；用户偏好/约定存 prefs 键；'
        + '告一段落或归档时 set lastSummary=本次小结。清空进度（study_progress clear）不影响记忆。'
        + 'get 全量输出会对含"现学/正在学"等进度句的键给出过期提示——进度位置以 study_progress 为准（单一来源）。'
        + '保留控制键 _autoPrefs（自迭代记忆开关，值 on/off，默认关闭）：set 切换、remove 回默认、不支持 append；'
        + '开启后无需用户"请记住"，按 memory-auto 技能把持久偏好/约定自动写入 prefs.* 键（每类约定一个键、覆盖更新）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'get（key 可选，默认全量）/set/append/remove/clear' },
          key: { type: 'string', description: '记忆键名（≤64 字符；lastSummary=上次小结，置顶显示；_autoPrefs=自迭代开关，值 on/off）' },
          value: { type: 'string', description: 'set/append：记忆内容（≤4000 字符）' },
        },
        required: ['action'],
      },
      output,
      execute: (args) => store.memory(String(args.action ?? 'get'), {
        key: args.key !== undefined && args.key !== null ? String(args.key) : undefined,
        value: args.value !== undefined && args.value !== null ? String(args.value) : undefined,
      }),
    },
  ]
}
