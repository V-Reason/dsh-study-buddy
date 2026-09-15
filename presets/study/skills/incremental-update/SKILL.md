---
name: incremental-update
description: 增量更新细则：定位提醒、四种动作（append / replace / move / definition）的判定与建议、先存档后写正文的不变量、存档与回退流程。检测到新内容与现有笔记相关时加载。
---

# 增量更新

新内容与旧笔记相关时按三步走。**决定权永远在用户**：你只给建议与差异对比。

## 步骤 1：定位提醒

```
检测到"[新概念]"与现有笔记 [ID] 相关。
旧笔记摘要："[简述]"；新内容摘要："[简述]"。
建议增量更新。
```

## 步骤 2：判定与建议

| 情形 | 判定 | 建议 | 动作 |
| :-- | :-- | :-- | :-- |
| 补充 | 不推翻旧结论 | 追加到对应小节，旧内容天然保留 | `note_update(append)`（可带 `section`） |
| 推翻 / 大改 | 推翻旧结论 | 整体重写；**旧正文先存入 `.study/archive/`** | `note_update(replace, newContent)` |
| 无关 | 完全无关 | 新建一块 + 与旧块建"后续"关联 | `note_write` + `note_link(kind=next)` |
| 只是定位写歪了 | 内容都对 | 字段级微调，不算知识更新 | `note_update(definition, summary)` |
| 该挪目录 | 内容都对 | 搬到新目录 | `note_update(move, targetPath)` |

先用表格贴"旧 vs 新"对比，再 `ask_user_question` 请用户确认。

## 步骤 3：执行

- 确认后才调用；返回的是更新后的整篇（含新旧内容之外的完整正文）。
- **正文不留历史块**（2026-10 口径）：`replace` 的旧正文进 `.study/archive/<ID>/<时间戳>.md`，正文里不写 `<details>`；`append` 也不产生"版本更新"小节——补充就是补充，正文只有一份最新版。
- **先存档、后写正文**是工具强制的不变量：存档失败就中止，不会出现"正文已改、历史已丢"。
- 想回退：`note_history({ref, action:'list'})` 看存档 → `note_restore({ref, archiveId})` 恢复（恢复前当前版本也会先存档，可来回）。
- 更新后跑一次 `note_lint({ref})` 看数据卫生（会话残留 / 未标语言的代码块 / 外部资源）——**不再有分数与模板类检查**。
- 目录结构变了（如 `move` 到新目录）→ 重跑 `note_toc` 刷新微目录，必要时 `note_overview` 看覆盖度。
- 更新 `study_progress` 的 `touchedIds`。
- 用户拒绝 → 不写任何文件。
