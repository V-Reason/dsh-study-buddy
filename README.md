# dsh-study-buddy

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeekHarness)（DSH）的「通用学习 Agent」模式：一个**苏格拉底式学习伙伴**插件 + Agent 预设。快节奏讲解、四步学习闭环，把知识沉淀成**可独立复读的文档式笔记**并按你规划的目录结构写进 Obsidian vault——**笔记就是文档，目录由你规划**。
>
> 📖 完整上手请读 [docs/用户使用指南.md](docs/用户使用指南.md)：安装部署、逐键配置详解、全部 18 个工具参考、笔记规范、Obsidian 配合、检索技巧与故障排查手册。
>
> 🗺️ 文档地图见 [docs/README.md](docs/README.md)（哪份文档负责什么、改代码要同步哪些文档）· 🧭 其他文档：[需求分析](docs/需求分析.md)（v1.0 要什么）· [架构选型](docs/架构选型.md)（怎么做）· [重构计划](docs/重构计划.md)（按什么顺序做 + 偏离记录）· [设计文档](docs/设计文档.md)（为什么这样设计）· [技术文档](docs/技术文档.md)（API / 规则 / 配置 / 测试）· [经验文档](docs/经验文档.md)（两轮踩坑与技巧）· [归档索引](docs/archive/README.md)
>
> 版本基线：v1.0.0 ｜ 协议：MIT ｜ 逐版变更见 [更新记录](#更新记录)

## 特性

- **四步学习闭环**：资料摄入 → 讲解拓展 → 问答反诘（三明治原则）→ 笔记归档，每步都有明确清单
- **文档式笔记（v1.0 重构核心）**：一个块 = **一个可独立阅读的知识单元**，落成 vault 里一篇普通 `.md`。**没有模板、没有必填小节、字数不设限**——写法（结构/详略/文风/公式图表/互引）完全由你 vault 根的 **《笔记期望.md》** 决定；改期望立即生效（改过就得重读，门禁会挡住旧口径的写入）
- **三条硬门禁（工具强制，不靠 Agent 自觉）**：① 未读《笔记期望.md》→ 不写；② 没有**你确认过的文件夹规划** → 不写；③ 落盘路径不在规划范围内 / 同一规划内重复消费 → 不写。每条拒绝都带修复步骤，且**磁盘零改动**（测试逐条断言目标文件不存在）
- **文件夹规划（先规划后落盘）**：归档前 Agent 先出「目录结构 + 块清单 + 顺序 + 来源章节」提案给你拍板，**提案只在对话里、不落盘**；确认后逐块写入。规划凭据默认 24 小时过期（防门禁死锁），可 `abandon`
- **目录层级「资料 / 章 / 节 / 块」+ 微目录**：每个主题目录都有 `微目录.md` 作导航入口（按顺序键排列、带来源章节与一句话简介）；`note_toc` 只重写生成段，**你手写的导读段原样保留**
- **覆盖度总览（`note_overview`）**：按 `来源章节` 聚合成「资料 → 章 → 节」，回答"这个主题记全了没有"；缺口只依据笔记里真实出现的章节号，**不虚构章节**，解析不出的进"未归类"
- **历史不留痕在正文（`note_update` / `note_restore`）**：补充直接追加（不产生版本块）；推翻重写时**旧正文先存入 `.study/archive/` 再写新版**（`archiveThenWrite` 把"先存档后写正文"收成唯一入口），正文里不留 `<details>`；随时可回退，恢复前当前版本也会先存档
- **wikilink 关联（`note_link`）**：`- 前置：[[目标]]` 双向写入，在 Obsidian 里可点、可看反向链接；`note_rename` 改标题时同步 frontmatter + 文件名 + 全库 wikilink + 断链检测
- **多根只读检索**：`note_search` 覆盖 vault + **会话工作目录**（`includeSessionCwd`）+ 配置的 `searchRoots` 旧笔记；命中标注「类型：块/存量卡/旧笔记」与「路径」；旧笔记默认只读、不碰不动
- **索引不常驻正文（v1.0 的性能修复）**：索引只留元数据 + 倒排 token，命中的前 N 篇才现读正文算片段；目录导航只读 4KB 头。工具 schema 固定开销 **14.7 KB / 18 工具**（v0.9 为 ~15.0 KB / 21 工具）
- **跨会话进度与记忆**：资料/小节/未答追问/触及笔记持久化，重启后"接着讲"从断点继续；新会话开场**硬门禁**（首条消息先读记忆与进度，读取结果返回前不响应）
- **自迭代记忆开关（默认关）**：开启后无需"请记住"，Agent 按 `memory-auto` 技能自动把偏好/约定写入 `prefs.*`，回复标注"（已自动记入偏好）"；"忘了…"随时删
- **指令驱动（听指挥）**：读取 ≠ 讲解——"读取 X"只输出读取报告，说"讲解"才开始讲；读取 PDF/PNG/PPTX/DOCX 走内置 `file-reading` 技能（**内嵌图片自动提取**并逐张 `read_image`）
- **轻量**：技能按需加载；会话早期自动压缩历史（阈值 30%）；253 项测试覆盖契约往返、门禁（端到端零改动）、规划与存档、覆盖度、目录索引、检索多根、原子写与路径安全、文档/配置/技能一致性守卫

## 更新记录

- **v1.0.0（2026-10-24）— 文档式笔记重构**：从"原子卡片"转向"文档式笔记"。① 需求分析（26 问落成 30 条决策）→ 架构选型 → 8 阶段重构计划三份文档；② **解除约束**：删除三型模板/必填小节/分型推断/`定义 ≤60 字硬拒绝`/14 条 lint 打分（改为 4 条数据卫生规则、无分值），写法唯一来源改为用户自己的《笔记期望.md》（缺失时 fail-loud 不回退）；③ **目录约束**：新建 `note_plan`（提案不落盘 + 用户确认）、`note_toc`（微目录，手写段保留）、`note_overview`（按 `来源章节` 的覆盖度，不虚构章节）；④ **硬门禁**：`note_write` 三连校验（期望已读签名一致 / 规划已确认未过期 / 路径在规划内），拒绝时磁盘零改动；⑤ **历史存档**：`replace`/`restore` 走 `archiveThenWrite`（先存档后写正文），正文不留 `<details>`，新增 `note_history`/`note_restore`；⑥ **关联改 wikilink**，新增 `note_unlink`；⑦ **工具面重建**：12 个 `card_*`/`study_*` → 18 个 `note_*`/`study_*`（一个工具一个动词），`card_moc`/`card_id` 删除；⑧ **架构**：模块 16 → 20（新增 dirs/gate/planstore/archive/store/overview/sourceSection，删除 template/insight/card/moc/history/updatelegacy，rename 并入 links），**索引不再常驻正文**，构建前清 `lib/types`；⑨ 预设侧：persona 重写、`card-format` → `note-format`、`domain-adaptation` 去掉自带侧重表（改为引导写进期望）、新增默认期望模板 `presets/study/assets/笔记期望.md`、配置键删 `mocDir`/`templateHints` 加 `expectFile`/`planTtlHours`。测试 268 → 253（删掉的是被删功能的用例，安全类一条未删）。详见 [docs/需求分析.md](docs/需求分析.md)、[docs/架构选型.md](docs/架构选型.md)、[docs/重构计划.md](docs/重构计划.md)
- **v0.9.1（2026-09-10）— 复审（`docs/archive/review/07`）N1~N15 修复**：① `card_link` 一侧位于只读检索根时**先校验后写盘**（旧实现先写 A 再在 B 处报错，留下单向入链）——改为两侧全部规划完再落盘，中途失败按写前内容回滚；② `card_create` 不再为同名提示触发全库重扫（改 `titleHints` O(1) 查询）；③ 索引 TTL 的可见性回归修复：**未命中/找不到卡片的路径强制重扫一次**；④ 其余 12 项 nit。另新增 `tests/docs.spec.ts`（文档链接/锚点 + 版本基线守卫）与 `docs/README.md`（文档地图）。测试 248 → 263；逐条状态见 `docs/审查修复记录.md` §三。
- **v0.9.0（2026-09-10）— 首轮审查修复**（明细归档于 `docs/archive/review/`）：3 个 blocker（`strip` 行号漂移删错正文、换行截断 frontmatter、`rename` 半写盘）+ 15 warning + 12 nit；lint 收敛为 `RULES` 注册表；索引 TTL；工具仍 12 个，测试 209 → 248。
- **v0.8.0（2026-09-10）— P1/P2 收口**：模板分型与四个新小节落进代码与文档；`card_lint` 增 `cross`/`trend`/`rating` 三个分析开关。测试 203 → 209。
- **v0.6.0（2026-09-10）— 卡片质量可检测**：新增 `card_lint`（14 条规则）、`card_history`、`card_rename`；会话残留白名单；工具 9 → 12，测试 136 → 201。
- **v0.5.0（2026-09-07）— dsh 0.1.3-alpha.1 平台适配**：宿主侧仍零 `@deepseek-ai` 运行时导入；开场门禁改为**双形状特性探测**（兼容 `session.events` 与 `session.snapshotEvents()`）。
- **v0.4.0（2026-09-03）**：自迭代记忆开关、开场记忆硬门禁、课件图片提取；多根检索与旧笔记联动。
- **v0.3.0（2026-08-21）**：记忆功能；修复 vaultRoot==cwd 时工具静默不注册（fail-loud）。

## 性能与成本

每次请求的固定开销（persona + 工具 schema）：

| 模式 | 固定开销 | 模型可见工具 |
| :-- | --: | --: |
| 标准模式 | ~21.3 KB | ~26 个 |
| 学习伙伴 | **14.7 KB** | 18 个（插件）+ 文件/搜索/问询等 |

> v1.0 实测：`buildToolDefs({})` 的 name+description+parameters JSON 总字节 14.7 KB / 18 工具（v0.9 基线 ~15.0 KB / 21 工具）。测量方法见 [docs/重构计划.md](docs/重构计划.md) §七。

日常成本（V4-Flash、约 60 轮/天、2 小时学习；[2026-08-17 峰谷定价](http://www.nbd.com.cn/articles/2026-08-17/4543868.html)）：

| 计费项 | 高峰（9-12、14-18 点） | 低谷（晚上/清晨） |
| :-- | --: | --: |
| 输入·缓存命中 | ¥0.10/天 | ¥0.05/天 |
| 输入·未命中 | ¥0.54/天 | ¥0.27/天 |
| 输出（含推理） | ¥0.27/天 | ¥0.14/天 |
| **合计** | **≈ ¥0.9/天** | **≈ ¥0.45/天** |

月开销约 ¥14–27（Flash）；换 V4 Pro 约 ×3。精简省的主要是延迟（每轮少处理 ~1.1k tokens），成本大头始终是输出与新鲜输入。

## 原理

```
你说的话 → 「学习伙伴」会话（persona + 18 个 note_*/study_* 工具）
                  │ note_expect_get 读期望 → note_plan 提案（你拍板）
                  │ → note_write（门禁三连校验）→ note_toc 微目录 → note_overview 覆盖度
                  ▼
       插件直连你的 Obsidian vault（node:fs 直写，不经沙箱）
                  │ 笔记 = vault 里普通的 .md，与旧笔记同库
                  ▼
       多根索引（vault + 会话工作目录 + searchRoots；标题/简介/领域/正文
       token，mtime|ctime|size 签名缓存）——磁盘变了自动重扫；命中标注 块/存量卡/旧笔记
```

- 笔记不是数据库记录，就是带 frontmatter 的 Markdown 文件；你在 Obsidian 里改它，插件下次检索即重扫，互不打架
- 过程状态存于 vault 的 `.study/`：`progress.json`（进度）、`memory.json`（记忆）、`session.json`（门禁状态）、`plans/`（规划凭据）、`archive/`（历史存档）——**删掉不丢笔记**
- 状态/记忆 JSON 损坏时工具直接报错（fail-loud）；`session.json`/`plans/` 损坏则**回空态**（门禁要求重做一步，不阻断笔记读写）
- Agent 只能通过 `note_*` 工具操作 vault，写文件采用"临时文件 + rename"原子写，不会写坏一半
- 插件挂在 preset 作用域内，不污染其他 Agent（standard/cordis 等）的工具目录

## 你的主动权

| 环节 | 谁说了算 |
| :-- | :-- |
| 新会话衔接 | 自动：开场读回记忆与进度给衔接提示；"记住…"/"忘了…"随时改 |
| 讲不讲解 | 读取只出报告、不自动开讲；你说"讲解"才开始，讲完待命 |
| 讲多深 | 默认快节奏；你说"详细讲讲 / 查一下 / 深入研究"才深入；"别问了"停止反诘 |
| **笔记怎么写** | **你的《笔记期望.md》**——受众、文风、详略、结构、公式图表、领域侧重都由它决定；改完立即生效 |
| **写到哪里** | **你确认过的文件夹规划**（提案只给建议，落盘路径必须在你拍板的范围内） |
| 写不写 | 只有你说"整理笔记 / 生成笔记 / 归档"才落盘 |
| 改不改旧笔记 | 永远先给"旧 vs 新"对比，你确认才改（追加 / 整体替换 / 只改定位 / 挪目录） |
| 旧内容会不会丢 | 不会：替换前旧正文先进 `.study/archive/`，且可 `note_restore` 回退（来回都行） |
| 旧笔记 | 不碰不动；说"把这篇改成笔记"才原地升级，旧版本进存档 |
| 找知识 | 直接问"我笔记里有没有讲过 X"，全库检索含旧笔记（vault + 工作目录 + searchRoots） |
| 进度 | "接着讲"续讲；"清空进度"重来（只清进度位置，记忆保留） |
| 兜底 | Obsidian 手改、git 回滚永远有效——磁盘是唯一真相 |

## 笔记格式（v1.0 · 写法由你的期望文件决定）

```markdown
---
ID: 202610241430_ab12cd          # note_write 自动生成
标题: 高斯消元法
领域: #计算方法-线性方程组        # 首个标签 = 领域键（可选）
来源: 《计算方法》                # 资料名（必填）
状态: 已确认                      # 草稿 / 已确认 / 需更新
来源章节: 《计算方法》第2章 线性方程组数值解法 / 2.1节
顺序: 3                           # 同目录阅读顺序（微目录排序用）
简介: 用初等行变换把系数矩阵化为上三角，再回代求解。
---

> 一句话定位（可选；无长度限制，缺省时从正文首个引用块提取）

## 直接法

用初等行变换把系数矩阵化为上三角，再回代求解……

### 关联
- 前置：[[矩阵与向量]]
- 后续：[[列主元消元]]
```

- **没有必填小节**：写什么、分几节、详略到什么程度，看你的《笔记期望.md》。
- `来源章节` 是**覆盖度的唯一数据源**：`《资料名》第N章 章标题 / N.N节`（无节号也合法；全角数字与多余空格会被无损归一）。
- 目录层级：`资料 / 章 / 节 / 块`（课程笔记四层；项目类笔记可少一层）；**文件名不加序号前缀**，阅读顺序由 `顺序` 键与微目录承担。
- 默认期望模板在 [presets/study/assets/笔记期望.md](presets/study/assets/笔记期望.md)——复制到 vault 根再按自己习惯改。

## 快速开始

> 前提：你已有一份可运行的 DSH 部署（web profile）。本仓库是插件 + 预设，不含 DSH 本体。

```powershell
# 1. 克隆并构建插件
git clone https://github.com/V-Reason/dsh-study-buddy.git
cd dsh-study-buddy
pnpm install
pnpm run check          # typecheck + 253 项测试 + 构建 lib/index.js

# 2. 把插件装进你的 DSH profile（<profileDir> 通常是 %DSH_HOME%\profiles\web）
#    在 <profileDir>\package.json 的 dependencies 里加入：
#    "dsh-study-buddy": "file:D:/path/to/dsh-study-buddy"
cd <profileDir>
pnpm install

# 3. 部署预设
Copy-Item -Recurse presets/study "$env:DSH_HOME\.agent-presets\study"

# 4. 必做两步配置
#    a) 编辑 $env:DSH_HOME\.agent-presets\study\agent.cordis.yml：
#       - vaultRoot：换成你自己的 Obsidian vault 绝对路径
#       - （可选）domainFolders / skipDirs / includeSessionCwd / searchRoots / linkIntoNotes
#    b) 把默认期望模板复制进 vault 根，改成你自己的写法：
Copy-Item presets/study/assets/笔记期望.md "<你的vault>\笔记期望.md"

# 5. 重启 DSH，新建会话，选择「学习伙伴」预设
```

> ⚠ **第 4b 步不是可选项**：没有《笔记期望.md》时 `note_write` 会拒绝写入并给创建指引（这是设计决定——允许回退到内建写法会让"写法只从期望来"变成两处口径）。

> 升级插件后若 DSH 未加载新代码：删掉 `<profileDir>\node_modules\dsh-study-buddy` 再 `pnpm install`（file: 依赖不自动刷新），然后重启 DSH。
>
> 升级 **DSH 本体**同样会动预设：行内的配置键可能被改名（例如 DSH 0.1.5 起 persona 行的 `text` 已改名必填的 `prefix`），旧副本会在挂载时报 `invalid config: $.prefix missing required value`；挂载失败不留缓存，重新选一次该预设就生效。

## 使用

| 你说 | 发生什么 |
| :-- | :-- |
| 新会话第一条消息 | 硬门禁：先 `study_memory(get)` + `study_progress(get)`（读取结果返回前不响应），首行衔接提示并问"接着讲？" |
| 给文件路径 / "读取 X" | 阶段一·读取：按 `file-reading` 技能读取（PDF/PPTX/DOCX 自动提取内嵌图片逐张读图），只输出读取报告 |
| "讲解 / 讲吧 / 开始讲解" | 阶段二·讲解：一次一个原子点，每点结尾问"清晰？细化/跳过？" |
| 提问 | 三明治回答：直击 ≤3 句 → 底层逻辑 → 反诘追问 |
| 整理笔记 / 生成笔记 / 归档 | **十步归档**：查未答追问 → 读期望 → 列目录 → **规划提案（你拍板）** → 逐块写入 → 微目录 → 覆盖度 → 更新进度与记忆 |
| 回退 / 恢复旧版本 / 改坏了 | `note_history` 看存档 → `note_restore` 恢复（恢复前当前版本也会先存档） |
| 接着讲 | 从上次断点继续 |
| "记住…" / "忘了…" / 开启自迭代 | 跨会话记忆与 `_autoPrefs` 开关 |
| 别问了 | 停止反诘追问 |

## 配置参考（`study` 插件行 config）

| 键 | 默认 | 说明 |
| :-- | :-- | :-- |
| `vaultRoot` | 必填 | Obsidian vault 绝对路径；为空/文件系统根会挂载失败（fail-loud） |
| `expectFile` | `笔记期望.md` | 期望文件名（vault 根下）；读取路径、门禁签名与回显都用它，含路径分隔符会抛错 |
| `planTtlHours` | `24` | 规划凭据有效期；超期要重新提案（防门禁死锁） |
| `stateDir` | `.study` | 过程状态目录（进度/记忆/会话/规划/存档） |
| `fallbackDir` | `未分类` | 未映射领域且规划未给路径时的兜底 |
| `domainFolders` | `{}` | 领域 → vault 内相对目录的**快捷方式**（v1.0 起落盘目录以规划的 `path` 为主） |
| `skipDirs` | `[]` | 额外跳过扫描的顶层目录名（内置已跳过 `.obsidian`/`.trash`/`.study`/`.git`/`node_modules`） |
| `includeSessionCwd` | `false` | 把会话工作目录（`{{cwd}}`）的旧笔记纳入检索；与 vault 相同/嵌套自动去重 |
| `searchRoots` | `[]` | 额外检索根（绝对路径或相对 vaultRoot）：旧笔记库，**只读**；不存在即挂载失败 |
| `linkIntoNotes` | `false` | 是否把 `note_link` 关联写入无 ID 的旧笔记本体；同时决定只读根是否可写 |
| `lint.residueLevel` | `warn` | 会话残留规则级别：`off`/`warn`/`error`；`off` 时报告单列「⊘ 未执行」 |
| `lint.rulesOff` | `[]` | 禁用的规则 id 列表；**未知 id 挂载即报错**（fail-loud） |
| `indexTtlMs` | `2000` | 索引缓存 TTL；**未命中/找不到的路径自动强制重扫一次**；设 `0` = 每次重扫 |
| `maxWalkFiles` | `20000` | 每根扫描文件数安全阀；超限**截断并回显 ⚠**（不再让工具整体失败） |

> v1.0 **删除**的键：`mocDir`（MOC 退场，导航改由微目录承担）、`templateHints`（三型模板退场）。
> 写进 preset 也不会生效——`tests/preset.spec.ts` 会断言这两个键不存在。

插件工具一览（18 个，只在「学习伙伴」预设作用域内可见）：
`note_library`（库与期望自检）/ `note_expect_get`（读期望并开门禁）/ `note_list`（逐层导航）/ `note_get`（读全文）/ `note_search`（关键词多根检索）/ `note_overview`（主题总览 + 覆盖度）/ `note_plan`（文件夹规划提案与确认）/ `note_write`（落块，门禁三连校验）/ `note_update`（append / replace / move / definition）/ `note_toc`（生成/刷新微目录）/ `note_link`（建 wikilink 关联）/ `note_unlink`（移除关联）/ `note_rename`（改标题并同步入链）/ `note_history`（看历史存档）/ `note_restore`（从存档恢复）/ `note_lint`（4 条数据卫生规则，无分数）/ `study_progress`（进度与断点）/ `study_memory`（跨会话记忆 + 自迭代开关）。

预设内另有压缩配置（`compaction-basic` 组）：`thresholdRatio: 0.3`、`retainRatio: 0.15`、`maxTokens: 4096`，并带 `deepseek-v4-flash` / `deepseek-v4-pro` 模型策略。

## 隐私

**vault 内容会出境。** 这个插件把 vault 里的内容读出来交给模型，这是它的工作方式，需要明确写在这里：

- `note_search` / `note_get` / `note_list` / `note_overview` 的返回文本（标题、简介、正文片段、**整篇原文**）、绝对/相对路径，都会写入 DSH 会话日志，并作为请求内容发送给模型服务商。
- `.study/progress.json`（进度、未答追问）、`.study/memory.json`（跨会话记忆）与 `session.json`（门禁状态）在开场或写入前被读取，同样进入上下文。
- 笔记正文里的 HTML 外链（`<img src="http…">`、`<iframe>`）会在你于 Obsidian 打开笔记时由**本机主动外联**；`note_lint` 的 `external-resource` 规则会给出 info 级提示。
- 插件本身**不联网**：全仓无 `child_process`、无 HTTP 客户端、无 `eval`；所有 IO 只有 `node:fs` 与 `.study/*.json`。
- 记忆与进度中的文本是**用户数据**：persona 与 `memory-auto` 技能明确要求只能作为事实引用，不得当作指令执行；`study_memory(get)` 对以"忽略/指令/你现在是"开头的记忆给出软提示。

结论：**不要把不适合交给模型服务商的内容放进同一个 vault**，或为该 vault 单独配置部署。

## 开发

```bash
pnpm install
pnpm run check     # typecheck + vitest（253 项）+ esbuild 构建
```

- 源码在 `src/`（**20 模块**，零运行时依赖，仅 Node 内置模块），构建产物 `lib/index.js`（`@deepseek-ai/*` 保持 external）
- 构建前会**清空 `lib/types`**：删掉的模块不能留下可 import 的 `.d.ts`（v1.0 补的守卫）
- 测试在 `tests/`（20 文件 / 253 项）：门禁端到端（含"拒绝时磁盘零改动"）、规划与存档、覆盖度聚合、目录索引与列举、检索多根与歧义、frontmatter 往返、原子写与路径越界、文档/配置/技能一致性守卫
- CI：push/PR 自动跑 `pnpm run check`（`.github/workflows/check.yml`，Node 22）
- 想改行为？先读 [docs/README.md](docs/README.md) §二"改代码要同步哪些文档"

## 目录结构

```
dsh-study-buddy/
├── src/                 # 插件源码（20 模块：vault 适配 / 检索索引 / 块契约 / 段落模型 /
│                        #   frontmatter / 目录模型 / 门禁 / 规划存储 / 存档 / 会话状态 /
│                        #   覆盖度 / 来源章节 / 关联与改名 / lint / 进度 / 记忆 / 开场门禁 / 工具 / 入口）
├── tests/               # 253 项单元与端到端测试
├── presets/study/       # 「学习伙伴」Agent 预设
│   ├── agent.cordis.yml # persona + 工具行 + 插件挂载行（配置主战场）
│   ├── assets/笔记期望.md # 默认期望模板（复制到 vault 根后自定义）
│   └── skills/          # study-loop / note-format / file-reading / incremental-update / domain-adaptation / memory-auto
├── docs/                # 需求分析 / 架构选型 / 重构计划 + 用户指南 / 设计 / 技术 / 经验 + check + archive
├── build.mjs            # esbuild + tsc 构建脚本（先清 lib/types）
└── cordis.patch.yml     # 备用：宿主平面挂载层（默认走 preset 行）
```

## 路线图

- [ ] 复习测验子模式（基于笔记库抽卡出题）
- [ ] 语义检索（嵌入向量）替代纯关键词召回
- [ ] 笔记浏览面板（客户端 Slot UI）
- [ ] `/整理笔记`、`/接着讲` 斜杠命令
- [ ] 多 vault 支持
- [ ] 覆盖度的"计划块 vs 已落块"对照（需要规划留痕，当前提案不落盘）

## 致谢

- 插件包结构与构建方式参考 [dsh-at-file](https://github.com/omdsh-dev/dsh-at-file)（MIT）
- 交互设计来自早期需求文档 `docs/archive/design/DeepSeekHarness —— 通用学习 Agent.md`（历史溯源；现行口径以 `presets/study/skills/` 为准）

## License

[MIT](LICENSE)
