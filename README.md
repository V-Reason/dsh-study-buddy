# dsh-study-buddy

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeekHarness)（DSH）的「通用学习 Agent」模式：一个**苏格拉底式学习伙伴**插件 + Agent 预设。快节奏讲解、四步学习闭环、原子卡片（Zettelkasten 风格）直接写入你的 Obsidian vault——**知识即卡片，卡片即知识**。

## 特性

- **四步学习闭环**：资料摄入 → 讲解拓展 → 问答反诘（三明治原则）→ 笔记归档，每步都有明确模板与检查清单
- **原子卡片落盘 Obsidian vault**：卡片就是普通 `.md` 文件，与你的旧笔记同库同目录，Obsidian 可直接打开、编辑、git 管理；插件做全库索引，旧笔记（无 frontmatter）同样可被检索
- **增量更新（活笔记）**：补充加"版本更新"、推翻加"勘误"、无关则新卡关联——旧内容永不丢失，更新决定权永远在你
- **全库检索与重叠预警**：摄入新资料前自动检索已有卡片，提示重叠与差异
- **跨会话进度与记忆**：当前资料/小节/未答追问持久化，重启后"接着讲"从断点继续；新会话开场自动读回进度与记忆，首行衔接提示不脱节；偏好/约定/小结可"记住"
- **快节奏 + 用户主动权**：默认精简回答，深入研究（联网/超纲推导）由你开口才做
- **指令驱动（听指挥）**：读取 ≠ 讲解——"读取 X"只输出读取报告，说"讲解"才开始讲；读取 PDF/PNG/PPT 等文件走内置 `file-reading` 技能，不摸索工具
- **MOC 知识目录**：归档时自动生成按领域分组的知识地图
- **轻量**：每次请求固定开销约 15KB（比标准模式低 ~30%）；技能按需加载；会话早期自动压缩历史（阈值 30%）
- 63 项单元测试覆盖卡片渲染、检索索引、增量更新、进度与记忆持久化、原子写与路径安全

## 性能与成本（2026-08 实测估算）

每次请求的固定开销（persona + 工具 schema）：

| 模式 | 固定开销 | 模型可见工具 |
| :-- | --: | --: |
| 标准模式 | ~21.3 KB | ~26 个 |
| 学习伙伴 | ~15.0 KB\* | 21 个 |

\* 实测基线（2026-08）；新增 `study_memory` 与记忆小节后为估算（约 +0.5KB，未重新实测）。

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
你说的话 → 「学习」会话（persona + 8 个卡片工具）
                  │ card_search / card_create / card_update / study_progress …
                  ▼
       插件直连你的 Obsidian vault（node:fs 直写，不经沙箱）
                  │ 卡片 = vault 里普通的 .md 文件，与旧笔记同库
                  ▼
       内存索引（标题/标签/正文，mtime 签名缓存）——磁盘变了自动重扫
```

- 卡片不是数据库记录，就是带 frontmatter 的 Markdown 文件；你在 Obsidian 里改它，插件下次检索即重扫，互不打架
- 学习进度存于 vault 的 `.study/progress.json`，跨会话、跨重启有效
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
| 找知识 | 直接问"我笔记里有没有讲过 X"，全库检索含旧笔记 |
| 进度 | "接着讲"续讲；"清空进度"重来（只清进度位置，记忆保留；彻底重来再"清空记忆"） |
| 兜底 | Obsidian 手改、git 回滚永远有效——磁盘是唯一真相 |

## 卡片格式（定稿）

```markdown
---
ID: 202608161430_ab12
标题: 光线与表面的两种交互：散射与吸收
领域: #图形学
来源: 《Unity Shader入门精要》6.1.2
状态: 草稿 / 已确认 / 需更新
---

> 一句话定义（30 字左右，直接引用块，不加标题）。

### 自由小节

推导、表格、公式（块级 LaTeX 编号）、代码（标注语言）自由组织。

### 关联卡片

