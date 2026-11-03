/**
 * 学习简报：把持久化进度整理成计划入口所需的紧凑上下文。
 *
 * 这里只做文本归一与渲染，不推断用户是否完成，也不生成复习提醒。
 * @module studyBrief
 */
import type { ProgressState } from './state.ts';
export declare const MAX_BRIEF_TEXT = 500;
export declare const MAX_PARALLEL_LINES = 10;
export declare const MAX_PARALLEL_CHARS = 200;
export declare function normalizeBriefText(value: string, label: string): string;
export declare function normalizeParallelLines(values: string[] | undefined): string[] | undefined;
export declare function formatStudyBrief(state: ProgressState): string;
