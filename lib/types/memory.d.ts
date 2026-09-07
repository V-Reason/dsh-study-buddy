/**
 * 跨会话记忆：vault `.study/memory.json`，键值笔记 + 保留键 `lastSummary`
 * （上次会话小结）。与 progress.json（临时进度位置）相互独立——
 * "清空进度"不触碰记忆，彻底重来才 study_memory(clear)。
 * @module memory
 */
/** 单条记忆值的长度上限（字符） */
export declare const MAX_MEMORY_VALUE = 4000;
/** 记忆键名长度上限（字符） */
export declare const MAX_MEMORY_KEY = 64;
/** 保留键：上次会话小结（get 时置顶显示） */
export declare const SUMMARY_KEY = "lastSummary";
/** 保留控制键：自迭代记忆开关（on/off，缺省关闭）。「_」前缀键为控制键，不参与普通计数。 */
export declare const AUTO_PREFS_KEY = "_autoPrefs";
/** 自迭代开关的合法值 */
export declare const AUTO_PREFS_VALUES: readonly ["on", "off"];
/** 自迭代开关的缺省值（键不存在即视为该值） */
export declare const AUTO_PREFS_DEFAULT = "off";
export interface MemoryState {
    notes: Record<string, string>;
    updatedAt?: string;
}
export declare function readMemory(file: string): Promise<MemoryState>;
export declare function writeMemory(file: string, state: MemoryState): Promise<void>;
/** 校验并规范化记忆键名：trim 后非空、≤64 字符、不含控制字符 */
export declare function normalizeMemoryKey(key: string): string;
/** 校验记忆值：字符串且 ≤4000 字符 */
export declare function checkMemoryValue(value: string): string;
export interface StaleProgressHit {
    key: string;
    snippet: string;
}
/**
 * 检测记忆中疑似过期的进度句（进度位置应单一来源 study_progress；
 * prefs.* 只存偏好/惯例）。返回命中键与片段（≤3 条）。
 */
export declare function findProgressSentences(notes: Record<string, string>): StaleProgressHit[];
/** 是否为保留控制键（「_」前缀）；控制键由插件维护，不计入普通记忆条数 */
export declare function isControlKey(key: string): boolean;
/** 校验自迭代开关值：trim 后必须为 on/off */
export declare function normalizeAutoPrefsValue(value: string): string;
/** 格式化开关状态行（供 get 单键与 formatMemory 复用） */
export declare function formatAutoPrefs(value: string | undefined): string;
/** 格式化整份记忆：开关状态行置顶（如有），lastSummary 置顶为"上次小结"，其余键按名排序 */
export declare function formatMemory(state: MemoryState): string;
