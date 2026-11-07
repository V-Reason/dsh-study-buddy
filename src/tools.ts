/**
 * 工具定义注册表（模型可见的 19 个 `note_*` / `study_*` 工具）。
 *
 * 工具 schema 本身是"提示词资产"（描述即文档）：本文件与 VaultStore 业务逻辑分文件，
 * 各自演进更清晰；工具只做参数解析与委派，业务在 VaultStore。
 *
 * 2026-10 重构：`card_*` 整族退场（需求 R18），改为文档式笔记工具面；工具数取
 * v1.3.0 增至 19 个（新增 study_mode）——列目录/看单篇/搜全库/看覆盖度各自独立，
 * 模型不必靠参数分支猜语义（需求方定稿："宁可多不要挤"）。
 *
 * 硬门禁（需求 F2/R25）落在 `note_write`：未读期望 / 未确认规划 / 越界路径一律拒绝，
 * 且磁盘零改动——这条由 `src/gate.ts` 强制，不靠 persona 自觉。
 * @module tools
 */

import { VALID_STATUS, type BlockLinks } from './note.ts'
import { RULES, ruleIds } from './lint.ts'
import { sessionCwdOf, sessionIdOf, type ToolExecLike } from './host.ts'
import { normalizeStudyIntent, normalizeStudyScope, type StudyModeArgs } from './studyMode.ts'
import type { VaultStore } from './index.ts'

/**
 * 宿主形状与读取函数都在 host.ts（本插件唯一的宿主接触面）；这里 re-export 是为了
 * 保持 `ToolExecLike` / `sessionCwdOf` 这两个既有公开出口不漂移（index.ts 继续转发）。
 */
export { sessionCwdOf, sessionIdOf, type ToolExecLike }

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

const renderText = (_args: unknown, value: string) => [{ type: 'text', text: value }]
const output = { schema: { type: 'string' as const }, render: renderText }

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined
}

/** 解析 links 参数（note_write 用；wikilink 格式的关联标签） */
function linksOf(value: unknown): BlockLinks | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  return { prev: stringList(raw.prev), next: stringList(raw.next), sibling: stringList(raw.sibling) }
}

const READ_ONLY = () => true

