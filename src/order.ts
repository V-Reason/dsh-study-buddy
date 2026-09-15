/**
 * 排序口径（唯一来源）。
 *
 * **为什么不能直接用 `a.localeCompare(b)`**：不传 locale 时它按**宿主环境**的默认
 * locale 比较，同一份 vault 在不同机器/CI 上会列出不同顺序。v1.0.0 就是这么在 CI 上
 * 红的——本机 zh-CN（`计算方法` 在前，拼音 ji < suan），GitHub runner 的 en-US 走
 * 根排序（`算法设计与分析` 在前，按部首）。排序看起来只是"顺序"，但它是**用户可见
 * 结果**：`note_list` 子目录、`note_overview` 的资料分组、`note_history` 的存档列表
 * 都会跟着变。所以这里 pin 死一个 locale，让结果只由内容决定。
 *
 * **为什么不用"纯码位比较"**：`<`/`>` 比码位确实最确定，但中文会排成"看起来随机"
 * 的顺序；本插件面向中文 vault，拼音序才是用户预期。代价是依赖 Node 自带 ICU 的
 * zh 数据（官方构建含 full-ICU）——若某环境缺这份数据，`tests/order.spec.ts` 会红，
 * 不会静默退化。
 *
 * **为什么不做"纯 ASCII 走码位、其余走排序器"的快路径**：两种比较器混用会破坏
 * **传递性**——排序器认为 `a < A < B`，码位认为 `A < B < a`，于是 `a < A < B < a`
 * 成环，`Array.prototype.sort` 的结果将不再确定。要快就得全都快，要确定就得全都
 * 确定，这里选后者。
 *
 * @module order
 */

/**
 * 排序器：中文按拼音（`zh-Hans-CN`），数字按数值（`第2章` 排在 `第10章` 之前，
 * 这正是插件自己推荐的目录命名）。
 */
const COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true })

/**
 * 文本全序比较：唯一允许出现在 `src/` 的排序口径。
 *
 * 排序器对个别"等价但不同"的串（如不同 Unicode 规范化形式）会返回 0，
 * 此时回落到码位比较，保证任意两个不同字符串都有稳定先后。
 */
export function compareText(a: string, b: string): number {
  if (a === b) return 0
  const diff = COLLATOR.compare(a, b)
  if (diff !== 0) return diff
  return a < b ? -1 : 1
}
