export interface MermaidIssue {
    line: number;
    message: string;
}
export interface MermaidValidation {
    issues: MermaidIssue[];
    warning?: string;
}
/**
 * 提取并逐张校验 Mermaid；行号指向 fenced block 的 opener。
 *
 * 解析器不可用时返回可见 warning，让调用方明确知道门禁没有执行；不能把加载失败
 * 静默当作"没有语法问题"。
 */
export declare function validateMermaidReport(body: string): Promise<MermaidValidation>;
/** 兼容只需问题列表的调用方。 */
export declare function validateMermaid(body: string): Promise<MermaidIssue[]>;
