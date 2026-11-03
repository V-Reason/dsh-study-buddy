# 学习伙伴 DSH 模式体验报告（文档式笔记 v1.0 首次实战：7 站讲解 + 7 块归档）

> 归档说明（2026-11-03）：本报告保留为当时版本的时间点快照，库规模已脱敏。文中的
> `docs/Experience Report/` 工作目录已退役，历史体验报告统一存放在 `docs/archive/experience-reports/`。

- 日期：2026-09-17
- 会话基线：学习伙伴预设（`note-*` 文档式笔记体系 + 母版式讲解法），一次完整闭环：
  读取资料 → 出讲解微计划 → 7 站讲解（每站一问一答推进）→ 归档 7 块 → 建关联 → 生成微目录 → 覆盖度回报
- 覆盖工具：`study_memory` / `study_progress` / `skill` / `read` / `note_library` / `note_expect_get` / `note_list` / `note_get` / `note_search` / `note_plan` / `note_write` / `note_update` / `note_link` / `note_toc` / `note_overview` / `note_lint` / `edit` / `pwsh`
- 报告性质：机制复盘，只谈工具链路与流程体验，不涉及本次讨论的知识内容本身
- 与前五份报告（L16 / GAMES101 L20 / B17 / PBR 18-20 / GAMES101 L21-22）关系：第六次体验报告，且是**换到文档式笔记体系后的第一份**——旧报告里的 `card_*` 结论不再直接适用，本份可作为新体系的基线

---

## 0. 总评

本次闭环的"内容链路"很稳：**讲解零返工、7 块一次落盘成功、10 条关联全成功、微目录与覆盖度闭环、无越权（读取只出报告、讲解一次一站、归档只在触发词后）**。门槛全部由用户文件与工具门禁承担，模型侧不需要额外记忆规则。

成本集中在"落盘后的元数据与环境边界"：

| # | 现象 | 代价 |
| :-- | :-- | :-- |
| 1 | `note_write` 传了 `summary` 时，工具把简介写成正文首行引用块，与正文手写的首行引用块重复 | 3 块返工（`note_update replace` ×3，占本次写操作约 12%） |
| 2 | `note_update(replace)` 重置 frontmatter 的领域标签，且没有任何字段级补救通道 | 只能越出插件体系，用 `pwsh` 直接改 vault 文件 |
| 3 | vault 在工作区外时 `edit` / `write` 被 workspace-write 沙箱拒绝 | 3 次失败 + 2 次审批提升，两次打断用户 |

一句话：**写入链路的"正文"部分已经够用，"元数据"与"环境边界"部分是下一轮迭代的重点。**

---

## 1. 执行顺利、零返工的部分

| 环节 | 观察 | 说明 |
| :-- | :-- | :-- |
| 开场门禁 | 1 次并行成功 | `study_memory(get)` + `study_progress(get)` 一次带回全部记忆与断点，首行直接给出衔接信息（上次小结 + 主线断点），无需试探 |
| 期望驱动写法 | 7 块一次成型 | `note_expect_get` 把"受众 / 文风 / 详略 / 领域侧重"全部交给用户的《笔记期望.md》；本次按"客户端架构 / 框架设计"那一条写出的结构（判据表、失败模式、增量渲染、不写框架 API 用法）**没有一处被用户要求返工**。门禁 + 单一来源的设计价值最高 |
| 规划记账 | 7 块零冲突 | `note_plan(create)` 提案在对话里、`confirm` 后才可写、标题唯一 + 路径必须在规划根之下 → 7 次 `note_write` 全部一次成功，无越界、无重名、无覆盖 |
| 落盘进度回显 | 一眼可读 | 每次 `note_write` 返回"剩余 N 项（6→5→4→3→2→1→0）"，批量落盘时不需要额外记账 |
| 关联工具 | 10 条全成功 | 目录内 6 条 `next` 链 + 跨目录 4 对 `sibling`，全部"改动 2 侧"、无重复行（旧卡时代 `card_link` 的重复行坑未复现） |
| 微目录设计 | 生成段与手写段共存 | `note_toc` 只重写 `<!-- note_toc:begin -->` / `end` 之间的内容，手写导读原样保留——这让"工具维护清单 + 人写导读"可以组合，是本次最舒服的一处设计 |
| 重叠预警 | 一行定决策 | `note_search` 一行命中摘要直接支撑了"vault 里没有该主题、可以新建目录"的判断，避免了重复主题 |
| 状态机纪律 | 无越权 | 读取阶段只出读取报告；7 站讲解每站一问一答（用户说"继续吧"才推进）；归档只在触发词后启动 |
| 历史保护 | 修正零丢失 | 3 次 `replace` 全部先存档（`.study/archive/<ID>/…`），正文不留历史块 |
| lint 定位 | 无分数 | 只给问题清单与严重级，符合"拒绝无意义评分"的用户偏好 |
| 覆盖度口径 | 提示措辞到位 | `note_overview` 的"节号跳号（按你的书写口径统计，不代表资料真的缺节）"直接避免了把正常合并误判成漏节 |
| 自动记忆 | 闭环成立 | 会话中的工具/环境踩坑被写入 `prefs.*` 并在回复末尾标注，形成跨会话资产（下次会话开场即带回） |

