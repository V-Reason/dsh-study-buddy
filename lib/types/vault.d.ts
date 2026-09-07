/**
 * vault 适配层：目录扫描（含跳过清单）、路径安全、原子写、落盘目录解析。
 * 全部走 node:fs 直写（插件是可信 preset 代码，不经沙箱 fs）。
 * @module vault
 */
/** 扫描时跳过的通用目录（vault 特定目录如"资源"由 config.skipDirs 配置） */
export declare const SKIP_DIRS: Set<string>;
/** 合并内置通用目录与用户配置的额外跳过目录 */
export declare function skipSetFor(extra?: string[]): Set<string>;
/** Windows 非法文件名字符清洗 + 长度上限。引号（ASCII/中文）直接移除不留空格，避免"标题↔文件名"脱节 */
export declare function sanitizeFilename(title: string): string;
/**
 * 领域键近似匹配：按字符重合度（共同字符 / 较长键长度）≥0.6 排序，取前 2。
 * 用于 card_create 领域键未精确命中时回显"最接近的已映射键"（如
 * "图形学-动画与特效" → "图形学-动画特效"），避免 agent 翻配置文件绕路。
 */
export declare function findSimilarDomainKeys(domain: string, keys: string[]): string[];
export declare function withinRoot(root: string, p: string): boolean;
export declare function ensureDir(p: string): Promise<void>;
/** 临时文件 + rename 原子写；失败清理临时文件，不留下半成品 */
export declare function atomicWrite(file: string, content: string): Promise<void>;
export declare function exists(p: string): Promise<boolean>;
export interface WalkedFile {
    path: string;
    rel: string;
    /** 来源根标签（vault / 工作目录 / searchRoots 目录名） */
    root: string;
    mtimeMs: number;
    /** inode 变更时间（rename/元数据变更也触发；与 mtime 互补防同毫秒同大小漏检） */
    ctimeMs: number;
    size: number;
}
/** 一个检索根：扫描目录 + 展示标签 */
export interface SearchRoot {
    path: string;
    label: string;
}
/** 递归收集 root 下所有 .md（跳过 skip 集合，默认内置通用目录）；rootLabel 标注来源 */
export declare function walk(root: string, skip?: Set<string>, rootLabel?: string): Promise<WalkedFile[]>;
/** 跨根扫描：逐根 walk 后拼接（rel 为各根内相对路径，root 标注来源） */
export declare function walkRoots(roots: SearchRoot[], skip?: Set<string>): Promise<WalkedFile[]>;
/** 规范化路径键：Windows 下大小写不敏感，用于跨根去重（cwd 与 vault 相同时只索引一次） */
export declare function canonicalRootKey(p: string): string;
/** outer 是否包含 inner（按规范化绝对路径前缀判断；同路径视为包含） */
export declare function containsRoot(outer: string, inner: string): boolean;
/**
 * 去重检索根：按规范化路径 + 包含关系裁剪——已被更早（优先）根覆盖的根直接丢弃，
 * 只保留真正贡献新文件的根（cwd == vaultRoot 或 cwd 在 vault 内时 cwd 不重复扫描）。
 */
export declare function dedupeRoots(roots: SearchRoot[]): SearchRoot[];
/** 文件级去重：同文件（规范化路径）只留首个（调用方把 vault 放最前，vault 标签优先） */
export declare function dedupeFiles(files: WalkedFile[]): WalkedFile[];
/** 校验额外检索根存在（fail-loud）并解析为绝对路径 + 唯一展示标签 */
export declare function resolveSearchRoots(vaultRoot: string, raw?: string[]): SearchRoot[];
export interface VaultLayout {
    vaultRoot: string;
    stateDir: string;
    fallbackDir: string;
    mocDir: string;
    domainFolders?: Record<string, string>;
    /** 额外跳过扫描的顶层目录名（与内置通用目录合并） */
    skipDirs?: string[];
    /** 额外检索根（绝对路径，或相对 vaultRoot 的路径）：旧笔记库，只读 */
    searchRoots?: string[];
    /** 是否把会话工作目录（exec.agent.session.header.cwd）纳入检索，默认 false */
    includeSessionCwd?: boolean;
    /** 是否允许把关联写入没有 ID 的旧笔记，默认 false（旧笔记不碰不动） */
    linkIntoNotes?: boolean;
}
/** 解析某领域卡片的落盘目录：优先映射表，未映射落入 fallbackDir/<领域名> */
export declare function cardDirFor(layout: VaultLayout, domain: string): string;
/** 生成唯一文件名：`标题.md`，冲突时追加 ID 后缀，再冲突用完整 ID */
export declare function uniqueCardPath(dir: string, title: string, id: string): Promise<string>;
export declare function fileNameOf(p: string): string;
/** MOC 落盘路径：mocDir/日期_标题.md */
export declare function mocPathFor(layout: VaultLayout, title: string, date: string): string;
