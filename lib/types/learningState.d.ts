/**
 * 主题学习足迹：`<vault>/.study/learning.json`。
 *
 * 只记录“何时实质接触过哪个主题”，不复制笔记正文。主题数设硬上限，
 * 防止长期使用后状态文件无限增长。
 * @module learningState
 */
import type { ContactKind, StudyMode } from './studyMode.ts';
export declare const LEARNING_STATE_VERSION = 1;
export declare const MAX_LEARNING_TOPICS = 2000;
export interface TopicFootprint {
    label: string;
    lastContactAt: string;
    lastMode: StudyMode;
    contactCount: number;
    relatedNotes: string[];
}
export interface LearningState {
    version: typeof LEARNING_STATE_VERSION;
    topics: Record<string, TopicFootprint>;
}
export interface TouchLearningInput {
    topic: string;
    kind: ContactKind;
    mode: StudyMode;
    relatedNotes?: string[];
    now?: Date;
}
export declare function emptyLearningState(): LearningState;
/**
 * 主题标识只做确定性文本归一，不做语义合并。
 * 调用方应使用同一标题或用户确认后的规范主题名，避免近义词各记一条。
 */
export declare function normalizeTopicKey(topic: string): string;
export declare function readLearningState(file: string): Promise<LearningState>;
export declare function writeLearningState(file: string, state: LearningState): Promise<void>;
/**
 * 形成新的足迹状态；不修改入参。
 *
 * 所有五种实质接触都会刷新时间并递增计数。`kind` 在此参与输入校验，
 * 具体类型保留在调用边界，不复制进长期状态。
 */
export declare function touchLearningState(state: LearningState, input: TouchLearningInput): LearningState;