---

## 2. 执行不顺利 / 设计不合理

### 2.1 `note_write` 的 `summary` 会与正文首行引用块重复（P0，本次最大返工源）

- 现象：前 3 块落盘后，正文出现两个语义几乎相同的 `>` 引用块——一个来自 `summary` 自动写入、一个来自正文手写首行。
- 证据：`note_write` 返回的正文回显里，frontmatter 之后连续两行引用块（第 2、3 行）。
- 根因：工具描述写的是"`summary` 缺省时从正文首个引用块提取，此时不再另写一遍引用块"，反向暗示了"传 `summary` 时工具会自己写进正文"，但没有明说；模型按"简介是 frontmatter 字段"的直觉又写了一遍正文引用块。
- 影响：3 次 `note_update(replace)` 返工（每篇 100+ 行全量重传），并连带触发 2.2（replace 重置标签）。
- 建议（三选一）：
  1. 行为改：`summary` 只写 frontmatter，永不动正文；正文首行引用块由作者负责。
  2. 描述改：`summary` 描述里显式写明"**传了 summary 就不要再写正文首行引用块；反之则留空**"，并给一正一反两个示例。
  3. 落盘时校验：若正文首个引用块与 `summary` 相似度高（去标点后前缀相同），跳过自动写入或回一条提示。

### 2.2 `note_update(replace)` 重置 frontmatter 领域标签，且无字段级补救通道（P0）

- 现象：3 次 `replace` 之后，`领域:` 从 `#客户端架构 #数值系统 #数据驱动 #Unity` 变成只剩 `#客户端架构`；`note_update` 没有 `tags` / `domain` 参数，正文之外的字段无处可改。
- 影响：为了保证元数据一致，只能脱离插件体系直接改 vault 文件（见 2.3，进一步触发沙箱问题）。
- 建议：
  1. `replace` 保留未在调用中出现的 frontmatter 字段（只覆盖 `summary` / `sourceSection` 这类显式入参）。
  2. 或给 `note_update` 增加 `tags` / `domain` / `status` 字段级更新（这与"字段级 patch"的诉求一致，`definition` 已经是同类先例）。
  3. 或在 `replace` 返回里回显"字段变化 diff"，让调用方立刻发现标签被重置。

### 2.3 vault 在工作区外 → 插件能写、`edit` / `write` 被沙箱拒绝（P0，环境/文档边界）

- 现象：3 次 `edit`（每篇改 1 行 frontmatter）全部返回 `[sandbox: file access denied under workspace-write mode]`；最终用 `pwsh` + `danger-full-access` 一次性提升才写成，用户被弹窗打断 2 次。
- 观察：`note_*` 系列写 vault 不受工作区沙箱限制（本次 20+ 次写全部成功），只有通用文件工具的写入受限——这条边界在文档/工具描述里没有体现。
- 建议：
  1. 在预设启用时把 vault 根加入可写路径（若 DSH 支持 per-session 可写白名单），消除"改一行元数据要审批"的落差。
  2. 或提供 `note_raw_write`（vault 内任意文本文件的小范围替换/追加），把"元数据修补、微目录导读"这类需求收回插件体系内。
  3. 最低成本：在 skill/文档里写明"vault 在工作区外时，`note_*` 可写、`edit`/`write` 不可写；修补走 `note_update` 或 `pwsh`"，避免模型反复试错。

### 2.4 微目录的"手写导读"没有写入通道（P1）

- 现象：`note_toc` 只维护生成段，导读必须由作者写；而写导读属于"改 vault 文件"，又落回 2.3 的沙箱问题（本次用 `pwsh` 提升解决）。技能系统目录的同位置也曾如此。
- 影响：把"导航入口质量"和"沙箱边界"绑在一起，本来一次调用能做完的事变成了提升 + 审批。
- 建议：`note_toc` 增加可选入参（如 `intro` / `notes`），写进 `<!-- note_toc:begin -->` 之前；重跑时同样只更新生成段，手写段保留语义不变。

