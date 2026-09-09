# 卡片框架重设计（2026-09）：落地记录与验收

> ⚠ **已归档**：本文件是按 P0/P1/P2 逐项对照的**落地记录**；现行设计口径已整理为
> `docs/设计文档.md`（设计）与 `docs/技术文档.md`（实现），过程方法论并入 `docs/经验文档.md`。
> 输入：`docs/archive/design/card-format-2026-09-redesign-proposal.md`（提案，已全部落地 → 归档）
> 产出：框架重设计 + P0/P1/P2 三层落地（顺序执行），`pnpm run check` 全绿（typecheck + 209 项测试 + 构建）
> 版本：0.5.0 → **0.8.0**（P0 落 0.6.0、P1/P2 落 0.8.0）
> 边界：**未改动任何真实 vault**（用户选择"不碰真实 vault"）；所有验收在临时目录与构造样本上完成

---

## 1. 框架重设计（地基，一次成型）

### 1.1 问题

原实现把"卡片该长什么样"写成 `src/card.ts` 里一个常量数组 + 字符串 `includes` 校验，
正文是一整块字符串；每加一条规则都要改多处，P1/P2 会被卡住。

### 1.2 新模块边界

| 模块 | 职责 |
| :-- | :-- |
| `src/cardmodel.ts` | 段落模型：`splitSections` / `renderSections` / `matchesTitle` / `insertBlockBefore` / `blankOutBlocks` |
| `src/template.ts` | 模板注册表：理论型/工程型/对比型 + 自动推断 + 小节齐备度校验 |
| `src/lintrules.ts` | 规则判定（纯函数）+ 共享正则常量（会话残留白名单在此） |
| `src/lint.ts` | lint 引擎：规则权重、打分、单卡报告、批量汇总 |
| `src/history.ts` | 版本更新/勘误/`<details>` 历史块：定位、插入位置、list、strip、配对校验 |
| `src/rename.ts` | 改名：标题替换、关联行重写、wikilink 重写、断链检测、文件名计划 |
| `src/insight.ts` | P2：跨卡一致性、质量趋势、可执行性评级 |
| `src/tools.ts` | 12 个工具定义（从 `index.ts` 抽出，schema 即文档） |
| `src/index.ts` | `VaultStore`（业务）+ `apply`；re-export 既有公开符号，测试导入路径不变 |

**关键兼容口径**：小节标题匹配为"精确相等，或以规范标题开头且紧跟括号/冒号"——
存量卡片的 `### 阶梯式解剖（第 1 层 → 第 4 层）`、`### 核心思想（直击）` 仍被识别，不会被误判缺节。

### 1.3 新增/变更契约

| 契约 | 内容 | 兼容性 |
| :-- | :-- | :-- |
| frontmatter `模板` | 可选字段（理论型/工程型/对比型） | 旧卡无此键 → 自动推断；五键 schema 未变 |
| `CardInput.template` | `card_create` / `card_update(replace)` 可选参数 | 不传则推断 |
| `lint` 配置 | `lint.residueLevel`（off/warn/error）、`lint.rulesOff` | 缺省 warn、无禁用 |

---

## 2. P0（v0.6.0）：堵住已暴露的 6 个缺陷

| # | 提案项 | 落地 | 验收证据 |
| :-- | :-- | :-- | :-- |
| P0-1 | `card_lint` 工具 | `src/lint.ts` + 注册 | 单卡/批量/规则过滤/跨卡/趋势/评级六种输出；`tests/lint.spec.ts` 18 项、`tests/store.spec.ts` 端到端 4 项 |
| P0-2 | 会话残留规则集 | `src/lintrules.ts` | 6 类命中 + 4 组白名单反例单测（`L0/L1/L2`、`LOD`、`GAMES101 L15`、代码块与 `<details>` 内、引用块内第二人称） |
| P0-3 | 版本块插到关联卡片之前 | `src/card.ts` → `insertHistoryBlock` | `tests/history.spec.ts` 断言 `阶梯式解剖 < 版本更新 < 关联卡片`；端到端读盘验证 |
| P0-4 | `card_history` list/strip | `src/history.ts` | strip 后正文与关联保留、历史块消失；未闭合 `<details>` 只警告不删 |
| P0-5 | `card_rename` | `src/rename.ts` + store 方法 | 改名后旧文件消失、新文件标题正确、另一张卡入链同步、`card_search` 用新标题命中；`dryRun` 不写盘；旧笔记拒绝 |
| P0-6 | 关联块归一 + 双向去重 | `src/card.ts addLink` | 标题相同/ID 相同两向都跳过；新写入格式 `` - 标签：`标题`（ID） `` |

