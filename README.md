# dsh-study-buddy

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeekHarness)（DSH）的**「学习伙伴」**：一个插件 + Agent 预设，陪你把一份资料**讲完、问透、写成自己的文档**。
>
> 讲解快节奏、听懂才往下走；笔记不是摘要卡片，而是 vault 里一篇篇能独立复读的 `.md`——**写到哪个目录由你规划，写法由你 vault 根的《笔记期望.md》决定**。
>
> 版本基线：v1.1.1 ｜ [MIT](LICENSE) ｜ [快速开始](#快速开始) · [用户使用指南](docs/用户使用指南.md) · [文档地图](docs/README.md) · [更新记录](docs/更新记录.md)

## 它替你解决什么

- **读完就忘** → 四步闭环：读取资料 → 讲解 → 问答反诘 → 归档成文档
- **笔记像流水账** → 一个块 = 一个能独立阅读的知识单元，按 `资料 / 章 / 节 / 块` 成篇，每层有 `微目录.md` 当导航
- **写法不合口味** → 写法只看你的《笔记期望.md》（受众、文风、详略、结构、公式图表都由它决定），改完立即生效
- **AI 乱建文件** → 归档前先出**文件夹规划**给你拍板，落盘路径必须在你确认的范围内
- **数据不是黑盒** → 就是 vault 里的普通 Markdown：Obsidian 手改、git 回滚永远有效；推翻重写前旧正文先进 `.study/archive/` 可回退，删掉 `.study/` 也不丢一篇笔记

## 快速开始

前提：一份能跑的 DSH 部署（web profile）+ Node.js ≥ 22 + pnpm。本仓库是**插件 + 预设**，不含 DSH 本体。
DSH 要求 **≥ 0.1.7-rc.1**（更低版本没有 `dsh.bundle.patch` 这套声明式预设，见 [安装与兼容性](#安装与兼容性)）。

```powershell
# 1. 装进 DSH profile —— 本包是「bundle」：装它同时把「学习伙伴」预设声明进 profile
dsh plugin --profile web add dsh-study-buddy
#   本地开发也可以用：plugin_manager install_bundle target=<绝对路径>
#   装完确认 profile 的 dsh.profile.bundles 含本包（预设在下次启动/热重载时出现）

# 2. 告诉插件你的 vault 在哪（包内**不含**机器路径，三种给法任选）
$env:DSH_STUDY_VAULT = 'D:\你的vault绝对路径'        # ① 环境变量（推荐，重启 DSH 生效）
#   ② 或写 <DSH_HOME>\study-buddy.json： {"vaultRoot":"D:\\你的vault绝对路径","skipDirs":["资源"]}
#   ③ 或覆盖 presets/study.patch.yml 里 study 行的 config.vaultRoot（部署侧精调）

# 3. 把默认期望模板复制进 vault 根，改成你自己的写法（笔记写法的唯一来源）
Copy-Item presets/study/assets/笔记期望.md "D:\你的vault绝对路径\笔记期望.md"

# 4. 重启 DSH，新建会话，选择「学习伙伴」预设
```

只读自检三步（都不需要翻日志）：`plugin_manager list_bundles` → 本包在列；`plugin_manager list_plugins`
→ `include:preset-study` 且 `fiberPhase: active`；新会话里 18 个 `note_*` / `study_*` 工具都在。

> ⚠ **第 3 步不是可选项**：没有《笔记期望.md》时 `note_write` 会拒绝写入并给创建指引（有意为之——允许回退到内建写法会把"写法只看期望"变成两处口径）。
> 升级插件后若 DSH 没加载到新代码：删掉 `<profileDir>\node_modules\dsh-study-buddy` 再 `pnpm install`（依赖不自动刷新）。逐步详解见 [用户指南 §3](docs/用户使用指南.md#3-安装与部署)，出问题看 [§11 排障](docs/用户使用指南.md#11-故障排查手册)。

## 安装与兼容性

| DSH 版本 | 本插件 | 说明 |
| :-- | :-- | :-- |
| ≥ 0.1.7-rc.1 | v1.1.1+ | **声明式预设**（`dsh.bundle.patch`）——当前形态；v1.1.1 起注入消息改用生产者自有 kind，才能通过 v4 写盘准入 |
| ≥ 0.1.7-rc.1 | v1.1.0 | 交付形态对，但开场门禁的来源用了退场的 `{kind:'plugin'}` 包装：**每个新会话的首条消息都会整轮失败**（`format v4 message requires a producer-owned source kind`）→ 升到 v1.1.1 |
| ≤ 0.1.6 | v1.0.x | 目录式预设（`%DSH_HOME%\.agent-presets\study\`）；该目录**自 0.1.7 起平台已不再读取** |

- **装法**：`dsh plugin --profile <name> add dsh-study-buddy`（或 `plugin_manager install_bundle`），
  然后确认 `dsh.profile.bundles` 里有本包 —— 少了这一步只是"预设不出现"，**不会报错**，
  这是 2026-09-24 那次失效的真实形态（详见 [技术文档 §9.2](docs/技术文档.md)）。
- **升级 / 本地改动**：profile 里记的是 `github:V-Reason/dsh-study-buddy`，所以**改了必须先 `git push`，
  再 `dsh plugin --profile <name> update dsh-study-buddy`**。只改本机不推，下一次 profile 里的任何
  `pnpm install`（装卸别的插件也会触发）都会把 `node_modules\<插件>` 换回远端那个提交——旧版没有
  `dsh.bundle.patch`，于是被从 `dsh.profile.bundles` 里摘掉、预设在注册表里消失，而 `dsh web`
  只会报别的插件的错。`pnpm tools/verify-deploy.ps1 -Profile <name>` 的第 1、2 节就是为这种
  "看着改了、其实被回滚"准备的。
- **兼容门禁**：本包在 `package.json` 声明 `peerDependencies["@deepseek-ai/dsh"]`。DSH 会按它拒绝装载不兼容版本；
  升级 DSH minor（如 0.2.x）需要同步提这个范围，或用 `plugin_manager` 的版本豁免（有风险，慎用）。
  忘了提范围的表现是"插件被拒绝装载"，跑 `pnpm run verify:contract` 会直接点名。
- **DSH 内部 API 漂移怎么办**：本插件对 DSH 的依赖**全部收在 `src/host.ts`**（`HOST_CONTRACTS` 契约表 +
  特性探测/降级），源码与产物里**没有任何 `@deepseek-ai/*` 静态 import**。升级 DSH 后先跑
  `pnpm run verify:contract`：它会对着**运行中的 DSH** 逐点断言并指出"平台源码坐标 + 失效后果 + 改哪里"。
- **可选兼容层**：[`@dsh-plugin/dsh-loader`](https://github.com/dsh-plugins/dsh-loader) 装了就用它的稳定入口，
  没装完全照常（本包不 import、不 inject 它）。注意它当前的覆盖面是 settings 桥 / 包名别名 / `Session.events`
  补丁，**不含**本插件的三个真实触点（工具注册、系统提示段、`agent/pre-step`），所以它是加分项而不是防线。

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

`vaultRoot` 是**唯一必填**项，而且它**不在包里**（包开源、多机共用）。三种给法按优先级：

| 序 | 给法 | 例子 |
| --: | :-- | :-- |
| 1 | 预设声明行 `presets/study.patch.yml` 的 `study` 行 `config.vaultRoot` | 部署侧精调（会随包更新被覆盖的注意点见 [用户指南 §3](docs/用户使用指南.md#3-安装与部署)） |
| 2 | 环境变量 `DSH_STUDY_VAULT`（别名 `DSH_VAULT_ROOT`） | `setx DSH_STUDY_VAULT "D:\vault"`，重启 DSH |
| 3 | `<DSH_HOME>/study-buddy.json` | `{"vaultRoot":"D:\\vault","skipDirs":["资源"],"searchRoots":[]}` |

三者都没有 → 挂载失败（fail-loud），错误里会列出这三种给法。挂载时日志会打印一行
`[dsh-study-buddy] vaultRoot ← <来源>：<路径>`，排障第一问不必翻配置。

| 键 | 默认 | 说明 |
| :-- | :-- | :-- |
| `vaultRoot` | — | Obsidian vault 绝对路径；为空或文件系统根会挂载失败（fail-loud） |
| `expectFile` | `笔记期望.md` | 期望文件名（vault 根下）；读取路径、门禁签名与回显都用它 |
| `planTtlHours` | `24` | 规划凭据有效期，超期要重新提案 |

其余键（`stateDir` / `fallbackDir` / `domainFolders` / `skipDirs` / `searchRoots` / `includeSessionCwd` / `linkIntoNotes` / `lint.*` / `indexTtlMs` / `maxWalkFiles`）见 [用户指南 §4 配置参考](docs/用户使用指南.md#4-配置参考逐键详解)（含"来源与优先级"一节）。

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
  pnpm run verify:contract                        # 交付形态 + 插件 ↔ 本机 DSH 的平台契约（没装 DSH 时自动跳过探针）
  pnpm run verify:deploy -- -Profile web          # 产物哈希 / 已装 bundle 的预设 patch / 技能目录 / 《笔记期望.md》
  ```

  平台与插件之间的契约变更不会以编译错误的形式暴露，`pnpm run check` 对它无感；部署副本落后
  （插件升了、预设还是老模板，或 bundle 没被 profile 选中）同样是"看着改了其实没生效"。
  `verify:contract` 还会断言本包**交付形态**：`dsh.bundle.patch` 存在、声明可解析、`study` 行不含
  `vaultRoot`（这两条正是 2026-09-24 那次"预设整行消失、工具全没"的病根）。

## 致谢与许可

- 插件包结构与构建方式参考 [dsh-at-file](https://github.com/omdsh-dev/dsh-at-file)（MIT）
- 交互设计来自早期需求稿 `docs/archive/design/DeepSeekHarness —— 通用学习 Agent.md`（历史溯源；现行口径以 `presets/study/skills/` 为准）
- [MIT](LICENSE)
