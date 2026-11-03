/**
 * 写入硬门禁：三连校验（架构选型 §5.1）。
 *
 * 需求 R25 明确要求"未读期望 / 未确认规划 / 越界路径 → 拒绝写入"，且**由工具强制**
 * 而不是写进 persona 靠模型自觉。原因很直接：persona 是提示词，模型可能忘；
 * 而门禁一旦落成进程内状态，DSH 重启就凭空失效。所以状态落 `.study/`（磁盘），
 * 校验放工具里（每次写入前跑一遍）。
 *
 * 三条校验各自的"可修复性"同样重要——每条失败都带**具体到调用的修复步骤**，
 * 否则门禁会把用户永久锁在外面（需求 §十 风险 4）。
 * @module gate
 */
import { type PlanRecord } from './planstore.ts';
import type { SessionState } from './store.ts';
export interface GateOk {
    ok: true;
    /** 本次写入所属的规划（未要求规划时为 null，如 `note_update`） */
    plan: PlanRecord | null;
}
export interface GateBlocked {
    ok: false;
    /** 失败原因（中文一句话，供工具直接抛错） */
    reason: string;
}
export type GateResult = GateOk | GateBlocked;
export interface GateInput {
    vaultRoot: string;
    stateDir: string;
    /** 当前会话状态（已读期望签名 + 待消费规划 id） */
    session: SessionState;
    /** 当前《笔记期望.md》的文件签名；`null` = 文件不存在 */
    expectSignature: string | null;
    /** 是否要求必须先读完期望（`note_write` 要求，`note_update` / `note_toc` 不要求） */
    requireExpect?: boolean;
    /** 本次写入目标（vault 内相对路径）；`note_write` 要求 */
    targetRel?: string;
    /** 是否要求必须有已确认的规划（`note_write` 要求） */
    requirePlan?: boolean;
    /** 规划有效期（小时） */
    planTtlHours?: number;
}
/**
 * 校验一：笔记期望已读且未过期。
 *
 * 用**文件签名**而非"读过一次"的布尔值：用户中途改了期望，签名就变，下次写入
 * 前必须重读（需求 F1 要求热配置立即生效）。文件缺失时**不回退**到内建默认写法
 * （架构选型 A14）——回退会让"约束只从期望文件来"重新变成两处口径。
 */
export declare function checkExpect(input: GateInput): GateResult;
/** 校验二：存在已确认且未过期的规划 */
export declare function checkPlan(input: GateInput): Promise<GateResult>;
/** 校验三：目标路径在规划范围内 */
export declare function checkPathInPlan(record: PlanRecord, targetRel: string): GateResult;
/**
 * 三连校验（按序短路）。返回第一个失败原因——一次只说一个问题，
 * 比一次性抛出三条更利于模型自我纠正。
 */
export declare function checkWrite(input: GateInput): Promise<GateResult>;
/**
 * 规划提案的对话呈现文本（**只在对话里给**，需求 R11：不落盘、vault 不新增文件）。
 * 结构固定为「目标根 → 新建/复用目录 → 块清单 → 下一步」，便于用户逐行批注。
 */
export declare function formatPlanProposal(record: PlanRecord, opts?: {
    reusedDirs?: string[];
}): string;
