export interface MermaidIssue {
    line: number;
    message: string;
}
/** 提取并逐张校验 Mermaid；行号指向 fenced block 的 opener。 */
export declare function validateMermaid(body: string): Promise<MermaidIssue[]>;