**会话残留规则与白名单（实证校准，真实 vault 只读抽样 223 张卡后定稿）**

| 规则 | 判定 | 白名单 |
| :-- | :-- | :-- |
| 路径 | 盘符路径 / `Assets/` / 源码扩展名 | `.md` 引用（卡片互引合法） |
| 行号 | `L\d+`，仅当紧跟文件名或成 `L35-55` 区间 | `L0/L1/L2`、`L2 正则化`、`LOD`、`GAMES101 L15`、`第 15 讲` |
| 第二人称 | `你/你的/我们/咱们` | 引用块内、代码块内 |
| 时间词 | `上次/本次/刚才/刚刚/昨天/前天/前几讲` | `今天`（可作口语化定义）、代码块、`<details>` |
| 阶段代号 | `P0-P3`、`W1-W9` | `M1/M2/M3` 默认不报，仅同行含"工程/阶段/里程碑"时提示 |
| 会话词 | `本工程/本卡会话/实测/排查顺序/先证据后结论/课上` | 单独的"会话"不报 |

> 抽样结论：223 张卡中，严格正则命中 55 张（其中大量为球谐带 `L0/L1/L2` 与讲义引用 `L15` 的误伤）。
> 收紧 + 白名单后，构造样本上零误伤；真实 vault 未写入、未批量迁移（提案 §3.3「存量旧卡不强迁」）。

---

## 3. P1（v0.8.0）：模板分型与结构规范

| # | 提案项 | 落地 |
| :-- | :-- | :-- |
| P1-1 | `template` 参数 + 按型拆分小节 | `src/template.ts`（三型注册表 + `inferTemplate`），`card_create` 回显推断结果 |
| P1-2 | 自测题格式与答案校验 | `checkSelfTest`（`Qn` 规范写法、缺答案、`1./2.` 漂移） |
| P1-3 | 代码块语言标注校验 | `checkCodeFences`（成对识别开闭栅栏，避免把闭栅栏算成未标块） |
| P1-4 | 层级序号校验（4~6 层） | `checkLayers`（层数区间 + 1→N 连续 + 是否有序号） |
| P1-5 | 领域标签归一 | `checkDomainTags`（只判"根域+子域混挂"，`Cook-Torrance` 类关键词不误报） |
| P1-6 | 四个新小节进模板与 lint | `重入点`/`前置检查`/`验证实验`/`排障判据` |
| P1-7 | 定义字数维持、正文不设限 | 代码无正文长度校验；persona/技能/指南/README 全部删除"≥400 字/600~1500/≥~500 字"口径 |

**模板分型（提案 §4.2 原样落地）**

| 模板 | 回答 | 必填小节 |
| :-- | :-- | :-- |
| 理论型 | 为什么 | 核心思想 / 主干线 / 阶梯式解剖 / 实例走查 / 易错点 / 自测题 |
| 工程型 | 怎么做 | 上述 + 验证实验（≥3 步）+ 排障判据 |
| 对比型 | 怎么选 | 核心思想 / 主干线 / 对比表 / 选型口诀 / 场景走查 / 易错点 / 自测题 |

推断：标题含对比/谱系/选型/取舍 → 对比型；领域落在图形学/Unity/Shader/渲染族或标题含接入/配置/参数/坑/实现/源码/变体 → 工程型；其余 → 理论型。

**文档同步（§6.4）**

