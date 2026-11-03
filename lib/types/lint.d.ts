/**
 * lint 引擎（2026-10 瘦身版）：规则注册表 + 报告渲染。
 *
 * 相对 2026-09 版本，本轮删掉了**全部模板类规则**（必填小节 / 主干线 / 重入点 /
 * 验证实验 / 排障判据 / 层级序号 / 自测题答案 / 关联块格式 / 领域标签 / 定义长度），
 * 并**废弃 100 分制**（架构选型 A9）：
 * 分值那套记分法建立在"模板缺节扣 5 分"之上，模板退场后分值不再可比，留着只会误导。
 * 现在报告的是**问题清单 + 严重级**，用户看得到"有什么问题"而不是"得了多少分"。
 *
 * 保留的三条通用规则与内容自由度无关，属数据卫生（架构选型 §6.4）：
 * - `session-residue`：会话残留（本机路径 / 源码行号 / 第二人称 / 会话口吻）
 * - `code-language`：未标语言的代码块
 * - `external-resource`：正文引用外部资源（Obsidian 打开会主动外联）
 *
 * 外加一条**由期望文件驱动**的 `expect-rule`：用户在《笔记期望.md》里写
 * `- [检查] 禁止 <内容>` 才启用。这样"检查什么"也是热配置，而不是写死在代码里。
 * @module lint
 */
import { type DocSection } from './notemodel.ts';
export type Severity = 'error' | 'warn' | 'info';
export interface LintFinding {
    /** 规则 id（稳定，供 rule 过滤与统计） */
    rule: string;
    severity: Severity;
    /** 规则中文名 */
    title: string;
    message: string;
    /** 行号（1 基；0 = 不适用） */
    line: number;
    /** 命中片段 */
    excerpt?: string;
    suggestion?: string;
}
export interface LintReport {
    title: string;
    /** `block` = 有 ID 且有来源章节；`legacy` = 有 ID；`note` = 旧笔记（无 ID） */
    kind: 'block' | 'legacy' | 'note';
    /** 正文实际字数（不含代码块与折叠块） */
    chars: number;
    findings: LintFinding[];
    /** 每条**已执行**规则是否通过（规则 id → 通过）；被禁用/未执行时不含该键 */
    passed: Record<string, boolean>;
    /** 本次**未执行**的规则中文名（报告不得把它当成"通过"，N7） */
    notRun: string[];
}
/** 用户写在《笔记期望.md》里的检查项 */
export interface ExpectRule {
    /** 禁止 / 必须 出现的字面内容 */
    pattern: string;
    mode: 'forbid' | 'require';
    severity: Severity;
    reason?: string;
}
export interface LintContext {
    /** 会话残留级别：off 不执行 / warn 警告 / error 错误（默认 warn） */
    residueLevel?: 'off' | 'warn' | 'error';
    /** 关闭的规则 id 列表 */
    rulesOff?: string[];
    kind?: 'block' | 'legacy' | 'note';
    /** 由《笔记期望.md》解析出的检查项（`- [检查] 禁止 xx` / `- [检查] 必须 xx`） */
    expectRules?: ExpectRule[];
}
export interface RuleCtx {
    title: string;
    summary: string;
    body: string;
    sections: DocSection[];
    /** `blankOutBlocks(body)`：只扫正文（代码块与折叠块之外） */
    residueText: string;
    bodyChars: number;
    residueLevel: 'off' | 'warn' | 'error';
    kind: 'block' | 'legacy' | 'note';
    expectRules: ExpectRule[];
}
export interface Rule {
    id: string;
    title: string;
    severity: Severity;
    /** 判定函数；返回空数组 = 通过 */
    run(ctx: RuleCtx): LintFinding[];
}
/** 规则注册表：加一条规则 = 加一个数组元素（工具描述与 ruleIds 自动跟随） */
export declare const RULES: Rule[];
export declare function ruleIds(): string[];
export declare function ruleTitle(id: string): string;
export declare function ruleCatalog(): Array<{
    id: string;
    title: string;
    severity: Severity;
}>;
/** 规则清单渲染（工具描述由它派生，避免与注册表漂移） */
export declare function ruleTable(): string[];
/**
 * 解析《笔记期望.md》里的检查项：
 *
 * ```
 * - [检查] 禁止 本机绝对路径 理由：笔记要能换机器读
 * - [检查] 禁止 🚀 严重：error
 * - [检查] 必须 ## 目录
 * ```
 *
 * 只认这一种明确写法——自由 Markdown 的其它内容不会被误当规则
 * （"能被解析的就不靠自觉"，但也不能靠猜）。
 */
export declare function parseExpectRules(text: string): ExpectRule[];
export declare function lintNote(input: {
    title?: string;
    summary?: string;
    body: string;
    kind?: LintReport['kind'];
}, ctx?: LintContext): LintReport;
export declare function formatReport(report: LintReport): string;
export interface LintBatch {
    total: number;
    noteCount: number;
    legacyCount: number;
    /** 有问题（至少一条 finding）的文档数 */
    problemCount: number;
    /** 按"问题数"的分布桶标签（如 `1~2 条`）与计数 */
    distribution: Array<{
        label: string;
        count: number;
    }>;
    /** 规则命中统计（规则 id → 命中文档数） */
    rules: Array<{
        id: string;
        title: string;
        count: number;
    }>;
    /** 问题最多的文档（降序） */
    worst: Array<{
        title: string;
        count: number;
    }>;
}
/** 分布桶宽（按问题条数） */
export declare const PROBLEM_BUCKET = 2;
export declare function summarizeLint(reports: LintReport[]): LintBatch;
export declare function formatBatch(batch: LintBatch, limit?: number): string;
