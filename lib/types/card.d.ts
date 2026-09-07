/**
 * 原子卡片：ID 生成、校验、渲染、增量更新组装、关联卡片维护、MOC 组装。
 * 纯文本变换（不碰文件系统），便于单元测试。
 * @module card
 */
export declare const VALID_STATUS: readonly ["草稿", "已确认", "需更新"];
/** 阶梯式解剖模板必需小节（缺失出 warning 提示，不阻塞落盘；硬强制在 persona/归档清单） */
export declare const TEMPLATE_SECTIONS: readonly [{
    readonly title: "核心思想";
    readonly hint: "一句话讲清 + 为什么重要 + 记忆锚点";
}, {
    readonly title: "阶梯式解剖";
    readonly hint: "第 1 层直觉 → 第 2 层机制 → 第 3 层细节推导 → 第 4 层边界反例";
}, {
    readonly title: "实例走查";
    readonly hint: "代入具体数字/代码逐步走完";
}, {
    readonly title: "易错点";
    readonly hint: "坑 + 为什么错";
}, {
    readonly title: "自测题";
    readonly hint: "2~3 题，先答再看答案";
}];
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
/** `YYYYMMDDHHmm_xxxx`（hex 后缀，恒为 [0-9a-f]） */
export declare function generateId(now?: Date): string;
/** 本地时区的 `YYYY-MM-DD`（与 generateId 同源；勿用 toISOString——UTC 会把凌晨会话日期算到前一天） */
export declare function todayLocal(now?: Date): string;
/** 一句话定义：≤30 字最佳；31~60 字允许放行（等级化提示）；>60 字硬拒绝 */
export declare const DEFINITION_TARGET = 30;
export declare const DEFINITION_MAX = 60;
/** 校验单条一句话定义（validateCard 与 card_update definition 模式共用） */
export declare function validateDefinition(definition: string): ValidateResult;
export declare function validateCard(input: CardInput): ValidateResult;
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
/**
 * 在卡片正文维护关联卡片：新增 `- 标签：目标` 行；目标已存在则跳过。保留原 frontmatter。
 * 去重规则：有 targetId 时按 `（ID）` 判重（标题变更后仍能识别已关联）；
 * 旧笔记无 ID 时回退为按目标标签文本判重。
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
