# 故障复盘：vaultRoot 等于工作目录时，study 预设工具静默不注册

- 日期：2026-08-21
- 影响版本：dsh-study-buddy 0.2.0 – 0.3.0
- 定位耗时：数天（跨会话）；根因一句话可解释
- 修复提交：见仓库历史（`src/index.ts` normalizeConfig + fail-loud 改造，新增 `tests/apply.spec.ts` 回归）

## 摘要

DSH 由配套 launcher 以 Obsidian vault 目录为工作目录启动（`pwsh -WorkingDirectory <vault> -Command "node … web"`），进程 `cwd` 恰好等于 vault。插件 `normalizeConfig` 的防护把"vaultRoot 等于当前目录"误判为危险配置而抛错；`apply` 捕获后仅 `console.error` 并静默 `return`。结果：预设挂载成功、study 行处于激活状态、其余 10 个行的工具全部注册，唯独本插件的 9 个工具从未注册，且没有任何会话级报错——报错行只存在于最小化的 DSH 控制台窗口。所有离线复现全部"成功"，因为它们的工作目录都不是 vault。

## 现象

1. study 会话正常创建并跑轮；persona、5 个预设技能、其余 10 个行的 12 个工具（read/glob/grep/pwsh/web_search/ask_user_question/todo_write/skill 等）全部正常。
2. 唯独 `dsh-study-buddy` 的 9 个工具（card_search/card_get/card_id/card_create/card_update/card_link/card_moc/study_progress/study_memory）一个都不在模型工具清单里。
3. 挂载不报 `agent-preset-invalid`——会话能创建，说明该行"激活"（inject 已解析、apply 已执行）。
4. 历史沿革：v0.2.0 时代即存在（旧会话 Agent 自述"插件未挂载"）；8/16–8/19 的"学习"会话实际全部由 standard 预设运行（session.list 佐证），掩盖了问题。

## 根因链（五环缺一不可）

1. **launcher**：以 vault 目录为工作目录拉起 DSH，node 进程 `cwd == vault`。
2. **插件防护误伤**：`normalizeConfig` 中 `vaultRoot === resolve('.')` 的比较——`resolve('.')` 即 cwd，vaultRoot 恰好等于 cwd 时被判定为"当前目录"而抛错（防护本意是拒绝未配置的 `.`，却误伤了合法部署）。
3. **静默失败**：`apply` 捕获异常后 `console.error` + `return`，不抛错、不写日志系统。
4. **日志不可达**：launcher 不接管 stdout/stderr，输出只进独立控制台窗口，无日志文件。
5. **挂载审计的盲区**：preset 挂载审计只检查"行是否激活 / 是否泄漏服务"，apply 内部的静默失败无法被发现。

真实报错行（自 19:03 起一直躺在控制台窗口里）：

```text
[dsh-study-buddy] vaultRoot 不能是文件系统根或当前目录：T:\杂七杂八\2.笔记\碎语札
```

## 时间线

| 时间 | 事件 |
| :-- | :-- |
| 8/16–8/19 | "学习"会话实际由 standard 预设运行；todos 里的"写卡片"是 Agent 手写文件，不是 card_create |
| 8/20 23:31 | 部署 v0.3.0 预设（文件哈希与仓库一致） |
| 8/20 23:37 | 插件构建并同步至 profile（`lib/index.js` 与仓库逐字节一致） |
| 8/21 18:58 | 旧进程中的 study 会话——同样缺 9 个工具 |
| 8/21 19:02:54 | 新进程（PID 35860）启动，cwd = vault |
| 8/21 19:03 | study 会话创建；Agent 自述"工具列表里没有 study_memory" |
| 8/21 夜间 | 通过会话事件、在线进程探查、fail-loud 受控实验定位根因；修复 + 69 项测试全绿 |

## 排查过程与关键证据

1. **会话事件是工具清单的第一证据源**：`session.history` 的 `request/header` 事件完整记录了模型实际收到的 `tools` 数组（12 个，无 card_*）——"会话不记录工具清单"的印象不成立。
2. **部署三要素核对**：插件、预设、进程命令行逐一哈希/比对，排除"部署错、代码旧"。
3. **在线进程探查**（动态插件 + `standingKeyFor` + `systemPrompt.assemble({scope})`）：确认其余行的工具都注册在 study standing 层，study 行的工具不在任何可见层；挂载本身零问题。
4. **受控实验定案**：给已安装副本打 fail-loud 补丁，用 `agentPresets.copy` 复制预设触发全新挂载，把静默错误变成 `agent-preset-invalid`，直接捕获真实异常文本 → 锁定 cwd 误伤。

## 为什么此前的复现全部失效（三个排查陷阱）

1. **cwd 陷阱**：复现脚本的工作目录（harness 根 / profile 目录）都不是 vault，防护不触发。复现环境与真实环境只差一个"进程工作目录"，却是决定性差异——复现必须复刻进程级全局状态。
2. **预设文件位置陷阱**：`mini-study.yml` 恰好放在 profile 目录内，即使裸包名解析走了 Include 的回退路径也能成功，未真正复现真实挂载路径（真实路径由 `mountPreset` 以宿主 baseUrl 解析）。
3. **ESM 模块缓存陷阱**：进程内 `import()` 按 URL 缓存模块；"改了已安装副本再触发挂载"仍复用旧模块，必须用带 query 的 file URL 或新进程才能加载新代码。

## 修复内容

- `src/index.ts`：
  - `normalizeConfig` 只拒绝空值与文件系统根，**不再拒绝 vaultRoot == cwd**（launcher 以 vault 为工作目录是受支持部署形态）。
  - `apply` 全面 fail-loud：config 失败、`ctx.tools.register` 缺失、单工具注册失败一律抛错——今后任何故障都会以 `agent-preset-invalid`（含完整原因）暴露。
  - 9 个注册 disposer 由 `ctx.effect` 持有，随预设作用域注销。
- `tests/apply.spec.ts`（新增 6 项）：vaultRoot==cwd 注册成功、文件系统根/缺失配置/注册表缺失/注册失败均抛错、effect 卸载移除工具。合计 69 项测试全绿。
- `README.md`：补充"以 vault 为工作目录启动是受支持场景"。

## 教训清单

1. **插件 apply 的失败路径永远不要静默吞掉**。preset 挂载审计不会替插件发现内部静默失败；fail-loud 是插件对"可诊断性"的最低义务。
2. **配置校验不要与进程工作目录耦合**。cwd 是环境事实，不是配置错误；拒绝"等于 cwd"的配置前先想清楚部署形态。
3. **启动器与插件的契约要成文**：cwd == vault 是合法部署，写进 README，而不是让插件靠猜测防护。
4. **复现脚本必须复刻真实进程状态**（cwd、环境变量、宿主组合、启动路径），"代码同、环境异"是幽灵故障的温床。
5. **会话 `request/header` 事件是排查工具清单的第一证据源**，优先于 Agent 自述与工具调用历史。
6. **控制台窗口不是日志系统**：launcher 应提供 stdout/stderr 落盘选项（后续改进项），否则这类问题只能靠受控实验反推。

## 后续改进建议

- launcher 增加 `--log-file`（或默认落盘），使 `[dsh-study-buddy]` 这类前缀日志可检索。
- 插件侧可考虑把 `console.error` 升级为 `ctx.logger.warn`（结构化、可进日志系统）。
- preset 挂载审计可考虑"行激活但注册产物为空"的启发式提示（需 harness 侧支持，非本仓库范围）。
