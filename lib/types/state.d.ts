/**
 * 学习进度状态：vault `.study/progress.json`，跨会话/跨重启持久。
 * @module state
 */
export interface ProgressState {
    currentMaterial?: string;
    currentSection?: string;
    pendingQuestions?: string[];
    touchedCardIds?: string[];
    updatedAt?: string;
}
export declare function readProgress(file: string): Promise<ProgressState>;
export declare function writeProgress(file: string, state: ProgressState): Promise<void>;
