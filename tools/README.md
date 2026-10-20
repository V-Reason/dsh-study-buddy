# tools —— 契约与部署校验

两个**只读**脚本，回答同一类问题：「我跑的那份 DSH / 那份预设，到底还是不是我改的这份？」

| 命令 | 管什么 | 需要什么 | CI |
| :-- | :-- | :-- | :-- |
| `pnpm run verify:contract` | **交付形态**（bundle 声明可解析）+ **peer 范围**（离线版本表 + 平台自己的门禁）+ 插件 ↔ 本机 DSH 的平台契约（注入来源的形状规则**不需要** DSH） | 本机装过 DSH 才跑平台探针，否则自动跳过 | 可跑（跳过探针，但**离线 peer 断言照跑**） |
| `pnpm run verify:deploy -- -Profile web` | 仓库产物 ↔ profile 安装副本 ↔ bundle 选中 ↔ **peer 范围一致** ↔ 预设 patch ↔ vault | Windows + pwsh + 本机 DSH | 不跑（依赖本机部署） |

## 为什么需要它们

平台与插件之间的契约变更**不会以编译错误的形式暴露**，而且有两种形态都很隐蔽：

1. **API 形状漂移**：2026-09-15 的 DSH 更新把 Typert strict codec 的 `schema` 换成惰性 `create()`，
   插件整行未激活，而 `pnpm run check`（typecheck + vitest）照样全绿——源码零 `@deepseek-ai/*`
   运行时导入，也没有任何断言真的去碰宿主。
2. **交付形态被删**：2026-09-24（DSH 0.1.7-rc.1，提交 `d1e22a7e24 / #4569`）删除了**目录式预设**，
   `$DSH_HOME/.agent-presets/<id>/` 再没有读者。症状是**预设整行从名单里消失、18 个工具全没，
   却没有任何报错**——平台 API 全绿，插件根本没被装配。
3. **字段语义升级**：2026-09-25（DSH 0.1.7 的 v4 会话格式）把消息来源从**包装**
   `{kind:'plugin', plugin:'x'}` 升级成**生产者自有 kind**，检查挂在 `codec.encodeEvent`（写盘路径）上。
   症状是**每个新会话的第一条消息整轮失败**：`format v4 message requires a producer-owned source kind`。
   同一类"身份字段升级"挂在不同路径上后果完全不同（写盘 = 整轮失败 / 读盘 = 会话打不开 / 投影 = 只是渲染怪）。
4. **门禁字段过期**：2026-09-29（DSH 0.2.0-rc.1）`peerDependencies["@deepseek-ai/dsh"]` 的上界
   `<0.2.0-0` 把 0.2.0-rc.1 判成不兼容，而这条判定住在**平台**里、判在**交付形态**上：
   `loadProfileDirectory` 把整个 bundle 层塞进 `skippedBundles`，预设与 18 个工具一起消失。
   `pnpm run check` 全绿、平台契约探针全绿，只有 `pnpm run verify:contract` 的 peer 那条会点名。
   **而且它曾经只在装了 DSH 的机器上才看得见**——所以现在多了一条不依赖平台的离线版本表断言。
5. **提示词变量退场**：2026-10-20（DSH 0.2.1-rc.2，提交 `79bd3d8d`）删除了 loop 的 `cwd`
   提示词变量，只保留 `provider` / `model`；自定义 persona 模板仍写 `{{cwd}}` 时，
   `dsh-system-prompt` 的 strict 插值在**首个模型请求前**抛
   `unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix"`。
   目录事实改由 `dsh-working-directory` 的 required 上下文
   `Current working directory: …` 提供；本仓库的模板变量白名单断言就是为这一类准备的。

所以分工是：

- `pnpm run test`（含 `tests/contract.spec.ts`）—— 管**仓库自己**：工具面、输出契约、宿主接线形状、
  声明 patch 的卫生（`tests/preset.spec.ts`）。零平台依赖，任何机器任何 CI 都能跑。
