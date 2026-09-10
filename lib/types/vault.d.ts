/**
 * vault 适配层：目录扫描（含跳过清单）、路径安全、原子写、落盘目录解析。
 * 全部走 node:fs 直写（插件是可信 preset 代码，不经沙箱 fs）。
 * @module vault
 */
import type { TemplateHints } from './template.ts';
/** 扫描时跳过的通用目录（vault 特定目录如"资源"由 config.skipDirs 配置） */
export declare const SKIP_DIRS: Set<string>;
/** 文件名长度上限（标题↔文件名同口径的唯一来源，CPLX-7） */
export declare const MAX_FILENAME = 80;
/** 单次扫描安全阀：文件数与递归深度上限（防跨盘符/异常根导致整盘扫描，SEC-2） */
export declare const MAX_WALK_FILES = 20000;
export declare const MAX_WALK_DEPTH = 16;
/** 合并内置通用目录与用户配置的额外跳过目录 */
export declare function skipSetFor(extra?: string[]): Set<string>;
/**
 * Windows 非法文件名字符清洗 + 长度上限。引号（ASCII/中文）直接移除不留空格，
 * 避免"标题↔文件名"脱节；`[` `]` 必须清洗——它们会让 MOC 的 `[[wikilink]]`
 * 断裂（SEC-3）；设备名加 `_` 前缀兜底。
 */
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
    /** 是否可写（只有 vault 根为 true；只读根不写入，EXT-5） */
    writable: boolean;
    mtimeMs: number;
    /** inode 变更时间（rename/元数据变更也触发；与 mtime 互补防同毫秒同大小漏检） */
    ctimeMs: number;
    size: number;
}
/** 一个检索根：扫描目录 + 展示标签 + 是否可写（EXT-5：可写性策略上移到根定义） */
export interface SearchRoot {
    path: string;
    label: string;
    /** vault=true；searchRoots 与工作目录=false（只读，绝不写入） */
    writable: boolean;
}
/** 是否文件系统根（`resolve('/')` 在 Windows 上只等于当前盘根，跨盘符 cwd 会漏拦，SEC-2） */
export declare function isFsRoot(p: string): boolean;
/** 扫描进度回调（读取失败/超限时收集，供工具返回文本回显，BIZ-7） */
export type SkipReporter = (entry: {
    path: string;
    reason: string;
}) => void;
/**
 * 递归收集 root 下所有 .md（跳过 skip 集合，默认内置通用目录）；rootLabel 标注来源。
 * 读取失败与安全阀超限都通过 `onSkip` 上报，绝不静默吞掉。
 *
 * `maxFiles` 是**每根**的文件数安全阀（默认 `MAX_WALK_FILES`，可用
 * `config.maxWalkFiles` 调整）：超限时**截断扫描并上报**，不再抛错（N6）——
 * 安全阀的语义是"拦住异常根"，不是"让大型 vault 彻底不可用"。
 */
export declare function walk(root: string, skip?: Set<string>, rootLabel?: string, onSkip?: SkipReporter, writable?: boolean, maxFiles?: number): Promise<WalkedFile[]>;
/** 跨根扫描：逐根 walk 后拼接（rel 为各根内相对路径，root 标注来源）；`maxFiles` 为每根上限 */
export declare function walkRoots(roots: SearchRoot[], skip?: Set<string>, onSkip?: SkipReporter, maxFiles?: number): Promise<WalkedFile[]>;
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
/**
 * 校验额外检索根存在（fail-loud）并解析为绝对路径 + 唯一展示标签。
 * 额外根默认只读；`config.linkIntoNotes: true` 时允许写入（此时根标记可写）。
 */
export declare function resolveSearchRoots(vaultRoot: string, raw?: string[], writable?: boolean): SearchRoot[];
/** lint 口径配置（具名接口，供 StudyConfig 与 VaultLayout 共用，EXT-6） */
export interface LintConfig {
    /** 会话残留级别：off 关闭 / warn 扣分 / error 扣分并封顶 59（默认 warn） */
    residueLevel?: 'off' | 'warn' | 'error';
    /** 禁用的规则 id 列表 */
    rulesOff?: string[];
}
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
    /** lint 口径（可选）：会话残留级别与禁用规则 */
    lint?: LintConfig;
    /** 索引缓存 TTL（毫秒）：默认 2000；0 = 每次调用都重扫全库（外部编辑立即可见） */
    indexTtlMs?: number;
    /** 每根扫描文件数上限（默认 20000）：超限截断扫描并回显警告，不再让工具整体失败（N6） */
    maxWalkFiles?: number;
    /** 模板推断提示词表（缺省用内置默认值） */
    templateHints?: TemplateHints;
}
/** 解析某领域卡片的落盘目录：优先映射表，未映射落入 fallbackDir/<领域名> */
export declare function cardDirFor(layout: VaultLayout, domain: string): string;
/** 生成唯一文件名：`标题.md`，冲突时追加 ID 后缀（末 6 位），再冲突用完整 ID */
export declare function uniqueCardPath(dir: string, title: string, id: string): Promise<string>;
export declare function fileNameOf(p: string): string;
/** MOC 落盘路径：mocDir/日期_标题.md */
export declare function mocPathFor(layout: VaultLayout, title: string, date: string): string;
