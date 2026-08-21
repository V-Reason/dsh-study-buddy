# 项目健康体检报告（2026-08-21）

> 对 dsh-study-buddy v0.3.0 的全面体检：源码通读 + 基线验证 + 动态验证。本文记录体检基线、
> 发现的问题（分级）、修复内容与后续建议。对应提交见仓库历史（health-check 2026-08-21）。

## 一、体检基线

| 检查项 | 结果 |
| :-- | :-- |
| `pnpm run typecheck`（tsc strict） | ✅ 通过 |
| `pnpm run test`（vitest） | ✅ 70 项全绿（9 个文件） |
| `pnpm run build`（esbuild + tsc d.ts） | ✅ 通过（lib/index.js ≈43.4kb） |
| git 工作树 | 干净（体检前）；11 个文件被本次修复改动 |
| CI（check.yml：node 22 + pnpm frozen-lockfile） | ✅ 配置正确 |
| 运行时依赖 | ✅ 零第三方依赖（仅 node: 内置模块） |
| 工程实践 | ✅ 原子写（临时文件+rename）、路径越界防护、fail-loud 挂载、mtime 签名缓存索引、postmortem 复盘文档 |

体检范围：`src/` 7 个模块、`tests/` 9 个测试文件、`presets/study/`（persona + 5 技能）、
`docs/` 2 篇、构建/CI/包配置（build.mjs / tsconfig / vitest.config / package.json / dsh.plugin.json / check.yml）。

## 二、发现与修复

### 🔴 P0（已修复）：新格式卡片的“一句话定义”无法被索引与展示

- **现象**：`card_create` 产出的卡片（v0.3.0 定稿格式，frontmatter 后首行为裸引用块 `> 定义`）
  在 `card_search` 结果里不显示 `- 定义：` 行，定义字段的检索加权（权重 3）失效。
- **根因**：`src/frontmatter.ts` `extractDefinition` 只识别两种旧格式（`> 概念:`、`### 定义` 小节下引用），
  与 `src/card.ts` `renderCard` 输出的裸引用块格式漂移。动态验证：新格式 → `null`，旧格式 → 正常。
- **为何测试未拦住**：`tests/search.spec.ts` 的 CARD 样本用的是旧格式，`tests/store.spec.ts` 未断言定义展示，
  测试样本与真实产物格式脱节。
- **修复**（`src/frontmatter.ts`）：`extractDefinition` 增加第三级回退——`body.trimStart()` 后首行若为
  `> ` 引用块则取之；`> 概念:` 与 `### 定义` 分支优先级不变，旧笔记行为不变。
- **测试**：`frontmatter.spec.ts` 新增裸引用块用例（含优先级断言）；`search.spec.ts` CARD 样本改为
  renderCard 真实产物格式并断言 `definition` 非空；`store.spec.ts` 全链路补断言 `- 定义：` 展示。
  测试数 69 → 70。

### 🟠 P1（已修复）：文档/配置漂移

1. **README 数字过时**：测试数“63 项”改 70（5 处）；“persona + 8 个卡片工具”改 9；
   工具数表格补充说明插件注册的 9 个工具清单。
2. **`presets/study/agent.cordis.yml` 提交了真实用户路径**：`vaultRoot: 'T:\杂七杂八\2.笔记\碎语札'`
   改为占位符 `<你的vault绝对路径>` + 部署必改注释（隐私与仓库可移植性）。
3. **`docs/DeepSeekHarness —— 通用学习 Agent.md` 为历史需求文档**：头部标注“已被 card-format /
   study-loop 技能取代”，避免读者按旧格式（`### 定义` + `### 核心内容`）输出卡片。

### 🟡 P2（已修复，低风险加固）

4. `src/index.ts` 头注释“模块级 VaultStore 实例”与实现不符（apply 每次创建局部实例）——注释修正。
5. `apply()` 工具注册循环半途失败时残留已注册工具——catch 中先 dispose 再抛。
6. `study_progress set` 无任何字段时仍重写文件（bump updatedAt）——改为直接返回当前状态、不写盘。
7. `src/search.ts:94` 冗余三元（两分支完全相同）——清理。
8. `tsconfig.json` 开启 `noUnusedLocals` / `noUnusedParameters`（通过，无存量问题）。
9. `package.json` 补 `repository` / `engines`（node >=22）。

## 三、后续建议（本期未改，需决策）

| # | 建议 | 影响 | 备注 |
| :-- | :-- | :-- | :-- |
| 1 | `card_update` replace 模式补 `links` 参数（或文档化“replace 丢弃活动关联小节”） | 旧关联只留在历史折叠块 | 需确认工具 schema 是否加字段 |
| 2 | 工具 schema 的 `status` 加 `enum` 约束 | 减少模型传非法值 | 现由 validateCard 兜底抛错 |
| 3 | `SKIP_DIRS` 硬编码 `资源` 目录名配置化 | vault 特定目录写死在插件 | 需确认配置键 |
| 4 | `card_link` 去重从 `raw.includes(标签)` 升级为按卡片 ID 去重 | 标题变更后重复关联会重复添加 | 需定义“目标”的规范化规则 |
| 5 | 索引签名加入 `ctimeMs` | 同毫秒同大小重写会漏重建（Obsidian 快速自动保存场景） | 概率低，成本低 |
| 6 | npm 发布物（`files`）不含 `presets/` | npm 安装后拿不到预设 | 发布前补齐或文档化部署流程 |
| 7 | `study_memory remove` 对不存在的键提示差异 | 现返回“已删除”误导 | 轻微 |
| 8 | `memory`/`state` 的 `readXxx` 损坏抛错 vs 静默降级策略 | 现损坏文件直接抛错 | 设计取舍，保持 fail-loud |

## 四、验收结果

- `pnpm run typecheck` ✅ / `pnpm run test` ✅（70 项）/ `pnpm run build` ✅
- 动态验证（node 直跑源码）：新格式定义提取 ✅、旧格式两路径回归 ✅、无定义返回 null ✅
- 旧格式回归：`> 概念:` 与 `### 定义` 既有测试全部保持通过
- README 数字与实测一致；agent.cordis.yml 不再含真实用户路径
