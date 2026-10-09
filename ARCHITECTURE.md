# Pin Context — Architecture

This document describes the extension's actual architecture. Keep it up to date whenever the code changes.

## Purpose

`Pin Context` manages pinned tabs and _contexts_: named sets of pinned files that can be saved and restored instantly. Git contexts associated with branches are supported as well.

## Entry Point and Build

- Entry point: `src/core/extension.ts` (`activate` / `deactivate`).
- Activation event: `onStartupFinished`.
- Build: `esbuild` (`scripts/build.ts`) bundles the extension into a single file, `out/extension.js` (CommonJS, `platform: node`, `target: node18`). The `vscode` module is external; `minimatch` and other dependencies are bundled. Type checking is performed with `tsc --noEmit` for extension source and `tsc -p tsconfig.scripts.json --noEmit` for build/release tooling.
- `package.json` → `main`: `./out/extension.js`.
- Packaging: `.vscodeignore` excludes `src/`, `test/`, `scripts/`, `docs/`, `node_modules/`, configuration files, and other development assets. The `.vsix` package contains only `out/extension.js`, `package.json`, `README.md`, `LICENSE`, and `images/`.

## Layers

```text
src/
  core/        — entry point and utilities (extension.ts, operationQueue.ts)
  stores/      — sources of truth and state (pinStore, contextStore)
  services/    — integrations and persistence
                 (gitContextService, gitApiSource, contextPersistenceService,
                  contextSyncService, contextFileService, workingSetService)
  ui/          — presentation (pinnedTreeView, statusBar, contextQuickPick)
  utils/       — pure helpers (tabUtils, gitStatus, logger)
  types/       — shared domain types
```

Data flows from **VS Code tabs → PinStore → ContextStore → UI**. The reverse flow (commands and context switching) goes through `ContextStore` into `PinStore`.

## Components

### `PinStore` (`src/stores/pinStore.ts`)

The source of truth for pinned files.

