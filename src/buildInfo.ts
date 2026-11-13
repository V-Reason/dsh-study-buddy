/**
 * 构建信息：发行产物由 build.mjs 注入真实版本；源码单测使用 dev 标记。
 *
 * Mermaid/JSDOM 必须是构建期内联产物。把状态暴露在启动日志与 note_library
 * 里，版本错位或回退到运行时包解析时能当场看出，而不是等 Mermaid 工具调用失败。
 */
declare const __DSH_STUDY_BUDDY_VERSION__: string

export const PLUGIN_VERSION = typeof __DSH_STUDY_BUDDY_VERSION__ === 'string'
  ? __DSH_STUDY_BUDDY_VERSION__
  : 'dev'

export const ARTIFACT_LABEL = 'Mermaid/JSDOM 已内联'
export const ARTIFACT_MARKER = `dsh-study-buddy-artifact:v${PLUGIN_VERSION}:bundled-mermaid-jsdom`
