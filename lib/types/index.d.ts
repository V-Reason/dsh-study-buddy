/**
 * dsh-study-buddy 插件入口。
 *
 * 设计：preset 行挂载（`name: dsh-study-buddy`），工具注册进 preset 的
 * 工具作用域层，不污染其他 agent。插件不发布 Cordis 服务——每次 apply
 * 创建独立 VaultStore 实例（索引缓存在实例内，不跨挂载共享），
 * 因此不需要 isolate realm。
 *
 * vault 读写全部走 node:fs 直写（插件是可信 preset 代码，不经沙箱 fs）：
 * 用户在会话里永远拿不到 vault 的沙箱 fs 权限，只能通过本插件的工具操作。
 * @module index
 */
import { type CardInput, type LinkKind, type UpdatePayload } from './card.ts';
import { type HistoryKind } from './history.ts';
import { type ToolDef } from './tools.ts';
import { type VaultLayout } from './vault.ts';
export type { ToolDef, ToolExecLike } from './tools.ts';
export { buildToolDefs } from './tools.ts';
export declare const name = "study-buddy";
export declare const inject: string[];
/**
 * 插件配置：`VaultLayout` 的"可省略默认值"视图（EXT-6：配置类型只有一份定义，
 * 不再三处同构搬运；新增配置项只改 vault.ts）。
 */
export interface StudyConfig extends Omit<VaultLayout, 'stateDir' | 'fallbackDir' | 'mocDir'> {
    /** 进度状态目录（相对 vaultRoot），默认 .study */
    stateDir?: string;
    /** 未映射领域的落盘目录（相对 vaultRoot），默认 未分类 */
    fallbackDir?: string;
    /** MOC 知识目录落盘位置（相对 vaultRoot），默认 目录 */
    mocDir?: string;
}
interface PluginContext {
    tools?: {
        register: (def: ToolDef) => () => void;
    };
    effect?: (callback: () => () => unknown, label?: string) => unknown;
    /** Cordis 事件订阅（预步门禁用；返回 disposer） */
    on?: (event: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => () => void;
    /** Cordis 服务读取（systemPrompt 用；可选服务一律特性探测） */
    get?: (key: string) => unknown;
}
export declare class VaultStore {
    private readonly layout;
    private index;
    private sig;
    private lastScanMs;
    private lastScanCwd;
    /** 上一次索引/扫描跳过的文件（读取失败等），在工具返回文本回显（BIZ-7） */
    private skipped;
    private extraRoots;
    constructor(layout: VaultLayout);
    private stateFile;
    private memoryFile;
    private assertVault;
    /** 当前会话的检索根：vault（可写）优先，随后配置的 searchRoots，最后（可选）会话工作目录（只读） */
    private rootsFor;
    /** 跳过的文件回显（BIZ-7：报告数字必须与"实际处理了哪些文件"一致） */
    private noteSkips;
    /** 写缓存失效：任何写操作之后必须调用 */
    private invalidate;
    /**
     * 取索引（必要时重建）。**名实相符**（CPLX-6）：每次调用都可能 `walk` 全库并
     * `stat` 每个文件；受 `config.indexTtlMs`（默认 2000ms）保护——TTL 内且会话
     * cwd 未变时直接复用缓存。写操作与 `rename` 会显式失效/强制重扫。
     */
    private ensureIndex;
    /** 写操作前的可写性校验（EXT-5：可写性策略上移到根定义，不再散落各处） */
    private assertWritable;
    private resolveCard;
    search(query: string, opts?: {
        domain?: string;
        status?: string;
        kind?: 'card' | 'note';
        limit?: number;
    }, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    private indexScopes;
    get(ref: string, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    create(input: CardInput, call?: {
        sessionCwd?: string;
    }): Promise<{
        text: string;
        rel: string;
    }>;
    update(id: string, payload: UpdatePayload, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    link(fromId: string, toId: string, kind: LinkKind, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    moc(opts: {
        title?: string;
        cardIds: string[];
        domain?: string;
    }, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    private lintCtx;
    /** 单卡报告：用刚从磁盘读到的原文（保证是最新版） */
    private reportOfRaw;
    /** 批量报告：直接用索引里已有的正文与模板，不再逐文件读盘（PERF-2） */
    private reportOfIndexed;
    /** 单卡/批量质量体检（card_lint）+ 跨卡一致性 / 质量趋势 / 可执行性评级（P2） */
    lint(opts: {
        ref?: string;
        scope?: 'vault' | 'all';
        limit?: number;
        rule?: string;
        cross?: boolean;
        trend?: boolean;
        rating?: boolean;
    }, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    private lintOne;
    private lintBatch;
    /** 版本更新 / 勘误 / 历史折叠块管理（card_history） */
    history(ref: string, action: 'list' | 'strip', opts?: {
        kinds?: HistoryKind[];
        dryRun?: boolean;
    }, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    /**
     * 改名：**先算出全部改动并做完冲突校验，再落盘**（BIZ-2），
     * 落盘失败按已写文件逆序回滚。入链扫描用索引正文预筛（PERF-5）。
     */
    rename(ref: string, newTitle: string, opts?: {
        dryRun?: boolean;
        sessionCwd?: string;
    }): Promise<string>;
    private planRenameAction;
    /** 提交改名：写本卡 → 写全库入链 → 改文件名；任一失败按已写文件回滚 */
    private commitRename;
    private fileExists;
    progress(action: string, fields: {
        material?: string;
        section?: string;
        pendingQuestions?: string[];
        touchedCardIds?: string[];
    }): Promise<string>;
    /** `study_memory get`：单键或全量（含进度句过期提示） */
    private memoryGet;
    /** `_autoPrefs` 控制键：只接受 set / remove（不接受 append） */
    private setControlKey;
    /** 普通键：set / append / remove */
    private writeNote;
    memory(action: string, fields: {
        key?: string;
        value?: string;
    }): Promise<string>;
}
export declare function apply(ctx: PluginContext, config?: StudyConfig): void;
