/**
 * lint 判定函数（纯函数）+ 共享正则常量。
 *
 * 2026-10 瘦身：模板类判定（小节齐备度 / 层级序号 / 自测题 / 领域标签 / 关联块格式）
 * 随三型模板一起删除（需求 R6）。保留的都是**与内容自由度无关**的数据卫生判定：
 * 会话残留、代码块语言、外部资源、正文字数。
 *
 * 规则集中在这里的目的不变：
 * 1. 代码与文档同源——技能/期望文件里写的口径就是这里的常量；
 * 2. 误伤控制显式化（白名单、代码块与折叠块跳过），可被单测钉住；
 * 3. 新增判定只改本文件，lint 引擎与工具描述自动跟随。
 * @module lintrules
 */
/** 会话残留：文件路径（`.md` 引用不算——笔记互引是合法内容） */
export declare const RESIDUE_PATH_RE: RegExp;
/** 会话残留：源码行号（需紧跟文件名或成 `L35-55` 区间；`L0/L1/L2` 球谐带白名单） */
export declare const RESIDUE_LINE_RE: RegExp;
/** 会话残留：第二人称 */
export declare const RESIDUE_PERSON_RE: RegExp;
/** 会话残留：会话相对时间词（`今天` 可作口语化定义，不在此列） */
export declare const RESIDUE_TIME_RE: RegExp;
/** 会话残留：阶段/里程碑代号 */
export declare const RESIDUE_PHASE_RE: RegExp;
/**
 * 会话残留：会话口吻词。
 * 2026-09 审查后移除 `实测`（BIZ-11i）：工程笔记里"实测帧率 60fps"是正常表述，
 * 真正要抓的是"本工程实测"里的 `本工程`，`实测` 单独出现误报率过高。
 */
export declare const RESIDUE_SESSION_RE: RegExp;
/** 行号白名单：球谐带 / 正则化 / LOD 等专有记号 */
export declare const LINE_WHITELIST_RE: RegExp;
/** 讲义/章节引用白名单（`GAMES101 L15`、`第 15 讲`）——是出处，不是会话残留 */
export declare const LECTURE_REF_RE: RegExp;
/** 外部资源引用（SEC-7）：Obsidian 打开笔记时会主动外联（信标/跟踪面） */
export declare const EXTERNAL_RESOURCE_RE: RegExp;
export interface ResidueHit {
    rule: 'path' | 'line' | 'person' | 'time' | 'phase' | 'session';
    line: number;
    excerpt: string;
    suggestion: string;
}
/**
 * 扫描会话残留。
 *
 * 误伤控制（用真实 vault 223 篇校准，误伤代价高于漏报）：
 * ① 只扫代码块与 `<details>` 折叠块**之外**的正文（`blanked` 可传入已算好的结果）；
 * ② 白名单优先：`L0/L1/L2`、`LOD`、讲义/章节引用（`GAMES101 L15`、`第 15 讲`）；
 * ③ 行号只在"紧邻文件名"或"成区间"时才报；
 * ④ `M1/M2/M3` 默认不报。
 */
export declare function scanResidue(body: string, opts?: {
    blanked?: string;
}): ResidueHit[];
export interface CodeFenceCheck {
    total: number;
    unlabeled: number;
    /** 未标语言的代码块序号（1 基，**不是行号**） */
    unlabeledIndexes: number[];
}
/** 代码块语言标注检查 */
export declare function checkCodeFences(body: string): CodeFenceCheck;
export interface ExternalResourceHit {
    line: number;
    excerpt: string;
}
/** 外部资源引用检查（SEC-7）：Obsidian 渲染 HTML 时会主动外联（信标/跟踪） */
export declare function checkExternalResources(body: string): ExternalResourceHit[];
/** 正文实际字数（不含 frontmatter、代码块与折叠块；`blanked` 可复用已算好的结果） */
export declare function bodyLength(body: string, blanked?: string): number;
