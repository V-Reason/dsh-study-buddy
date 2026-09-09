/**
 * 检索与索引：CJK 双字组 + 英文单词 token 化；字段加权打分；
 * 候选召回交给 Agent 做语义判断（插件负责召回，LLM 负责语义）。
 * @module search
 */
import type { WalkedFile } from './vault.ts';
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
    /** 卡片=有 frontmatter ID；旧笔记=无 ID */
    kind: 'card' | 'note';
    /** frontmatter 领域首个标签（去 #） */
    domain: string | null;
    /** frontmatter 领域全部标签（去 #） */
    tags: string[];
    status: string | null;
    source: string | null;
    definition: string | null;
    /** frontmatter 模板类型（理论型/工程型/对比型；旧笔记为 null） */
    template: string | null;
    /** 由相对路径顶层目录推断的领域（旧笔记用） */
    inferredDomain: string;
    /** 字段 → token 计数 */
    titleTokens: Map<string, number>;
    defTokens: Map<string, number>;
    tagTokens: Map<string, number>;
    bodyTokens: Map<string, number>;
    /** 正文（snippet 与全文检索用） */
    body: string;
}
export interface SearchHit {
    id: string | null;
    title: string;
    domain: string | null;
    tags: string[];
    status: string | null;
    source: string | null;
    definition: string | null;
    path: string;
    rel: string;
    root: string;
    fullRel: string;
    fileName: string;
    kind: 'card' | 'note';
    inferredDomain: string;
    score: number;
    snippet: string;
}
export declare function tokenize(text: string): string[];
/** 查询侧 token 化：短 CJK 词额外展开单字，提升召回 */
export declare function tokenizeQuery(text: string): string[];
export declare function indexNote(file: WalkedFile, raw: string): IndexedCard;
export interface SearchOptions {
    domain?: string;
    status?: string;
    /** 只返回卡片或只返回旧笔记 */
    kind?: 'card' | 'note';
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
    /**
     * 按引用串找候选：优先完整展示路径（root/rel，多根时）、各根内 rel，最后（仅当引用是纯文件名时）按文件名。
     * 返回全部候选（0/1/多个），由调用方决定唯一或报歧义。
     */
    candidatesForRef(ref: string): IndexedCard[];
    search(query: string, opts?: SearchOptions): SearchHit[];
    private toHit;
}
