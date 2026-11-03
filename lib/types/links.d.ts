/**
 * 关联维护：把「关联」小节里的 `- 前置/后续/兄弟：[[目标]]` 行做增删与判重。
 *
 * 2026-10 变化（相对旧的 `card.ts` 关联实现）：
 * - **落盘改为 Obsidian wikilink**（需求 R16）：`[[目标]]` 而非 `` `标题`（ID） ``。
 *   这样笔记在 Obsidian 里可点、路径/标题改名后由 `note_rename` 统一改写。
 * - 判重范围仍是「关联」小节内（沿用旧口径的教训）：扫全正文会把正文里
 *   恰好以 `- 前置：` 开头的行误判成"已关联"，从而静默跳过真实关联。
 * - `kind` 由 `prev/next/conflict` 改为 `prev/next/sibling`（兄弟关系替代易混淆，
 *   语义更贴"同主题内的相邻块"）。
 * @module links
 */
import { type LinkKind } from './note.ts';
export type { LinkKind };
/** 展示标签 → wikilink 目标（去 `.md`、去掉 `（ID）` 后缀、清洗非法字符） */
export declare function linkTargetOf(label: string): string;
/** 从一行关联行里取 wikilink 目标（`- 前置：[[目标]]` → `目标`） */
export declare function parseLinkTarget(line: string): string | null;
/**
 * 在某篇笔记正文里加一条关联（**不改 frontmatter，不写盘**）。
 *
 * 返回原文表示"已存在或无需改动"（判重命中），调用方据此报告"未改动"。
 */
export declare function addLink(raw: string, kind: LinkKind, targetLabel: string): string;
/** 移除一条关联；目标不存在时返回原文 */
export declare function removeLink(raw: string, targetLabel: string): string;
export interface LinkLine {
    kind: LinkKind | 'conflict';
    target: string;
    line: number;
}
/** 列出正文里的全部关联行（供 `note_link` 报告与去重检查） */
export declare function listLinks(body: string): LinkLine[];
/** 把 frontmatter 的标题替换为新标题，其余字段与正文原样保留（标题收敛为单行，SEC-1） */
export declare function replaceNoteTitle(raw: string, newTitle: string): string;
/** 从原始文本提取卡片标题（frontmatter 优先，回退正文一级标题） */
export declare function noteTitleOf(raw: string): string;
export interface LinkRewrite {
    text: string;
    /** 被改写的行数 */
    changed: number;
    /** 改写前的行样本（最多 3 条，供 dryRun 报告） */
    samples: string[];
}
/**
 * 重写「关联」小节里指向目标笔记的行（2026-10：关联改为 wikilink 格式）：
 * - wikilink：`- 前置：[[旧标题]]` → `- 前置：[[新标题]]`（按字面量替换）；
 * - 旧格式（迁移期兼容）：`- 前置：`旧标题`（ID）` —— 有 ID 时按 `（ID）` 锚点命中。
 * 只动以 `-` 开头且落在关联小节内的行，避免误改正文引用。
 */
export declare function rewriteLinkLines(body: string, opts: {
    oldTitle: string;
    newTitle: string;
    targetId?: string;
}): LinkRewrite;
/**
 * 重写 Obsidian wikilink（MOC 用文件名建链）：
 * `[[旧名]]` / `[[旧名|别名]]` / `[[旧名#标题]]` → 新文件名。
 */
export declare function rewriteWikilinks(body: string, oldBase: string, newBase: string): LinkRewrite;
export interface BrokenLinkHit {
    /** 行号（1 基） */
    line: number;
    text: string;
    reason: string;
}
/**
 * 断链检测（改名后调用）：在关联卡片小节里找
 * ① 仍指向旧标题且没有 ID 锚点的行（改名没同步到）；
 * ② 格式可疑（既不是 `- 标签：…` 也不像路径）的行（`checkFormat: false` 时跳过，
 *    用于"改别的文件时只关心本次改名相关的断链"，避免无关格式噪声）。
 * 注意：不带 `（ID）` 的关联行是合法的（旧笔记用路径寻址），不据此判为断链。
 */
export declare function detectBrokenLinks(body: string, opts?: {
    oldTitle: string;
    oldId?: string;
    newTitle?: string;
    checkFormat?: boolean;
}): BrokenLinkHit[];
export interface RenamePlanInput {
    /** 卡片当前文件名（含 .md） */
    fileName: string;
    /** frontmatter 旧标题 */
    oldTitle: string;
    newTitle: string;
}
export interface RenamePlan {
    /** 是否同步改文件名（仅当文件名 == 旧标题清洗结果时为真） */
    renameFile: boolean;
    oldBase: string;
    newBase: string;
    reason: string;
}
/**
 * 决定是否同步改文件名。文件名与旧标题脱节时（历史遗留、手动改过名）
 * 保留文件名，只改标题与入链——避免"改标题顺带搬文件"的意外。
 */
export declare function planRename(input: RenamePlanInput): RenamePlan;
/** 渲染改名报告（工具返回用） */
export declare function formatRenameReport(input: {
    id: string;
    oldTitle: string;
    newTitle: string;
    plan: RenamePlan;
    filesChanged: Array<{
        rel: string;
        kind: string;
        changed: number;
        samples: string[];
    }>;
    broken: BrokenLinkHit[];
    dryRun: boolean;
    /** 额外提示（回滚失败、旧文件未删除、跳过文件等） */
    notes?: string[];
}): string;
