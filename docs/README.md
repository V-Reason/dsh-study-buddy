# docs — 文档地图

> 版本基线：v1.0.0 ｜ 读者：使用者、插件维护者、二次开发者
>
> 本文件是 `docs/` 的**单一导航入口**：每份文档负责什么、改代码时该同步哪一份、什么情况下归档。
> 逐键配置与工具行为看 `用户使用指南.md`；"为什么这样设计"看 `设计文档.md`；"怎么实现"看 `技术文档.md`；
> **本轮重构的来龙去脉**看 `需求分析.md` → `架构选型.md` → `重构计划.md` 三份；
> "踩过什么坑"看 `经验文档.md`；v0.9 时期的审查台账见 `审查修复记录.md`（明细在 `archive/review/`）。

---

## 一、文档一览

| 类别 | 文档 | 负责什么 | 什么时候更新 |
| :-- | :-- | :-- | :-- |
| **需求** | [`需求分析.md`](需求分析.md) | v1.0 重构的**需求基线**：30 条决策、术语、功能与非功能需求、验收总纲、范围边界、风险 | 需求变更（新增/推翻决策）时追加并更新决策表 |
| **架构** | [`架构选型.md`](架构选型.md) | **怎么做**：模块划分、18 个工具契约、数据契约、硬门禁机制、配置变更、扩展点、验收门 | 接口/模块边界变化时 |
| **计划** | [`重构计划.md`](重构计划.md) | **按什么顺序做**：8 个阶段、批次门禁、测试资产处置、回归策略、实测记录、**计划偏离记录** | 每批完成时回填看板与实测；偏离时记一行 |
| **现行** | [`用户使用指南.md`](用户使用指南.md) | 安装部署、逐键配置、18 个工具、笔记规范、Obsidian 配合、检索技巧、排障 | 用户可见行为/配置/报错文案变化 |
| **现行** | [`设计文档.md`](设计文档.md) | 笔记定位、期望驱动、**硬门禁机制**、架构分层、关键决策（D1~D23）与取舍、扩展点、验收门 | 新增/推翻设计决策，或扩展点变化 |
| **现行** | [`技术文档.md`](技术文档.md) | 模块 API、工具契约、lint 规则表、配置键、错误语义、性能与缓存、测试布局 | 接口/规则/配置/性能模型变化 |
| **现行** | [`经验文档.md`](经验文档.md) | 过程方法论与踩坑（两轮：§一~§四 v0.9、§五~§八 v1.0） | 每轮迭代结束，沉淀新的坑与技巧 |
| **台账** | [`审查修复记录.md`](审查修复记录.md) | v0.9 两轮审查的**结论 + 逐项修复状态 + 为什么不修**（历史台账，仅溯源） | 不再更新；新问题走需求/设计文档 |
| **验证** | [`check/prompt-verify-all-features.md`](check/prompt-verify-all-features.md) | 全功能验证开场提示词（v1.0：重点验证**三条硬门禁真的挡住写入**） | 新增/修改用户可见行为时补验证项 |
| **归档** | [`archive/README.md`](archive/README.md) | 历史文档索引（审查报告原件、提案、早期需求稿、体检、复盘、体验报告） | 文档被取代/已完成/仅供溯源时 |
| **权威细则** | [`../presets/study/skills/*/SKILL.md`](../presets/study/skills/) | 6 个技能的执行口径（study-loop / note-format / file-reading / incremental-update / domain-adaptation / memory-auto） | 技能行为变化（与 persona 一起改） |
| **默认模板** | [`../presets/study/assets/笔记期望.md`](../presets/study/assets/笔记期望.md) | 用户复制到 vault 根的《笔记期望.md》默认内容（笔记写法的单一来源） | 想调整"默认写法建议"时（**不改代码**） |

根目录 [`README.md`](../README.md) 是**项目门面**：特性、性能与成本、原理、快速开始、配置速查、隐私与更新记录。

---

## 二、改代码要同步哪些文档

