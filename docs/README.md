# docs — 文档地图

> 版本基线：v1.0.2 ｜ 读者：使用者、插件维护者、二次开发者
>
> 本文件是 `docs/` 的**单一导航入口**：哪份文档在哪里、负责什么、改代码时该同步哪一份、什么情况下归档。
> 逐键配置与工具行为看 [`用户使用指南.md`](用户使用指南.md)；"为什么这样设计"看 [`设计文档.md`](设计文档.md)；
> "怎么实现"看 [`技术文档.md`](技术文档.md)；**本轮重构的来龙去脉**看 [`refactor/`](refactor/) 三份过程文档；
> "踩过什么坑"看 [`经验文档.md`](经验文档.md)；逐版变更看 [`更新记录.md`](更新记录.md)。

---

## 一、目录布局与文档一览

```
docs/
├── README.md            本文件：地图与维护约定
├── 用户使用指南.md        现行·给使用者（安装/配置/18 工具/规范/排障/隐私）
├── 设计文档.md            现行·为什么这样设计（决策表 D1~Dn）
├── 技术文档.md            现行·怎么实现（模块/契约/配置/性能/测试布局）← 数字的唯一来源
├── 经验文档.md            现行·两轮过程方法论与踩坑
├── 更新记录.md            现行·逐版变更（README 首屏只留版本行）
├── refactor/            本轮重构的过程文档（交付后整体归档）
├── check/               验证脚本
└── archive/             历史快照（审查原件、早期设计稿、v0.9 台账）
```

仓库根的 [`../tools/`](../tools/README.md) 放**两条只读校验命令**（不属于 `docs/`）：`verify:contract`
管「插件 ↔ 本机 DSH 的平台契约」，`verify:deploy` 管「仓库产物 ↔ profile 安装副本 ↔ 部署预设 ↔ vault」。
DSH 升级后排障先跑它们，判读口径见 [`tools/README.md`](../tools/README.md)。

| 层 | 位置 | 文档 | 负责什么 | 什么时候更新 |
| :-- | :-- | :-- | :-- | :-- |
| **现行** | `docs/` | [`用户使用指南.md`](用户使用指南.md) | 安装部署、逐键配置、18 个工具、笔记规范、Obsidian 配合、检索技巧、排障、隐私 | 用户可见行为/配置/报错文案变化 |
| **现行** | `docs/` | [`设计文档.md`](设计文档.md) | 笔记定位、期望驱动、**硬门禁机制**、架构分层、关键决策（D1~Dn）与取舍、扩展点、验收门 | 新增/推翻设计决策，或扩展点变化 |
| **现行** | `docs/` | [`技术文档.md`](技术文档.md) | 模块 API、工具契约、lint 规则表、配置键、错误语义、性能与缓存、**测试布局（数字唯一来源）** | 接口/规则/配置/性能模型变化 |
| **现行** | `docs/` | [`经验文档.md`](经验文档.md) | 过程方法论与踩坑（两轮：§一~§四 v0.9、§五~§八 v1.0） | 每轮迭代结束，沉淀新的坑与技巧 |
| **现行** | `docs/` | [`更新记录.md`](更新记录.md) | 逐版变更（**唯一来源**）；根 README 只留一行版本号 | 每次发版 |
| **过程** | `refactor/` | [`需求分析.md`](refactor/需求分析.md) | 本轮重构的**需求基线**：30 条决策、术语、功能与非功能需求、验收总纲、范围边界、风险 | 需求变更（新增/推翻决策）时追加并更新决策表 |
| **过程** | `refactor/` | [`架构选型.md`](refactor/架构选型.md) | **怎么做**：模块划分、18 个工具契约、数据契约、硬门禁机制、配置变更、扩展点、验收门 | 接口/模块边界变化时 |
| **过程** | `refactor/` | [`重构计划.md`](refactor/重构计划.md) | **按什么顺序做**：8 个阶段、批次门禁、测试资产处置、回归策略、实测记录、**计划偏离记录** | 每批完成时回填看板与实测；偏离时记一行 |
| **验证** | `check/` | [`check/prompt-verify-all-features.md`](check/prompt-verify-all-features.md) | 全功能验证开场提示词（v1.0：重点验证**三条硬门禁真的挡住写入**） | 新增/修改用户可见行为时补验证项 |
| **验证** | `check/` | [`check/升级后验收清单.md`](check/升级后验收清单.md) | 升级 DSH/插件/预设后的验收清单（命令层 → 会话层 → 归档链路 → 定位顺序） | 部署形态或校验命令变化时 |
| **验证** | `check/` | [`check/验证报告-2026-09-15-学习伙伴预设实战检查.md`](check/验证报告-2026-09-15-学习伙伴预设实战检查.md) | v1.0.0 真机会话逐条跑 50 项的**实测结果**（含 P0 缺陷：`note_plan` 无确认入口）；时间点快照 | 不改写；修完另起一份新报告 |
| **验证** | `check/` | [`check/验证报告-2026-09-15-归档链路修复复验.md`](check/验证报告-2026-09-15-归档链路修复复验.md) | 上份报告的 **P0/P1/P2 逐条修复状态 + 复验证据**（含新查出的 `generatePlanId` 补零死锁）；源码级与命令层复验，会话层待重跑 | 会话层复验完成后在同一份里回填结论 |
| **归档** | `archive/` | [`archive/README.md`](archive/README.md) | 历史文档索引（审查报告原件、提案、早期需求稿、体检、复盘、体验报告） | 文档被取代/已完成/仅供溯源时 |
| **归档** | `archive/` | [`archive/审查修复记录.md`](archive/审查修复记录.md) | v0.9 两轮审查的**结论 + 逐项修复状态 + 为什么不修**（历史台账，仅溯源） | 不再更新；新问题走需求/设计文档 |
| **权威细则** | `presets/` | [`../presets/study/skills/*/SKILL.md`](../presets/study/skills/) | 6 个技能的执行口径（study-loop / note-format / file-reading / incremental-update / domain-adaptation / memory-auto） | 技能行为变化（与 persona 一起改） |
| **默认模板** | `presets/` | [`../presets/study/assets/笔记期望.md`](../presets/study/assets/笔记期望.md) | 用户复制到 vault 根的《笔记期望.md》默认内容（笔记写法的单一来源） | 想调整"默认写法建议"时（**不改代码**） |

