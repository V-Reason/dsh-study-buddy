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
/** 笔记契约的唯一来源（阶段 6 起 card.ts / history.ts / moc.ts 已删除） */
import { type BlockLinks, type LinkKind } from './note.ts';
import { type StudyConfig } from './config.ts';
import { type HostContextLike } from './host.ts';
import { type NoteKind } from './search.ts';
import { type VaultLayout } from './vault.ts';
export type { ToolDef, ToolExecLike } from './tools.ts';
export { buildToolDefs } from './tools.ts';
/** 宿主契约表：`tools/verify-contract.mjs` 的**单一真相**（探针与排障说明都从这里取） */
export { HOST_CONTRACTS, type HostCapabilities, type HostContract } from './host.ts';
/** 配置键表：判定"声明行 / 用户级 JSON 里不认的键"，契约探针也用它做静态断言 */
export { KNOWN_CONFIG_KEYS, unknownConfigKeys, type StudyConfig } from './config.ts';
export declare const name = "study-buddy";
export declare const inject: string[];
export declare class VaultStore {
    private readonly layout;
    private index;
    private sig;
    private lastScanMs;
    private lastScanCwd;
    /** 上一次索引/扫描跳过的项（读取失败、安全阀截断等），在工具返回文本回显（BIZ-7） */
    private skipped;
    private extraRoots;
    /**
     * 标题 → 笔记摘要：写入时的同名提示用 O(1) 查询（N2）。
     * 旧实现为了一条提示调用 `ensureIndex`，让每次建卡都全库重扫。
     * 索引重建时整体填充，写入（create/replace/rename）后增量维护。
     */
    private titleHints;
    /** 上一次 `ensureIndex` 是否命中 TTL 缓存（命中时未命中/找不到的查询要强制重扫一次，N3） */
    private servedFromCache;
    /** 上一次索引是否多根（决定展示路径是否带 `vault/` 前缀） */
    private lastMultiRoot;
    constructor(layout: VaultLayout);
    private stateFile;
    private memoryFile;
    private assertVault;
    /** 当前会话的检索根：vault（可写）优先，随后配置的 searchRoots，最后（可选）会话工作目录（只读） */
    private rootsFor;
    /**
     * 跳过的项回显（BIZ-7：报告数字必须与"实际处理了哪些文件"一致）。
     * 按**原因**分组（N5）：跳过对象可能是目录（深度超限）或截断的根，
     * 旧实现只留路径、原因一律写成"读取失败/无权限"，会把用户引向错误方向。
     */
    private noteSkips;
    /** 展示路径：多根时带 `vault/` 前缀，与索引 `fullRel` 口径一致（N2） */
    private displayRel;
    /** 维护标题缓存（N2）：只在旧键确实指向本卡时删除，避免误伤同名卡 */
    private rememberTitle;
    /** 写缓存失效：任何写操作之后必须调用 */
    private invalidate;
    /**
     * 取索引（必要时重建）。**名实相符**（CPLX-6）：每次调用都可能 `walk` 全库并
     * `stat` 每个文件；受 `config.indexTtlMs`（默认 2000ms）保护——TTL 内且会话
     * cwd 未变时直接复用缓存。写操作会显式失效；**未命中/找不到卡片的路径**用
     * `{ force: true }` 重扫一次（N3：TTL 窗口内也要看得见外部编辑）。
     */
    private ensureIndex;
    /** 写操作前的可写性校验（EXT-5：可写性策略上移到根定义，不再散落各处） */
    private assertWritable;
    private resolveCard;
    search(query: string, opts?: {
        domain?: string;
        status?: string;
        kind?: NoteKind;
        dirPath?: string;
        limit?: number;
    }, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    private indexScopes;
    get(ref: string, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    private lintCtx;
    /**
     * 从《笔记期望.md》解析出的检查项（`- [检查] 禁止/必须 …`）。
     *
     * 这一步让"检查什么"也走热配置：期望文件里没写规则时，`expect-rule` 会明确
     * 列为"未执行"而不是假装通过（N7）。
     */
    private expectRules;
    /** 文档类型判定（三态）：有 ID 且有来源章节 = 块；有 ID = 存量卡；无 ID = 旧笔记 */
    private kindOf;
    /** 单篇报告：用刚从磁盘读到的原文（保证是最新版） */
    private reportOfRaw;
    /**
     * 批量报告：正文按需现读（A4 之后索引不再持有正文）。
     *
     * 代价是批量体检要逐篇读盘——这是"索引不常驻正文"的必然交换：内存从
     * 全库正文降到倒排表，而批量体检本来就是低频重操作。
     */
    private reportOfIndexed;
    /**
     * 质量体检（note_lint）。
     *
     * 2026-10：跨卡一致性 / 质量趋势 / 可执行性评级三个分析开关随模板与 100 分制一起
     * 退场（架构选型 A9 / §6.4）——它们的输入（模板、分值）已不存在。
     */
    lint(opts: {
        ref?: string;
        scope?: 'vault' | 'all';
        limit?: number;
        rule?: string;
    }, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    private lintOne;
    private lintBatch;
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
    /** `session.json` 的绝对路径（门禁状态文件） */
    private sessionFile;
    /** 读会话门禁状态（`session.json`；损坏回空态，不阻断） */
    private sessionState;
    /** 期望文件名（配置 `expectFile`，默认 `笔记期望.md`） */
    private expectFileName;
    /** 《笔记期望.md》的绝对路径（文件名由配置 `expectFile` 决定） */
    private expectPath;
    /** 当前《笔记期望.md》的文件签名（`null` = 文件不存在） */
    private expectSignature;
    /** 组装门禁输入（三连校验共用） */
    private gateInput;
    /** `note_library`：库状态与期望文件自检（硬门禁的第一环） */
    noteLibrary(action: string): Promise<string>;
    /** `note_expect_get`：读期望全文并**标记已读**（门禁开门动作） */
    noteExpectGet(): Promise<string>;
    /**
     * `note_list`：逐层导航（子目录 + 该层笔记；**不读正文**，只读 frontmatter 头）。
     *
     * 两个刻意的口径：
     * - 目录计数与"有无微目录"都按**子树累加**（父级只放章节标题时，其下几层才是块）；
     * - vault 根的《笔记期望.md》不是笔记，不列出来（否则每次导航都多一行噪声）。
     */
    noteList(opts?: {
        path?: string;
        depth?: number;
    }): Promise<string>;
    /** 由索引构建目录索引（A6：重建时整体构建，写入后增量维护） */
    private dirIndexFor;
    /** `note_overview`：主题块清单 + 按来源章节的覆盖情况 */
    /** `note_overview`：主题块清单 + 按来源章节的覆盖情况（聚合在 overview.ts，纯函数） */
    noteOverview(opts?: {
        path?: string;
        material?: string;
    }): Promise<string>;
    /**
     * `note_plan`：文件夹规划提案与确认（提案只在对话里，不落盘，需求 R11）。
     *
     * 三个动作共用 `rootPath` 入参（`create` 传规划根，`confirm` / `abandon` 传 planId）：
     * 工具 schema 的必填集合因此不必随动作变化，模型也能只靠提案回显完成后续动作。
     * **确认才置位 `confirmed`**——门禁的第二环由 `action=confirm` 打开，且有效期从
     * 确认时刻重新起算（搁置过久的提案要先重新提案，不把有效期变成"提案起算"）。
     */
    notePlan(args: {
        action?: string;
        rootPath?: string;
        items?: Array<{
            title?: string;
            path?: string;
            sourceSection?: string;
            order?: number;
        }>;
        material?: string;
        notes?: string;
    }): Promise<string>;
    /** `note_write`：落一个块（硬门禁三连校验 + 规划消费记账） */
    noteWrite(input: {
        planId: string;
        title: string;
        source: string;
        content: string;
        path: string;
        domain?: string;
        status?: string;
        sourceSection?: string;
        order?: number;
        summary?: string;
        tags?: string[];
        links?: BlockLinks;
        dryRun?: boolean;
    }): Promise<string>;
    /** `note_update`：append（补充）/ replace（替换，先存档）/ move（迁目录） */
    noteUpdate(args: {
        ref: string;
        action: string;
        changes?: string;
        section?: string;
        newContent?: string;
        summary?: string;
        targetPath?: string;
        sourceSection?: string;
        dryRun?: boolean;
    }, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    /** `note_history`：列出/读取某篇笔记的历史存档 */
    noteHistory(ref: string, opts?: {
        action?: string;
        archiveId?: string;
    }, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    /** `note_restore`：恢复某份存档（当前正文先转入存档，绝不丢内容） */
    noteRestore(ref: string, opts?: {
        archiveId?: string;
        dryRun?: boolean;
    }, call?: {
        sessionCwd?: string;
    }): Promise<string>;
    /** `note_toc`：生成/刷新某目录的微目录（只重写生成段，用户手写段保留） */
    noteToc(dir: string, opts?: {
        dryRun?: boolean;
        title?: string;
    }): Promise<string>;
    /** `note_link` / `note_unlink`：wikilink 关联的双向增删（先校验后写盘） */
    noteLink(fromRef: string, toRef: string, kind: LinkKind, remove?: boolean, call?: {
        sessionCwd?: string;
    }): Promise<string>;
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
export declare function apply(ctx: HostContextLike | undefined, config?: StudyConfig): void;
