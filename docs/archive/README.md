# docs/archive — 历史文档归档

> 这里放**已完成、已被取代或仅供溯源**的文档。当前有效文档在 `docs/` 根目录与 `docs/check/`。
> 归档不等于删除：历史结论、复盘方法论、用户反馈原件都保留，只是不再作为执行依据。

## 归档判据（三条满足其一即归档）

1. **已完成**：文档里的事项全部落地，且落地结果已在当前代码/文档中体现；
2. **已取代**：内容被更新版本文档覆盖（如卡片格式规范 → `presets/study/skills/card-format/SKILL.md`）；
3. **仅供溯源**：需求/设计的历史原稿，保留用于解释"为什么当初这样设计"。

**不归档**：当前文档——文档地图 `docs/README.md`、操作手册 `docs/用户使用指南.md`、设计文档 `docs/设计文档.md`、
技术文档 `docs/技术文档.md`、经验文档 `docs/经验文档.md`、验证脚本 `docs/check/prompt-verify-all-features.md`。

## 目录

### `design/` — 设计与体检历史

| 文档 | 是什么 | 为什么归档 | 当前口径在哪 |
| :-- | :-- | :-- | :-- |
| `card-format-2026-09-redesign-proposal.md` | 卡片格式与质量重设计提案（P0/P1/P2 三层） | **已全部落地**（v0.6.0–v0.8.0） | `docs/设计文档.md` |
| `design-2026-09-card-framework-landing-record.md` | 本轮重设计的落地记录与验收（按 P0/P1/P2 逐项对照） | 内容已并入 `docs/设计文档.md`（设计）与 `docs/技术文档.md`（实现） | `docs/设计文档.md`、`docs/技术文档.md` |
| `DeepSeekHarness —— 通用学习 Agent.md` | 项目早期需求与交互设计稿 | 卡片格式与交互细则已被技能取代（文件头也已自标"历史需求文档"） | `presets/study/skills/card-format/SKILL.md`、`study-loop/SKILL.md` |
| `health-check-2026-08-21.md` | v0.3.0 全面体检（定义提取 P0 修复 + 8 项加固） | 问题全部修复，8 项建议全部实施（测试 70 → 81 → 209） | 代码即口径；本仓库测试与 `docs/用户使用指南.md` |

### `dev-experience/` — 开发经验与故障复盘

| 文档 | 是什么 | 为什么归档 | 仍然有效的结论 |
| :-- | :-- | :-- | :-- |
| `postmortem-2026-08-21-tools-not-registered.md` | vaultRoot == cwd 时 9 个工具静默不注册的复盘 | 故障已修（fail-loud），版本停在 0.3.0 语境 | fail-loud 设计、`tests/apply.spec.ts` 回归仍生效 |
| `postmortem-2026-08-23-vault-subfolder-reorganization.md` | vault 子文件夹重组 + `card_id` 预生成 ID 的两个坑 | 事件已处理完毕 | `domainFolders` 是配置而非约定；`card_create` 不消费 `card_id` 预取值（已写进工具描述） |
| `dev-experience-2026-08-four-features.md` | 四需求落地会话实录（自迭代开关/开场门禁/图片提取/阶梯式解剖） | 该轮已发布（v0.4.0） | 纯函数优先、技能关键词断言钉住等方法论 |
| `dev-experience-2026-09-experience-report-fixes.md` | 五轮体验报告修复实录（v0.3.0 → v0.4.0） | 该轮已发布 | "版本号是最后一刀""工作区外数据先备份+唯一锚点校验" |
| `dev-experience-2026-09-platform-adaptation.md` | dsh 0.1.3-alpha.1 平台适配实录（v0.4.0 → v0.5.0） | 适配已完成 | `session.events` → `snapshotEvents()` 双形状探测仍生效 |
| `dev-experience-2026-09-card-framework-redesign.md` | 本轮重设计会话实录（v0.5.0 → v0.8.0） | 内容已并入 `docs/经验文档.md`（并补充了文档归档与行尾两坑） | 规则类需求先只读校准、成对结构用状态机、新旧值互为子串时先排除新值 |

### `review/` — 审查与复审报告（原件）

两轮代码审查的**时间点快照**：首轮（v0.8.0 重构后，`01`~`06`）+ 复审（v0.9.0 修复后，`07`）。
结论与逐项修复状态已回填到现行台账 [`docs/审查修复记录.md`](../审查修复记录.md)，报告本身不再改动。

| 文档 | 是什么 | 为什么归档 | 当前口径在哪 |
| :-- | :-- | :-- | :-- |
| `01-隐私与安全.md` | SEC-1~SEC-8 安全审计 | 47 项发现全部处置完毕（38 修 / 5 部分 / 2 不修 / 1 文档化 / 1 无需动作） | `docs/审查修复记录.md` §二 |
| `02-复杂度与可维护性.md` | CPLX-1~CPLX-11 度量与死代码 | 同上 | 同上 |
| `03-可拓展性.md` | EXT-1~EXT-8 扩展点评估 | 同上 | 同上 |
| `04-业务质量.md` | BIZ-1~BIZ-12（含 2 个 blocker） | 同上 | 同上 |
| `05-性能表现.md` | PERF-1~PERF-8 实测与对照 | 同上（复测数据见 `07` §六） | 同上 |
| `06-架构决策.md` | ARCH 六问（挑战式评审） | 同上 | `docs/审查修复记录.md` §2.7 |
| `07-复审-修复验收.md` | 第二次审查：blocker 探针验收 + 15 条修复副作用（N1~N15） | 15 条副作用已于 v0.9.1 全部修复 | `docs/审查修复记录.md` §三 |

> 报告内的行号、路径与章节引用均为**当时状态**，不随代码更新改写——这是有意的：它记录了"当时看到了什么"。

### `experience-reports/` — 用户侧体验报告（原件）

五次真实学习会话的体验报告（L16 / GAMES101 L20 / B17 表面着色器 / PBR 18-20 / GAMES101 L21-22 收尾）。
全部**已闭环**：报告里提的建议都已落地（工具描述补充、`card_moc` 日期前缀剥离、定义长度分级、进度单一来源提示、`card_lint` 等）。
保留作需求溯源与回归对照；未来若要复跑"体验报告 → 修复"链条，从这里取原始输入。

> 注：此前散落在 `docs/Experience Report/done/` 与 `docs/Experience Report/archive/`（含空格目录名）的报告已统一并入本目录。

## 归档后如何找当前口径

| 想了解 | 看这里 |
| :-- | :-- |
| **全部文档地图（先看这个）** | `docs/README.md` |
| 怎么用（安装/配置/工具/格式/排障） | `docs/用户使用指南.md` |
| 卡片该写成什么样 | `presets/study/skills/card-format/SKILL.md` |
| 为什么这样设计（架构、模板、决策取舍） | `docs/设计文档.md` |
| 怎么实现（API、规则表、配置、测试布局） | `docs/技术文档.md` |
| 本轮踩了什么坑、有什么可复用技巧 | `docs/经验文档.md` |
| 2026-09 审查发现了什么、修了没有、为什么不修（含复审 15 条） | `docs/审查修复记录.md`（§二 首轮状态、§三 复审处置） |
| 全功能验证怎么跑 | `docs/check/prompt-verify-all-features.md` |
| 特性/性能/更新记录/隐私 | `README.md` |
