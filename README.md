# dsh-study-buddy

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeekHarness)（DSH）的「通用学习 Agent」模式：一个**苏格拉底式学习伙伴**插件 + Agent 预设。快节奏讲解、四步学习闭环、原子卡片（Zettelkasten 风格）直接写入你的 Obsidian vault——**知识即卡片，卡片即知识**。
>
> 📖 完整上手请读 [docs/用户使用指南.md](docs/用户使用指南.md)：安装部署、逐键配置详解、全部 12 个工具参考、卡片格式规范、Obsidian 配合、检索技巧与故障排查手册。
>
> 🧭 其他文档：[设计文档](docs/设计文档.md)（为什么这样设计）· [技术文档](docs/技术文档.md)（API / 规则 / 配置 / 测试）· [经验文档](docs/经验文档.md)（本轮踩坑与可复用技巧）· [归档索引](docs/archive/README.md)（历史提案与复盘）

## 特性

- **四步学习闭环**：资料摄入 → 讲解拓展 → 问答反诘（三明治原则）→ 笔记归档，每步都有明确模板与检查清单
- **原子卡片落盘 Obsidian vault（2026-09 重设计：可独立复读的微课程）**：分型模板——理论型（为什么）/工程型（怎么做，含验证实验 + 排障判据）/对比型（怎么选，含对比表 + 选型口诀），自动推断并回显；通用骨架含核心思想/主干线/阶梯式解剖（4~6 层）/实例走查/易错点/自测题，长卡补重入点、有前置卡补前置检查；**正文不设字数上限**（长度由信息完备性决定），定义仍限 ≤60 字；卡片就是普通 `.md`，与旧笔记同库同目录，Obsidian 可直接打开、编辑、git 管理
- **反堆砌三规则**：主干线唯一（一句话写清"问题 → 约束 → 解法 → 代价 → 验证"）、删除测试（删了会迷路才留在主线）、前置检查（≤2 条直接前置 + 明确排除），写进 persona 与 card-format 技能
- **质量可检测（`card_lint`）**：14 条规则逐项打分——会话残留（路径/行号/第二人称/会话时间词/阶段代号，含 `L0/L1/L2`、讲义引用等白名单）、模板必填小节、主干线、重入点、验证实验步数、排障判据、代码块语言、自测题答案率、层级序号、关联块格式、领域标签；全部警告级、带改写建议，单卡或全库批量
- **多根检索（卡片 ↔ 旧笔记联动）**：`card_search` 不止检索 vault 卡片，还覆盖**会话工作目录**（`includeSessionCwd`）与配置的 `searchRoots` 旧笔记；命中标注「类型：卡片/旧笔记」与「路径」；`card_get` 可读旧笔记全文，`card_link` 默认只写卡片侧（旧笔记零改动），关联用根限定路径寻址
- **增量更新（活笔记）**：补充加"版本更新"、推翻加"勘误"、无关则新卡关联——旧内容永不丢失，更新决定权永远在你；版本块插在「关联卡片」**之前**（阅读顺序正确）；`card_history` 可列出/清除历史块；仅修一句话定义走字段级 `card_update(definition)`
- **改名不散链（`card_rename`）**：改标题时同步 frontmatter + 文件名 + 全库入链 + MOC wikilink，并做断链检测；`dryRun` 可先预演
- **全库检索与重叠预警**：摄入新资料前自动检索已有卡片，提示重叠与差异
- **跨会话进度与记忆**：当前资料/小节/未答追问持久化，重启后"接着讲"从断点继续；新会话开场**硬门禁**（首条消息先读记忆与进度，读取结果返回前不响应），首行衔接提示不脱节；偏好/约定/小结可"记住"
- **自迭代记忆开关（默认关）**：`study_memory` 保留控制键 `_autoPrefs`（on/off）；开启后无需"请记住"，Agent 按 memory-auto 技能自动把偏好/约定写入 `prefs.*`（每类一个键、覆盖更新），回复标注"（已自动记入偏好）"——下个会话不再犯"资料在哪/讲解风格"这类经验性错误；"忘了…"随时删
- **快节奏 + 用户主动权**：默认精简回答，深入研究（联网/超纲推导）由你开口才做
- **指令驱动（听指挥）**：读取 ≠ 讲解——"读取 X"只输出读取报告，说"讲解"才开始讲；读取 PDF/PNG/PPT 等文件走内置 `file-reading` 技能（PDF/PPTX/DOCX 的**内嵌图片自动提取**并逐张 `read_image`，不漏掉课件里的图），不摸索工具
- **MOC 知识目录**：归档时自动生成按领域分组的知识地图
- **轻量**：每次请求固定开销约 15KB（比标准模式低 ~30%）；技能按需加载；会话早期自动压缩历史（阈值 30%）
- 209 项单元测试覆盖卡片渲染、检索索引（含多根旧笔记）、增量更新、进度与记忆持久化、原子写与路径安全

