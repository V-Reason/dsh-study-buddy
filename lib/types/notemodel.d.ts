/**
 * 笔记文档模型：把一篇笔记正文视为「有序小节序列」，而不是一整块字符串。
 *
 * 沿用 2026-09 框架重设计的段落模型地基：版本块插入、块抹除、关联重写、
 * lint 的"小节存在性"判定都基于同一套模型，避免每加一条规则就动一处字符串拼接。
 * 纯文本变换，不碰文件系统。
 * @module notemodel
 */
/** 一个 `#`~`######` 小节（含正文，不含标题行） */
export interface DocSection {
    /** 井号数量（1~6） */
    level: number;
    /** 标题文本（已 trim，不含井号） */
    title: string;
    /** 小节正文（不含标题行；行尾空白已裁掉） */
    body: string;
    /** 标题行在输入文本中的起始下标 */
    start: number;
    /** 小节结束下标（下一个标题行之前，或文本末尾） */
    end: number;
}
/**
 * 单行字段收敛：**只把换行折成一个空格**（SEC-1）。
 *
 * 用途是**渲染兜底**：frontmatter 标量、`简介`、关联行里出现换行时，会让
 * `parseFrontmatter` 的非贪婪正则在注入的 `---` 处提前闭合，导致后半段元数据
 * 静默降级为正文（索引/lint/改名全部依据错）。校验层仍会拒绝换行（fail-loud），
 * 本函数是纵深防御，不替代校验。
 *
 * 不压缩连续空格（N12）：`C++  STL` 是**合法输入**，静默改写等于"用户看到的
 * 标题与磁盘上的不是同一个"。需要压空白的场景各自显式处理
 * （`sanitizeFilename` 压文件名、wikilink 目标压空白）。
 */
export declare function inlineText(value: unknown): string;
export interface SplitBody {
    /** 首个标题之前的引言（一句话定位引用块等） */
    lead: string;
    sections: DocSection[];
}
/**
 * 切分正文为有序小节。标题之前的引言保留在 `lead`；
 * `renderSections(splitSections(x))` 与原文本语义等价（只归一化空行）。
 */
export declare function splitSections(body: string): SplitBody;
/** 渲染小节序列为 Markdown 正文（lead 与小节之间、小节之间以空行分隔） */
export declare function renderSections(lead: string, sections: DocSection[]): string;
/**
 * 小节标题匹配：精确相等，或以 `title` 开头且紧跟括号/冒号/破折号
 * （允许 `### 关联（前置）` 这类变体）。说明性后缀不算新小节——
 * 这是存量笔记格式漂移的兼容口径。
 */
export declare function matchesTitle(heading: string, title: string): boolean;
/** 取首个匹配的小节 */
export declare function findSection(sections: DocSection[], title: string): DocSection | undefined;
/**
 * 兼容别名：`CardSection` 是 2026-09「卡片」时代的名字，重构期保留以便分批迁移；
 * 全部调用点迁到 `DocSection` 后删除（阶段 6 清理）。
 */
export type CardSection = DocSection;
/** 是否存在匹配的小节 */
export declare function hasSection(sections: DocSection[], title: string): boolean;
/**
 * 构造「下标 → 行号（1 基）」查询函数（PERF-4）。
 *
 * 旧写法 `text.slice(0, index).split('\n').length` 对每个小节都做一次
 * 前缀切片 + split，整篇成本 ≈ 正文长度 × 小节数（批量 lint 时放大）。
 * 这里预计算一次换行位置并二分查找，纯函数、可复用。
 */
export declare function makeLineOf(text: string): (index: number) => number;
/**
 * 在小节 `beforeTitle` 之前插入一段原始 Markdown；
 * 找不到该小节时追加到正文末尾。段落两侧空行归一化，不产生连续空行。
 */
export declare function insertBlockBefore(body: string, block: string, beforeTitle?: string): string;
/** 从 Markdown 中提取 fenced code block 的语言标注（空串 = 未标语言） */
export declare function codeFenceLanguages(body: string): string[];
/** 编号/项目列表项数量（`1.` / `1)` / `- ` / `* ` / `+ `）。
 *  迁移期保留（模板类 lint 规则仍引用），阶段 6 随 `template.ts` 删除。 */
export declare function countListItems(body: string): number;
/** 阶梯式解剖层号：返回出现的层号（去重升序）。
 *  迁移期保留（模板类 lint 规则仍引用），阶段 6 随 `template.ts` 删除。 */
export declare function layerNumbers(body: string): number[];
/**
 * 用空行替换 fenced code block 与 `<details>` 折叠块的内容（保留行号），
 * 供"只扫正文"的规则（会话残留）使用，避免代码/历史块误伤。
 */
export declare function blankOutBlocks(body: string): string;
