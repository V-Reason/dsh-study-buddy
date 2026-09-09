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
    /** lint 口径（可选）：residueLevel=off/warn/error（默认 warn），rulesOff=禁用的规则 id 列表 */
    lint?: {
        residueLevel?: 'off' | 'warn' | 'error';
        rulesOff?: string[];
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
    /** 版本更新 / 勘误 / 历史折叠块管理（card_history） */
    history(ref: string, action: 'list' | 'strip', opts?: {
        kinds?: HistoryKind[];
        dryRun?: boolean;
    }, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    /** 改标题并同步文件名 / 全库入链 / 断链检测（card_rename） */
    rename(ref: string, newTitle: string, opts?: {
        dryRun?: boolean;
        sessionCwd?: string;
    }): Promise<string>;
    private fileExists;
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
export declare function apply(ctx: PluginContext, config?: StudyConfig): void;