根目录 [`README.md`](../README.md) 是**项目门面**：定位、快速开始、三条硬门禁、笔记样例、最小配置、隐私摘要、文档导航。

> **`refactor/` 的使用规则**：只放**当前这一轮**重构的需求/选型/计划三份；本轮交付完成后整体移入 `archive/`，
> 下一轮新建同名三份（历史不用改名，归档目录按轮次分组）。

---

## 二、改代码要同步哪些文档

| 改了什么 | 必须同步 | 建议同步 |
| :-- | :-- | :-- |
| 用户可见行为 / 报错文案 / 配置键 | `用户使用指南.md`（§4 配置表、§11 排障表） | 验证提示词 |
| 新增/删除 lint 规则 | `lint.ts` 的 `RULES` → 工具描述自动跟随；`技术文档.md` 规则表、`用户使用指南.md` §7.13 | `设计文档.md` D16/D17 |
| 新增工具 / 改工具 schema | `技术文档.md` §3、`用户使用指南.md` §7 | `tests/tools.spec.ts` 名字集合、`tests/apply.spec.ts` 工具数 |
| 硬门禁的判定或文案 | `gate.ts` / `planstore.ts` → `设计文档.md` §3、`用户使用指南.md` §6.6 拒绝文案表 | 验证提示词第 2 部分（门禁专项）、`presets/study/**`（persona 与技能里的动作名） |
| frontmatter 键变化 | `frontmatter.ts` → `技术文档.md` §5.1、`用户使用指南.md` §8.3、`note-format/SKILL.md` | `tests/frontmatter.spec.ts` 往返 |
| 目录/微目录格式变化 | `dirs.ts` 与 `index.ts` 的 `noteToc` → `用户使用指南.md` §7.9、`note-format/SKILL.md` | `tests/noteflow.spec.ts` |
| 覆盖度口径变化 | `overview.ts` → `用户使用指南.md` §7.6、`设计文档.md` D14/D15 | `tests/overview.spec.ts` |
| **排序 / 文本比较口径** | `order.ts` 的 `compareText` → `技术文档.md` §7、`设计文档.md` D24 | `tests/order.spec.ts`（源码守卫 + 换 locale 复现） |
| 存档/回退行为变化 | `archive.ts` → `用户使用指南.md` §7.12、`设计文档.md` D9/D10 | `tests/gate.spec.ts` 存档段 |
| 决策推翻或新增取舍 | `设计文档.md` 决策表（新编号）+ `refactor/重构计划.md` §九 偏离记录 | `经验文档.md` |
| 性能模型 / 缓存策略 | `技术文档.md` §7、`设计文档.md` D2/D19/D20 | `用户使用指南.md` §12 |
| preset 配置键 / persona / 技能 | `presets/study/**` + `用户使用指南.md` §4 | `tests/preset.spec.ts`（config 键一致 + persona 不提旧工具）、`tests/skills.spec.ts` |
| 版本号 | `package.json` + `dsh.plugin.json`（两处必须一致）、`更新记录.md` 加一条、各现行文档头部基线 | `经验文档.md` 结果行；`tests/docs.spec.ts` 会校验头部基线 |
| 模块数 / 测试文件数 / 测试项数 | 只改 `技术文档.md` §2、§8（否则改 `tests/docs.spec.ts` 的守卫算法） | —— 数字不再散落在 README/用户指南里 |
| 平台契约 / 部署形态变化 | `tools/README.md`（两条校验命令的分工与判读）、`用户使用指南.md` §11.2 | `tools/verify-contract.mjs` 的 `CONTRACTS` 表（含平台 `文件:行号`）、`tests/contract.spec.ts` |
| 文档位置变化 | 本文件 §一 + `tests/docs.spec.ts` 的版本基线名单 | 全仓相对链接由该测试逐条校验 |
| 构建产物布局 | `build.mjs` | `技术文档.md` §1（产物自检） |