- `pnpm run verify:contract` —— 管**仓库 ↔ 真实 DSH**：①（文件级）`dsh.bundle.patch` 存在、声明可解析、
  `study` 行 config 键 ⊆ 插件认得的键且不含 `vaultRoot`、persona 模板变量 ⊆ loop 变量
  （`provider` / `model`；0.2.1 起 `cwd` 退场）、`src/` 与 `lib/` 无 `@deepseek-ai/*` 静态 import；
  ②（peer 范围，**两档**）**离线表**——声明的范围必须逐字等于复核值 `REVIEWED_DSH_PEER_RANGE`，
  并对一张钉死的版本表给出正确判定（不认的范围写法直接报错，不许静默通过；任何机器都跑）；
  **平台门禁**——装了 DSH 就用平台自己的 `evaluatePluginCompatibility` 判（权威判定）；
  ③（活符号）能从 `$DSH_HOME/profiles/*/node_modules`（含 `.pnpm/node_modules`，或 `--platform <dir>` 指定）
  解析到平台包就 import 真的 `ToolRuntime` / `Session` / `SystemPrompt` / `app-boot` /
  `dsh-session-format-v3-to-v4` 断言契约仍在（含把**真实注入消息**喂给平台的 v4 行编码器）；
  解析不到就打印跳过（CI 在 ubuntu 上不会因此变红）——
  与平台无关的那半（注入来源的形状规则 + 离线 peer 表）是**常跑**断言，任何机器都有增量。
- `pnpm run verify:deploy` —— 管**仓库 ↔ profile 安装副本 ↔ bundle 选中 ↔ peer 范围 ↔ 预设 patch ↔ vault**：
  依赖不自动刷新、bundle 没被选中、已装副本的范围落后、preset patch 落后、legacy 目录还在，
  这五类都是"看着改了其实没生效"的常客。

## 用法

```powershell
# 契约 + 交付形态：任何机器
pnpm run verify:contract                 # 21 条常跑断言（含离线 peer 表 + 模板变量白名单）；解析到平台包时再加 6 条平台探针（逐条打印）
pnpm run verify:contract:self-test       # 额外跑 9 例负向对照：把断言改坏必须报错
node tools/verify-contract.mjs --verbose # 打印每条断言与它对应的平台「文件:行号」
node tools/verify-contract.mjs --platform T:\deepseek-harness\node_modules\.pnpm\node_modules
                                         # 平台包不在 profile 里时（DSH 从源码树跑）手动指定解析根，让活断言真的跑起来

# 部署：本机（Windows）
pnpm run verify:deploy -- -Profile web
pwsh -NoProfile -File tools/verify-deploy.ps1 -Profile web -ReportOnly   # 只报告不返回非零
```

**升级 DSH 本体的标准动作**：先跑这两条，10 秒区分「插件坏了」「交付形态失效」「平台契约变了」
「部署副本落后了」四种情况。

## 退出码与判读

| 退出码 | 含义 |
| :-- | :-- |
| 0 | 全绿（`verify:contract` 在没装 DSH 的机器上也会打 `⏭ 跳过` 后返回 0） |
| 1 | 有断言失败：输出里每条都带「契约点：`平台文件:行号`」与「失效后果」，照它去 DSH 工作树 HEAD 读现行定义（改 `src/host.ts`） |
| 2 | 参数/环境问题（profile 名写错、`$DSH_HOME` 找不到等） |

## 负向对照为什么必须在

`verify-contract.mjs --self-test` 会把断言**故意改坏**（删一个工具、把 `output.schema.type`
改成 `object`、让 `apply` 不注册/直接抛错、清空契约表、清空认得的配置键列表、
把注入消息的来源改回退场的 `{kind:'plugin'}` 包装、把 DSH peer 范围改回 `^0.1.7-rc.1`、
把范围改成 `*`），要求每一种都必须报错。
它不是一个形式：写这套脚本时就靠它抓出过一个洞——最初的 `check()` 把「回调返回字符串」当通过，于是
「读到不对 → 返回一段中文诊断」的分支**把自己的诊断算成了绿灯**。校验脚本一旦失去
这个性质，两边一起改错就永远不会被发现。

> 同一条纪律也适用于"替身"：假 ctx **刻意不提供 `settings`**（DSH 0.1.7 删掉了 `settings.register`）——
> 如果哪天有人写出"只有 settings 在才工作"的实现，这条负向断言会立刻报红，而不是等到线上整行未激活。
