# dsh-study-buddy 重构后代码审查报告

- **审查对象**：`dsh-study-buddy` v0.8.0，commit `8e03995`（`refi: 重构`），对照基线 `1c71773`
- **审查日期**：2026-09-10
- **审查范围**：`src/`（16 文件 / 3932 行）、`presets/study/`（persona + 6 个技能）、`tests/`（18 文件 / 209 用例）、`README.md` 与 `docs/*.md` 的对外口径
- **审查方式**：逐文件静态阅读 + 关键分支探针复现（探针脚本临时写入 `tests/`，验证后已删除，复现方法见文末）+ 性能计时（本地 SSD）
- **基线事实（先摆事实，不作评价）**：`tsc --noEmit` 无输出（通过）；`vitest run` 209/209 通过；全仓无 `child_process`/网络客户端/`eval`；运行时依赖无环（`tools.ts → index.ts` 仅 `import type`，构建后不产生运行时环）

> 本报告只写问题，不写"整体设计良好"之类的客套话。正面结论集中在「6.1 方向是最简的」与下方"不应被推翻的部分"。

---

## 一、总体评审结论

**这是一次目标明确、方向正确、但收尾不干净的「可检测性重构」。**

1. **架构选型不该被推翻**：段落模型（`cardmodel`）+ 声明式模板（`template`）+ 规则引擎（`lint`）是解决"卡片腐化"的最小方案，没有引入数据库/服务/事件总线，数据仍是普通 `.md`。回退成本低（< 1 人日），说明这是一个**可逆的好决策**。
2. **但本轮重构在"数据一致性"上净收益为负**：新增的 `card_history strip` 会**删错内容**（BIZ-1，实测丢失整个「关联卡片」小节），`card_rename` 会在报错前**留下半改名状态**（BIZ-2）。重构前不存在这两条路径，所以这是**新引入的数据破坏面**，且现有 209 个测试全绿——绿灯没有覆盖到最关键的数据删除路径（CPLX-11）。
3. **"规则驱动"只落地了一半**：模板规格与 lint 结构检查是两套口径（EXT-2），`mainline` 字段定义了没人读，新增一条规则要改 4~5 处（EXT-1）；领域族判定硬编码在源码里（EXT-3）。
4. **性能不是本次目标，且被轻微恶化**：`refresh()` 的全库扫描没变，但工具从 9 个增加到 12 个，触发次数上升；`lint` 在索引已持有正文的情况下又全库读盘一遍（PERF-2）；同一份正文被解析 6 次（PERF-3）。本地 1000 卡规模下 0.05~0.5s/次，可接受；**同步盘（OneDrive/网络盘）上会到秒级**。
5. **安全面：没有经典注入，但有 1 个 blocker 级"文档结构注入"**：标题/定义里的换行与 `---` 未过滤，可截断 frontmatter、丢失元数据、伪造小节（SEC-1，实测）。另有一个跨盘符根目录守卫失效导致的整盘扫描与隐私外泄面（SEC-2）。
6. **文档与实现已经漂移**：工具描述说"旧笔记无模板要求"，实现照样套模板并打出 62 分（BIZ-4）；persona 的「格式红线」整段重复两遍（CPLX-9）。

**一句话结论**：**先把 2 个数据破坏 blocker 修掉（各约 20~40 行改动），再收敛规则/模板口径；性能与安全加固属于 P1，架构本身不需要动。**

---

## 二、高风险清单（blocker + 关键 warning）

### Blocker（3 项，必须修）

