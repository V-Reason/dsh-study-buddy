/**
 * 笔记块：ID 生成、校验、渲染、增量应用。
 *
 * 2026-10 文档式笔记重构的核心变化（相对旧的 `card.ts`）：
 * - **不再有模板**：三型模板与必填小节彻底退场（需求 R6），`note_write` 不对
 *   小节做任何检查——写什么、怎么组织，由用户自己的《笔记期望.md》决定。
 * - **不再有字数硬拒绝**：旧的"一句话定义 ≤60 字"是唯一保留的长度硬限，现改为
 *   可选键 `简介`，无长度限制（需求 R7）。
 * - **新增文档键**：`来源章节`（覆盖度数据源，写入时归一）、`顺序`（微目录排序）。
 * - **关联改 wikilink**：「关联」小节写 `- 前置：[[目标]]`（需求 R16）。
 *
 * 仍然是**纯文本变换**：不碰文件系统，历史存档由调用方通过 `archive.ts` 处理
 * （"先存档后写正文"的顺序不在这里，见 `archiveThenWrite`）。
 * @module note
 */
export declare const VALID_STATUS: readonly ["草稿", "已确认", "需更新"];
/** 关联小节标题（`note_link` 与渲染共用一处定义） */
export declare const LINKS_SECTION = "\u5173\u8054";
export interface BlockLinks {
    prev?: string[];
    next?: string[];
    sibling?: string[];
}
export interface BlockInput {
    title: string;
    /** 资料名（课程/书/项目名） */
    source: string;
    /** 正文 Markdown（尽细尽全，不设上下限） */
    content: string;
    /** 领域键（可选；用于检索过滤与 domainFolders 快捷落盘） */
    domain?: string;
    /** 状态：缺省"草稿" */
    status?: string;
    /** 来源章节（写入时归一；不合法不报错，只原样保留） */
    sourceSection?: string;
    /** 微目录排序键 */
    order?: number;
    /** 一句话定位（可选，无长度限制；缺省时从正文首个引用块提取，**不另写一遍引用块**） */
    summary?: string;
    /** 额外领域标签（如 线性代数） */
    tags?: string[];
    links?: BlockLinks;
}
export interface BlockDoc extends BlockInput {
    id: string;
}
export interface ValidateResult {
    errors: string[];
    warnings: string[];
}
/** `YYYYMMDDHHmm_xxxxxx`（6 位 hex 后缀；ID 是关联锚点，4 位碰撞概率不可忽略） */
export declare function generateId(now?: Date): string;
/** 本地时区的 `YYYY-MM-DD`（与 generateId 同源；勿用 toISOString——UTC 会把凌晨会话日期算到前一天） */
export declare function todayLocal(now?: Date): string;
/**
 * 校验 `简介`（可选键）：**没有长度上限**（旧 `DEFINITION_MAX` 已删除，需求 R7）。
 * 只拒绝换行——那是渲染层的正确性要求，不是内容约束。
 */
export declare function validateSummary(summary: string): ValidateResult;
export declare function validateBlock(input: BlockInput): ValidateResult;
export interface MetadataUpdate {
    sourceSection?: string;
    status?: string;
}
/**
 * 只更新 frontmatter 中的明确字段，保留键顺序、未知键、换行风格和正文字节。
 */
export declare function applyMetadataUpdate(raw: string, patch: MetadataUpdate): string;
/**
 * 渲染整篇笔记：
 * frontmatter → 一句话定位（裸 `>` 引用块，可选）→ 正文 → 关联小节。
 * 不加尾部标签；键序由 `renderFrontmatter` 固定。
 *
 * **引用块不重复写两遍**：只有显式传了 `summary` 才前置引用块；缺省时 `简介`
 * 从正文首个引用块提取（`extractDefinition`），那一段本身就是正文的一行定位，
 * 再前置一遍就会让同一句话连着出现两次（2026-09-15 真机检查实测 4 篇全中）。
 */
export declare function renderNote(doc: BlockDoc): string;
export type UpdateAction = 'append' | 'replace' | 'definition';
export interface UpdatePayload {
    action: UpdateAction;
    /** append 追加的 Markdown 内容 */
    changes?: string;
    /** append 的追加位置：`### <section>` 标题；缺省追加到正文末尾 */
    section?: string;
    /** definition：新的一句话定位（只替换正文首个引用块） */
    summary?: string;
    /** replace 的新正文（id 沿用旧块；旧正文由调用方先存档） */
    block?: Omit<BlockInput, 'id'>;
}
export interface UpdateResult {
    text: string;
    warnings: string[];
}
/**
 * 在正文的小节内追加内容：命中 `### <section>` 时插到该小节正文末尾，
 * 找不到该小节时**新建小节**（比静默追加到末尾更符合"补充到对应位置"的意图）。
 */
export declare function appendToSection(body: string, section: string, changes: string): string;
/**
 * 增量更新。**不再有"版本更新/勘误"块**（需求 R23）：旧内容由调用方先写进
 * `.study/archive/`，正文只保留最新版。
 *
 * - `append`：补充内容（可指定小节），旧内容天然保留；
 * - `replace`：整体替换（旧正文已存档），返回新渲染的全文；
 * - `definition`：字段级微调，只替换正文首个引用块，不算知识更新。
 */
export declare function applyUpdate(raw: string, id: string, payload: UpdatePayload): UpdateResult;
/** 关联行标签（wikilink 场景下只用于人类可读的粗标签） */
export type LinkKind = 'prev' | 'next' | 'sibling';
export declare const LINK_LABELS: Record<LinkKind, string>;
/**
 * 反向关系：`prev` ↔ `next`；`sibling` 两侧同向。
 * `note_link` 用它决定对端写哪一行（双向关联，需求 F7）。
 */
export declare function inverseKind(kind: LinkKind): LinkKind;
/**
 * wikilink 目标清洗：`[` `]` `#` `|` `^` 会截断链接
 * （SEC-3：文件名含 `]]` 时 `[[A]]B]]` 在 Obsidian 里点不开）。
 */
export declare function wikilinkTarget(name: string): string;
/** 由文件名生成 wikilink 目标（去 `.md` 并清洗） */
export declare function wikilinkOf(fileName: string): string;
/** 在正文中找「关联」小节的起始下标（找不到返回 -1） */
export declare function findLinksSectionStart(body: string): number;
export interface LinkLineHit {
    kind: LinkKind;
    target: string;
}
/** 解析一行关联行：`- 前置：[[目标]]` → `{ kind, target }`；不是关联行返回 null */
export declare function parseLinkLine(line: string): LinkLineHit | null;