## 更新记录

- **v0.8.0（2026-09-10）— P1/P2 收口**：模板分型（理论型/工程型/对比型，自动推断 + `template` 覆盖）与四个新小节（重入点/前置检查/验证实验/排障判据）落进代码与文档；`card_lint` 增 `cross`（跨卡一致性）/`trend`（质量趋势）/`rating`（可执行性评级）三个分析开关；persona、card-format、study-loop、incremental-update、用户指南、README 全面同步"正文不设字数上限 + 反堆砌三规则"。测试 203 → 209。
- **v0.6.0（2026-09-10）— 卡片质量可检测（P0）**：依据重设计提案（现归档于 `docs/archive/design/`）完成框架重设计与 P0 全部 6 项——① 新增 `card_lint`（14 条规则打分：会话残留/模板小节/主干线/重入点/验证实验/排障判据/代码块语言/自测题答案率/层级序号/关联块格式/领域标签…，全部警告级）；② 会话残留规则集含白名单（`L0/L1/L2` 球谐带、`GAMES101 L15` 讲义引用、代码块与 `<details>` 内不扫）；③ `append-version`/`errata` 改为插在「关联卡片」**之前**（阅读顺序不再被破坏）；④ 新增 `card_history`（list/strip + `<details>` 配对校验）；⑤ 新增 `card_rename`（改标题同步文件名 + 全库入链 + 断链检测 + dryRun）；⑥ 关联块归一为 `` - 前置：`标题`（ID） ``，去重改为"标题或 ID 任一命中即跳过"。工具 9 → 12，测试 136 → 201；新增 `src/cardmodel.ts`（段落模型）/`src/template.ts`（模板注册表）/`src/lint.ts`（规则引擎）/`src/history.ts`/`src/rename.ts`/`src/tools.ts`。
- **v0.5.0（2026-09-07）— dsh 0.1.3-alpha.1 平台适配**：宿主侧仍零 `@deepseek-ai` 运行时导入（加载层无需改动，不会因平台重构 fail-loud）；唯一 API 漂移是 2026-08-28 起 session 重构移除 `session.events`（改为 `session.snapshotEvents()`），已将开场门禁的恢复会话判定改为**双形状特性探测**（新旧平台均兼容：新平台恢复会话不再误注入预步提醒，旧平台行为不变）。同步版本元数据（package.json / dsh.plugin.json 均 0.5.0）并新增本更新记录。
- **v0.4.0（2026-09-03）**：自迭代记忆开关、开场记忆硬门禁、课件图片提取、阶梯式解剖卡片；多根检索（会话工作目录/searchRoots）与旧笔记联动（详见 `docs/archive/dev-experience/`）。
- **v0.3.0（2026-08-21）**：记忆功能与预设更新；修复 vaultRoot==cwd 时工具静默不注册（fail-loud）。

## 性能与成本（2026-08 实测估算）

每次请求的固定开销（persona + 工具 schema）：

| 模式 | 固定开销 | 模型可见工具 |
| :-- | --: | --: |
| 标准模式 | ~21.3 KB | ~26 个 |
| 学习伙伴 | ~15.0 KB\* | 21 个 |

\* 实测基线（2026-08）；新增 `study_memory` 与记忆小节后为估算（约 +0.5KB，未重新实测）。工具数为模型可见工具合计（插件注册 12 个：`card_search`/`card_get`/`card_id`/`card_create`/`card_update`/`card_link`/`card_moc`/`card_lint`/`card_history`/`card_rename`/`study_progress`/`study_memory`）。

