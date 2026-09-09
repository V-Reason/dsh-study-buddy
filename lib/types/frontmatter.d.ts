/**
 * 极简 YAML frontmatter 解析/生成：只支持标量 `key: value` 行，
 * 覆盖原子卡片的 ID/标题/领域/来源/状态 五字段。解析失败不吞——
 * 调用方按"无 frontmatter"降级索引并标记。
 * @module frontmatter
 */
export interface CardMeta {
    id?: string;
    title?: string;
    domain?: string;
    source?: string;
    status?: string;
    /** 模板类型（理论型/工程型/对比型，2026-09 新增，可选） */
    template?: string;
}
export interface ParsedNote {
    /** 解析出的标量 meta；文件以 `---` 开头但字段为空时是空对象，无 frontmatter 时为 null */
    meta: CardMeta | null;
    /** frontmatter 之后的正文字段 */
    body: string;
    /** 原始全文 */
    raw: string;
}
export declare function parseFrontmatter(raw: string): ParsedNote;
/**
 * 渲染 frontmatter。每个值都过 `inlineText`（SEC-1）：标题/来源里混入换行时
 * 会把 `key: value` 截成两行，`parseFrontmatter` 的非贪婪正则在注入的 `---`
 * 处提前闭合，后半段元数据静默降级为正文。校验层会拒绝换行，这里是兜底。
 */
export declare function renderFrontmatter(meta: CardMeta): string;
/**
 * 从正文提取一句话概念，按格式优先级：
 * 1. `> 概念:` 块引用（旧笔记约定）；
 * 2. `### 定义` 小节下的首行引用（旧卡片格式）；
 * 3. 正文首个裸 `> ` 引用块（v0.3.0 定稿格式：renderCard 输出，
 *    frontmatter 后第一行即一句话定义）。
 */
export declare function extractDefinition(body: string): string | null;
/** 正文首个一级标题；没有则 null */
export declare function firstHeading(body: string): string | null;
