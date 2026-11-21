/**
 * 课程编译器数据模型：可见课程蓝图、来源清单与覆盖校验。
 *
 * 课程正文留在 vault 的 Markdown 里；本模块只定义能被工具可靠校验的结构。
 * @module course
 */
export declare const COURSE_SCHEMA_VERSION = 1;
export type CourseDepth = 'deep' | 'index' | 'reference' | 'deferred';
export type ConceptPriority = 'core' | 'support' | 'implementation' | 'deferred';
export interface CourseCoverage {
    scope: string;
    depth: CourseDepth;
    reason: string;
}
export interface CourseConcept {
    id: string;
    name: string;
    priority: ConceptPriority;
    definition: string;
    introducedIn: string;
    prerequisites: string[];
    sources: string[];
}
export interface CourseLesson {
    id: string;
    title: string;
    previousOutput: string;
    output: string;
    prerequisites: string[];
    evidence: string[];
    boundary: string;
}
export interface CourseRun {
    id: string;
    title: string;
    goal: string;
    entryState: string;
    endState: string;
    evidence: string[];
    lessons: CourseLesson[];
}
export interface CourseBlueprint {
    version: typeof COURSE_SCHEMA_VERSION;
    courseId: string;
    title: string;
    outcomes: string[];
    sourceRoots: string[];
    coverage: CourseCoverage[];
    concepts: CourseConcept[];
    runs: CourseRun[];
}
export interface CourseInventoryRoot {
    label: string;
    path: string;
}
export interface CourseInventoryFile {
    root: string;
    path: string;
    extension: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
}
export interface CourseInventorySkip {
    path: string;
    reason: string;
}
export interface CourseInventory {
    version: typeof COURSE_SCHEMA_VERSION;
    courseId: string;
    createdAt: string;
    roots: CourseInventoryRoot[];
    files: CourseInventoryFile[];
    skipped: CourseInventorySkip[];
}
export type CourseStatus = 'preparing' | 'review' | 'active' | 'stale';
export interface CourseState {
    version: typeof COURSE_SCHEMA_VERSION;
    status: CourseStatus;
    courseId: string;
    title: string;
    blueprintPath: string;
    blueprintHash: string;
    inventoryPath: string;
    inventorySignature: string;
    activatedAt?: string;
    currentRun?: string;
    currentLesson?: string;
    previousOutput?: string;
    mapSlice?: string;
    updatedAt: string;
}
export interface CourseValidationReport {
    errors: string[];
    warnings: string[];
}
/** 从课程母图的围栏代码块中读取结构化数据。 */
export declare function parseCourseBlueprint(markdown: string): CourseBlueprint;
export declare function validateCourseBlueprint(blueprint: CourseBlueprint, inventory?: CourseInventory): CourseValidationReport;
/** 来源签名只由稳定元数据组成，不受遍历顺序影响。 */
export declare function courseInventorySignature(inventory: CourseInventory): string;
export declare function findLesson(blueprint: CourseBlueprint, runId: string, lessonId: string): {
    run: CourseRun;
    lesson: CourseLesson;
} | undefined;
/** 为课程建立全文件来源清单；只读来源根并保存文件元数据。 */
export declare function buildCourseInventory(courseId: string, roots: string[], options?: {
    maxFiles?: number;
    skipDirs?: string[];
    now?: Date;
}): Promise<CourseInventory>;
export declare function resolveCourseRoot(value: string, cwd?: string): string;
