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
import { type VaultLayout } from './vault.ts';
export declare const name = "study-buddy";
export declare const inject: string[];
export interface StudyConfig {
    /** Obsidian vault 根目录（绝对路径） */
    vaultRoot: string;
    /** 进度状态目录（相对 vaultRoot），默认 .study */
    stateDir?: string;
    /** 未映射领域的落盘目录（相对 vaultRoot），默认 未分类 */
    fallbackDir?: string;
    /** MOC 知识目录落盘位置（相对 vaultRoot），默认 目录 */
    mocDir?: string;
    /** 领域键 → 落盘目录（相对 vaultRoot），支持多个键别名映射同一目录 */
    domainFolders?: Record<string, string>;
    /** 额外跳过扫描的目录名（相对 vaultRoot 的顶层目录名；内置已跳过 .obsidian/.trash/.study/.git/node_modules） */
    skipDirs?: string[];
    /** 额外检索根（绝对路径，或相对 vaultRoot 的路径）：旧笔记库，只读；不存在即挂载失败（fail-loud） */
    searchRoots?: string[];
    /** 是否把会话工作目录（工具调用方会话 cwd）纳入检索，默认 false */
    includeSessionCwd?: boolean;
    /** 是否允许把关联写入无 ID 的旧笔记，默认 false（旧笔记不碰不动；只写卡片侧） */
    linkIntoNotes?: boolean;
}
interface ToolDef {
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
/** 工具方会话信息的最小结构类型（不引入 @deepseek-ai 类型，保持构建 external） */
interface ToolExecLike {
    agent?: {
        session?: {
            header?: {
                cwd?: string;
            };
        };
    };
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
    private extraRoots;
    constructor(layout: VaultLayout);
    private stateFile;
    private memoryFile;
    private assertVault;
    /** 当前会话的检索根：vault 优先，随后配置的 searchRoots，最后（可选）会话工作目录 */
    private rootsFor;
    /** 目录签名（含各根文件 mtime/ctime/size 与 cwd）变化才重建索引（Obsidian 外部编辑后仍能查到最新内容） */
    private refresh;
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
    create(input: CardInput): Promise<{
        text: string;
        rel: string;
    }>;
    update(id: string, payload: UpdatePayload): Promise<string>;
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
    progress(action: string, fields: {
        material?: string;
        section?: string;
        pendingQuestions?: string[];
        touchedCardIds?: string[];
    }): Promise<string>;
    memory(action: string, fields: {
        key?: string;
        value?: string;
    }): Promise<string>;
}
export declare function buildToolDefs(store: VaultStore): ToolDef[];
export declare function apply(ctx: PluginContext, config?: StudyConfig): void;
export {};
