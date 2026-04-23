# Pin Context for VS Code

[![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)](https://github.com/borisalex-in/pin-context)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6)](https://www.typescriptlang.org/)

Pin Context turns pinned tabs into a fast workflow/navigation system for VS Code.

## ✨ Features

- 🔖 **Fast pinning operations**: pin/unpin/toggle current editor, pin all, unpin all, pin by glob.
- 🗂️ **Workflow contexts**: create, switch, rename, delete manual contexts for task-based navigation.
- 🌿 **Optional git-aware contexts**: branch contexts are supported but disabled by default.
- ⚡ **Quick access UX**: command palette + fuzzy quick picks for contexts, timeline, and pinned files.
- 🕘 **Context timeline**: jump back to recently used contexts (`Today`, `Yesterday`, `Older`).
- 📁 **Dedicated sidebar**: sections for active context, contexts, recent contexts, and pinned files.
- 🖱️ **Drag and drop pinning**: drag files into `Pinned Files` to pin instantly and sync active context.
- 🚀 **Scalable behavior**: batching, debounce, caching, and progress reporting for large tab sets.
- 💾 **Configurable persistence**: choose global or workspace scope for pins and contexts.
- 📊 **Status bar integration**: live pinned count with low-noise updates.

## ⌨️ Keyboard Shortcuts (Default)

| Action               | macOS              | Windows/Linux      |
| -------------------- | ------------------ | ------------------ |
| Pin Current Editor   | `Cmd + Option + K` | `Ctrl + Shift + K` |
| Unpin Current Editor | `Cmd + Option + L` | `Ctrl + Shift + L` |
| Toggle Pin           | `Cmd + Option + J` | `Ctrl + Shift + J` |

> **Windows/Linux users:** Open Keyboard Shortcuts (`Ctrl+K Ctrl+S`) and search for `pin-context` to customize.

## 🧭 Commands

Open Command Palette (`Cmd+Shift+P`) and type `Pin Context`:

| Command                                     | Description                                    |
| ------------------------------------------- | ---------------------------------------------- |
| `Pin Context: Pin Current Editor`           | Pin the active editor tab                      |
| `Pin Context: Unpin Current Editor`         | Unpin the active editor tab                    |
| `Pin Context: Toggle Pin Current Editor`    | Toggle pin state                               |
| `Pin Context: Pin All Opened Editors`       | Pin every open editor                          |
| `Pin Context: Unpin All Editors`            | Unpin all pinned editors                       |
| `Pin Context: Pin Editors by Pattern`       | Pin editors matching glob pattern              |
| `Pin Context: Toggle View Mode`             | Switch between Tree and List view              |
| `Pin Context: Refresh Pinned Files View`    | Manually refresh the sidebar                   |
| `Pin Context: Create Context`               | Create a named pin context                     |
| `Pin Context: Switch Context`               | Fuzzy-switch between contexts                  |
| `Pin Context: Rename Context`               | Rename an existing manual context              |
| `Pin Context: Delete Context`               | Delete a manual context                        |
| `Pin Context: Save Current Pins to Context` | Persist current pinned set into active context |
| `Pin Context: Open Context Timeline`        | Open recent context history                    |
| `Pin Context: Quick Open Pinned File`       | Keyboard-first search across pinned files      |

## 🗃️ Sidebar Sections

Pin Context contributes a `Pinned Files` view in Explorer with structured sections:

- **Active Context**: currently selected context (if any).
- **Contexts**: manual and git contexts (git optional).
- **Recent Contexts**: timeline grouped by day buckets.
- **Pinned Files**: pinned file list in tree or flat mode.

## 🧩 Workflow Contexts

Contexts are named snapshots of your pinned working set:

- **Manual context flow**:
  1. Pin files for a task.
  2. Run `Create Context`.
  3. Later run `Switch Context` to restore that working set.
- **Context management**:
  - Rename and delete are available via commands and sidebar toolbar actions.
- **Sync behavior**:
  - When a manual context is active, pin/unpin changes are synchronized to it.
- **Git contexts**:
  - Optional feature; disabled by default via `pin-context.contexts.autoGitContexts`.

## 🛠️ Sidebar Menu

In the `Pinned Files` view:

- **Toolbar actions**:
  - `Refresh Pinned Files View`
  - `Toggle View Mode (Tree/List)`
  - `Switch Context`
  - `Quick Open Pinned File`
  - `Create Context`
  - `Rename Context`
  - `Delete Context`
- **File context menu** (`right-click` on pinned file):
  - `Unpin`
  - `Reveal in Explorer`
  - `Copy Path`

## ⚙️ Settings

### Core Pinning

- `pin-context.viewMode`: `tree` or `list`.
- `pin-context.confirmBeforeUnpinAll`: ask before unpinning everything.
- `pin-context.showPinnedCountInStatusBar`: show/hide status bar counter.
- `pin-context.persistenceScope`: where pinned files are stored (`globalState`/`workspaceState`).
- `pin-context.restoreBehavior`: `keepInTree` or `reopenAndPin`.
- `pin-context.restoreReopenLimit`: max tabs reopened when restore mode is `reopenAndPin`.

### Performance

- `pin-context.batchSize`: operation chunk size for pin/unpin.
- `pin-context.findFilesMaxResults`: limit for workspace glob search.
- `pin-context.debug`: enable debug logs.

### Contexts

- `pin-context.contexts.autoGitContexts` (default: `false`): enable branch contexts.
- `pin-context.contexts.restoreLastContext` (default: `false`): restore last active context on startup.
- `pin-context.contexts.timelineEnabled`: enable context timeline entries.
- `pin-context.contexts.maxTimelineEntries`: timeline retention limit.
- `pin-context.contexts.persistenceScope`: context storage scope (`globalState`/`workspaceState`).

## 🧪 Typical Workflow

1. Pin files related to a task.
2. Create a context (`Create Context`).
3. Switch tasks via `Switch Context`.
4. Return quickly via `Open Context Timeline`.
5. Open any pinned file instantly via `Quick Open Pinned File`.

## 🖱️ Drag and Drop

- Drag files from Explorer into `Pinned Files` to pin them instantly.
- Dropped files are synchronized with the active manual context automatically.
- Supports common VS Code drag payloads (`uri-list`, explorer tree payloads).

## 🎛️ Customize Shortcuts by Command

You can override defaults in `keybindings.json`:

```json
[
  {
    "key": "ctrl+cmd+p",
    "command": "pin-context.pinCurrentEditor",
    "when": "editorTextFocus"
  },
  {
    "key": "ctrl+cmd+shift+s",
    "command": "pin-context.switchContext"
  },
  {
    "key": "ctrl+cmd+shift+o",
    "command": "pin-context.quickOpenPinned"
  },
  {
    "key": "ctrl+cmd+r",
    "command": "pin-context.refreshPinnedView"
  }
]
```

To remove a default shortcut, prefix command with `-`:

```json
{
  "key": "ctrl+cmd+k",
  "command": "-pin-context.pinCurrentEditor"
}
```

## 📝 Notes

- On first use, create a manual context to start context-based workflow.
- Git contexts are opt-in and meant as an additional mode, not the default.
- For best performance in very large workspaces, tune `batchSize` and `findFilesMaxResults`.

## 🌐 GitHub Page

A modern project landing page is available in `docs/`:

- Entry file: `docs/index.html`
- Styles: `docs/styles.css`
- Script: `docs/script.js`
- Translations: `docs/i18n/en.json`, `docs/i18n/ru.json`
- Includes language switcher (EN/RU) and platform switcher (macOS / Windows/Linux) for shortcut display.

To publish it with GitHub Pages:

1. Go to your repository **Settings** -> **Pages**.
2. In **Build and deployment**, choose:
   - **Source**: `Deploy from a branch`
   - **Branch**: `master` (or your default branch)
   - **Folder**: `/docs`
3. Save and wait for deployment to complete.

> Works on GitHub Pages as static assets: `index.html` loads `script.js`, and `script.js` fetches translation JSON files from `docs/i18n/`.
>
> For local preview, use HTTP (not `file://`):
>
> - `npm run docs:serve`
> - open [http://localhost:4173](http://localhost:4173)

## 🧹 Code Quality

This project includes ESLint + Prettier + Husky pre-commit checks.

### Available scripts

- `npm run lint`: run ESLint for TypeScript sources.
- `npm run lint:fix`: auto-fix lint issues when possible.
- `npm run format`: apply Prettier formatting.
- `npm run format:check`: verify Prettier formatting.
- `npm run compile`: TypeScript compile check.
- `npm run docs:serve`: run local HTTP server for `docs/`.
- `npm run precommit:check`: runs `format:check`, `lint`, `compile`.

### Pre-commit hook

Before each commit, Husky runs:

1. `npm run format:check`
2. `npm run lint`
3. `npm run compile`
