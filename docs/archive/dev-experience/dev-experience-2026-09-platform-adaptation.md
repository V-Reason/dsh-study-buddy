# dsh-study-buddy v0.4.0 → v0.5.0：0.1.3-alpha.1 平台适配实录

> 背景：dsh 2026-08-30 重构（`9135a13a8b` / `f4e49ccf8f`）后，按 `dsh-plugin-migration-guide.md`
> §3 流程对本插件做适配核验与修复。加载层无需改动（宿主产物零 `@deepseek-ai` 运行时导入），
> 唯一 API 漂移在 session 事件面；本次修复 + 版本同步 + 构建产物刷新。

## 1. 核验结论（对照源码逐项）

| 平台契约 | 结论 |
|---|---|
| `ctx.tools.register(def)`（原始 JSON-Schema ToolDefinition，`parameters` + `output.schema/render` + `execute` + `isConcurrencySafe`） | ✅ 未变（`packages/core/tools`，raw/MCP interop 路径与回归测试仍在；`register` 返回 disposer） |
| `execute(args, exec)` 的 `exec.agent.session.header.cwd` | ✅ 未变（`Agent.session: Session` 保留；`SessionHeader.cwd` 保留） |
| `ctx.get('systemPrompt').section({name, order, text})` | ✅ 签名未变；仅 `FIRST_PARTY_SECTION_ORDER` 导出移除（本插件用字面量 -1，不依赖） |
| `agent/pre-step` 瀑布（payload `{agent, messages, turn, step, signal}`；决策 `enter/reject`） | ✅ 未变（spread 保留 `startsRequestSeries`） |
| 提醒消息 `source: {kind:'plugin', plugin:'dsh-study-buddy'}` | ✅ 仍为合法 UserMessage 源（compaction-basic 同款） |
| preset 行 `name: dsh-study-buddy` 解析（profile node_modules + 上溯 farm） | ✅ 健康检查与挂载路径均成立 |
| **`Agent.session.events`（数组）** | ❌ **移除**（08-28 `5660f44d29` perf(session) 起；改 `eventAt`/`snapshotEvents()`/`ownEvents()`） |

## 2. 修复

`src/opener.ts` `hasPriorUserMessage`：双形状特性探测——旧平台 `session.events` 数组优先，
新平台回退 `session.snapshotEvents()`，两者皆缺返回 false（保守：只多注入一次预步提醒，
不阻断流程）。维持"零 @deepseek-ai 类型/运行时依赖"（纯函数，结构与形状最小化）。

- 行为变化：新平台恢复会话（日志已有 `user/message`）不再误注入开场提醒；
  全新/首轮首步仍注入；旧平台（≤08-27）行为逐字不变。
- 测试：`tests/opener.spec.ts` + `tests/apply.spec.ts` 增补新形状用例与旧形状兼容用例
  （134 → 136 项，`pnpm run check` 全绿）。

## 3. 版本与产物

- `package.json` 0.4.0 → 0.5.0；`dsh.plugin.json` 0.3.0 → 0.5.0（消除清单页版本失配）；
  README 新增「更新记录」。
- `node build.mjs` 重建 `lib/`（esbuild bundle 68.5kb + tsc 声明）。
- 发布自检（指南 §3.1 / §3.5 步骤 0）：`lib/index.js` 无 `@deepseek-ai` 导入；
  冒烟加载输出 `study-buddy ["tools"] function`。

## 4. 部署与回滚

- `dsh plugin --profile web update dsh-study-buddy`（git 源）；重启后新会话验证
  9 个工具 + 开场门禁（新会话注入 / 恢复会话不注入两分支）。
- 无 schema/config 变化：settings.yaml、vault 数据、会话数据均不受影响。
- 回滚：profile 依赖指回旧提交即可（数据无迁移）。