- `presets/study/agent.cordis.yml`：新增「卡片分型」「反堆砌三规则」两节；格式红线改为"正文不设上下限 + 四层序号 + 关联行归一"。
- `presets/study/skills/card-format/SKILL.md`：按 §4 全文重写（通用骨架、三型必填表、可读性规范、工程型完整样张、维护三件套）。
- `presets/study/skills/study-loop/SKILL.md`：归档清单改为"分型必填小节 + `card_lint` 自检"；触发词表新增 history/rename。
- `presets/study/skills/incremental-update/SKILL.md`：版本块位置口径 + `card_lint` 复核 + `card_history` 清理。
- `docs/用户使用指南.md`：工具 9 → 12、格式章节（8.1~8.5）重写、7.7~7.11 新增工具参考、测试计数与目录结构同步。
- `README.md`：特性、卡片格式、配置表（`lint.*`）、工具一览、更新记录同步。

---

## 4. P2（v0.8.0）：长期价值

| # | 提案项 | 落地 | 说明 |
| :-- | :-- | :-- | :-- |
| P2-1 | 跨卡一致性 | `card_lint({scope:'vault', cross:true})` | 抽取表格首两列与行内公式赋值，同键多值 → 冲突组（如 π 标尺 3.14 vs 3.1416） |
| P2-2 | 质量趋势 | `card_lint({scope:'vault', trend:true})` | 按卡片 ID 日期归 ISO 周，输出张数/均分/短板规则/整体趋势 |
| P2-3 | 可执行性评级 | `card_lint({rating:true})` + 单卡默认附评级 | 能跑（代码 + 验证实验）/ 能查（排障判据或对比表）/ 只能读 |
| P2-4 | 复习元数据 | **未做**（提案 §6.3 明确"先不做"） | 写入 README/指南路线图 |

---

## 5. 验收

| 项 | 结果 |
| :-- | :-- |
| `pnpm run check` | ✅ typecheck 通过；vitest **17 文件 / 209 项全绿**；esbuild 产出 `lib/index.js` 133.2kb |
| 工具数 | 9 → **12**（`card_lint` / `card_history` / `card_rename`），`tests/tools.spec.ts` 与 `tests/apply.spec.ts` 同步 |
| 规则误伤 | 白名单反例单测 4 组（球谐带 / 正则化 / 讲义引用 / 代码块与折叠块）全绿 |
| 存量格式兼容 | `### 阶梯式解剖（第 1 层 → 第 4 层）` 等括号变体不判缺节（单测钉住） |
| 构建产物自检 | `lib/index.js` 无 `@deepseek-ai` 运行时导入；冒烟加载输出 12 个工具名 |
| 真实 vault | **零写入**（只读抽样用于规则校准；未批量迁移） |
| 文档残留 | `≥~500 字` / `≥~400 字` / `600~1500` / `五小节` / `9 个工具` / `134 项` 全库 grep 为空 |

### 测试增量

| 文件 | 项数 | 覆盖 |
| :-- | --: | :-- |
| `tests/cardmodel.spec.ts` | 10 | 段落切分/往返/标题兼容/块抹除 |
| `tests/template.spec.ts` | 6 | 三型必填表、推断、变体兼容、提示渲染 |
| `tests/lint.spec.ts` | 18 | 14 条规则 + 白名单反例 + 评分/封顶 + 批量汇总 |
| `tests/history.spec.ts` | 9 | 插入位置、applyUpdate 接线、list/strip/配对 |
| `tests/rename.spec.ts` | 9 | 标题替换、入链重写、wikilink、断链、文件名计划 |
| `tests/insight.spec.ts` | 5 | 事实抽取、冲突、ISO 周、趋势、可执行性 |
| 既有文件增补 | +16 | 工具契约、store 端到端（lint/history/rename）、addLink 双向去重、模板校验 |

---

## 6. 后续（未做，留待下一轮）

1. **存量卡迁移**：223 张卡缺 `主干线`/`重入点`/`前置检查`/`验证实验`/`排障判据`，建议"下次整卡替换时按新模板重写"，不做批量脚本改写。
2. **复习元数据**：`lastReviewed`/`recallScore` + 遗忘曲线（提案 §6.3 明确先不做）。
3. **可执行性评级回写 MOC**：当前只输出分布，未写入 MOC 注释。
4. **真实 vault 基线**：本次按用户选择未跑；如需基线，用 `card_lint({scope:'vault'})` 只读跑一次即可。