export function buildToolDefs(store: VaultStore): ToolDef[] {
  return [
    // ── 库状态与期望（硬门禁的前两环）──────────────────────────────────────
    {
      name: 'note_library',
      description:
        '笔记库自检：期望状态、各类笔记数量与待消费规划；写入被拒时用它定位原因。'
        + 'action=audit 时按 path 审计缺来源章节、缺微目录、孤立、断链、歧义链接和重复标题；'
        + '全库必须显式 path="."，只报告不自动修改。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['check', 'audit'], description: 'check=库状态；audit=可发现性体检' },
          path: { type: 'string', description: 'audit：vault 内目录；全库传 "."' },
          limit: { type: 'number', description: 'audit：明细条数，默认 10，上限 50' },
        },
        required: ['action'],
      },
      output,
      isConcurrencySafe: READ_ONLY,
      execute: (args) => store.noteLibrary(String(args.action ?? 'check'), {
        path: args.path !== undefined ? String(args.path) : undefined,
        limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined,
      }),
    },
    {
      name: 'note_expect_get',
      description:
        '读取并标记已读 vault 根《笔记期望.md》；它是对话文风与笔记写法的唯一来源。'
        + '缺失时对话用内置文风，正式写入仍拒绝；改期望后必须重读。',
      parameters: { type: 'object', properties: {} },
      output,
      isConcurrencySafe: READ_ONLY,
      execute: () => store.noteExpectGet(),
    },

    // ── 导航与检索 ─────────────────────────────────────────────────────────
    {
      name: 'note_list',
      description:
        '逐层导航笔记库，列出子目录、笔记元数据并标记缺微目录；path 省略=根，depth 控制展开层数。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'vault 内相对目录（省略=根；如 "计算机通识/计算方法"）' },
          depth: { type: 'number', description: '展开层数，默认 2（1~4）' },
        },
      },
      output,
      isConcurrencySafe: READ_ONLY,
      execute: (args) => store.noteList({
        path: args.path ? String(args.path) : undefined,
        depth: Number(args.depth) > 0 ? Number(args.depth) : undefined,
      }),
    },
    {
      name: 'note_get',
      description: '读取一篇笔记的完整原文（不截断）。ref 支持 ID、标题、根限定路径（vault/… 、工作目录/…）、相对路径或文件名。',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string', description: '笔记 ID / 标题 / 路径 / 文件名' } },
        required: ['ref'],
      },
      output,
      isConcurrencySafe: READ_ONLY,
      execute: (args, exec) => store.get(String(args.ref ?? ''), { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'note_search',
      description:
        '关键词检索 vault、searchRoots 与工作目录：返回标题/ID/类型/路径/元数据/片段。'
        + '插件负责召回，你负责语义判断；用核心术语，不要整句。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词（概念/术语/标题片段）' },
          domain: { type: 'string', description: '领域过滤' },
          status: { type: 'string', description: '状态过滤：草稿/已确认/需更新' },
          kind: { type: 'string', enum: ['block', 'legacy', 'note'], description: 'block=块（有 ID 且有来源章节）/ legacy=存量卡 / note=旧笔记' },
          path: { type: 'string', description: '只在该目录及其子目录内检索（vault 内相对路径）' },
          limit: { type: 'number', description: '返回条数，默认 5（上限 50）' },
        },
        required: ['query'],
      },
      output,
      isConcurrencySafe: READ_ONLY,
      execute: (args, exec) => store.search(String(args.query ?? ''), {
        domain: args.domain ? String(args.domain) : undefined,
        status: args.status ? String(args.status) : undefined,
        kind: args.kind === 'block' || args.kind === 'legacy' || args.kind === 'note' ? args.kind : undefined,
        dirPath: args.path ? String(args.path) : undefined,
        limit: Number(args.limit) > 0 ? Number(args.limit) : undefined,
      }, { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'note_overview',
      description:
        '主题/整库块清单，并按 `来源章节` 聚合覆盖与缺口；未归类显式列出，不虚构章节。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '限定目录（省略=整个库）' },
          material: { type: 'string', description: '只看某份资料（如 "计算方法"）' },
        },
      },
      output,
      isConcurrencySafe: READ_ONLY,
      execute: (args) => store.noteOverview({
        path: args.path ? String(args.path) : undefined,
        material: args.material ? String(args.material) : undefined,
      }),
    },

    // ── 规划（硬门禁的第三环）──────────────────────────────────────────────
    {
      name: 'note_plan',
      description:
        '文件夹规划：提案只在对话，不落盘。create 用 rootPath + items 出提案，路径须在规划根下。'
        + '用户拍板后必须 action=confirm（rootPath=planId），否则会被 note_write 拒绝；'
        + '有效期从确认时刻起算。abandon 放弃规划。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'confirm', 'abandon'], description: '提案/确认/放弃' },
          rootPath: { type: 'string', description: 'create=规划根；confirm/abandon=planId' },
          material: { type: 'string', description: '本次规划服务的资料名' },
          notes: { type: 'string', description: '给用户的补充说明（如"复用已有目录、只新增一个节"）' },
          items: {
            type: 'array',
            description: '待落块清单；标题唯一',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '块标题' },
                path: { type: 'string', description: '落盘路径（vault 内相对路径，含 .md）' },
                sourceSection: { type: 'string', description: '来源章节（如 《计算方法》第2章 线性方程组数值解法 / 2.1节）' },
                order: { type: 'number', description: '同目录阅读顺序（微目录排序用）' },
              },
              required: ['title', 'path'],
            },
          },
        },
        required: ['rootPath', 'items'],
      },
      output,
      isConcurrencySafe: READ_ONLY,
      execute: (args) => store.notePlan({
        action: args.action ? String(args.action) : undefined,
        rootPath: args.rootPath ? String(args.rootPath) : undefined,
        material: args.material ? String(args.material) : undefined,
        notes: args.notes ? String(args.notes) : undefined,
        items: Array.isArray(args.items)
          ? (args.items as Array<Record<string, unknown>>).map((it) => ({
            title: it.title ? String(it.title) : '',
            path: it.path ? String(it.path) : '',
            sourceSection: it.sourceSection ? String(it.sourceSection) : undefined,
            order: Number.isFinite(Number(it.order)) ? Number(it.order) : undefined,
          }))
          : [],
      }),
    },

    // ── 写入 ───────────────────────────────────────────────────────────────
    {
      name: 'note_write',
      description:
        '写入笔记块。门禁：先 note_expect_get，并带已确认 planId；路径须在规划根内且标题未写过。'
        + '正文按《笔记期望.md》，无模板、必填小节或字数限制。dryRun 只预览。',
      parameters: {
        type: 'object',
        properties: {
          planId: { type: 'string', description: '已确认的规划 id' },
          title: { type: 'string', description: '块标题（必须与规划里的某一项一致）' },
          path: { type: 'string', description: '落盘路径（vault 内相对路径，含 .md）' },
          source: { type: 'string', description: '资料名（课程/书/项目）' },
          content: { type: 'string', description: '正文；按《笔记期望.md》，不设限' },
          sourceSection: { type: 'string', description: '来源章节（缺省用规划里的值）：《资料》第N章 章标题 / N.N节' },
          order: { type: 'number', description: '同目录阅读顺序（缺省用规划里的值）' },
          domain: { type: 'string', description: '领域键（可选；用于检索过滤与落盘快捷方式）' },
          status: { type: 'string', enum: [...VALID_STATUS], description: '草稿/已确认/需更新，默认 草稿' },
          summary: { type: 'string', description: '一句话定位，无长度限制；H1 文档只写 frontmatter' },
          tags: { type: 'array', items: { type: 'string' }, description: '额外领域标签' },
          links: {
            type: 'object',
            description: '关联（可选，wikilink 格式，如 "[[列主元消元]]"）',
            properties: {
              prev: { type: 'array', items: { type: 'string' }, description: '前置' },
              next: { type: 'array', items: { type: 'string' }, description: '后续' },
              sibling: { type: 'array', items: { type: 'string' }, description: '兄弟（同主题相邻块）' },
            },
          },
          dryRun: { type: 'boolean', description: '只回显将写入的内容，不落盘' },
        },
        required: ['planId', 'title', 'path', 'source', 'content'],
      },
      output,
      execute: (args) => store.noteWrite({
        planId: String(args.planId ?? ''),
        title: String(args.title ?? ''),
        path: String(args.path ?? ''),
        source: String(args.source ?? ''),
        content: String(args.content ?? ''),
        sourceSection: args.sourceSection ? String(args.sourceSection) : undefined,
        order: Number.isFinite(Number(args.order)) ? Number(args.order) : undefined,
        domain: args.domain ? String(args.domain) : undefined,
        status: args.status ? String(args.status) : undefined,
        summary: args.summary ? String(args.summary) : undefined,
        tags: stringList(args.tags),
        links: linksOf(args.links),
        dryRun: args.dryRun === true,
      }),
    },
    {
      name: 'note_update',
      description:
        '更新笔记：append 补充；replace 整体替换，旧正文先存入 .study/archive/，绝不丢；'
        + 'move 迁目录；definition 改一句话定位；metadata 只改来源章节/状态，正文逐字不变。dryRun 可预演。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '笔记 ID / 标题 / 路径 / 文件名' },
          action: { type: 'string', enum: ['append', 'replace', 'move', 'definition', 'metadata'], description: '更新动作' },
          changes: { type: 'string', description: 'append：要补充的 Markdown' },
          section: { type: 'string', description: 'append：追加到哪个 `### 小节`（缺省=文末）' },
          newContent: { type: 'string', description: 'replace：新正文 Markdown' },
          summary: { type: 'string', description: 'definition/replace：新的一句话定位；H1 文档只改 frontmatter' },
          sourceSection: { type: 'string', description: 'replace/metadata：来源章节' },
          status: { type: 'string', enum: [...VALID_STATUS], description: 'metadata：新状态' },
          targetPath: { type: 'string', description: 'move：新的 vault 内相对路径（含 .md）' },
          dryRun: { type: 'boolean', description: '只预演，不落盘' },
        },
        required: ['ref', 'action'],
      },
      output,
      execute: (args, exec) => store.noteUpdate({
        ref: String(args.ref ?? ''),
        action: String(args.action ?? ''),
        changes: args.changes ? String(args.changes) : undefined,
        section: args.section ? String(args.section) : undefined,
        newContent: args.newContent ? String(args.newContent) : undefined,
        summary: args.summary ? String(args.summary) : undefined,
        sourceSection: args.sourceSection ? String(args.sourceSection) : undefined,
        status: args.status ? String(args.status) : undefined,
        targetPath: args.targetPath ? String(args.targetPath) : undefined,
        dryRun: args.dryRun === true,
      }, { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'note_toc',
      description:
        '生成/刷新主题目录的「微目录.md」并保留手写导读；只重写生成段。'
        + '增删改名后重跑；dryRun 只预览。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '主题目录（vault 内相对路径）' },
          title: { type: 'string', description: '微目录标题（缺省用目录名）' },
          dryRun: { type: 'boolean', description: '只回显将写入的内容，不落盘' },
        },
        required: ['dir'],
      },
      output,
      execute: (args) => store.noteToc(String(args.dir ?? ''), {
        title: args.title ? String(args.title) : undefined,
        dryRun: args.dryRun === true,
      }),
    },

    // ── 关联 ───────────────────────────────────────────────────────────────
    {
      name: 'note_link',
      description:
        '建立双向 Obsidian wikilink 关联（prev/next/sibling），先校验两侧再写；'
        + '重复不添加，旧笔记默认不写。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '源笔记（ID/标题/路径）' },
          to: { type: 'string', description: '目标笔记（ID/标题/路径）' },
          kind: { type: 'string', enum: ['prev', 'next', 'sibling'], description: 'prev=前置 / next=后续 / sibling=兄弟' },
        },
        required: ['from', 'to', 'kind'],
      },
      output,
      execute: (args, exec) => store.noteLink(
        String(args.from ?? ''),
        String(args.to ?? ''),
        (args.kind === 'prev' || args.kind === 'next' || args.kind === 'sibling' ? args.kind : 'sibling'),
        false,
        { sessionCwd: sessionCwdOf(exec) },
      ),
    },
    {
      name: 'note_unlink',
      description: '移除两侧的关联（与 note_link 相反）。目标不在关联里时返回"无改动"。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '源笔记' },
          to: { type: 'string', description: '要断开的目标笔记' },
        },
        required: ['from', 'to'],
      },
      output,
      execute: (args, exec) => store.noteLink(
        String(args.from ?? ''),
        String(args.to ?? ''),
        'sibling',
        true,
        { sessionCwd: sessionCwdOf(exec) },
      ),
    },

    // ── 改名与历史 ─────────────────────────────────────────────────────────
    {
      name: 'note_rename',
      description:
        '改标题并同步 frontmatter、文件名、全库 wikilink 与断链检测；冲突零写入，dryRun 可预演。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '笔记 ID / 标题 / 路径' },
          title: { type: 'string', description: '新标题' },
          dryRun: { type: 'boolean', description: '只预演' },
        },
        required: ['ref', 'title'],
      },
      output,
      execute: (args, exec) => store.rename(String(args.ref ?? ''), String(args.title ?? ''), {
        dryRun: args.dryRun === true,
        sessionCwd: sessionCwdOf(exec),
      }),
    },
    {
      name: 'note_history',
      description:
        '查看 `.study/archive/` 历史：list 列存档，read 配合 archiveId 读全文。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '笔记 ID / 标题 / 路径' },
          action: { type: 'string', enum: ['list', 'read'], description: 'list（默认）/ read' },
          archiveId: { type: 'string', description: 'read：存档 id（先用 list 查看）' },
        },
        required: ['ref'],
      },
      output,
      isConcurrencySafe: READ_ONLY,
      execute: (args, exec) => store.noteHistory(String(args.ref ?? ''), {
        action: args.action ? String(args.action) : undefined,
        archiveId: args.archiveId ? String(args.archiveId) : undefined,
      }, { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'note_restore',
      description:
        '把笔记恢复为历史存档；恢复前当前正文先存档，可来回，dryRun 可预演。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '笔记 ID / 标题 / 路径' },
          archiveId: { type: 'string', description: '要恢复的存档 id（缺省=最新一份）' },
          dryRun: { type: 'boolean', description: '只预演' },
        },
        required: ['ref'],
      },
      output,
      execute: (args, exec) => store.noteRestore(String(args.ref ?? ''), {
        archiveId: args.archiveId ? String(args.archiveId) : undefined,
        dryRun: args.dryRun === true,
      }, { sessionCwd: sessionCwdOf(exec) }),
    },

    // ── 质量体检 ───────────────────────────────────────────────────────────
    {
      name: 'note_lint',
      description:
        `笔记质量体检：按 ${RULES.length} 条规则列出问题与建议——${RULES.map((r) => r.title).join('、')}。`
        + '覆盖数据卫生与期望检查；只给问题清单和严重级，不给分数。'
        + 'ref=单篇；scope=vault/all 批量。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '单篇：笔记 ID/标题/路径（与 scope 二选一）' },
          scope: { type: 'string', enum: ['vault', 'all'], description: '批量：vault=只体检有 ID 的笔记，all=含旧笔记' },
          limit: { type: 'number', description: '批量时返回的明细条数，默认 20' },
          rule: { type: 'string', enum: ruleIds(), description: '只看某条规则（如 session-residue）' },
        },
      },
      output,
      isConcurrencySafe: READ_ONLY,
      execute: (args, exec) => store.lint({
        ref: args.ref ? String(args.ref) : undefined,
        scope: args.scope === 'vault' || args.scope === 'all' ? args.scope : undefined,
        limit: Number(args.limit) > 0 ? Number(args.limit) : undefined,
        rule: args.rule ? String(args.rule) : undefined,
      }, { sessionCwd: sessionCwdOf(exec) }),
    },

    // ── 学习进度与记忆（语义不变）──────────────────────────────────────────
    {
      name: 'study_progress',
      description:
        '读写持久学习进度：资料/小节/追问/笔记、计划引用、当前阶段、下一动作、完成判据和并行线。'
        + 'get=完整状态；brief=紧凑计划入口；set=写字段；clear=清空。'
        + 'brief 只在用户问“今天学什么/从哪继续”时使用，不主动提醒复习。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'clear', 'brief'], description: 'get/set/clear/brief' },
          material: { type: 'string', description: 'set：资料名' },
          section: { type: 'string', description: 'set：小节' },
          pendingQuestions: { type: 'array', items: { type: 'string' }, description: 'set：追问队列（整体替换）' },
          touchedIds: { type: 'array', items: { type: 'string' }, description: 'set：触及笔记 ID（整体替换）' },
          planRef: { type: 'string', description: 'set：当前计划笔记的路径/标题/ID' },
          phase: { type: 'string', description: 'set：当前主阶段' },
          nextAction: { type: 'string', description: 'set：当前下一动作' },
          doneWhen: { type: 'string', description: 'set：下一动作的完成判据' },
          lastOutcome: { type: 'string', description: 'set：最近完成结果' },
          parallelLines: { type: 'array', items: { type: 'string' }, description: 'set：简短并行进度' },
        },
        required: ['action'],
      },
      output,
      execute: (args) => store.progress(String(args.action ?? 'get'), {
        material: args.material ? String(args.material) : undefined,
        section: args.section ? String(args.section) : undefined,
        pendingQuestions: stringList(args.pendingQuestions),
        touchedCardIds: stringList(args.touchedIds),
        planRef: args.planRef !== undefined ? String(args.planRef) : undefined,
        phase: args.phase !== undefined ? String(args.phase) : undefined,
        nextAction: args.nextAction !== undefined ? String(args.nextAction) : undefined,
        doneWhen: args.doneWhen !== undefined ? String(args.doneWhen) : undefined,
        lastOutcome: args.lastOutcome !== undefined ? String(args.lastOutcome) : undefined,
        parallelLines: stringList(args.parallelLines),
      }),
    },
    {
      name: 'study_memory',
      description:
        '读写跨会话记忆（.study/memory.json）：键值笔记。新会话先 get；偏好/约定存 prefs.*；'
        + '告一段落 set lastSummary。清进度不影响记忆。'
        + '控制键 _autoPrefs=on/off 只支持 set/remove，不支持 append。',
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
    {
      name: 'study_mode',
      description:
        '自适应讲解模式：resolve=判断，touch=记录，set=会话覆盖，status=查看。'
        + '依据 note_search 证据、intent/scope 与 30 天接触窗口；不确定时详细。'
        + '默认不向用户展示模式标签；只影响讲解和答疑，不改变正式笔记。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['resolve', 'touch', 'set', 'status'], description: '判断/记录/切换/查看' },
          topic: { type: 'string', description: '知识主题；resolve/touch 必填' },
          mode: { type: 'string', enum: ['auto', 'quick', 'full'], description: 'set；touch 仅 quick/full' },
          kind: {
            type: 'string',
            enum: ['lecture', 'qa', 'note-read', 'note-write', 'review'],
            description: '实质接触类型；搜索/列目录不算',
          },
          relatedNotes: {
            type: 'array',
            items: { type: 'string' },
            description: '确认相关的笔记 ID/标题/路径',
          },
          intent: {
            type: 'string',
            enum: ['direct', 'refresh', 'learn', 'apply', 'debug', 'compare'],
          },
          scope: {
            type: 'string',
            enum: ['single', 'concept', 'system'],
          },
        },
        required: ['action'],
      },
      output,
      execute: (args, exec) => store.studyMode(String(args.action ?? 'status'), {
        topic: args.topic ? String(args.topic) : undefined,
        mode: args.mode === 'auto' || args.mode === 'quick' || args.mode === 'full' ? args.mode : undefined,
        kind: args.kind === 'lecture' || args.kind === 'qa' || args.kind === 'note-read'
          || args.kind === 'note-write' || args.kind === 'review'
          ? args.kind
          : undefined,
        relatedNotes: stringList(args.relatedNotes),
        intent: normalizeStudyIntent(args.intent),
        scope: normalizeStudyScope(args.scope),
      } satisfies StudyModeArgs, { id: sessionIdOf(exec), cwd: sessionCwdOf(exec) }),
    },
  ]
}
