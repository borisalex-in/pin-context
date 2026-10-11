# Pin Context for VS Code

[![Version](https://img.shields.io/badge/version-0.0.6-blue.svg)](https://github.com/borisalex-in/pin-context)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.102.0-007ACC)](https://code.visualstudio.com/)
[![Support](https://img.shields.io/badge/Support-Crypto-FF9900?logo=bitcoin&logoColor=white)](#-support-the-project)

Pin Context helps developers switch tasks without losing focus: save pinned tabs as contexts, restore them instantly, and keep branch-based workflows organized automatically.

🇷🇺 **Русский:** расширение полностью переведено на русский язык. Переключите VS Code на русский — интерфейс Pin Context тоже переключится на русский.

## 💡 Why Developers Use It

- ⚡ **Switch tasks fast**: jump from feature work to bugfix or review and restore the right files in one action.
- 🧹 **Reduce tab chaos**: keep each task in a clean, named context instead of one giant mixed tab set.
- 🌿 **Stay in flow with git**: branch contexts are enabled by default, so context changes follow your branch changes.
- 🕘 **Recover your rhythm**: timeline history helps you return to what you worked on recently.
- ⌨️ **Work keyboard-first**: core actions are optimized for command palette and shortcuts.

## 🧩 What You Get

- 🔖 Pin, unpin, or toggle the current file; pin or unpin all open tabs; pin files by pattern.
- 🗂️ Manual contexts: create, switch, rename, delete.
- 🌿 Git contexts: auto-maintained per branch (**enabled by default**).
- 🕘 Context timeline (`Today`, `Yesterday`, `Older`).
- 📁 Sidebar workflow: pinned files + contexts + recent contexts.
- 🖱️ Drag-and-drop from Explorer into pinned view.
- 🎯 First-run onboarding, contextual empty states, and lightweight nudges.
- 📦 **Working sets**: each context remembers editor cursors, scroll positions, open tabs, and the editor group layout.
- 💾 **Repository contexts**: save and share contexts via `.vscode/pin-contexts.json`.
- 📤 **Export / Import**: save contexts to a JSON file or load from one.
- 🖱️ **Explorer context menu**: a context-menu action to pin or unpin the selected file directly from Explorer.
- 🤖 **AI agent integration**: expose context and pinned-file tools to VS Code Chat and other MCP-compatible agents, with approval for state-changing actions.

## 🚀 Quick Start (1 Minute)

1. Open and pin a few files.
2. Run `Pin Context: Create Context`.
3. Run `Pin Context: Switch Context`.
4. Create or switch a Git branch and observe branch-aware contexts.

## 🧠 Typical Developer Scenarios

- 🚀 **Feature development**: keep frontend, backend, and tests in one context per feature.
- 🔍 **PR review**: save review tabs and return later exactly where you stopped.
- 🚨 **Incident/debug mode**: isolate logs, diagnostics, and hotfix files in a dedicated context.
- 🧱 **Multi-repo workspace**: keep branch/task context predictable across folders.
- 👥 **Team sharing**: share context definitions via `.vscode/pin-contexts.json` in the repository.

---

## AI Agent Integration

Pin Context exposes a shared agent API and MCP tools for compatible AI agents. Agents can inspect the active context and pinned files, list/switch contexts, and pin or unpin workspace files. Read operations are non-mutating; changes require user approval. See [AI_AGENT_INTEGRATION.md](AI_AGENT_INTEGRATION.md) for Claude Code, Codex, and other MCP client setup, tools, and security details.

## Commands

- `Pin Context: Pin Current File`
- `Pin Context: Unpin Current File`
- `Pin Context: Toggle Pin for Current File`
- `Pin Context: Pin All Open Tabs`
- `Pin Context: Unpin All Open Tabs`
- `Pin Context: Pin Files by Pattern`
- `Pin Context: Create Context`
- `Pin Context: Switch Context`
- `Pin Context: Rename Context`
- `Pin Context: Delete Context`
- `Pin Context: Save Current Pins to Context`
- `Pin Context: Open Context Timeline`
- `Pin Context: Quick Open Pinned File`
- `Pin Context: Export Contexts`
- `Pin Context: Import Contexts`
- `Pin Context: Refresh Pinned Files View`
- `Pin Context: Toggle View Mode (Tree/List)`
- `Pin Context: Copy MCP Client Configuration`

## Default Shortcuts

| Action                      | macOS              | Windows/Linux    |
| --------------------------- | ------------------ | ---------------- |
| Pin Current File            | `Cmd + Option + K` | `Ctrl + Alt + K` |
| Unpin Current File          | `Cmd + Option + L` | `Ctrl + Alt + L` |
| Toggle Pin for Current File | `Cmd + Option + J` | `Ctrl + Alt + J` |
| Switch Context              | `Cmd + Option + P` | `Ctrl + Alt + P` |

> Since 0.0.6, the default shortcuts on Windows/Linux no longer override built-in VS Code shortcuts
> (`Ctrl+Shift+P` is the Command Palette). If `Ctrl+Alt+letter` types special characters on
> your keyboard layout (AltGr), rebind the commands in **Keyboard Shortcuts**.

## Main Settings

### Core

- `pin-context.viewMode`: `tree` or `list`
- `pin-context.confirmBeforeUnpinAll`: ask before unpinning all
- `pin-context.persistenceScope`: `globalState` or `workspaceState` (default: `workspaceState`)
- `pin-context.restoreBehavior`: `keepInTree` or `reopenAndPin`
- `pin-context.restoreReopenLimit`: reopen limit for `reopenAndPin`

### Contexts

- `pin-context.contexts.autoGitContexts` (**default: `true`**)
- `pin-context.contexts.autoSwitchOnGitBranchChange` (default: `true`)
- `pin-context.contexts.restoreLastContext` (default: `false`)
- `pin-context.contexts.timelineEnabled` (default: `true`)
- `pin-context.contexts.maxTimelineEntries` (default: `100`)
- `pin-context.contexts.persistenceScope`: `globalState` or `workspaceState` (default: `workspaceState`)
- `pin-context.contexts.repoContextsFile`: enable repository-level contexts (default: `true`)

### Working Sets

- `pin-context.contexts.captureEditorState`: save cursor position and scroll (default: `true`)
- `pin-context.contexts.captureOpenTabs`: save open tabs (default: `false`)

## Troubleshooting

- Open the **Pin Context** output channel (`View > Output`) for logs.
- Enable `pin-context.debug` for verbose logs.
- Git contexts require Git to be available on `PATH` and the workspace to be trusted.

## Performance

- `pin-context.batchSize`
- `pin-context.findFilesMaxResults`
- `pin-context.debug`

## Docs and Local Dev

- Docs site: `docs/index.html`
- Local docs preview: `npm run docs:serve` -> [http://localhost:4173](http://localhost:4173)
- Build: `npm run compile`
- Lint: `npm run lint`
- Pre-commit checks: `npm run precommit:check`

## 💰 Support the Project

> Your support helps keep the project actively maintained and improved.

<p align="left">
  <img src="./images/icon-btc.png" width="18"/> 
  <b>BTC:</b> 
  <code>bc1qvcm9x9prgn7njvxzktmwg0jn8rv9vjm6azus63</code><br/>
  <span style="opacity:0.7;">(send only via Bitcoin network)</span><br/><br/>

  <img src="./images/icon-eth.png" width="18"/> 
  <b>ETH / USDT (ERC20):</b> 
  <code>0xA3fca703Edd9c2A77941De2c8A13ED97778a3eBE</code><br/>
  <span style="opacity:0.7;">(send only via Ethereum / ERC20 network)</span><br/><br/>

  <img src="./images/icon-trc.png" width="18"/> 
  <b>Tron / USDT (TRC20):</b> 
  <code>TM1Dcp4BP9PVYP7HwvQGCSGVCQLorHPdzK</code><br/>
  <span style="opacity:0.7;">(send only via Tron network)</span><br/><br/>

  <img src="./images/icon-sol.png" width="18"/> 
  <b>SOL / USDT (Solana):</b> 
  <code>22kVADbujhQTfptSARSbLqa8UZfozgEPMsjmuh2gNHLc</code><br/>
  <span style="opacity:0.7;">(send only via Solana network)</span>
</p>