| 编号 | 位置 | 一句话 | 后果 |
| --- | --- | --- | --- |
| **BIZ-1** | `src/history.ts:157-176` | `stripHistory` 用原始行号去删重排后的文本 | **删掉无关正文**：实测丢失 `<details>` 剩余部分与整个 `### 关联卡片` 小节；手改卡多一个空行即触发 |
| **SEC-1** | `src/frontmatter.ts:49-59`、`src/card.ts:151-163`、`src/card.ts:72-134` | 标题/定义/来源/状态未过滤 `\n` 与 `---` | **frontmatter 被截断**：`领域/来源/状态/模板` 降级为正文，索引与 lint 依据全错，且无任何报错 |
| **BIZ-2** | `src/index.ts:536-547` | `rename` 的目标名冲突校验在**所有写入之后** | **半改名不一致**：报错后标题已改、入链已指向不存在的文件名、文件名未变 |

### 关键 Warning（按修复优先级排序）

| 优先级 | 编号 | 位置 | 一句话 |
| --- | --- | --- | --- |
| P1 | BIZ-3 | `src/index.ts:283`、`src/tools.ts:216` | `card_update` 缺 `sessionCwd` → `card_search` 回显的路径用不了（实测） |
| P1 | BIZ-4 | `src/tools.ts:275` vs `src/index.ts:405` | `scope=all` 把模板规则套到旧笔记（与描述相反，实测 62 分） |
| P1 | BIZ-6 | `src/card.ts:300-306` | `card_link` 全正文判重 → 静默跳过真实关联却报"已建立关联"（实测） |
| P1 | BIZ-7 | `src/index.ts:194,413,499`、`src/vault.ts:104,116` | 5 处读盘失败静默吞掉，报告数字仍显示"完整" |
| P1 | BIZ-5 | `src/index.ts:395-400` | 规则被禁用时输出"未通过（该规则无发现）"（实测） |
| P1 | SEC-2 | `src/index.ts:175`、`src/vault.ts:182` | `resolve('/')` 只等于当前盘根 → 跨盘符 cwd 会整盘扫描并出境 |
| P1 | CPLX-9 | `presets/study/agent.cordis.yml:58-70` | persona「格式红线」整段重复两遍（每轮固定 token + 未来漂移） |
| P2 | PERF-2/3 | `src/index.ts:411-423`、`src/lint.ts:139-280` | lint 重复读盘 + 每卡 6 次解析、3 次全文重建 |
| P2 | PERF-1 | `src/index.ts:184-205` | 每次工具调用全库 `walk+stat`（25ms@300 卡、61ms@1000 卡；同步盘放大） |
| P2 | PERF-6 | `src/search.ts:231-258` | 先对全部命中算 snippet 再截断；单字查询扫全库正文 |
| P2 | BIZ-8/9/10 | 见 `04-业务质量.md` | 重复建卡、`hasPriorUserMessage` 兜底缺失、`rename` dryRun 假"无断链" |
| P2 | EXT-1/2/4 | `src/lint.ts`、`src/template.ts`、`src/index.ts` | 规则注册点未收敛、模板与 lint 两套口径、`VaultStore` 上帝类 |
| P2 | SEC-4/5 | `src/index.ts:231`、`src/memory.ts:66` | 整卡原文/路径出境未披露；记忆是跨会话注入载体 |

完整清单见各维度文件（编号 `SEC-*`/`CPLX-*`/`EXT-*`/`BIZ-*`/`PERF-*`/`ARCH-*`）。

---

## 三、建议的修复顺序（含工作量估计）

### 第 0 批：数据安全（建议立即，合计约 1 天）

1. **BIZ-1**：`stripHistory` 改为"先删 details（用原始坐标系）→ 再删 version/errata 小节"。约 20 行改动 + 2 条回归用例（CPLX-11 给出的两个反例）。
2. **SEC-1**：`validateCard`/`validateDefinition` 拒绝 `\r\n`；`renderFrontmatter`/`renderCard`/`versionBlock`/`renderMoc` 统一把换行替换为空格。约 15 行 + 1 条用例。
3. **BIZ-2**：把 `fileExists(targetPath)` 与 `index.byTitle` 校验**前置**到任何写入之前；条件允许时加"写前缓存原文，异常时回滚"。约 20 行。

> 这三项修完，本轮重构的"净收益为负"就回到零，剩下的都是增量改进。

