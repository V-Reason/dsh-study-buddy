# tools —— 契约与部署校验

两个**只读**脚本，回答同一类问题：「我跑的那份 DSH / 那份预设，到底还是不是我改的这份？」

| 命令 | 管什么 | 需要什么 | CI |
| :-- | :-- | :-- | :-- |
| `pnpm run verify:contract` | 插件 ↔ 本机 DSH 的平台契约 | 本机装过 DSH（否则平台探针自动跳过） | 可跑（跳过探针） |
| `pnpm run verify:deploy -- -Profile web` | 仓库产物 ↔ profile 安装副本 ↔ 部署预设 ↔ vault | Windows + pwsh + 本机 DSH | 不跑（依赖本机部署） |

## 为什么需要它们

平台与插件之间的契约变更**不会以编译错误的形式暴露**：2026-09-15 的 DSH 更新把 Typert
strict codec 的 `schema` 换成了惰性 `create()`，插件整行未激活，而 `pnpm run check`
（typecheck + vitest）照样全绿——源码零 `@deepseek-ai/*` 运行时导入，也没有任何断言
真的去碰宿主。同一轮排查还发现另一种更隐蔽的形态：**部署副本还是卡片时代的预设**，
persona 教模型调 18 个工具里根本不存在的 `card_*`。

所以分工是：

- `pnpm run test`（含 `tests/contract.spec.ts`）—— 管**仓库自己**：工具面、输出契约、
  宿主接线形状。零平台依赖，任何机器任何 CI 都能跑。
- `pnpm run verify:contract` —— 管**仓库 ↔ 真实 DSH**：能从 `$DSH_HOME/profiles/*/node_modules`
  解析到平台包就 import 真的 `ToolRuntime` / `Session` / `SystemPrompt` 断言方法仍在；
  解析不到就打印跳过（CI 在 ubuntu 上不会因此变红）。
- `pnpm run verify:deploy` —— 管**仓库 ↔ profile 安装副本 ↔ 部署预设 ↔ vault**：
  `file:` 依赖不自动刷新、预设是各机自行编辑的副本，这两处是"看着改了其实没生效"的常客。

## 用法

```powershell
# 契约：任何机器
pnpm run verify:contract                 # 13 条契约断言（本机有 DSH 时 + 4 条平台探针）
pnpm run verify:contract:self-test       # 额外跑负向对照：把断言改坏必须报错
node tools/verify-contract.mjs --verbose # 打印每条断言与它对应的平台「文件:行号」

# 部署：本机（Windows）
pnpm run verify:deploy -- -Profile web
pwsh -NoProfile -File tools/verify-deploy.ps1 -Profile web -ReportOnly   # 只报告不返回非零
```

**升级 DSH 本体的标准动作**：先跑这两条，10 秒区分「插件坏了」还是「平台契约变了」还是
「部署副本落后了」。

## 退出码与判读

| 退出码 | 含义 |
| :-- | :-- |
| 0 | 全绿（`verify:contract` 在没装 DSH 的机器上也会打 `⏭ 跳过` 后返回 0） |
| 1 | 有断言失败：输出里每条都带「契约点：`平台文件:行号`」与「失效后果」，照它去 DSH 工作树 HEAD 读现行定义 |
| 2 | 参数/环境问题（profile 名写错、`$DSH_HOME` 找不到等） |

## 负向对照为什么必须在

`verify-contract.mjs --self-test` 会把断言**故意改坏**（删一个工具、把 `output.schema.type`
改成 `object`、让 `apply` 不注册/直接抛错），要求每一种都必须报错。它不是一个形式：
写这套脚本时就靠它抓出过一个洞——最初的 `check()` 把「回调返回字符串」当通过，于是
「读到不对 → 返回一段中文诊断」的分支**把自己的诊断算成了绿灯**。校验脚本一旦失去
这个性质，两边一起改错就永远不会被发现。
