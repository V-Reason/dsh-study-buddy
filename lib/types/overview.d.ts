/**
 * 覆盖度总览：把一组笔记按 `来源章节` 聚合成「资料 → 章 → 节」的视图。
 *
 * 需求 R15 的口径：**不虚构章节**。完整性基线只由两件事构成——笔记里真实出现
 * 过的章节号，以及用户在《笔记期望.md》里声明的资料；因此这里只做聚合与
 * "跳号提示"，绝不去猜"这门课应该有 9 章"。
 *
 * 无法解析的条目进"未归类"而不是被丢掉：用户能看到是哪几篇需要补 `来源章节`。
 * @module overview
 */
/** 输入：一篇待聚合的笔记（由调用方从目录遍历或索引给出） */
export interface OverviewNote {
    title: string;
    rel: string;
    /** `来源章节` 原文（缺失/无法解析 → 未归类） */
    sourceSection: string | null;
    /** 只有块（有 ID）参与覆盖度；存量卡与旧笔记由调用方过滤或标记 */
    kind: string;
}
export interface OverviewEntry {
    title: string;
    rel: string;
    section: string;
}
export interface OverviewChapter {
    material: string;
    chapter: string;
    chapterTitle: string;
    entries: OverviewEntry[];
    /** 该章出现过的节号（去重升序，按数值） */
    sections: string[];
    /** 节号跳号提示（只提示，不断言资料缺节） */
    gaps: string[];
}
export interface OverviewResult {
    chapters: OverviewChapter[];
    /** 无法归入任何章节的笔记（缺 `来源章节` 或写法解析不出） */
    unclassified: Array<{
        title: string;
        rel: string;
    }>;
    /** 每份资料已记录的章号（升序） */
    materials: Array<{
        material: string;
        chapters: string[];
    }>;
    /** 参与统计的笔记数（不含未归类与旧笔记） */
    counted: number;
}
/**
 * 聚合。
 *
 * @param notes 候选笔记（调用方可先按目录/资料过滤）
 * @param opts.material 只统计某份资料（其余资料不参与，也不进"未归类"）
 */
export declare function summarizeOverview(notes: OverviewNote[], opts?: {
    material?: string;
}): OverviewResult;
/** 渲染成对话可读的报告（工具直接返回它） */
export declare function formatOverview(result: OverviewResult, opts?: {
    scope?: string;
}): string;