### 第 1 批：行为一致性（约 1 天）

4. **BIZ-3**：`update()` 增加 `call?: {sessionCwd}`（3 行）。
5. **BIZ-4 + CPLX-9**：`reportOf` 对 `kind === 'note'` 跳过结构类规则；删掉 persona 重复段落；工具描述改为由 `ruleIds()`/`templateTable()` 生成。
6. **BIZ-5**：`passed === undefined` 时输出"未启用"（3 行）。
7. **BIZ-6**：`addLink` 判重限定在「关联卡片」小节内（约 10 行）。
8. **BIZ-7**：`refresh`/`lint`/`rename` 累计 `skipped` 并在返回文本回显（约 15 行）。
9. **SEC-2**：改用 `parse(p).root === p` 判定根目录 + `walk` 加文件数/深度上限（约 10 行）。

### 第 2 批：性能与可维护性（约 2~3 天）

10. **PERF-2/3**：`IndexedCard` 增加 `template`，lint 复用 `card.body`；`splitSections`/`blankOutBlocks` 结果作为参数传入各检查函数。
11. **PERF-1**：`refresh` 加 2s TTL（1 行起）。
12. **PERF-6**：先排序取 top-limit 再算 snippet；单字 token 降权。
13. **EXT-1/2**：引入 `RULES` 注册表，`template-sections`/`mainline`/`walkthrough` 由 `templateSpec` 驱动。
14. **CPLX-1/2/3/5**：按文件里给出的拆分方案重排热点函数（纯重构，行为不变）。

### 第 3 批：可选项（视使用反馈）

15. **EXT-4**：拆 `CardRepository`/`LintService`/`MemoryService`（成本较高，等下一次功能扩展时再做）。
16. **ARCH-6.5-A/E**：评估"结构检查取代打分"与"删除 cross/trend/rating"，若无人使用则减负。
17. **SEC-4**：在 README/用户指南补「隐私」小节（内容出境披露）。

---

## 四、不应被推翻的部分（避免误伤）

- **`cardmodel` 段落模型**：方向正确，`insertBlockBefore`/`matchTitle`/`blankOutBlocks` 的语义清晰且有单测；问题是**没有被 `addLink`/`stripHistory` 真正复用**（ARCH-6.3-③），应扩大使用面而非回退。
- **`template` 声明式规格**：数据驱动的正确做法；只需让 lint 也读它（EXT-2）。
- **`tools.ts` 从 `index.ts` 抽离**：让"提示词资产"与业务逻辑分文件演进，方向正确。
- **fail-loud 的挂载策略**（`src/index.ts:664-689`）：配置错误直接抛错而不是静默不注册工具，是踩过坑之后的正确选择。
- **`atomicWrite`（临时文件 + rename）**、**`withinRoot` 路径复核**、**`readMemory`/`readProgress` 的逐字段白名单重建**：实现正确，无需要改。

---

## 五、复现方法（探针）

审查期间使用的探针脚本已删除（未污染仓库）。要复现关键结论，把下列片段写进 `tests/zz-probe.spec.ts` 后 `npx vitest run tests/zz-probe.spec.ts`：