- Stores a `Map<uriKey, PinRecord>`; the list is cached and sorted by folder/name.
- Synchronizes with the tab model through `onDidChangeTabs` (25 ms debounce), `onDidDeleteFiles`, and `onDidRenameFiles`.
- A file is considered pinned when at least one of its tabs is pinned (split view). Only trackable URI schemes are monitored (`file`, `vscode-remote`, `vscode-vfs`, `vscode-userdata`); diff editors are not tracked.
- Pinning uses the native `workbench.action.pinEditor` / `unpinEditor` commands. Because these commands act on the active tab, the target tab is activated before the command and the previous focus is restored afterward (`captureActiveTab` / `restoreActiveTab`). Operations are serialized through `OperationQueue` (`batchQueue`, `focusQueue`).
- To reduce flicker during bulk operations, a batch is processed in an order that minimizes tab switches (`orderForMinimalFocusChanges`): targets already in the desired state first, then the active tab, then the remaining tabs. Tab-model changes are awaited through events (`waitFor` via `notifyTabChange`); polling is used only as a fallback.
- Persistence: the `pin-context.pinnedUris` key (an array of URI strings), stored in `workspaceState` by default. See [Persistence](#persistence).
- Menu context keys: after every tab update and active-tab change, it sets `pin-context.isPinned` / `pin-context.hasActiveEditor` (`updateContextKeys`). To check whether a file is pinned, it registers `pin-context.pinnedResourceState` and exposes the `pin-context.pinnedResources` context set (used in `when` clauses as `resource in pin-context.pinnedResources`). The Explorer menu shows one command (Pin or Unpin) instead of three commands at once.

### `ContextStore` (`src/stores/contextStore.ts`)

The source of truth for contexts.

- Holds `Map<id, PinContext>`, the active and previously active contexts, and a timeline (`ContextTimelineEntry[]`).
- Automatic synchronization: when pins change, the active context is updated (150 ms debounce). Writes are suppressed during context switches (`pendingSwitches > 0`) and when `pinsInconsistent` is set.
- `switchContext` calculates the pin diff (`ContextSyncService.buildPinDiff`) and applies it. Switches are serialized and can be cancelled through `CancellationTokenSource`.
- Git contexts are updated by `GitContextService`. Automatic switching on branch changes is available through `contexts.autoSwitchOnGitBranchChange`. A branch with no saved pins inherits the current pins (`adoptCurrentPins`).
- `getAllContexts()` hides Git contexts belonging to other workspaces (relevant when using `globalState`).
- Export/import: `exportContexts(fileUri, selected?)` writes selected manual contexts to JSON through `ContextFileService`; `importContexts(fileUri)` merges by name, updating an existing context instead of creating a duplicate. The `pin-context.exportContexts` / `pin-context.importContexts` commands are registered in `extension.ts`; context selection and file dialogs live in `contextQuickPick.ts`.
- Stale Git contexts: `markStaleGitContexts` compares the branches represented by contexts with `git branch` (60-second cache). `onDidFindStaleContexts` notifies the UI; `extension.ts` displays a single Remove/Keep prompt, and the Keep choice is remembered in `globalState`. Empty branch contexts are removed silently.

### `GitContextService` (`src/services/gitContextService.ts`)

- Retrieves the branch and change counters with one command, `git status --porcelain=v1 --branch -uno`; for detached HEAD it uses `git rev-parse`.
- Polls state on a timer: every 4 seconds while active and every 12 seconds after three unchanged cycles. Polling stops when the window is unfocused, no Git folders are present, `contexts.autoGitContexts` is disabled, or the workspace is untrusted (`isTrusted`). If the `git` executable is unavailable, polling is disabled.
- Does not acquire `index.lock` (`GIT_OPTIONAL_LOCKS=0`); uses a timeout and a buffer limit.
- Uses a 3-second TTL cache, prevents concurrent duplicate calls (`inflight`), and negatively caches “not a repository” results for 30 seconds.
- Events: `onDidChangeBranch`, `onDidChangeStatus`.

### `gitApiSource` (`src/services/gitApiSource.ts`)

The primary source for branch and change-counter data is the built-in `vscode.git` extension API (`getAPI(1)`, repository API and event subscriptions), so no Git processes need to be spawned. If the API is unavailable (`enabled: false`, no `getAPI`, or no extension), `GitContextService` falls back to CLI polling.

`getLocalBranches` (used to find stale contexts) remains a CLI call to `git branch --list`, with caching.

### `ContextPersistenceService` (`src/services/contextPersistenceService.ts`)

- Saves a `ContextSnapshot` (contexts, active/previously active context, and timeline) as one value under the `pin-context.contexts.snapshot` key.
- Loads data with sanitization (`sanitizeSnapshot`) so corrupted stored data does not break activation.
- If no data exists in the preferred storage scope, reads from the other scope as a fallback, enabling migration when the default scope changes.

### `ContextSyncService` (`src/services/contextSyncService.ts`)

A thin adapter between `PinStore` and `ContextStore`: it builds the `toPin` / `toUnpin` diff and returns the current pins as an array of URI strings.

### `WorkingSetService` (`src/services/workingSetService.ts`)

The context's _working set_ captures what surrounds the pinned files.

- `capture()` records cursor/scroll positions for visible editors (`contexts.captureEditorState`, limit 60) and the list of ordinary (unpinned) tabs with their group numbers (`contexts.captureOpenTabs`, disabled by default, limit 80). Data is written to `PinContext.editorStates` / `openTabs` whenever a context is saved (`applyWorkingSet`).
- `restore()` first restores tabs in ascending `group` order, with the active tab last (VS Code creates a missing group at the end of the row, so this restores the original layout position). It then focuses the active tab and restores cursors/scroll positions only for editors that are already visible. Errors are handled on a best-effort basis and do not interrupt context switching.

### `ContextFileService` (`src/services/contextFileService.ts`)

Defines the JSON format for contexts (`version` + `contexts[]`) used for exports and the repository file `.vscode/pin-contexts.json`.

- Paths are serialized relative to the workspace folder (`path`) and resolved against `base` on import, making the file portable between machines.
- `parseContexts` sanitizes contexts through `sanitizeSnapshot`; manually editing the file cannot bypass sanitization and insert unchecked data into the store.
- Contexts loaded from the file use `source: 'repo'` and exist only in the file; they are not written to the state snapshot. The `**/.vscode/pin-contexts.json` watcher reloads them after external edits. The repository file can be disabled with the `contexts.repoContextsFile` setting.

### UI

- `PinnedTreeViewProvider` (`src/ui/pinnedTreeView.ts`) provides the Explorer tree with “Pinned Files”, “Contexts”, and “Recent Contexts” sections. It supports `tree` / `list` modes, drag and drop from Explorer, and multi-selection. Refreshes are debounced by 40 ms.
- `StatusBarManager` (`src/ui/statusBar.ts`) shows the pin count and active context; clicking it pins or unpins the active tab.
- `contextQuickPick.ts` implements QuickPick flows to create, rename, delete, and switch contexts, browse the timeline, and jump to a pinned file.

### Utilities

- `tabUtils.ts` — `PinRecord`, `toUriKey`, `isTrackableUri`, `parseUri`, `isSameOrNested`.
- `gitStatus.ts` — pure parser for `git status --porcelain=v1` (covered by tests).
- `logger.ts` — wrapper around the `LogOutputChannel` named “Pin Context”, respecting the `pin-context.debug` setting.
- `operationQueue.ts` — serializes asynchronous operations.

## Persistence

| Data       | Key                             | Default scope    | Setting                                 |
| ---------- | ------------------------------- | ---------------- | --------------------------------------- |
| Pins       | `pin-context.pinnedUris`        | `workspaceState` | `pin-context.persistenceScope`          |
| Contexts   | `pin-context.contexts.snapshot` | `workspaceState` | `pin-context.contexts.persistenceScope` |
| Onboarding | `pin-context.onboarding.*`      | `globalState`    | —                                       |

Both scopes (`globalState` / `workspaceState`) can be selected manually. If the selected scope has no data yet, the extension reads from the other scope once; subsequent writes go to the selected scope, completing the migration.

## Key Settings

- `pin-context.persistenceScope`, `pin-context.contexts.persistenceScope` — storage scope (default: `workspaceState`).
- `pin-context.restoreBehavior` (`keepInTree` | `reopenAndPin`), `pin-context.restoreReopenLimit`.
- `pin-context.contexts.autoGitContexts`, `pin-context.contexts.autoSwitchOnGitBranchChange`, `pin-context.contexts.restoreLastContext`, `pin-context.contexts.timelineEnabled`, `pin-context.contexts.maxTimelineEntries`.
- `pin-context.viewMode`, `pin-context.confirmBeforeUnpinAll`, `pin-context.showPinnedCountInStatusBar`, `pin-context.batchSize`, `pin-context.findFilesMaxResults`, `pin-context.debug`.

## Tests and Checks

- `npm test` — `node:test` + `tsx`: `test/gitStatus.test.ts` (parser) and `test/extension.smoke.test.ts` (activation and workflows using an in-memory `vscode` mock from `test/vscodeMock.ts`, including a real Git repository).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — ESLint.
- `npm run compile` — typecheck + esbuild bundle.
- `npm run build:vsix` — creates the `.vsix` package (see `.vscodeignore`).

## Known Limitations

- Diff editors are not tracked.
- A file opened as a regular tab and included in pins remains in the list until it is pinned again or opened from the sidebar.
- With an explicit `globalState` scope, contexts are stored as a single snapshot (the last write wins). See `IMPROVEMENTS.md`, item 4.
