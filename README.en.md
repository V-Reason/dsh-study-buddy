# dsh-study-buddy

[English](README.en.md) | [简体中文](README.md)

> **Understand the material, then keep what you learned.**
>
> `dsh-study-buddy` is a study companion plugin and agent preset for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeekHarness) (DSH). It guides you from source material through adaptive explanations and follow-up questions to durable Markdown notes in an Obsidian vault.

Current version: **v1.4.1** · [MIT](LICENSE) · DSH `>=0.1.7-rc.1 <0.3.0-0`

## Why use it

- **Explanations adapt to your familiarity.** New topics are usually explained in depth; related topics studied recently can be summarized more quickly.
- **Notes are more than chat summaries.** Each note is a self-contained knowledge unit with room for examples, derivations, code, and links to related material.
- **You control the writing style.** Audience, tone, depth, and domain-specific expectations live in a single `笔记期望.md` file at the vault root.
- **The agent cannot silently reorganize your vault.** It proposes a folder plan before writing, and only writes after you confirm it.
- **Your notes remain yours.** Everything is ordinary Markdown. You can edit it in Obsidian, version it with Git, and remove `.study/` without losing a note.

It is designed for self-directed learners in computer science, game development, and engineering, as well as developers who want a long-running study workflow in DSH.

## Core capabilities

| Capability | What it provides |
| :-- | :-- |
| Adaptive explanations | Chooses a quick or detailed mode from prior notes and learning history, defaulting to detail when evidence is weak |
| Four-stage study loop | Source reading, explanation, Q&A, and note archiving form one continuous workflow |
| Plan-aware progress | `study_progress(brief)` returns the current thread, one next action, and completion criteria |
| Expectation-driven notes | One `笔记期望.md` file defines the writing style instead of multiple templates |
| Structured documents | Notes follow `source / chapter / section / block` folders, with a maintainable directory index at each topic level |
| Coverage and audits | Detects missing source sections, missing indexes, broken links, ambiguous links, and duplicate titles |
| Safe updates and history | Append, replace, move, and rename are explicit operations; replaced content is archived first |
| Session continuity | Progress, unanswered questions, and preferences persist under `.study/` in the vault |

## How the study loop works

```text
Read source → Explain → Discuss and ask → Plan and archive
     ↑                                         │
     └──────── progress, memory, and next step ┘
```

Reading and explaining are separate actions. Giving the agent a file or asking it to “read” produces a source report only. Explanation starts when you ask for it. The agent works through one complete knowledge unit at a time and leaves the next step under your control.

### A typical session

```text
You: Read chapter 2 of Game Engine Architecture
Agent: Source report only; no automatic explanation
You: Explain it
Agent: Selects a mode and explains one complete knowledge unit
You: Save these notes
Agent: Proposes a folder plan and writes only after confirmation
```

## Quick start

### 1. Check the environment

You need:

- A working DSH installation in the supported range `>=0.1.7-rc.1 <0.3.0-0`
- Node.js 22 or newer
- An Obsidian vault and its absolute path
- Optional: Python and either PyMuPDF or `python-pptx` for reading PDF or PPTX material

This repository contains the plugin and preset, not DSH itself.

### 2. Install the bundle

```bash
dsh plugin --profile web add dsh-study-buddy
```

Make sure the profile's `dsh.profile.bundles` list contains `dsh-study-buddy`. The package supplies its preset through this bundle. If the profile does not select it, neither the preset nor its tools will appear.

### 3. Configure the vault

Create `<DSH_HOME>/study-buddy.json`:

```json
{
  "vaultRoot": "/absolute/path/to/your/vault"
}
```

On Windows, an absolute path such as `"D:/Notes/Study"` also works. `vaultRoot` is the only required setting. It stays outside the repository, so reinstalling the plugin preserves it.

### 4. Add the writing expectations and start DSH

```powershell
# Windows PowerShell
Copy-Item presets/study/assets/笔记期望.md "<your vault>/笔记期望.md"
```

```bash
# macOS / Linux
cp presets/study/assets/笔记期望.md "<your vault>/笔记期望.md"
```

Restart DSH, create a session, and select the **学习伙伴** preset. You should see 19 `note_*` / `study_*` tools in the session.

The `笔记期望.md` file is required. Without it, note creation is intentionally rejected with instructions for creating the file.

## Why notes stay organized

The archive flow has three safeguards:

1. The current session must read `笔记期望.md`.
2. The agent must propose a folder plan and receive your confirmation.
3. Every write must remain inside the confirmed plan, and each planned item can be consumed only once.

When a note is replaced, the previous version is moved to `.study/archive/` before the new content is written. You can restore it later.

## Privacy and data boundaries

The plugin itself does not make network requests, start shell commands, or run an HTTP client. File access is limited to the local vault and its `.study/` state directory.

The model still has to read content to do its job. Titles, summaries, note text, paths, progress, and memory returned through `note_*` tools enter the DSH session log and are sent to the model provider as request content. Do not put data in the same vault that you are unwilling to send to the model provider.

See the full [privacy and data-flow guide (Chinese)](docs/用户使用指南.md#14-隐私与数据流向).

## Compatibility and limitations

- Supports DSH `>=0.1.7-rc.1 <0.3.0-0` and exposes 19 `note_*` / `study_*` tools.
- Search is currently keyword-based, with CJK bigrams for Chinese retrieval; it does not use semantic vectors.
- Coverage reporting depends on a valid `来源章节` field. Unrecognized entries are grouped as “unclassified.”
- Detailed configuration, upgrade steps, platform compatibility history, and troubleshooting are in the [Chinese user guide](docs/用户使用指南.md).

## Documentation

| Topic | Document |
| :-- | :-- |
| Installation, configuration, tools, and troubleshooting | [User guide (Chinese)](docs/用户使用指南.md) |
| Design principles and key tradeoffs | [Design document (Chinese)](docs/设计文档.md) |
| Modules, APIs, rules, and test layout | [Technical reference (Chinese)](docs/技术文档.md) |
| Documentation map and maintenance rules | [Documentation map (Chinese)](docs/README.md) |
| Release history and known issues | [Changelog (Chinese)](docs/更新记录.md) |

## Development

```bash
pnpm install
pnpm run check
pnpm run verify:contract
```

`pnpm run check` runs type checking, Vitest, and the build. `verify:contract` checks the integration contract between the plugin and the installed DSH version; online probes are skipped when DSH is not available.

Source code lives in `src/`, the preset and skills live in `presets/study/`, and tests live in `tests/`.

## License

[MIT](LICENSE)

The package structure was inspired by [dsh-at-file](https://github.com/omdsh-dev/dsh-at-file) (MIT). Early interaction design notes remain under `docs/archive/design/`; current behavior is defined by `presets/study/skills/` and the user guide.
