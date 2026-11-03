/**
 * 笔记可发现性审计：找缺来源章节、缺微目录、孤立、断链、歧义链接和重复标题。
 *
 * 审计只返回问题，不修改文件。链接与正文只在这里读取一次，避免把全库正文
 * 常驻进检索索引。
 * @module discoverability
 */
import type { NoteKind } from './search.ts';
export type DiscoverabilityIssueKind = 'missing-source-section' | 'invalid-source-section' | 'missing-toc' | 'orphan' | 'broken-link' | 'ambiguous-link' | 'duplicate-title';
export interface DiscoverabilityNote {
    rel: string;
    title: string;
    kind: NoteKind;
    sourceSection: string | null;
    body: string;
}
export interface DiscoverabilityIssue {
    kind: DiscoverabilityIssueKind;
    severity: 'error' | 'warn' | 'info';
    title: string;
    rel: string;
    message: string;
    suggestion: string;
}
export interface DiscoverabilityReport {
    scope: string;
    total: number;
    legacy: number;
    oldNotes: number;
    issues: DiscoverabilityIssue[];
}
export interface DiscoverabilityOptions {
    /** vault 内相对目录；`.` / 空串表示全库 */
    path?: string;
}
export declare function wikilinkTargets(body: string): string[];
export declare function auditDiscoverability(notes: DiscoverabilityNote[], tocDirs: string[], opts?: DiscoverabilityOptions): DiscoverabilityReport;
export declare function formatDiscoverability(report: DiscoverabilityReport, limit?: number): string;