| 改了什么 | 必须同步 | 建议同步 |
| :-- | :-- | :-- |
| 用户可见行为 / 报错文案 / 配置键 | `用户使用指南.md`（§4 配置表、§11 排障表）、`README.md` 配置表 | 验证提示词 |
| 新增/删除 lint 规则 | `lint.ts` 的 `RULES` → 工具描述自动跟随；`技术文档.md` 规则表、`用户使用指南.md` §7.13 | `设计文档.md` D16/D17 |
| 新增工具 / 改工具 schema | `技术文档.md` §3、`用户使用指南.md` §7、`README.md` 工具一览 | `tests/tools.spec.ts` 名字集合、`tests/apply.spec.ts` 工具数 |
| 硬门禁的判定或文案 | `gate.ts` → `设计文档.md` §3、`用户使用指南.md` §6.6 拒绝文案表 | 验证提示词第 2 部分（门禁专项） |
| frontmatter 键变化 | `frontmatter.ts` → `技术文档.md` §5.1、`用户使用指南.md` §8.3、`note-format/SKILL.md` | `tests/frontmatter.spec.ts` 往返 |
| 目录/微目录格式变化 | `dirs.ts` 与 `index.ts` 的 `noteToc` → `用户使用指南.md` §7.9、`note-format/SKILL.md` | `tests/noteflow.spec.ts` |
| 覆盖度口径变化 | `overview.ts` → `用户使用指南.md` §7.6、`设计文档.md` D14/D15 | `tests/overview.spec.ts` |
| 存档/回退行为变化 | `archive.ts` → `用户使用指南.md` §7.12、`设计文档.md` D9/D10 | `tests/gate.spec.ts` 存档段 |
| 决策推翻或新增取舍 | `设计文档.md` 决策表（新编号）+ `重构计划.md` §九 偏离记录 | `经验文档.md` |
| 性能模型 / 缓存策略 | `技术文档.md` §7、`设计文档.md` D2/D19/D20 | `用户使用指南.md` §12 |
| preset 配置键 / persona / 技能 | `presets/study/**` + `用户使用指南.md` §4 | `tests/preset.spec.ts`（config 键一致 + persona 不提旧工具）、`tests/skills.spec.ts` |
| 版本号 | `package.json` + `dsh.plugin.json`（两处必须一致）、`README.md` 更新记录、各现行文档头部基线 | `经验文档.md` 结果行；`tests/docs.spec.ts` 会校验头部基线 |
| 构建产物布局 | `build.mjs` | `技术文档.md` §1（产物自检） |

> 版本号是**最后一刀**：代码、测试、文档全部到位后再改，改完跑一次 `pnpm run check` 并核对两个 manifest。

---

## 三、三条约定

1. **口径单一来源**：同一事实只在一处定义——lint 规则在 `src/lint.ts` 的 `RULES`、块契约在 `src/note.ts`、
   门禁判定在 `src/gate.ts`、frontmatter 键在 `src/frontmatter.ts`、笔记写法在**用户自己的**《笔记期望.md》、
   技能细则在 `presets/study/skills/*/SKILL.md`。文档是它的**投影**，不是第二份定义。
2. **能被解析的就不靠自觉**：领域键表、preset config 键、persona 是否仍提旧工具、
   默认期望模板的检查项语法、文档相对链接/锚点与头部版本基线，全部由
   `tests/skills.spec.ts` / `tests/preset.spec.ts` / `tests/docs.spec.ts` 断言。
   文档里的数字（测试项数、工具数、模块数）改了要一起改。
3. **审查报告与历史快照不改写**：`docs/archive/review/01~07` 与 `审查修复记录.md` 是 v0.9 的**时间点快照**，
   保持当时状态；v1.0 的新问题走 `需求分析.md` / `设计文档.md`，不回头改历史报告。
   归档文档同理（见 `archive/README.md` 的归档判据）。

---

## 四、维护检查清单

发布或提交前，逐条过一遍：

- [ ] `pnpm run check` 全绿（typecheck → vitest → esbuild）
- [ ] `package.json` 与 `dsh.plugin.json` 版本一致，`README.md` 更新记录已加一条
- [ ] 各现行文档头部的"版本基线"已同步
- [ ] 新增/删除的规则、工具、配置键已在 §二 对应的文档中同步
- [ ] 文档里的数字（测试项数、工具数、模块数）与实际一致
- [ ] 文档内的相对链接与锚点可跳转（标题改名后尤其注意）
- [ ] `src/` 与 `presets/` 中不再出现已退场概念（`card_*`、`templateHints`、`mocDir`、三型模板）
- [ ] `lib/types/` 已由构建重建（删掉的模块不残留 `.d.ts`）
- [ ] 被取代的文档已移入 `docs/archive/` 并在 `archive/README.md` 登记
