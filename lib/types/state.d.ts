/**
 * 学习进度状态：vault `.study/progress.json`，跨会话/跨重启持久。
 * @module state
 */
export interface ProgressState {
    currentMaterial?: string;
    currentSection?: string;
    pendingQuestions?: string[];
    touchedCardIds?: string[];
    /** 当前完整计划文档的笔记引用（路径/标题/ID） */
    planRef?: string;
    /** 当前主阶段，如 `B 3D 数学与流程` */
    phase?: string;
    /** 当前真正应做的下一动作 */
    nextAction?: string;
    /** 该动作的完成判据 */
    doneWhen?: string;
    /** 最近已完成结果 */
    lastOutcome?: string;
    /** 八股/算法/投递等并行线的简短状态 */
    parallelLines?: string[];
    updatedAt?: string;
}
export declare function readProgress(file: string): Promise<ProgressState>;
export declare function writeProgress(file: string, state: ProgressState): Promise<void>;