### 2.5 "该目录还没有微目录"警告在落块阶段反复出现（P1，噪音）

- 现象：7 次 `note_write` 每次都追加同一句话——而"先落块、后 `note_toc`"是归档十步的既定顺序，该警告在前 6 次必然是重复的。
- 影响：单次会话产生 7 条等价噪音，占用上下文。
- 建议：改为收尾统一提示（或在 `note_plan` 阶段创建空的 `微目录.md` 骨架，落块后由 `note_toc` 一次填满）。

### 2.6 `note_write` / `note_update` 回显全文（P1，上下文成本）

- 现象：每次落盘回显 frontmatter + 整篇正文（本次每块 100–180 行），7 次写入 + 3 次替换 ≈ 数万 token 的重复输入。
- 影响：挤占"还能讲/还能改"的上下文预算，批量归档时尤其明显。
- 建议：默认回显"路径 + ID + 标题 + 字数 + 变更摘要 + 前 3 行"，全文回显作为 `verbose` 选项；`dryRun` 继续保留全文预览。

### 2.7 `note_lint` 的「会话残留（本机路径）」误报（P1）

- 现象：新块被判"本机路径"，证据是 `.asset`、`.cs`、`Core/Stats/SingleStat.cs` 这类扩展名与项目内相对路径；全库扫描时大量笔记命中该规则。
- 影响：高误报率会训练用户忽略 lint 输出（本次结论是"这几条不用改"）。
- 建议：把"本机绝对路径"精确化为 `^[A-Za-z]:\\`、`\\\\`、`~/`、`file:///` 等模式；对 `.*\.(cs|asset|unity|prefab|hlsl|shader)` 与项目内相对路径加白名单。

### 2.8 `study_progress` 的"位置"字段承载历史事件，且 set 是整体替换（P1）

- 现象：为不丢主线断点，本次只能把归档附注**追加进 `section` 长文本**（该字段里已累计 4 条日期附注，越写越长）；若直接 `set` 新位置又会覆盖主线断点。
- 影响："当前位置"与"事件日志"混在一个字段，两者都在长大，开场读取成本逐年上升。
- 建议：`study_progress` 增加独立的追加式字段（如 `notes` / `events`），`set` 支持 `append` 模式；"位置"只保留当前一句话。

### 2.9 开场全量记忆读取的固定成本（P1，注意与既有策略的边界）

- 现象：`study_memory(get)` 本次返回 33 条、约 1.2 万字（含两份长计划、多份长配方），每次新会话开场都要付一次。
- 注意：用户已明确否决"把内容外移到笔记、记忆只留指针"——本建议**不碰那一决策**，只动读取方式。
- 建议：get 默认返回"`lastSummary` + 键名清单 + 每键一行摘要"，需要正文时按 `key` 拉取；或提供 `mode=summary|full`。门禁语义不变（仍先读记忆再办事）。

### 2.10 frontmatter 值的 HTML 转义（P2）

- 现象：含 `<...>` 的简介被写成 `IStatOwner&lt;TActorData&gt;`，在 Obsidian 里显示为实体转义而非原字符。
- 建议：YAML 序列化路径不要做 HTML 转义，或仅在需要时用引号包裹。

### 2.11 `note_link` 的并发安全与重复行风险需要文档化（P2）

- 现象：本次为规避"两个调用同时改同一篇文件"的竞争，主动把 10 次 `note_link` 分 3 批（3+3+4）串行下发；工具本身没有关于并发/顺序的说明。
- 历史教训：旧卡体系出现过"同一前缀两行关联、格式不一致无法去重"的记录。
- 建议：在工具描述里写明"一次调用会写两侧文件，请勿并行操作同一篇笔记"，并说明重复链接的去重口径。

### 2.12 persona 与 skill 的规则重叠 + 长度红线与实际格式冲突（P2，提示词治理）

- 现象：system prompt 已完整描述四步闭环、归档十步、三条硬门禁；`study-loop` / `note-format` / `file-reading` / `memory-auto` 又把同一批规则各讲一遍。同时 persona 写"讲解一次一个原子点 ≤15 行"，而本次每站 40–70 行才装得下用户认可的"母版六段式"（对照表 + 最小实现 + 执行日志 + 症状对照 + 判据表）——两条规则在实际执行中必然冲突。
- 影响：token 冗余 + 规则冲突时模型需要在两套说法间取舍。
- 建议：
  1. 流程类规则单一来源（persona 留判据与红线，技能只留"操作细节与命令模板"）。
  2. 长度红线改为"一次一个原子点；长度由知识单元决定"，不再给行数上限；需要短答复的场景用"问答 ≤6 行"承接。

