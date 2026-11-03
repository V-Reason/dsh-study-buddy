/**
 * 规划存储：vault `.study/plans/<planId>.json`。
 *
 * 这是"文件夹规划"这条硬门禁的凭据（需求 F2 / 架构选型 §4.3）。先规划后落盘，
 * 是为了解决旧模型"笔记被无脑堆进同一目录"的老问题——目录结构由用户在写之前
 * 拍板，而不是由领域键在写之时被动决定。
 *
 * 三条设计约束：
 * - **提案只在对话里**（需求 R11）：vault 里不出现可见的规划文件；这里存的只是
 *   凭据与消费记录，删掉不影响任何笔记。
 * - **凭据可放弃、会过期**：用户改主意 → `abandonPlan`；搁置太久 → `planTtlHours`
 *   之后失效。门禁必须可解，否则一次误操作会把笔记写入永久锁死。
 * - **消费按标题记账**：同一规划里同一个标题只能写一次，防止"边写边改结构"
 *   （写入路径必须在提案范围内，且不能借同一条目反复写不同内容）。
 * @module planstore
 */
/** 规划项：一个待落的块 */
export interface PlanItem {
    title: string;
    /** vault 内相对路径（含文件名） */
    path: string;
    /** 来源章节（`《资料》第N章 标题 / N.N节`），可省略 */
    sourceSection?: string;
    /** 同目录阅读顺序 */
    order?: number;
}
export interface ConsumedItem {
    title: string;
    rel: string;
    at: string;
}
export interface PlanRecord {
    planId: string;
    createdAt: string;
    confirmed: boolean;
    confirmedAt?: string;
    /** 规划根：所有 `items[].path` 必须落在它之下 */
    rootPath: string;
    material?: string;
    notes?: string;
    items: PlanItem[];
    /** 本次规划将新建的目录（仅用于回显与确认，不预创建） */
    createdDirs: string[];
    consumed: ConsumedItem[];
}
/** 默认有效期（小时）：超过则规划失效，必须重新提案 */
export declare const DEFAULT_PLAN_TTL_HOURS = 24;
/**
 * 规划 id：与笔记 ID 同源格式，便于人工核对（`YYYYMMDDHHmm` + 6 位随机）。
 *
 * **每个两位字段都要补零**：`planFileFor` 的校验式要求恰好 12 位时间戳。
 * 只要有一处漏补，00:00~09:59（或每月 1~9 日）生成的 id 就只有 11 位，
 * 同一个 id 传给 confirm / note_write 会被自己的合法性校验拒绝——
 * "凭据刚发出去就读不回来"，正是门禁最该避免的死锁（实测于 23:05，漏的是小时位）。
 */
export declare function generatePlanId(now?: Date): string;
/** `.study/plans/<planId>.json` 的绝对路径（越界或非法 id 即抛错） */
export declare function planFileFor(vaultRoot: string, planId: string, stateDir?: string): string;
/** 宽容读取：文件不存在或损坏返回 `null`（调用方判定"规划无效"，不抛错阻断） */
export declare function readPlan(file: string): Promise<PlanRecord | null>;
export declare function writePlan(file: string, record: PlanRecord): Promise<void>;
export interface CreatePlanInput {
    rootPath: string;
    items: PlanItem[];
    material?: string;
    notes?: string;
    now?: Date;
}
/**
 * 建规划记录（提案即落凭据，但 **`confirmed` 恒为 false**）。
 *
 * 置位只发生在 `notePlan(action=confirm)`：门禁的第二环要求"用户显式拍板"，
 * 而这一步由工具的 confirm 分支完成（覆盖写同一条记录并盖 `confirmedAt`）。
 * 提案与确认是同一条记录的两次写，因此用户改结构时直接重提一次即可。
 */
export declare function buildPlanRecord(input: CreatePlanInput, planId?: string): PlanRecord;
/** 是否已过期（`createdAt` 解析不出时按"未过期"处理：宁可多问一次，不可误判失效） */
export declare function isPlanExpired(record: PlanRecord, ttlHours?: number, now?: Date): boolean;
export interface ConsumeResult {
    ok: boolean;
    /** 失败原因（中文，供门禁拼装修复提示）；`ok === true` 时为空 */
    reason?: string;
}
/**
 * 消费一个规划项并落盘消费记录。
 *
 * 校验（顺序即优先级）：未确认 → 已过期 → 标题不在规划里 → 该标题已消费。
 * 通过后把 `consumed` 追加一条并写盘；**写盘失败即视为失败**——宁可让调用方
 * 重试，也不要出现"文件写了、记录没记"从而可以重复写的口子。
 */
export declare function consumePlanItem(file: string, title: string, rel: string, opts?: {
    ttlHours?: number;
    now?: Date;
}): Promise<ConsumeResult>;
/** 放弃规划：删除记录（幂等，文件不存在也成功） */
export declare function abandonPlan(file: string): Promise<void>;
/** 规划根下的目标路径是否在范围内 */
export declare function pathInPlan(record: PlanRecord, rel: string): boolean;
