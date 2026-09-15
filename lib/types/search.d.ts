/**
 * 检索与索引：CJK 双字组 + 英文单词 token 化；字段加权打分；多根索引。
 *
 * 候选召回交给 Agent 做语义判断（插件负责召回，LLM 负责语义）。
 *
 * 2026-10 关键改动（架构选型 A4 / §5.2）：**索引不再常驻正文**。
 * 旧实现把全库正文留在 `IndexedCard.body` 里（1000 卡 × 4KB ≈ 4MB），文档式
 * 笔记单篇可达 10KB 级，这个模型会线性膨胀。现在索引只驻留元数据 + 倒排 token
 * 计数，snippet 只在**命中前 N 篇**时按路径现读——"共检索多少篇"不变，常驻内存
 * 与单次工具调用的读盘量都掉下来。
 * @module search
 */
import type { WalkedFile } from './vault.ts';
/** 文档类型三态（取代旧的 card/note 二元） */
export type NoteKind = 'block' | 'legacy' | 'note';
export interface IndexedCard {
    id: string | null;
    title: string;
    path: string;
    rel: string;
    /** 来源根标签（vault / 工作目录 / searchRoots 目录名） */
    root: string;
    /** 该文件是否可写（只有 vault 内文件为 true；只读根永不写入，EXT-5） */
    writable: boolean;
    /** 展示/寻址路径：多根时为 root/rel，单根时无前缀 */
    fullRel: string;
    fileName: string;
    /** 文档类型（三态由 ID 与来源章节共同决定） */
    kind: NoteKind;
    /** frontmatter 领域首个标签（去 #） */
    domain: string | null;
    /** frontmatter 领域全部标签（去 #） */
    tags: string[];
    status: string | null;
    source: string | null;
    /** 一句话定位（`简介`，旧卡的 `定义` 作别名） */
    definition: string | null;
    /** 来源章节（覆盖度数据源；缺失 = 存量卡/旧笔记） */
    sourceSection: string | null;
    /** 微目录排序键 */
    order: number | null;
    /** 由相对路径顶层目录推断的领域（旧笔记用） */
    inferredDomain: string;
    /** 字段 → token 计数 */
    titleTokens: Map<string, number>;
    defTokens: Map<string, number>;
    tagTokens: Map<string, number>;
    bodyTokens: Map<string, number>;
}
export interface SearchHit {
    id: string | null;
    title: string;
    domain: string | null;
    tags: string[];
    status: string | null;
    source: string | null;
    definition: string | null;
    sourceSection: string | null;
    path: string;
    rel: string;
    root: string;
    fullRel: string;
    fileName: string;
    kind: NoteKind;
    inferredDomain: string;
    score: number;
    /** 命中片段（由调用方按需现读正文算出；未提供时为 null） */
    snippet: string | null;
}
export declare function tokenize(text: string): string[];
/** 查询侧 token 化：短 CJK 词额外展开单字，提升召回 */
export declare function tokenizeQuery(text: string): string[];
/** 文档类型判定：有 ID 且有来源章节 = 块；有 ID = 存量卡；无 ID = 旧笔记 */
export declare function kindOfNote(meta: {
    id?: string;
    sourceSection?: string;
} | null): NoteKind;
export declare function indexNote(file: WalkedFile, raw: string): IndexedCard;
/** 命中片段：在已读到的正文里找首个含查询 token 的行（调用方按需现读正文） */
export declare function snippetOf(body: string, queryTokens: string[]): string;
export interface SearchOptions {
    domain?: string;
    status?: string;
    /** 只返回某一类文档 */
    kind?: NoteKind;
    /** 只在该目录（vault 内相对路径）及其子目录下检索 */
    dirPath?: string;
    limit?: number;
}
export declare class SearchIndex {
    private cards;
    private inverted;
    private titleInverted;
    private defInverted;
    private tagInverted;
    private idIndex;
    private titleIndex;
    private rootSet;
    rebuild(cards: IndexedCard[], multiRoot?: boolean): void;
    private push;
    get size(): number;
    /** 只读视图（CPLX-6：不再泄露内部数组引用） */
    all(): readonly IndexedCard[];
    /** 已索引的来源根标签集合（拼「来源：…」用，避免每次 O(n) 扫描） */
    roots(): string[];
    byId(id: string): IndexedCard | undefined;
    byTitle(title: string): IndexedCard | undefined;
    /** 某目录（vault 内相对路径）及其子目录下的文件；`''` = 整库 */
    underDir(dir: string): IndexedCard[];
    /**
     * 按引用串找候选：优先完整展示路径（root/rel，多根时）、各根内 rel，最后（仅当引用是纯文件名时）按文件名。
     * 返回全部候选（0/1/多个），由调用方决定唯一或报歧义。
     */
    candidatesForRef(ref: string): IndexedCard[];
    search(query: string, opts?: SearchOptions): SearchHit[];
    /** 命中列表的查询 token（算 snippet 用；与 `search` 内同一口径） */
    static queryTokens(query: string): string[];
    private toHit;
}
