# Pin Context for VS Code

[![Version](https://img.shields.io/badge/version-0.0.5-blue.svg)](https://github.com/borisalex-in/pin-context)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC)](https://code.visualstudio.com/)
[![Support](https://img.shields.io/badge/Support-Crypto-FF9900?logo=bitcoin&logoColor=white)](#-support-the-project)

Pin Context helps developers switch tasks without losing focus: save pinned tabs as contexts, restore them instantly, and keep branch-based workflows organized automatically.

## 💡 Why Developers Use It

- ⚡ **Switch tasks fast**: jump from feature work to bugfix or review and restore the right files in one action.
- 🧹 **Reduce tab chaos**: keep each task in a clean, named context instead of one giant mixed tab set.
- 🌿 **Stay in flow with git**: branch contexts are enabled by default, so context changes follow your branch changes.
- 🕘 **Recover your rhythm**: timeline history helps you return to what you worked on recently.
- ⌨️ **Work keyboard-first**: core actions are optimized for command palette and shortcuts.

## 🧩 What You Get

- 🔖 Pin/unpin/toggle current editor, pin all, unpin all, pin by pattern.
- 🗂️ Manual contexts: create, switch, rename, delete.
- 🌿 Git contexts: auto-maintained per branch (**enabled by default**).
- 🕘 Context timeline (`Today`, `Yesterday`, `Older`).
- 📁 Sidebar workflow: pinned files + contexts + recent contexts.
- 🖱️ Drag-and-drop from Explorer into pinned view.
- 🎯 First-run onboarding, contextual empty states, and lightweight nudges.

## 🚀 Quick Start (1 Minute)

1. Open and pin a few files.
2. Run `Pin Context: Create Context`.
3. Run `Pin Context: Switch Context`.
4. Create/switch git branch and observe branch-aware contexts.

## 🧠 Typical Developer Scenarios

- 🚀 **Feature development**: keep frontend, backend, and tests in one context per feature.
- 🔍 **PR review**: save review tabs and return later exactly where you stopped.
- 🚨 **Incident/debug mode**: isolate logs, diagnostics, and hotfix files in a dedicated context.
- 🧱 **Multi-repo workspace**: keep branch/task context predictable across folders.

---

## Commands

- `Pin Context: Pin Current Editor`
- `Pin Context: Unpin Current Editor`
- `Pin Context: Toggle Pin Current Editor`
- `Pin Context: Pin All Opened Editors`
- `Pin Context: Unpin All Editors`
- `Pin Context: Pin Editors by Pattern`
- `Pin Context: Create Context`
- `Pin Context: Switch Context`
- `Pin Context: Rename Context`
- `Pin Context: Delete Context`
- `Pin Context: Save Current Pins to Context`
- `Pin Context: Open Context Timeline`
- `Pin Context: Quick Open Pinned File`
- `Pin Context: Refresh Pinned Files View`
- `Pin Context: Toggle View Mode (Tree/List)`

## Default Shortcuts

| Action               | macOS              | Windows/Linux      |
| -------------------- | ------------------ | ------------------ |
| Pin Current Editor   | `Cmd + Option + K` | `Ctrl + Shift + K` |
| Unpin Current Editor | `Cmd + Option + L` | `Ctrl + Shift + L` |
| Toggle Pin           | `Cmd + Option + J` | `Ctrl + Shift + J` |
| Switch Context       | `Cmd + Option + P` | `Ctrl + Shift + P` |

## Main Settings

### Core

- `pin-context.viewMode`: `tree` or `list`
- `pin-context.confirmBeforeUnpinAll`: ask before unpinning all
- `pin-context.persistenceScope`: `globalState` or `workspaceState`
- `pin-context.restoreBehavior`: `keepInTree` or `reopenAndPin`
- `pin-context.restoreReopenLimit`: reopen limit for `reopenAndPin`

### Contexts

- `pin-context.contexts.autoGitContexts` (**default: `true`**)
- `pin-context.contexts.autoSwitchOnGitBranchChange` (default: `true`)
- `pin-context.contexts.restoreLastContext` (default: `false`)
- `pin-context.contexts.timelineEnabled` (default: `true`)
- `pin-context.contexts.maxTimelineEntries` (default: `100`)
- `pin-context.contexts.persistenceScope`: `globalState` or `workspaceState`

### Performance

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
