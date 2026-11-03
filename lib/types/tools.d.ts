/**
 * 工具定义注册表（模型可见的 19 个 `note_*` / `study_*` 工具）。
 *
 * 工具 schema 本身是"提示词资产"（描述即文档）：本文件与 VaultStore 业务逻辑分文件，
 * 各自演进更清晰；工具只做参数解析与委派，业务在 VaultStore。
 *
 * 2026-10 重构：`card_*` 整族退场（需求 R18），改为文档式笔记工具面；工具数取
 * v1.3.0 增至 19 个（新增 study_mode）——列目录/看单篇/搜全库/看覆盖度各自独立，
 * 模型不必靠参数分支猜语义（需求方定稿："宁可多不要挤"）。
 *
 * 硬门禁（需求 F2/R25）落在 `note_write`：未读期望 / 未确认规划 / 越界路径一律拒绝，
 * 且磁盘零改动——这条由 `src/gate.ts` 强制，不靠 persona 自觉。
 * @module tools
 */
import { sessionCwdOf, sessionIdOf, type ToolExecLike } from './host.ts';
import type { VaultStore } from './index.ts';
/**
 * 宿主形状与读取函数都在 host.ts（本插件唯一的宿主接触面）；这里 re-export 是为了
 * 保持 `ToolExecLike` / `sessionCwdOf` 这两个既有公开出口不漂移（index.ts 继续转发）。
 */
export { sessionCwdOf, sessionIdOf, type ToolExecLike };
export interface ToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: {
            type: string;
        };
        render: (_args: unknown, value: string) => Array<{
            type: string;
            text: string;
        }>;
    };
    isConcurrencySafe?: () => boolean;
    /** exec 由 DSH 工具注册表注入：调用方会话信息（agent.session.header.cwd） */
    execute: (args: Record<string, unknown>, exec?: ToolExecLike) => Promise<string> | string;
}
export declare function buildToolDefs(store: VaultStore): ToolDef[];
