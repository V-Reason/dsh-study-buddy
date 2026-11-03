/**
 * 学习讲解模式：根据相关笔记、主题接触时间和用户覆盖选择快速或详细。
 *
 * 纯函数模块，不读写文件。无法确定时一律选择完整讲解，避免把陌生知识
 * 误当成“已经学过”而压缩掉必要机理。
 * @module studyMode
 */
export type StudyMode = 'quick' | 'full';
export type StudyModeOverride = StudyMode | 'auto';
export type ContactKind = 'lecture' | 'qa' | 'note-read' | 'note-write' | 'review';
export type StudyIntent = 'direct' | 'refresh' | 'learn' | 'apply' | 'debug' | 'compare';
export type StudyScope = 'single' | 'concept' | 'system';
export interface StudyModeArgs {
    topic?: string;
    mode?: StudyModeOverride;
    kind?: ContactKind;
    relatedNotes?: string[];
    intent?: StudyIntent;
    scope?: StudyScope;
}
export interface ModeInput {
    override?: StudyModeOverride;
    hasRelatedNote: boolean;
    lastContactAt?: string;
    windowDays?: number;
    intent?: StudyIntent;
    scope?: StudyScope;
    now?: Date;
}
export interface ModeDecision {
    mode: StudyMode;
    reason: 'override' | 'direct' | 'intent' | 'no-note' | 'no-contact' | 'recent' | 'stale';
    ageDays: number | null;
}
export declare const DEFAULT_MODE_WINDOW_DAYS = 30;
export declare const MAX_MODE_WINDOW_DAYS = 3650;
/** 把外部输入归一为工具支持的三档覆盖值。 */
export declare function normalizeStudyMode(value: unknown): StudyModeOverride;
export declare function normalizeStudyIntent(value: unknown): StudyIntent | undefined;
export declare function normalizeStudyScope(value: unknown): StudyScope | undefined;
/** 从《笔记期望.md》读取可选的复习窗口，缺失或越界时使用 30 天。 */
export declare function parseModeWindowDays(expectText: string): number;
/**
 * 选择讲解模式。
 *
 * 优先级：用户覆盖 > 直答/学习意图 > 系统范围 > 笔记证据 > 复习窗口。
 * “30 天以内”包含第 30 天；从第 31 天起退回完整讲解。
 */
export declare function resolveStudyMode(input: ModeInput): ModeDecision;