---

## 3. 建议清单（按优先级与落地点）

| 优先级 | 事项 | 落地点 |
| :-- | :-- | :-- |
| P0 | `summary` 与正文首行引用块重复 | `note_write` 实现或工具描述 |
| P0 | `replace` 重置 frontmatter 字段 + 缺字段级更新 | `note_update` 实现（保留未传字段 / 增加 tags·domain·status） |
| P0 | 工作区外 vault 的元数据修补路径 | 预设可写白名单 或 `note_raw_write` 工具 或 文档写明替代路径 |
| P1 | `note_toc` 支持 `intro` 入参 | `note_toc` 实现 |
| P1 | 微目录缺失警告收敛到收尾 | `note_write` 提示逻辑 |
| P1 | 落盘回显瘦身（全文转 verbose） | `note_write` / `note_update` |
| P1 | lint「本机路径」规则精确化 + 白名单 | `note_lint` 规则 |
| P1 | `study_progress` 位置 / 事件字段分离，`set` 支持 append | `study_progress` 实现 |
| P1 | 记忆读取支持摘要优先、按 key 拉取 | `study_memory` 实现 |
| P2 | frontmatter 值不做 HTML 转义 | 序列化路径 |
| P2 | 关联工具的并发与去重口径写进描述 | 工具描述 |
| P2 | persona 与技能去重、长度红线改写 | 预设与技能文本 |

---

## 4. 本次未覆盖、建议下次会话验证

| 未覆盖项 | 说明 |
| :-- | :-- |
| `note_write(dryRun)` / `note_update(dryRun)` | 本次 7 块直接落盘、3 次替换直接执行；dryRun 的预览质量未验证 |
| `note_history` / `note_restore` | 3 份存档已产生但未消费；回退链路（含"恢复前当前版本再存档"）未实测 |
| `note_rename` / `note_unlink` | 本次无改名与断链需求 |
| `ask_user_question` | 全程未用——两次关键拍板（规划确认、逐站推进）都用自然语言完成。可据此判断该工具在"学习伙伴"场景是否必要 |
| `note_library` 的"待消费规划"字段 | 开场读到上一轮的 `planId`，但 `note_plan(confirm)` 之后该字段是否即时更新未复验 |
| 批量归档的上下文上限 | 本次单目录 7 块已接近舒适区；10+ 块目录是否应拆多轮，需要一次压力样本 |

---

## 5. 附：本次工具调用流水（可复算）

```text
开场        study_memory(get) + study_progress(get)                      2
技能加载    skill(file-reading / study-loop / memory-auto)               3
读取资料    read(资料) + note_list(同源目录)                              2
格式对齐    note_get(母版块) + note_get(母版微目录)                        2
重叠预警    note_search × 2                                              2
归档前置    study_progress(get) + note_library(check) + skill(note-format) 3
            note_expect_get + note_list(父目录)                           2
规划        note_plan(create) → 用户拍板 → note_plan(confirm)            2
落盘        note_write × 7                                               7
元数据返工  note_update(replace) × 3                                      3
标签修补    read × 3 → edit × 3（全部被沙箱拒）→ pwsh(提升) × 1           7
关联        note_link × 10（分 3 批）                                    10
微目录      note_toc × 1 + pwsh(提升，补导读) × 1                         2
收尾        note_overview + note_lint(scope=vault) + note_lint(ref) × 2  4
            study_progress(set) + study_memory(set lastSummary) + set(prefs) 3
合计 ≈ 54 次调用，其中纯返工 3 次（replace）+ 失败重试 3 次（edit），约 11%
```

---

## 6. 文档落位说明

- 本报告按用户指示写在 `docs/Experience Report/`；此前五份体验报告已按归档判据统一并入 `docs/archive/experience-reports/`。
- 建议：本目录继续收"**待消费**的体验报告"（尚未修复、作为迭代输入），修复落地并进入某一版本后，再按 `docs/archive/README.md` 的三条判据迁入 `docs/archive/experience-reports/`。
- 同时建议更新 `docs/archive/README.md` 第 61 行的注记：`docs/Experience Report/` 已作为"现行体验报告入口"重新启用，旧目录只保留历史归属说明。
