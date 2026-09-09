/**
 * 原子卡片：ID 生成、校验、渲染、增量更新组装、关联卡片维护、MOC 组装。
 * 纯文本变换（不碰文件系统），便于单元测试。
 * @module card
 */
import { type TemplateHints, type TemplateType } from './template.ts';
export declare const VALID_STATUS: readonly ["草稿", "已确认", "需更新"];
export interface CardLinks {
    prev?: string[];
    next?: string[];
    conflict?: string[];
}
export interface CardInput {
    title: string;
    /** 领域键（目录映射表的主键，也作为 frontmatter 领域标签写入） */
    domain: string;
    source: string;
    status: string;
    /** 一句话定义，≤30 字 */
    definition: string;
    /** 核心内容 Markdown */
    content: string;
    /** 模板类型：理论型/工程型/对比型；缺省按领域与标题自动推断 */
    template?: string;
    /** 额外中文领域标签（如 线性代数） */
    tags?: string[];
    links?: CardLinks;
}
export interface CardDoc extends CardInput {
    id: string;
}
export interface ValidateResult {
    errors: string[];
    warnings: string[];
}
/** `YYYYMMDDHHmm_xxxxxx`（6 位 hex 后缀，恒为 [0-9a-f]；ID 是关联锚点，4 位碰撞概率不可忽略） */
export declare function generateId(now?: Date): string;
/** 本地时区的 `YYYY-MM-DD`（与 generateId 同源；勿用 toISOString——UTC 会把凌晨会话日期算到前一天） */
export declare function todayLocal(now?: Date): string;
/** 一句话定义：≤30 字最佳；31~60 字允许放行（等级化提示）；>60 字硬拒绝 */
export declare const DEFINITION_TARGET = 30;
export declare const DEFINITION_MAX = 60;
/** 校验单条一句话定义（validateCard 与 card_update definition 模式共用） */
export declare function validateDefinition(definition: string): ValidateResult;
export interface ValidateOptions {
    /** 已解析的模板类型（缺省按 domain/title 推断） */
    template?: string;
    /** domainFolders[domain] 的落盘目录，用于按领域族推断模板 */
    mappedFolder?: string;
    /** 模板推断提示词表（config.templateHints） */
    hints?: TemplateHints;
}
/** 解析卡片模板：显式声明优先（非法值报错），否则按领域与标题推断 */
export declare function resolveTemplate(input: {
    title?: string;
    domain?: string;
    template?: string;
}, opts?: ValidateOptions): {
    type: TemplateType;
    error?: string;
};
export declare function validateCard(input: CardInput, opts?: ValidateOptions): ValidateResult;
/**
 * 渲染整卡 Markdown（用户定稿格式）：
 * frontmatter 后空一行 → 一句话定义（裸 > 引用块）→ 自由 ### 小节正文
 * → 关联卡片（前置/后续/易混淆）。不加尾部标签。
 */
export declare function renderCard(card: CardDoc): string;
export type UpdateMode = 'append-version' | 'errata' | 'definition' | 'replace';
export interface UpdatePayload {
    mode: UpdateMode;
    /** append-version / errata 追加的 Markdown 内容 */
    changes?: string;
    /** append-version 的更新来源 */
    source?: string;
    /** definition 模式：新的一句话定义（只替换定义，不产生历史折叠） */
    definition?: string;
    /** replace 模式的新卡内容（id 沿用旧卡） */
    card?: Omit<CardInput, 'id'>;
    /** replace 模式：domainFolders 映射出的落盘目录（用于模板推断） */
    mappedFolder?: string;
    /** replace 模式：模板推断提示词表（config.templateHints） */
    hints?: TemplateHints;
}
export interface UpdateResult {
    text: string;
    warnings: string[];
}
/**
 * 增量更新：append-version / errata 保留旧内容并追加章节；
 * definition 只替换一句话定义（字段级微调，不产生历史折叠，不算知识更新）；
 * replace 整卡替换但把旧正文压入"历史版本"折叠块。
 */
export declare function applyUpdate(raw: string, id: string, payload: UpdatePayload): UpdateResult;
/**
 * 剥离 MOC 标题开头的日期前缀（`YYYY-MM-DD_` / `YYYY-MM-DD ` 等）：
 * 旧惯例把完整日期写进 title，而 card_moc 会自动加日期前缀 → 双前缀。
 * 工具侧保证"title 只传主题"，本函数做兜底归一。
 */
export declare function stripMocDatePrefix(title: string): string;
export type LinkKind = 'prev' | 'next' | 'conflict';
/** 关联目标：从展示标签里剥出标题（去掉尾部 `（ID）` / `（路径.md）` 与反引号） */
export declare function linkTargetTitle(label: string): string;
/** 关联目标：从展示标签里剥出 ID / 路径锚点（无则空串） */
export declare function linkTargetId(label: string): string;
/**
 * 归一关联行标签：`标题（ID）` → `` `标题`（ID） ``（P0-6）。
 * 标题已带反引号时保持原样；标题含反引号时跳过归一（避免破坏内容）。
 */
export declare function normalizeLinkLabel(label: string): string;
/**
 * 在卡片正文维护关联卡片：新增 `- 标签：目标` 行。
 *
 * 判重范围**限定在「关联卡片」小节内**（BIZ-6）：旧实现扫全正文的 `-` 行，
 * 卡片「前置检查」小节里的 `- 前置：甲` 会被当成"已关联"，静默跳过真实关联
 * 却报告"已建立关联"。小节不存在时视为无重复。
 *
 * 去重规则（P0-6）：**标题或 ID 任一命中即跳过**——既覆盖"标题改了但 ID 未变"
 * （按 ID 判重），也覆盖"标题相同但没写 ID / ID 写错"（按标题判重）。
 * 保留原 frontmatter。
 */
export declare function addLink(raw: string, kind: LinkKind, targetLabel: string, targetId?: string): string;
export interface MocEntry {
    id: string;
    title: string;
    domain: string;
    fileName: string;
}
/** 生成 MOC Markdown：按领域分组 + Obsidian wikilink */
export declare function renderMoc(title: string, date: string, entries: MocEntry[]): string;
