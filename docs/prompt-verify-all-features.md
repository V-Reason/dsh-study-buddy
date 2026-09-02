# 学习伙伴模式·全功能验证（开场提示词）

> 用法：把下面整段复制为「学习」预设**新会话的第一条消息**。第 0–3、5 部分由 Agent
> 连续自动执行；第 4 部分需要你按清单逐条发令配合。验证会在 vault 落盘少量
> 【验证】测试卡与 MOC，收尾会恢复进度/记忆原值并给出清理指引。

---

本次会话为**功能验证会话**。我已授权你连续执行以下清单，无需每步停留确认；
每完成一项输出一行结果（✔/✘ + 一行证据），全部完成后输出汇总报告。
涉及 vault 落盘/修改的操作**只准**通过 card_*/study_* 工具，不得用其他方式改动 vault 文件。

## 0 · 环境与基线
1. 按惯例执行开场衔接：`study_memory(get)` + `study_progress(get)`，输出一行衔接提示（验证跨会话记忆读取与开场衔接行为）。
2. 记录第 1 步返回的进度/记忆**原值**（收尾恢复用；为空则记“空”）。
3. 读 preset 配置，报告 vaultRoot；从 domainFolders 任选一个映射键（用于映射落盘验证）。

## 1 · 检索与读取（card_search / card_get）
4. `card_search` 一个 vault 中大概率存在的概念词（若未命中则换词，直到命中一次）：核对返回字段齐全（标题/ID/领域/状态/来源/定义/片段）。
5. `card_search` 一个未命中词（如 `zzqqxx`）：应返回“未命中（共 N 篇）”。
6. `card_search` 带 domain 过滤、status 过滤各一次。
7. `card_get`：分别用 **ID**、**标题**、**相对路径** 三种 ref 读取同一张卡。

## 2 · 卡片生命周期（card_id / card_create / card_update / card_link / card_moc）
8. `card_id` 生成 3 个：核对 `YYYYMMDDHHmm_xxxx` 格式。
9. `card_create` 一张**映射领域**卡：标题以 `【验证】` 开头、定义 ≤30 字；核对落盘目录 = 映射目录、返回含 ID。
10. `card_create` 一张**未映射领域**卡（domain 用 `验证专用`）：核对落入 `未分类/验证专用/`。
11. `card_create` 传空 title：应报“卡片校验失败”（fail-loud，不落盘）。
12. `card_search` 检索第 9 步的卡：核对结果含 `- 定义：` 行。
13. `card_update` append-version：尾部出现 `### 版本更新（来源：…）`，旧内容保留。
14. `card_update` errata：出现 `### 勘误`，旧结论保留。
15. `card_update` replace（带 `links` 传 prev/next）：标题/状态更新、旧版进“历史版本”折叠块、新卡含关联小节。
16. `card_link` prev / next / conflict 三向各一次：核对两卡**双向**更新。
17. 对同一对卡重复 `card_link` 同 kind：核对不产生重复行（按 ID 去重）。
18. `card_link` 传非法 kind（如 `sideways`）：应报错。
19. `card_moc` 传入本次涉及卡片 ID：核对按领域分组 + Obsidian wikilink + 落入 `目录/` 目录。

## 3 · 进度与记忆（study_progress / study_memory）
20. `study_progress` set（material/section/pendingQuestions/touchedCardIds 全字段）→ get 核对 → clear 核对。
21. `study_memory`：set prefs → get 单键 → get 全量（核对 lastSummary 置顶）→ append → remove 存在键 → remove 不存在键（应提示“无此键”且不写盘）。
22. 自迭代开关：set `_autoPrefs=on` → get 单键/全量核对置顶行 → 非法值（如 `yes`）应报错、append 应拒绝 → remove 回默认关闭 → 恢复原开关状态（原为空则 remove，非空则 set 回原值）。
23. 边界：超长 value（>4000 字符）被拒、空 key 被拒、未知 action 被拒。

## 4 · 行为与流程（persona 规则，需我逐条发令）
以下四项请在我发出对应指令后执行，并告诉我每项是否符合 persona 规则：
- **A**：我发“读取 <工作区内任一文本文件路径>”——你应只输出读取报告，不讲解（读取 ≠ 讲解）。
- **B**：我发“讲解 <概念>”（概念由我指定）——一次一个原子点 ≤15 行，结尾问“清晰？细化/跳过？”。
- **C**：我提一个概念问题——三明治回答（直击 ≤3 句 → 底层逻辑 → 反诘追问）。
- **D**：我发“归档”——按原子知识点生成 `【验证】` 卡（数量不限，一张卡=一个原子知识点）+ `card_moc`，只重组去重、不加新知识；每张卡须含阶梯式解剖模板五小节（核心思想/阶梯式解剖/实例走查/易错点/自测题）。

## 5 · 收尾
24. 恢复进度/记忆：把第 2 步记录的原值写回（原值为空则 clear，非空则 set 回原值；含开关状态）。
25. 清理测试数据：列出全部创建的 `【验证】` 文件路径（卡 + MOC）；尝试用你可用且安全的工具删除；删除不了就给出手动删除清单（或提示可用 git 还原）。
26. 输出汇总报告：按 0–5 分组逐项 ✔/✘/⚠ + 一行证据；✘ 项给出原因与建议。