日常成本（V4-Flash、约 60 轮/天、2 小时学习；[2026-08-17 峰谷定价](http://www.nbd.com.cn/articles/2026-08-17/4543868.html)）：

| 计费项 | 高峰（9-12、14-18 点） | 低谷（晚上/清晨） |
| :-- | --: | --: |
| 输入·缓存命中 | ¥0.10/天 | ¥0.05/天 |
| 输入·未命中 | ¥0.54/天 | ¥0.27/天 |
| 输出（含推理） | ¥0.27/天 | ¥0.14/天 |
| **合计** | **≈ ¥0.9/天** | **≈ ¥0.45/天** |

月开销约 ¥14–27（Flash）；换 V4 Pro 约 ×3。注意：精简省的主要是延迟（每轮少处理 ~1.1k tokens），金额上因为前缀缓存便宜（¥0.1/M）而差异不大——成本大头始终是输出与新鲜输入。


## 原理

```
你说的话 → 「学习」会话（persona + 12 个卡片工具）
                  │ card_search / card_create / card_update / study_progress …
                  ▼
       插件直连你的 Obsidian vault（node:fs 直写，不经沙箱）
                  │ 卡片 = vault 里普通的 .md 文件，与旧笔记同库
                  ▼
       多根索引（vault + 会话工作目录 + searchRoots；标题/标签/正文，
       mtime 签名缓存）——磁盘变了自动重扫；命中标注 卡片/旧笔记
```

- 卡片不是数据库记录，就是带 frontmatter 的 Markdown 文件；你在 Obsidian 里改它，插件下次检索即重扫，互不打架
- 学习进度存于 vault 的 `.study/progress.json`，跨会话、跨重启有效
- 状态/记忆 JSON 损坏时工具直接报错（fail-loud，不静默降级）：报错含文件名与原因，可手动修复或删除该文件后继续
- Agent 只能通过 `card_*` 工具操作 vault，写文件采用"临时文件 + rename"原子写，不会写坏一半
- 插件挂在 preset 作用域内，不污染其他 Agent（standard/cordis 等）的工具目录

## 你的主动权

| 环节 | 谁说了算 |
| :-- | :-- |
| 新会话衔接 | 自动：开场读回记忆与进度给衔接提示；记忆内容（偏好/小结）你说了算，"记住…"/"忘了…"随时改 |
| 讲不讲解 | 读取只出报告、不自动开讲；你说"讲解"才开始，讲完待命 |
| 讲多深 | 默认快节奏；你说"详细讲讲 / 查一下 / 深入研究"才深入；"别问了"停止反诘 |
| 讲多快 | 每个原子点讲完问"清晰？细化/跳过？"——跳过就走 |
| 写不写卡 | 只有你说"整理笔记 / 生成笔记 / 归档"才落盘 |
| 写到哪里 | 领域→目录映射表自由配置；未映射的落"未分类" |
| 改不改旧卡 | 永远先给"旧 vs 新"对比，你确认才改（补充 / 勘误 / 整卡替换） |
| 旧笔记 | 不碰不动；说"把这篇改成卡片"才原地升级，旧版本进历史折叠块 |
| 找知识 | 直接问"我笔记里有没有讲过 X"，全库检索含旧笔记（vault + 工作目录 + searchRoots）；命中标注 卡片/旧笔记 与 路径 |
| 进度 | "接着讲"续讲；"清空进度"重来（只清进度位置，记忆保留；彻底重来再"清空记忆"） |
| 兜底 | Obsidian 手改、git 回滚永远有效——磁盘是唯一真相 |

## 卡片格式（2026-09 重设计 · 三型模板）

```markdown
---
ID: 202608161430_ab12
标题: 光线与表面的两种交互：散射与吸收
领域: #图形学-光照模型 #PBR
来源: 《Unity Shader入门精要》6.1.2
状态: 已确认
模板: 工程型            # 可选；card_create 自动推断并回显
---

> 一句话定义（≤30 字最佳，≤60 字硬上限；直接引用块，不加标题）。

### 重入点              # 长卡（>3000 字）必填：30 秒 / 5 分钟 / 30 分钟三种读法
### 前置检查            # 有前置卡时必填：需要知道（卡片 ID）+ 不需要知道
### 核心思想            一句话讲清 / 为什么 / 记忆锚点
### 主干线              问题 → 关键约束 → 解法 → 代价 → 验证方式（一条因果链）
### 阶梯式解剖          第 1 层直觉 → 第 2 层机制 → 第 3 层细节推导 → 第 4 层边界（4~6 层带序号）
### 实例走查            数值代入 / 代码走查 / 场景走查
### 验证实验            # 工程型必填：≥3 步，每步"看到什么说明什么"
### 排障判据            # 工程型必填：| 症状 | 判据 | 修复 |
### 易错点              坑：为什么错
### 自测题              - **Q1**：问题 → 答案要点（答不出 → 回看 X）
### 关联卡片            - 前置：`标题`（ID）
```

| 模板 | 回答 | 必填小节 |
| :-- | :-- | :-- |
| 理论型 | 为什么 | 核心思想 / 主干线 / 阶梯式解剖 / 实例走查 / 易错点 / 自测题 |
| 工程型 | 怎么做 | 上述 + 验证实验（≥3 步）+ 排障判据 |
| 对比型 | 怎么选 | 核心思想 / 主干线 / 对比表 / 选型口诀 / 场景走查 / 易错点 / 自测题 |

**正文不设字数上下限**（长度由信息完备性决定；一张卡只回答一个问题，主题变大就拆卡互链）；定义仍限 ≤60 字。缺节出警告（不阻塞落盘，persona 归档清单强制补齐），归档后可用 `card_lint` 自检。存量旧卡不强迁，下次整卡替换时按新模板重写。完整规范与三型样张见 `presets/study/skills/card-format/SKILL.md`。

## 快速开始

> 前提：你已有一份可运行的 DSH 部署（web profile）。本仓库是插件 + 预设，不含 DSH 本体。

```powershell
# 1. 克隆并构建插件
git clone https://github.com/V-Reason/dsh-study-buddy.git
cd dsh-study-buddy
pnpm install
pnpm run check          # typecheck + 209 项测试 + 构建 lib/index.js

# 2. 把插件装进你的 DSH profile（<profileDir> 通常是 %DSH_HOME%\profiles\web）
#    在 <profileDir>\package.json 的 dependencies 里加入：
#    "dsh-study-buddy": "file:D:/path/to/dsh-study-buddy"
cd <profileDir>
pnpm install

# 3. 部署预设
Copy-Item -Recurse presets/study "$env:DSH_HOME\.agent-presets\study"

# 4. 必改：编辑 $env:DSH_HOME\.agent-presets\study\agent.cordis.yml
#    - vaultRoot：换成你自己的 Obsidian vault 绝对路径
#    - domainFolders：按你的 vault 分类调整"领域 → 目录"映射
#    - （可选）includeSessionCwd: true 把会话工作目录旧笔记纳入检索；
#      searchRoots 追加固定旧笔记目录；linkIntoNotes 决定能否写入旧笔记

# 5. 重启 DSH，新建会话，选择「学习」预设
```

> 升级插件后若 DSH 未加载新代码：删掉 `<profileDir>\node_modules\dsh-study-buddy` 再 `pnpm install`（file: 依赖不自动刷新），然后重启 DSH。

> 若你的启动器以 vault 目录为工作目录启动 DSH（如配套 launcher 的默认行为），`vaultRoot` 与工作目录相同是受支持的部署形态——插件只拒绝文件系统根作为落盘目标。

## 使用

| 你说 | 发生什么 |
| :-- | :-- |
| 新会话第一条消息 | 硬门禁：先 `study_memory(get)` + `study_progress(get)`（读取结果返回前不响应），首行衔接提示（上次学到/未答追问/上次小结）并问"接着讲？" |
| 给文件路径 / "读取 X" | 阶段一·读取：按 `file-reading` 技能读取（PDF/PNG/PPT/Word/文本…，PDF/PPTX/DOCX 自动提取内嵌图片逐张读图），只输出读取报告，待命 |
| 上传/粘贴截图 | 图片读取：`read_image`，只输出读取报告，不讲解 |
| "讲解 / 讲吧 / 开始讲解" | 阶段二·讲解：一次一个原子点，每点结尾问"清晰？细化/跳过？"，讲完待命 |
| 提问 | 三明治回答：直击 ≤3 句 → 底层逻辑 → 反诘追问 |
| 查一下 / 详细讲讲 / 深入研究 | 联网补充（标注 [联网补充]）或展开讲解 |
| "记住…" / "忘了…" | 写/删跨会话记忆（偏好、约定；告一段落自动记 lastSummary 小结） |
| 开启自迭代 / 关闭自迭代 | 切换 `_autoPrefs`（on/off，默认关）；开启后偏好/约定自动记录，无需"请记住" |
| 整理笔记 / 生成笔记 / 归档 | 按原子知识点分型出卡（数量不限，正文不设字数上限）+ `card_lint` 自检 + MOC 目录 |
| 接着讲 | 从上次断点继续 |
| 别问了 | 停止反诘追问 |

## 配置参考（`study` 插件行 config）

| 键 | 默认 | 说明 |
| :-- | :-- | :-- |
| `vaultRoot` | 必填 | Obsidian vault 绝对路径 |
| `stateDir` | `.study` | 进度状态目录（相对 vaultRoot） |
| `fallbackDir` | `未分类` | 未映射领域的落盘目录 |
| `mocDir` | `目录` | MOC 知识目录的落盘位置 |
| `domainFolders` | `{}` | 领域 → vault 内相对目录；支持多键别名指向同一目录 |
| `skipDirs` | `[]` | 额外跳过扫描的顶层目录名（内置已跳过 `.obsidian`/`.trash`/`.study`/`.git`/`node_modules`） |
| `includeSessionCwd` | `false` | 把会话工作目录（DSH 启动目录即 `{{cwd}}`）的旧笔记纳入检索；与 vault 相同/嵌套自动去重 |
| `searchRoots` | `[]` | 额外检索根（绝对路径或相对 vaultRoot）：旧笔记库，只读；不存在即挂载失败（fail-loud） |
| `linkIntoNotes` | `false` | 是否把 `card_link` 关联写入无 ID 的旧笔记本体（默认只写卡片侧，旧笔记不碰不动） |
| `lint.residueLevel` | `warn` | 会话残留规则级别：`off` 关闭 / `warn` / `error`（含残留的卡封顶 59 分） |
| `lint.rulesOff` | `[]` | 禁用的 lint 规则 id 列表（如 `['domain-tag']`） |

预设内另有压缩配置（`compaction-basic` 组）：`thresholdRatio: 0.3`、`retainRatio: 0.15`、`maxTokens: 4096`，并带 `deepseek-v4-flash` / `deepseek-v4-pro` 模型策略。

插件工具一览（12 个）：`card_search`（多根：vault + 会话工作目录 + searchRoots；标注 类型：卡片/旧笔记 与 路径）/ `card_get`（卡片与旧笔记均可）/ `card_id`（预生成占位，card_create 不消费）/ `card_create`（定义 ≤60 字硬上限；模板自动推断；领域键未映射回显可用键/近似键）/ `card_update`（append-version · errata · definition · replace；版本块插在关联卡片之前）/ `card_link`（关联行归一 + 标题/ID 双向去重；旧笔记默认只写卡片侧）/ `card_moc`（title 只传主题名，日期自动加且回显文件名/标题/日期）/ `card_lint`（14 条规则体检：单卡或全库批量）/ `card_history`（版本块/历史折叠 list + strip）/ `card_rename`（改标题同步文件名与全库入链 + 断链检测）/ `study_progress` / `study_memory`（跨会话记忆：键值笔记 + 上次小结 lastSummary + 自迭代开关 `_autoPrefs`；get 对疑似过期进度句给出提示，与进度相互独立）。

## 开发

```bash
pnpm install
pnpm run check     # typecheck + vitest（209 项）+ esbuild 构建
```

- 源码在 `src/`（零运行时依赖，仅 Node 内置模块），构建产物 `lib/index.js`（`@deepseek-ai/*` 保持 external）
- 测试在 `tests/`：段落模型与模板分型、lint 规则与白名单反例、历史块与改名、frontmatter 往返、卡片渲染/增量更新/关联、CJK+英文混合检索、原子写与路径越界、临时 vault 端到端全链路
- CI：push/PR 自动跑 `pnpm run check`（`.github/workflows/check.yml`，Node 22）

## 目录结构

```
dsh-study-buddy/
├── src/                 # 插件源码（vault 适配 / 检索索引 / 卡片模型 / 模板 / lint / 历史块 / 改名 / 工具 / 入口）
├── tests/               # 209 项单元与端到端测试
├── presets/study/       # 「学习」Agent 预设（persona + 工具行 + 6 个技能）
│   └── skills/          # file-reading / study-loop / card-format / incremental-update / domain-adaptation / memory-auto
├── docs/                # 当前文档：用户使用指南、设计文档、技术文档、经验文档
│   ├── check/           # 全功能验证脚本
│   └── archive/         # 历史文档归档（提案 / 早期需求稿 / 体检 / 复盘 / 体验报告）
├── build.mjs            # esbuild 构建脚本
└── cordis.patch.yml     # 备用：宿主平面挂载层（默认走 preset 行）
```

## 路线图

- [ ] 复习测验子模式（基于卡片库抽卡出题）
- [ ] 语义检索（嵌入向量）替代纯关键词召回
- [ ] 卡片浏览面板（客户端 Slot UI）
- [ ] `/整理笔记`、`/接着讲` 斜杠命令
- [ ] 多 vault 支持

## 致谢

- 插件包结构与构建方式参考 [dsh-at-file](https://github.com/omdsh-dev/dsh-at-file)（MIT）
- 交互设计来自早期需求文档 `docs/archive/design/DeepSeekHarness —— 通用学习 Agent.md`（历史溯源；现行口径以 `presets/study/skills/` 为准）

## License

[MIT](LICENSE)
