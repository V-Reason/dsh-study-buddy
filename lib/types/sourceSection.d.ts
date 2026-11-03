/**
 * `来源章节` 的语法与归一（架构选型 §4.2）。
 *
 * 它是**覆盖度总览的唯一数据源**：`note_overview` 按「资料 → 章 → 节」聚合，
 * 因此书写口径必须收敛。归一只做**无损归一**——全角/半角、`第 2 章` 与 `第2章`
 * 这类同义写法统一，绝不猜测或补全语义（不虚构章节，需求 R15）。
 *
 * 解析不出来时不报错：条目原文照样存进 `来源章节`，只是进总览的"未归类"，
 * 用户能看到是哪几条需要补。
 * @module sourceSection
 */
export interface SourceRef {
    /** 资料名（`《…》` 内的内容或章节号之前的裸文本） */
    material: string;
    /** 章号（阿拉伯数字；缺失时为空串） */
    chapter: string;
    /** 章标题（章号之后、节号之前） */
    chapterTitle: string;
    /** 节号（`2.1`；缺失时为空串） */
    section: string;
    /** 归一后的完整字符串（原样落进 frontmatter） */
    raw: string;
}
/**
 * 归一 `来源章节`：
 *
 * ```
 * 《计算方法》第 2 章　线性方程组数值解法／2.1 节   →  《计算方法》第2章 线性方程组数值解法 / 2.1节
 * 《算法设计与分析》第6章 动态规划                 →  《算法设计与分析》第6章 动态规划
 * ```
 *
 * 无法识别出「第N章」时：原文折叠空白后返回（`chapter` 等为空），不抛错。
 */
export declare function normalizeSourceSection(input: string): SourceRef;
/** 归一后的字符串；识别不出「第N章」时返回原文折叠结果（保留用户写法） */
export declare function normalizeSourceSectionText(input: string): string;
/** 是否可参与覆盖度聚合（能切出资料名与章号的才算） */
export declare function isSourceRefComplete(ref: SourceRef): boolean;