> 版本号是**最后一刀**：代码、测试、文档全部到位后再改，改完跑一次 `pnpm run check` 并核对两个 manifest。

---

## 三、三条约定

1. **口径单一来源**：同一事实只在一处定义——lint 规则在 `src/lint.ts` 的 `RULES`、块契约在 `src/note.ts`、
   门禁判定在 `src/gate.ts`、frontmatter 键在 `src/frontmatter.ts`、**排序在 `src/order.ts`**、
   笔记写法在**用户自己的**《笔记期望.md》、技能细则在 `presets/study/skills/*/SKILL.md`、
   逐版变更在 `更新记录.md`、模块与测试数字在 `技术文档.md` §2/§8。文档是它的**投影**，不是第二份定义。
2. **能被解析的就不靠自觉**：领域键表、preset config 键、persona 是否仍提旧工具、
   默认期望模板的检查项语法、文档相对链接/锚点、头部版本基线、**模块数与测试项数**
   （`src/`、`tests/` 现算）、`src/` 中不得出现裸 `localeCompare`，全部由
   `tests/skills.spec.ts` / `tests/preset.spec.ts` / `tests/docs.spec.ts` / `tests/order.spec.ts` 断言。
3. **审查报告与历史快照不改写**：`archive/review/01~07`、`archive/审查修复记录.md` 与其余归档文档是**时间点快照**，
   保持当时状态（含当时的路径与行号）；v1.0 之后的新问题走 `refactor/需求分析.md` / `设计文档.md`，不回头改历史报告。

---

## 四、维护检查清单

发布或提交前，逐条过一遍：

- [ ] `pnpm run check` 全绿（typecheck → vitest → esbuild），CI 的非中文 locale 复跑同样全绿
- [ ] `pnpm run verify:contract` 全绿（含本机 DSH 时的平台探针；CI 无 DSH 则跳过探针）
- [ ] 动过预设/部署文档时另跑 `pnpm run verify:deploy -- -Profile web` 做终检
- [ ] `package.json` 与 `dsh.plugin.json` 版本一致，`更新记录.md` 已加一条
- [ ] 各现行文档头部的"版本基线"已同步
- [ ] 新增/删除的规则、工具、配置键已在 §二 对应的文档中同步
- [ ] 模块数、测试文件数、测试项数只在 `技术文档.md` §2/§8（守卫测试会现算比对）
- [ ] 文档内的相对链接与锚点可跳转（标题改名后尤其注意）
- [ ] `src/` 与 `presets/` 中不再出现已退场概念（`card_*`、`templateHints`、`mocDir`、三型模板）
- [ ] `src/` 中不再出现裸 `localeCompare` / `Intl.Collator`（排序只走 `order.ts`）
- [ ] 两份 manifest 的 `description` 不是旧口径（不复述"卡片库/MOC"）
- [ ] `lib/types/` 已由构建重建（删掉的模块不残留 `.d.ts`）
- [ ] 被取代的文档已移入 `archive/` 并在 `archive/README.md` 登记