- 前置：`辐照度与朗伯余弦定律`（基础光照模型 6.1）
- 后续：`漫反射模型（Lambert）`、`Phong/Blinn-Phong 高光`
- 易混淆：漫反射 vs 高光反射（物理来源不同）
```

完整规范与样张见 `presets/study/skills/card-format/SKILL.md`。

## 快速开始

> 前提：你已有一份可运行的 DSH 部署（web profile）。本仓库是插件 + 预设，不含 DSH 本体。

```powershell
# 1. 克隆并构建插件
git clone https://github.com/V-Reason/dsh-study-buddy.git
cd dsh-study-buddy
pnpm install
pnpm run check          # typecheck + 63 项测试 + 构建 lib/index.js

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

# 5. 重启 DSH，新建会话，选择「学习」预设
```

> 升级插件后若 DSH 未加载新代码：删掉 `<profileDir>\node_modules\dsh-study-buddy` 再 `pnpm install`（file: 依赖不自动刷新），然后重启 DSH。

> 若你的启动器以 vault 目录为工作目录启动 DSH（如配套 launcher 的默认行为），`vaultRoot` 与工作目录相同是受支持的部署形态——插件只拒绝文件系统根作为落盘目标。

## 使用

| 你说 | 发生什么 |
| :-- | :-- |
| 新会话第一条消息 | 自动读回记忆与进度：`study_memory(get)` + `study_progress(get)`，首行衔接提示（上次学到/未答追问/上次小结）并问"接着讲？" |
| 给文件路径 / "读取 X" | 阶段一·读取：按 `file-reading` 技能读取（PDF/PNG/PPT/文本…），只输出读取报告，待命 |
| 上传/粘贴截图 | 图片读取：`read_image`，只输出读取报告，不讲解 |
| "讲解 / 讲吧 / 开始讲解" | 阶段二·讲解：一次一个原子点，每点结尾问"清晰？细化/跳过？"，讲完待命 |
| 提问 | 三明治回答：直击 ≤3 句 → 底层逻辑 → 反诘追问 |
| 查一下 / 详细讲讲 / 深入研究 | 联网补充（标注 [联网补充]）或展开讲解 |
| "记住…" / "忘了…" | 写/删跨会话记忆（偏好、约定；告一段落自动记 lastSummary 小结） |
| 整理笔记 / 生成笔记 / 归档 | 1~3 张卡片落盘 + MOC 目录 |
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

预设内另有压缩配置（`compaction-basic` 组）：`thresholdRatio: 0.3`、`retainRatio: 0.15`、`maxTokens: 4096`，并带 `deepseek-v4-flash` / `deepseek-v4-pro` 模型策略。

插件工具一览：`card_search` / `card_get` / `card_id` / `card_create` / `card_update`（append-version · errata · replace）/ `card_link` / `card_moc` / `study_progress` / `study_memory`（跨会话记忆：键值笔记 + 上次小结 lastSummary，与进度相互独立）。

## 开发

```bash
pnpm install
pnpm run check     # typecheck + vitest（63 项）+ esbuild 构建
```

- 源码在 `src/`（零运行时依赖，仅 Node 内置模块），构建产物 `lib/index.js`（`@deepseek-ai/*` 保持 external）
- 测试在 `tests/`：frontmatter 往返、卡片渲染/增量更新/关联、CJK+英文混合检索、原子写与路径越界、真实 vault 端到端全链路
- CI：push/PR 自动跑 `pnpm run check`（`.github/workflows/check.yml`，Node 22）

## 目录结构

```
dsh-study-buddy/
├── src/                 # 插件源码（vault 适配 / 检索索引 / 卡片渲染 / 进度与记忆 / 入口）
├── tests/               # 63 项单元与端到端测试
├── presets/study/       # 「学习」Agent 预设（persona + 工具行 + 5 个技能）
│   └── skills/          # file-reading / study-loop / card-format / incremental-update / domain-adaptation
├── docs/                # 需求与设计文档
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
- 交互设计来自需求文档 `docs/DeepSeekHarness —— 通用学习 Agent.md`

## License

[MIT](LICENSE)