| 结论 | 探针要点 |
| --- | --- |
| BIZ-1 | 构造含 `### 版本更新` + `### 易错点` + `<details>` + `### 关联卡片` 的正文，调 `stripHistory(body, {})`，断言输出仍含关联行且无未闭合 `<details>`（当前会失败） |
| BIZ-2 | 手工放一个同名 `.md`，再 `store.rename(id, 同名标题)`，捕获异常后读原文件：标题已改、入链已改（当前如此） |
| BIZ-3 | `includeSessionCwd: true` 下 `search(..., {sessionCwd})` 得到 `工作目录/x.md`，再 `store.update('工作目录/x.md', ...)`（当前抛"找不到卡片"） |
| BIZ-4 | 建一篇无 frontmatter 的 `.md`，`store.lint({scope:'all'})`（当前输出 62/100 + 模板必填小节） |
| BIZ-6 | 卡片「前置检查」小节写 `- 前置：甲`，再 `store.link(乙, 甲, 'prev')`，读乙文件（当前无关联小节） |
| SEC-1 | `renderCard({title: 'A\n---\n注入: x', ...})` 后 `parseFrontmatter`（当前 `meta` 只剩 id/title） |
| SEC-2 | `resolve('/')` 在 Windows 上等于当前盘根（`T:\`），跨盘符 cwd 不被拦截 |
| PERF-1/2/3/5/6 | 生成 300 / 1000 张卡后对 `search`/`lint`/`rename` 计时（本报告数据即此方法所得） |

---

## 六、维度报告索引

| 文件 | 内容 |
| --- | --- |
| `01-隐私与安全.md` | SEC-1~SEC-8：文档结构注入、跨盘符扫描、路径清洗、隐私出境、记忆注入、已核查无风险项 |
| `02-复杂度与可维护性.md` | CPLX-1~CPLX-11：函数长度/圈复杂度/嵌套、隐藏副作用、魔法值、死代码、文档漂移、测试盲区 |
| `03-可拓展性.md` | EXT-1~EXT-8：规则注册点、模板与 lint 双口径、领域族硬编码、上帝类、配置三份同构 |
| `04-业务质量.md` | BIZ-1~BIZ-12：2 个 blocker + 6 处"报告与实际不符"的静默错误 + 9 项细节缺陷 |
| `05-性能表现.md` | PERF-1~PERF-8：实测数据、重构前后对照、触发负载与可接受性判断 |
| `06-架构决策.md` | ARCH 六问：真实问题、优化目标达成度、新隐患、回退成本、更小的替代方案 |

---

## 七、修复状态（2026-09-10 回填，v0.9.0）

> 修复后基线：`pnpm run check` 全绿（typecheck + **17 文件 / 248 项测试** + 构建），`lib/index.js` 中 `@deepseek-ai` 计数 0，
> 冒烟 `study-buddy 12`。审查期间删除的探针已全部改写为**永久回归用例**（见「回归用例」列）。
> 未修项在表中给出理由，不静默跳过。

### 7.1 Blocker

| 编号 | 状态 | 落点 | 回归用例 |
| --- | --- | --- | --- |
| BIZ-1 | ✅ 已修复 | `stripHistory` 改为「先按原始坐标系删 `<details>` → 再按段落模型过滤版本/勘误小节」；`dropDetailsBlocks` 增加行号越界防御 | `tests/history.spec.ts` BIZ-1 探针 P2 / F 两条 |
| SEC-1 | ✅ 已修复 | 新增 `cardmodel.inlineText`（渲染兜底）+ `validateCard`/`validateDefinition`/`rename` 拒绝换行；`renderFrontmatter`/`renderCard`/`versionBlock`/`renderMoc`/`replaceCardTitle` 全部收敛 | `tests/card.spec.ts` SEC-1 ×2、`tests/store.spec.ts` SEC-1 |
| BIZ-2 | ✅ 已修复 | `rename` 拆 `planRenameAction`（全部冲突校验前置）+ `commitRename`（写前缓存 + 逆序回滚）；目标同名时抛「未做任何写入」 | `tests/store.spec.ts` BIZ-2 探针 P7 |

### 7.2 安全（SEC）

| 编号 | 状态 | 落点 / 说明 |
| --- | --- | --- |
| SEC-2 | ✅ 已修复 | `vault.isFsRoot`（`parse(resolve(p)).root === resolve(p)`）替换三处 `resolve('/')` 守卫；`walk` 增加 20000 文件 / 16 层安全阀并抛错 |
| SEC-3 | ✅ 已修复 | `sanitizeFilename` 增 `[`/`]` 与设备名兜底；`rename.ts` 删除重复实现改为复用；`renderMoc` 的 wikilink 目标清洗 |
| SEC-4 | 🟡 部分修复 | 已做：README「隐私」小节 + 用户指南「内容出境」+ `card_get` 描述标明返回完整原文。**不做**：`maxChars` 参数（避免多一个模型要猜的参数）、错误信息去掉绝对路径（配置错时该路径是唯一排障线索，且属用户自身环境） |
| SEC-5 | ✅ 已修复 | `MANDATE` 与 persona「跨会话记忆」补硬口径；memory-auto 技能补安全口径；`formatMemory` 对指令性开头给软提示（不拒绝写入） |
| SEC-6 | ✅ 已修复 | `normalizeMemoryKey` 拒绝 `__proto__`/`prototype`/`constructor` |
| SEC-7 | ✅ 已修复 | 新增 `external-resource` 规则（info 级、权重 0） |
| SEC-8 | ⏭️ 无需动作 | 已核查无该注入面，保留结论供后续审计免重复劳动 |

### 7.3 复杂度与可维护性（CPLX）

| 编号 | 状态 | 落点 |
| --- | --- | --- |
| CPLX-1 | ✅ 已修复 | `rename()` → `planRenameAction` / `commitRename` + 报告；`dryRun` 与实写共用同一规划路径 |
| CPLX-2 | ✅ 已修复 | `lint()` 拆 `lintOne` / `lintBatch`（内含 rule/cross/trend/rating 路由）+ `reportOfRaw`/`reportOfIndexed` |
| CPLX-3 | ✅ 已修复 | `RULES` 注册表（id/title/weight/severity/scope/run）；`lintCard` 从 158 行降到 ~40 行 |
| CPLX-4 | ✅ 已修复 | `scanResidue` 改数据表 + 单次遍历，白名单变 `guard(line, m)` 回调 |
| CPLX-5 | ✅ 已修复 | `memory()` 拆 `memoryGet` / `setControlKey` / `writeNote` |
| CPLX-6 | ✅ 已修复 | `refresh` → `ensureIndex`（JSDoc 写明每次可能全库 stat）；`SearchIndex.all()` 返回 `readonly`，新增 `roots()` |
| CPLX-7 | ✅ 已修复 | 抽 `REENTRY_CHARS` / `ERROR_SCORE_CAP` / `SCORE_BUCKET` / `MAX_FILENAME` / `FIELD_WEIGHTS`；`lint.ts` 直接 import `DEFINITION_MAX`（无环） |
| CPLX-8 | ✅ 已修复 | 删 `TEMPLATE_SECTIONS`/`sectionBody`/`hasHeading`/`headingLine`/`byRel`；`sectionHints`/`templateTable` 真正用于生成工具描述；`rename.ts` 复用 `sanitizeFilename` |
| CPLX-9 | ✅ 已修复 | 删 persona 重复「格式红线」；`card_lint` 描述由 `RULES` 生成；`scope=all` 描述改为与实现一致 |
| CPLX-10 | ✅ 已修复 | `splitSections` 改 `matchAll`，删手动 `lastIndex` |
| CPLX-11 | ✅ 已修复 | 补两条回归用例（探针 P2 / F），断言"关联小节与关联行仍在、无未闭合 `<details>`" |

### 7.4 可扩展性（EXT）

| 编号 | 状态 | 落点 / 说明 |
| --- | --- | --- |
| EXT-1 | ✅ 已修复 | 单一 `RULES` 注册表；`ruleIds()`/`ruleTitle()`/`card_lint` 描述/枚举全部派生 |
| EXT-2 | ✅ 已修复 | `template-sections`/`mainline`/`verify-experiment`/`troubleshoot-criteria`/`reentry-point`/`prereq-check` 全部读 `templateSpec`；`SectionSpec.mainline` 首次被真正读取；删除与规格重复且对对比型误报的 `walkthrough` |
| EXT-3 | ✅ 已修复 | `config.templateHints` 三张表可覆盖；匹配改「领域键精确/前缀 + 目录路径段精确」，「渲染数学」不再误判 |
| EXT-4 | ⏭️ 不修（本轮） | 上帝类只做函数级拆分（CPLX-1/2/5）。服务化拆分（CardRepository/LintService/…）成本高、收益滞后，留到下次功能扩展；`tools.ts` 仍只依赖 `VaultStore` 一个门面 |
| EXT-5 | ✅ 已修复 | `SearchRoot.writable` / `IndexedCard.writable` + `assertWritable`；`linkIntoNotes` 决定额外根可写性 |
| EXT-6 | ✅ 已修复 | `StudyConfig extends Omit<VaultLayout,…>`；`lint` 抽具名 `LintConfig`；`normalizeConfig` 只填默认值 |
| EXT-7 | ⏭️ 不修 | 12 个工具全量改结构化返回收益滞后，保留纯文本出口（记录为下一步约定） |
| EXT-8 | ✅ 已修复 | `tests/skills.spec.ts` 解析 YAML 与 SKILL.md 键表并断言完全一致 |

### 7.5 业务质量（BIZ）

| 编号 | 状态 | 落点 |
| --- | --- | --- |
| BIZ-3 | ✅ 已修复 | `update(id, payload, call?: {sessionCwd})`；`tools.ts` 传 `sessionCwdOf(exec)` |
| BIZ-4 | ✅ 已修复 | `LintContext.kind`；结构类规则 `scope:'card'`，旧笔记跳过且不写 `passed`；批量报告单列旧笔记数 |
| BIZ-5 | ✅ 已修复 | `passed === undefined` → 「未启用或不适用于此类文档（检查 config.lint.rulesOff）」 |
| BIZ-6 | ✅ 已修复 | `addLink` 判重限定「关联卡片」小节；返回文本区分「新增 N 侧关联行 / 两侧均已存在」 |
| BIZ-7 | ✅ 已修复 | `walk`/`walkRoots` 增加 `onSkip` 上报；`ensureIndex`/`rename` 累计 `skipped`，`search`/`lint`/`rename`/`moc` 追加 `⚠ 跳过 N 个文件` |
| BIZ-8 | ✅ 已修复 | `create()` 查 `byTitle`，命中时**不阻断**但给出「建议 card_update 增量更新」提示 |
| BIZ-9 | ✅ 已修复 | `hasPriorUserMessage` 加 `try/catch → false` + 回归用例 |
| BIZ-10 | ✅ 已修复 | 断链检测对象改本卡改写后正文；其它文件只报「仍指向旧标题」（`checkFormat:false`）；`dryRun` 与实写同路径 |
| BIZ-11a | ✅ 已修复 | `link()` 同篇自关联返回「无需自关联」 |
| BIZ-11b | ✅ 已修复 | `generateId` 后缀 4 → 6 位 hex（同步文档与测试） |
| BIZ-11c | ✅ 已修复 | `validateCard` 拒绝 `tags` 含空白 |
| BIZ-11d | ✅ 已修复 | `stripMocDatePrefix` 支持 `2026/09/10`、`2026年9月`、`2026年9月10日` |
| BIZ-11e | ✅ 已修复 | `HISTORY_KINDS` 白名单校验，非法值抛错 |
| BIZ-11f | ✅ 已修复 | 进度队列上限 50 条 × 200 字，超限抛错 |
| BIZ-11g | ✅ 已修复 | `memory`/`progress` 入口 `assertVault()`（**参数校验先于 assertVault**，保持"未知 action"语义） |
| BIZ-11h | ✅ 已修复 | strip 结果统一走 `renderSections` 收尾，写入时补单个换行 |
| BIZ-11i | ✅ 已修复 | `RESIDUE_SESSION_RE` 移除 `实测`；`session-residue` 按残留类型分档（硬信号 10 / 第二人称·会话口吻 3） |
| BIZ-12 | 🟡 部分修复 | 已做：card-format 技能与 README 写清「lint 覆盖 14 条 vs persona 人工约束」。**不做**：新增「代码块 >60 行」「表格列数 >4」两条规则（避免规则集膨胀，记入路线图） |

### 7.6 性能（PERF）

| 编号 | 状态 | 落点 |
| --- | --- | --- |
| PERF-1 | ✅ 已修复 | `config.indexTtlMs`（默认 2000ms，`0` 关闭）；写操作与 `rename` 强制失效 |
| PERF-2 | ✅ 已修复 | `IndexedCard.template`；批量 lint 用索引 `body`/`template`，不再逐文件读盘 |
| PERF-3 | ✅ 已修复 | `RuleCtx` 预计算 `sections`/`residueText`/`bodyChars`/`spec`；结构检查统一接收小节 |
| PERF-4 | ✅ 已修复 | `cardmodel.makeLineOf`（换行下标 + 二分），`history`/`insight` 改用 |
| PERF-5 | ✅ 已修复 | `rename` 用索引正文预筛 + 只读根不读盘 + 只读要写的文件 |
| PERF-6 | ✅ 已修复 | 先排序取 top-`limit` 再算 snippet；单字 token 权重 ×0.2 |
| PERF-7 | ✅ 已修复 | `idIndex`/`titleIndex`/`rootSet` 在 `rebuild` 时建立 |
| PERF-8 | 📄 文档化 | 技术文档「已知边界」写明索引常驻正文的内存模型与懒加载触发条件，代码不动 |

### 7.7 架构决策（ARCH 六问）

| 问 | 处置 |
| --- | --- |
| 6.1 是否解决真实问题 / 是否最简 | 方向保留。实现层面的三处超配已处理：5 条"小节存在性"规则合并为规格驱动（EXT-2）、`mainline` 字段生效、重复扣分消除 |
| 6.2 达成度 | 数据一致性从"负分"回到零（BIZ-1/2）；可检测性保持；扩展点收敛（EXT-1/2/3/5/6/8）；性能按 PERF-1~7 收敛 |
| 6.3 新隐患 | ① 行号坐标系混用 → 已消灭（BIZ-1）；② 多文件写无事务 → 已消灭（先校验后提交 + 回滚）；③ 四种改写路径 → `addLink`/`stripHistory` 已改走段落模型，`rename` 保持正则但限定小节；④ 误报驱动返工 → 分档权重 + 移除 `实测`；⑤ 固定 prompt 开销 → 描述改为注册表生成，净增极少；⑥ 测试与实现同源 → 新增"配置/文档一致性"测试（EXT-8、persona 重复段落、规则描述） |
| 6.4 回退成本 | 不变（仍 < 1 人日）；本轮所有数据格式变更向后兼容（ID 变长只影响新卡） |
| 6.5 更小的替代方案 | A（结构检查取代打分）**不采纳**：100 分制是已发布功能，改为修校准而非删功能；B（strip 整卡重写）**已采纳**；C（rename 降级为 opt-in 重写入链）**部分采纳**（先校验 + 预筛，不改默认 UX）；D（合并维护工具）**不采纳**（与报告结论一致）；E（删 cross/trend/rating）**不采纳**（等使用反馈） |

### 7.8 与报告结论的差异（说明）

1. **安全阀阈值**：报告建议 5000 文件 / 12 层，实现取 20000 / 16 —— 避免大型 Zettelkasten（>5000 卡）被误判为失败；
   SEC-2 的根因（跨盘符整盘扫描）已由 `isFsRoot` 堵住，安全阀只是纵深防御。
2. **`walkthrough` 规则删除**：报告只要求"由规格驱动"，实现发现它与 `template-sections` 完全重复且对对比型误报，
   故合并删除（规则数保持 14：13 + 新增 `external-resource`）。
3. **SEC-4 保留绝对路径**：见 7.2 说明。
