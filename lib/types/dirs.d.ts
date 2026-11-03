/**
 * vault 目录模型：路径归一、微目录约定、层级校验、目录索引（DirIndex），
 * 以及"块该落到哪个目录"的三档解析。
 *
 * 2026-10 文档式笔记重构新增：旧模型用「领域键 → 目录」映射被动生成目录，
 * 于是笔记被无脑堆进同一个目录、彼此没有阅读顺序。新模型把**目录路径**升为
 * 主键（由用户确认的文件夹规划给出），领域映射降级为语法糖。
 *
 * 纯函数为主；`walk` 是唯一的 IO。
 * @module dirs
 */
import { type WalkedFile } from './vault.ts';
/** 微目录固定文件名：每个主题目录都有一份（需求 R12） */
export declare const TOC_FILE = "\u5FAE\u76EE\u5F55.md";
/** 嵌套层数提示阈值：超过只提示不拒绝 */
export declare const MAX_NEST_HINT = 6;
/** 笔记期望文件名（vault 根固定位置，需求 A4） */
export declare const EXPECT_FILE = "\u7B14\u8BB0\u671F\u671B.md";
/** 路径归一：反斜杠 → 正斜杠、去掉首尾斜杠、折叠重复斜杠 */
export declare function normRel(rel: string): string;
/** 相对路径所在的目录（顶层文件返回 `''`） */
export declare function dirOfRel(rel: string): string;
/** 父目录（顶层目录 / 根返回 `''`） */
export declare function parentDir(dir: string): string;
/** 目录的路径段 */
export declare function dirSegments(dir: string): string[];
/** 是否为微目录文件（按相对路径判断） */
export declare function isTocRel(rel: string): boolean;
/** 目录嵌套层数（根 = 0） */
export declare function depthOf(dir: string): number;
/**
 * 笔记期望文件的绝对路径。
 *
 * `fileName` 来自配置 `expectFile`（默认 `笔记期望.md`）。这个参数是 2026-10 收口时补的：
 * 之前该配置键**配了不生效**（路径写死常量），属于"配了没用"的静默陷阱。
 */
export declare function expectPathFor(vaultRoot: string, fileName?: string): string;
/** 目标目录的绝对路径（`dir` 为空/`.` 时就是 vault 根） */
export declare function dirPathFor(vaultRoot: string, dir: string): string;
export declare function assertDirPath(dir: string): string;
/** 层级提示（软约束，不拒绝）：超过阈值时给人文案，由调用方回显 */
export declare function nestHint(dir: string): string;
export interface DirStat {
    /** 该目录下的块数（有 ID 且有来源章节） */
    blocks: number;
    /** 该目录下的存量卡数（有 ID、无来源章节） */
    legacy: number;
    /** 该目录下的旧笔记数（无 ID） */
    notes: number;
    /** 是否已有微目录 */
    hasToc: boolean;
}
export interface DirBuildInput {
    /** vault 内相对路径 */
    rel: string;
    kind: 'block' | 'legacy' | 'note';
    /** 是否属于 vault 根（只读检索根的文件不参与目录导航） */
    inVault: boolean;
} /**
 * 目录索引：路径 → 计数。**只统计承载文件的目录本身**，父目录计数按需累加
 * （`countAt`）——这样 `add`/`remove` 都是 O(1)，无需向上逐级更新。
 *
 * 索引重建时整体构建；写入后增量维护（与 `titleHints` 同手法，N2）。
 */
export declare class DirIndex {
    private stats;
    get size(): number;
    /** 全部含文件的目录路径（升序，未归一：调用方按需 normRel） */
    dirs(): string[];
    /** 单目录自身的计数（不递归） */
    statOf(dir: string): DirStat;
    /** 目录及其子树的累加计数（含子目录） */
    countAt(dir: string): DirStat;
    /** 目录的直接子目录（含文件的那些） */
    childrenOf(dir: string): string[];
    /** 该目录下是否有文件直接落在这里 */
    hasFiles(dir: string): boolean;
    /** 目录自身或子树里是否存在微目录（父级判断"该子树有入口"用） */
    hasTocIn(dir: string): boolean;
    add(rel: string, kind: DirBuildInput['kind']): void;
    remove(rel: string, kind: DirBuildInput['kind']): void;
    clear(): void;
}
/** 从已扫描文件构建目录索引（只收 vault 根内的文件） */
export declare function buildDirIndex(files: WalkedFile[], kinds: Map<string, DirBuildInput['kind']>): DirIndex;
/** 目录扫描结果（`note_list` 的数据源）：子目录 + 直接落在该层的文件 */
export interface DirListing {
    /** 归一化后的目录路径（根为 `''`） */
    dir: string;
    /** 直接子目录（相对 vault 根的路径） */
    subdirs: string[];
    /** 该目录下的文件（含富化后的元数据） */
    files: DirListFile[];
}
export interface DirListFile {
    rel: string;
    fileName: string;
    title: string;
    summary: string | null;
    sourceSection: string | null;
    order: number | null;
    kind: 'block' | 'legacy' | 'note';
    id: string | null;
}
/**
 * 列出某目录的直接子目录与文件。
 *
 * **不读正文**：只读每个文件前 `headerBytes` 字节拿 frontmatter，因此目录里
 * 有几十篇长笔记也不影响导航速度（架构选型 A4 / §2.3）。
 */
export declare function listDir(vaultRoot: string, dir: string, opts?: {
    headerBytes?: number;
}): Promise<DirListing>;
/** 排序：顺序键 → 标题字典序（缺顺序键的排在有顺序键之后，按标题排） */
export declare function compareOrder(a: DirListFile, b: DirListFile): number;
/** 头部解析结果（`listDir` 用；字段名与 frontmatter 模块解耦，避免循环依赖） */
export interface NoteHeader {
    id: string | null;
    title: string | null;
    summary: string | null;
    sourceSection: string | null;
    order: number | null;
}
/**
 * 只读文件头（默认前 4KB）取 frontmatter。
 *
 * 头读失败（frontmatter 超长 / 无换行巨行）时**回退读全文一次**（架构选型 C4）：
 * 宁可慢一次，不可让索引缺字段——缺字段会让检索与导航静默错位。
 */
export declare function readNoteHeader(absPath: string, headerBytes?: number): Promise<NoteHeader>;
/**
 * 从（可能被截断的）文本里提取头部字段。
 * 解析口径与 `frontmatter.ts` 保持一致：只认标量 `key: value` 行。
 */
export declare function parseHeaderFields(text: string): NoteHeader;
/**
 * 解析块的落盘目录，优先级（架构选型 §4.2 / 需求 R30）：
 * ① 规划显式给出的目录 → ② `domainFolders` 快捷方式 → ③ `fallbackDir/<领域名>`
 */
export declare function resolveNoteDir(layout: {
    domainFolders?: Record<string, string>;
    fallbackDir: string;
}, opts: {
    plannedDir?: string;
    domain?: string;
}): string;
/** 绝对路径 → vault 内相对路径（不在 vault 内时抛错） */
export declare function vaultRelOf(vaultRoot: string, absPath: string): string;
