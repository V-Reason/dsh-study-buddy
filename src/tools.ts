/**
 * 工具定义注册表（模型可见的 18 个 `note_*` / `study_*` 工具）。
 *
 * 工具 schema 本身是"提示词资产"（描述即文档）：本文件与 VaultStore 业务逻辑分文件，
 * 各自演进更清晰；工具只做参数解析与委派，业务在 VaultStore。
 *
 * 2026-10 重构：`card_*` 整族退场（需求 R18），改为文档式笔记工具面；工具数取
 * 16~18 个中的上限——**一个工具一个动词**，列目录/看单篇/搜全库/看覆盖度各自独立，
 * 模型不必靠参数分支猜语义（需求方定稿："宁可多不要挤"）。
 *
 * 硬门禁（需求 F2/R25）落在 `note_write`：未读期望 / 未确认规划 / 越界路径一律拒绝，
 * 且磁盘零改动——这条由 `src/gate.ts` 强制，不靠 persona 自觉。
 * @module tools
 */

import { VALID_STATUS, type BlockLinks } from './note.ts'
import { RULES, ruleIds } from './lint.ts'
import type { VaultStore } from './index.ts'

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
        '笔记库自检：vault 是否可写、《笔记期望.md》是否存在并已读、块/存量卡/旧笔记各多少、有无待消费规划。'
        + '会话开始处理笔记前先调用一次；写入被拒时也用它定位原因。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['check'], description: 'check=输出库状态与门禁状态' },
        },
        required: ['action'],
      },
      output,
      isConcurrencySafe: READ_ONLY,
      execute: (args) => store.noteLibrary(String(args.action ?? 'check')),
    },
    {
      name: 'note_expect_get',
      description:
        '读取 vault 根的《笔记期望.md》全文，并**标记为已读**——这是写入笔记的前置条件之一。'
        + '期望文件是笔记写法的唯一来源（结构/详略/文风/公式图表/领域侧重），代码里没有内建模板。'
        + '用户改了期望后签名会变，必须重新读取才能继续写入（热配置立即生效）。',
      parameters: { type: 'object', properties: {} },
      output,
      isConcurrencySafe: READ_ONLY,
      execute: () => store.noteExpectGet(),
    },

    // ── 导航与检索 ─────────────────────────────────────────────────────────
    {
      name: 'note_list',
      description:
        '逐层导航笔记库：列出某目录下的子目录与笔记（标题·类型·来源章节·简介），并标出没有微目录的目录。'
        + 'path 省略即列 vault 根；depth=2 时连下一层笔记一起列。目录层级是「资料 / 章 / 节 / 块」（项目类笔记可少一层）。',
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
        '关键词全库检索（vault + 配置的 searchRoots + 会话工作目录旧笔记）；召回由插件做，语义判断由你完成。'
        + '命中返回标题/ID/类型（块·存量卡·旧笔记）/路径/领域/状态/来源/来源章节/简介/片段。'
        + '摄入新资料前查重叠、引用旧笔记前定位、判断是否增量更新时用。检索词用核心术语，不要整句。',
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
        '主题/整库总览：列出块清单，并按 `来源章节` 聚合出「资料 → 章 → 节」的覆盖情况与缺口（含"未归类"）。'
        + '回答"这个主题记全了没有"用它。缺口只依据笔记里真实出现的章节号统计，不会替你虚构资料目录。',
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
        '文件夹规划：把"这次要写哪些块、各落到哪个目录"整理成提案，供用户拍板。**提案只在对话里，不落盘**。'
        + 'items 是待落块清单（title + path，path 为 vault 内相对路径含文件名）；rootPath 是规划根，之后 note_write 的路径必须落在它之下。'
        + '用户确认（或让你改）后，用返回的 planId 调 note_write 逐个落盘；结构或顺序要改就直接重新提案一次。'
        + 'action=abandon 放弃规划（把 rootPath 传成要放弃的 planId）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'abandon'], description: 'create=提案（默认）；abandon=放弃指定规划' },
          rootPath: { type: 'string', description: 'create：规划根目录；abandon：要放弃的 planId' },
          material: { type: 'string', description: '本次规划服务的资料名' },
          notes: { type: 'string', description: '给用户的补充说明（如"复用已有目录、只新增一个节"）' },
          items: {
            type: 'array',
            description: '待落块清单（至少一项；同一规划内标题必须唯一）',
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
        '写入一个笔记块。硬门禁（会被拒绝并列修复步骤）：① 必须先 note_expect_get 读过《笔记期望.md》且之后没改过；'
        + '② 必须带已确认的 planId；③ path 必须在规划根之下、标题在规划清单里且未被写过。'
        + '正文写法（结构/详略/公式/图表/互引）完全按《笔记期望.md》，**没有模板与必填小节，字数不设限**。'
        + 'dryRun=true 只回显将写入的内容，不落盘。目标已存在时报错——改写用 note_update，避免覆盖。',
      parameters: {
        type: 'object',
        properties: {
          planId: { type: 'string', description: 'note_plan 返回的规划 id（必须已确认）' },
          title: { type: 'string', description: '块标题（必须与规划里的某一项一致）' },
          path: { type: 'string', description: '落盘路径（vault 内相对路径，含 .md）' },
          source: { type: 'string', description: '资料名（课程/书/项目）' },
          content: { type: 'string', description: '正文 Markdown：写法完全按《笔记期望.md》（结构/详略/公式/图表/互引），长度不设限' },
          sourceSection: { type: 'string', description: '来源章节（缺省用规划里的值）：《资料》第N章 章标题 / N.N节' },
          order: { type: 'number', description: '同目录阅读顺序（缺省用规划里的值）' },
          domain: { type: 'string', description: '领域键（可选；用于检索过滤与落盘快捷方式）' },
          status: { type: 'string', enum: [...VALID_STATUS], description: '草稿/已确认/需更新，默认 草稿' },
          summary: { type: 'string', description: '一句话定位（可选，无长度限制；缺省时从正文首个引用块提取）' },
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
        '更新已有笔记：action=append 把补充内容追加到正文（可指定 section，缺省追加到末尾，旧内容天然保留）；'
        + 'action=replace 整体替换正文——**旧正文会先存入 .study/archive/，绝不丢**（先存档后写正文）；'
        + 'action=move 把笔记移到新目录（targetPath）；action=definition 只替换一句话定位（字段级微调，不算知识更新）。'
        + 'dryRun=true 预演 replace/move。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '笔记 ID / 标题 / 路径 / 文件名' },
          action: { type: 'string', enum: ['append', 'replace', 'move', 'definition'], description: 'append/replace/move/definition' },
          changes: { type: 'string', description: 'append：要补充的 Markdown' },
          section: { type: 'string', description: 'append：追加到哪个 `### 小节`（缺省=文末）' },
          newContent: { type: 'string', description: 'replace：新正文 Markdown' },
          summary: { type: 'string', description: 'definition/replace：新的一句话定位' },
          sourceSection: { type: 'string', description: 'replace：修正来源章节' },
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
        targetPath: args.targetPath ? String(args.targetPath) : undefined,
        dryRun: args.dryRun === true,
      }, { sessionCwd: sessionCwdOf(exec) }),
    },
    {
      name: 'note_toc',
      description:
        '生成/刷新某主题目录的「微目录.md」：按阅读顺序（顺序键→标题）列出该目录的块，带来源章节与一句话简介。'
        + '**每个主题目录都应有微目录**（note_write 会在缺失时提醒）。'
        + '只重写 `<!-- note_toc:begin -->` 与 `<!-- note_toc:end -->` 之间的生成段，你手写的导读段落原样保留；'
        + '增删改名笔记后重跑一次即可保持一致。dryRun=true 只看将写入什么。',
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
        '建立双向关联（落盘为 Obsidian wikilink，写在两侧的「### 关联」小节）：'
        + 'kind=prev（from 是 to 的前置）/ next（后续）/ sibling（同主题兄弟，两侧同向）。'
        + '已存在的关联不重复添加；旧笔记（无 ID）默认不写，需 config.linkIntoNotes。先校验两侧再写，不留单向入链。',
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
        '改标题并同步四件事：frontmatter 标题 → 文件名（仅当文件名=旧标题清洗结果）→ 全库 wikilink 入链 → 断链检测。'
        + '目标标题/文件名冲突时**不做任何写入**；dryRun=true 先预演。只写 vault 内文件，旧笔记（无 ID）拒绝。',
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
        '查看某篇笔记的历史存档（`.study/archive/<ID>/`）：action=list 列出存档（时间/原因/原路径）；'
        + 'action=read 配合 archiveId 看某份存档全文。存档在笔记被 replace 或被恢复时自动产生，正文里不留历史块。',
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
        '把某篇笔记恢复成一份历史存档（缺省恢复最新那份）。恢复前**当前正文会先存入存档**，所以可反复来回；'
        + 'dryRun=true 先看将恢复成什么。用户说"回退/恢复旧版本/改坏了"时用。',
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
        + '规则只覆盖"数据卫生"（会话残留含白名单：L0/L1/L2 球谐带、讲义引用、代码块与折叠块内不扫），'
        + '不再有模板/字数类检查；报告给问题清单与严重级，不给分数。'
        + 'ref 给单篇；scope="vault" 批量体检有 ID 的笔记，scope="all" 含旧笔记。',
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
        '读写学习进度（持久，跨会话有效）：资料/小节/未答追问/触及笔记。'
        + '"接着讲"前 get；小节推进 set；归档（整理笔记）前检查 pendingQuestions。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'get/set/clear' },
          material: { type: 'string', description: 'set：资料名' },
          section: { type: 'string', description: 'set：小节' },
          pendingQuestions: { type: 'array', items: { type: 'string' }, description: 'set：追问队列（整体替换）' },
          touchedIds: { type: 'array', items: { type: 'string' }, description: 'set：触及笔记 ID（整体替换）' },
        },
        required: ['action'],
      },
      output,
      execute: (args) => store.progress(String(args.action ?? 'get'), {
        material: args.material ? String(args.material) : undefined,
        section: args.section ? String(args.section) : undefined,
        pendingQuestions: stringList(args.pendingQuestions),
        touchedCardIds: stringList(args.touchedIds),
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
