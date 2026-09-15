# dsh-study-buddy

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeekHarness)（DSH）的**「学习伙伴」**：一个插件 + Agent 预设，陪你把一份资料**讲完、问透、写成自己的文档**。
>
> 讲解快节奏、听懂才往下走；笔记不是摘要卡片，而是 vault 里一篇篇能独立复读的 `.md`——**写到哪个目录由你规划，写法由你 vault 根的《笔记期望.md》决定**。
>
> 版本基线：v1.0.0 ｜ [MIT](LICENSE) ｜ [快速开始](#快速开始) · [用户使用指南](docs/用户使用指南.md) · [文档地图](docs/README.md) · [更新记录](docs/更新记录.md)

## 它替你解决什么

- **读完就忘** → 四步闭环：读取资料 → 讲解 → 问答反诘 → 归档成文档
- **笔记像流水账** → 一个块 = 一个能独立阅读的知识单元，按 `资料 / 章 / 节 / 块` 成篇，每层有 `微目录.md` 当导航
- **写法不合口味** → 写法只看你的《笔记期望.md》（受众、文风、详略、结构、公式图表都由它决定），改完立即生效
- **AI 乱建文件** → 归档前先出**文件夹规划**给你拍板，落盘路径必须在你确认的范围内
- **数据不是黑盒** → 就是 vault 里的普通 Markdown：Obsidian 手改、git 回滚永远有效；推翻重写前旧正文先进 `.study/archive/` 可回退，删掉 `.study/` 也不丢一篇笔记

## 快速开始

前提：一份能跑的 DSH 部署（web profile）+ Node.js ≥ 22 + pnpm。本仓库是**插件 + 预设**，不含 DSH 本体。

```powershell
# 1. 克隆并构建插件
git clone https://github.com/V-Reason/dsh-study-buddy.git
cd dsh-study-buddy
pnpm install
pnpm run check          # typecheck + 测试 + 构建 lib/index.js

# 2. 装进 DSH profile（<profileDir> 通常是 %DSH_HOME%\profiles\web）：在其 package.json 的
#    dependencies 里加 "dsh-study-buddy": "file:D:/path/to/dsh-study-buddy"，再 pnpm install

# 3. 部署预设
Copy-Item -Recurse presets/study "$env:DSH_HOME\.agent-presets\study"

# 4. 必改两步：agent.cordis.yml 里的 vaultRoot 换成你的 vault 绝对路径；
#    再把默认期望模板复制进 vault 根，改成你自己的写法（笔记写法的唯一来源）
Copy-Item presets/study/assets/笔记期望.md "<你的vault>\笔记期望.md"

# 5. 重启 DSH，新建会话，选择「学习伙伴」预设
```

> ⚠ **第 4 步不是可选项**：没有《笔记期望.md》时 `note_write` 会拒绝写入并给创建指引（有意为之——允许回退到内建写法会把"写法只看期望"变成两处口径）。
> 升级插件后若 DSH 没加载到新代码：删掉 `<profileDir>\node_modules\dsh-study-buddy` 再 `pnpm install`（`file:` 依赖不自动刷新）。逐步详解见 [用户指南 §3](docs/用户使用指南.md#3-安装与部署)，出问题看 [§11 排障](docs/用户使用指南.md#11-故障排查手册)。

## 笔记长什么样

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

## 直接法

用初等行变换把系数矩阵化为上三角，再回代求解……

### 关联
- 前置：[[矩阵与向量]]
```

- **没有必填小节**，写什么、写多细看你的《笔记期望.md》；`来源章节` 是覆盖度总览的唯一数据源。
- 文件名不加序号前缀，阅读顺序由 `顺序` 键与 `微目录.md` 承担；检索覆盖 vault + 会话工作目录 + `searchRoots` 旧笔记，旧笔记默认只读。

## 三条硬门禁（为什么它写不乱）

1. **没读过《笔记期望.md》** → 不写（改过期望就得重读，挡住旧口径落盘）
2. **没有你确认过的文件夹规划** → 不写（提案只在对话里，凭据默认 24 小时过期，可 `abandon`）
3. **路径不在规划内 / 同一规划重复消费** → 不写

每条拒绝都带修复步骤，且**磁盘零改动**（测试逐条断言目标文件不存在）。

## 你说一句，它做什么

| 你说 | 它做 |
| :-- | :-- |
| 给文件路径 / "读取 X" | 只出读取报告（PDF/PPTX/DOCX 的内嵌图片自动逐张读），不自动开讲 |
| "讲解 / 讲讲" | 一次一个原子点，每点结尾问"清晰？细化 / 跳过？" |
| 提问 | 三明治回答：直击 ≤3 句 → 底层逻辑 → 反诘追问 |
| "整理笔记 / 归档" | 十步归档：查未答追问 → 读期望 → 列目录 → **规划提案（你拍板）** → 逐块写入 → 微目录 → 覆盖度 → 更新进度 |
| "接着讲" | 从上次断点继续（进度与记忆存在 vault 的 `.study/`） |
| 改旧笔记 | 永远先给"旧 vs 新"对比，你确认才动；追加 / 整体替换 / 只改定位 / 挪目录 |

## 最小配置

| 键 | 默认 | 说明 |
| :-- | :-- | :-- |
| `vaultRoot` | 必填 | Obsidian vault 绝对路径；为空或文件系统根会挂载失败（fail-loud） |
| `expectFile` | `笔记期望.md` | 期望文件名（vault 根下）；读取路径、门禁签名与回显都用它 |
| `planTtlHours` | `24` | 规划凭据有效期，超期要重新提案 |

其余键（`stateDir` / `fallbackDir` / `domainFolders` / `skipDirs` / `searchRoots` / `includeSessionCwd` / `linkIntoNotes` / `lint.*` / `indexTtlMs` / `maxWalkFiles`）见 [用户指南 §4 配置参考](docs/用户使用指南.md#4-配置参考逐键详解)。

## 隐私

**vault 内容会出境**：`note_*` 工具读出的标题、简介、正文片段、整篇原文与路径都会进入会话日志并发给模型服务商，`.study/` 里的进度与记忆同理；**插件自身不联网**（全仓无 `child_process`、无 HTTP 客户端、无 `eval`）。
完整的边界与自查清单见 [用户指南 §14 隐私与数据流向](docs/用户使用指南.md#14-隐私与数据流向)。**不要把不适合交给模型服务商的内容放进同一个 vault。**

## 文档

| 想知道 | 看这里 |
| :-- | :-- |
| 怎么装、怎么用、18 个工具、排障 | [用户使用指南](docs/用户使用指南.md) |
| 全部文档地图 +"改代码要同步哪些文档" | [docs/README.md](docs/README.md) |
| 性能与成本（固定开销 **14.7 KB / 18 个工具**） | [用户指南 §12](docs/用户使用指南.md#12-性能与成本) |
| 为什么这样设计 / 怎么实现 | [设计文档](docs/设计文档.md) · [技术文档](docs/技术文档.md) |
| 本轮重构的来龙去脉 | [需求分析](docs/refactor/需求分析.md) → [架构选型](docs/refactor/架构选型.md) → [重构计划](docs/refactor/重构计划.md) |
| 逐版变更 / 踩过的坑与技巧 | [更新记录](docs/更新记录.md) · [经验文档](docs/经验文档.md) |
| 已知限制与路线图 | [用户指南 §13](docs/用户使用指南.md#13-已知限制与路线图) |
| 全功能验证脚本 | [check/prompt-verify-all-features.md](docs/check/prompt-verify-all-features.md) |
| 历史归档（v0.9 审查原件、早期设计稿） | [archive/README.md](docs/archive/README.md) |

## 开发

```bash
pnpm install && pnpm run check     # typecheck → vitest → esbuild 构建 lib/index.js
```

- `src/` 零运行时依赖（只用 Node 内置模块）；模块清单、工具契约、测试布局见 [技术文档](docs/技术文档.md)。
- 想改行为？先读 [docs/README.md](docs/README.md) §二"改代码要同步哪些文档"，再动手。
- **DSH 升级后先跑这两条**（只读，10 秒出结论；判读口径见 [tools/README.md](tools/README.md)）：

  ```bash
  pnpm run verify:contract                        # 插件 ↔ 本机 DSH 的平台契约（没装 DSH 时自动跳过探针）
  pnpm run verify:deploy -- -Profile web          # 产物哈希 / 部署预设 / 技能目录 / 《笔记期望.md》
  ```

  平台与插件之间的契约变更不会以编译错误的形式暴露，`pnpm run check` 对它无感；部署副本落后
  （插件升了、预设还是老模板）同样是"看着改了其实没生效"。

## 致谢与许可

- 插件包结构与构建方式参考 [dsh-at-file](https://github.com/omdsh-dev/dsh-at-file)（MIT）
- 交互设计来自早期需求稿 `docs/archive/design/DeepSeekHarness —— 通用学习 Agent.md`（历史溯源；现行口径以 `presets/study/skills/` 为准）
- [MIT](LICENSE)
