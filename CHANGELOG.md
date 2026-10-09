# Changelog

All notable changes to Pin Context are documented here.

## [0.0.6]

### Added

- Added `Pin Context: Export Contexts` and `Pin Context: Import Contexts` commands to back up manual contexts to JSON and import them later. Import merges by context name rather than creating duplicates.
- Added cleanup for Git contexts whose branches no longer exist, with a **Remove** / **Keep** prompt whose choice is remembered.
- Added a context menu for sidebar contexts, including switch, save pins, rename, and delete actions.
- Added a `Pin Context` output channel and the active context name to the status-bar tooltip.
- Added full Russian localization for extension UI strings, notifications, commands, settings, and onboarding content, plus scaffolding for a Russian language-pack extension.
- Added regression, unit, and smoke tests for context workflows, persistence failures, imports and exports, Git status counters, and localization.

### Fixed

- Fixed default Windows/Linux shortcuts that conflicted with built-in VS Code commands; extension shortcuts now use `Ctrl+Alt` combinations.
- Fixed clicking a pinned file in the sidebar so opening it no longer unintentionally removes it from the pinned list.
- Fixed pin/unpin operations targeting the wrong editor and duplicate tabs for notebooks and custom editors.
- Fixed pinned-state tracking for files open in multiple tabs or diff editors.
- Fixed context switching races that could save a partially restored state or overwrite the previous context after a cancelled switch.
- Fixed creating a Git branch so existing pins are retained when the new branch has no saved pin state.
- Fixed Git context identification for non-Git workspaces and detached HEAD states; unrelated workspaces no longer expose each other's Git contexts.
- Fixed `restoreLastContext` to restore the last active context rather than the previously active one.
- Fixed persistence-scope handling and migration of existing data.
- Fixed the missing `contexts.autoSwitchOnGitBranchChange` setting declaration.
- Fixed `showPinnedCountInStatusBar` so the initial state and subsequent setting changes are respected.
- Fixed drag-and-drop handling so plain text, folders, and missing files are not pinned as bogus paths.
- Fixed multi-selection handling in Explorer and the sidebar for pin, unpin, and copy-path commands.
- Fixed disposal of `GitContextService`, overlapping Git status polls, and Git polling in untrusted workspaces. Git status is collected with a single bounded operation rather than multiple competing processes.
- Fixed tab tracking after exceptions during batch operations.
- Fixed activation failures caused by context initialization errors or corrupt stored data.
- Fixed view-mode settings so toggling the mode does not unexpectedly write to the workspace settings file and configuration changes take effect.
- Fixed duplicate Cancel buttons in modal dialogs and stale sidebar entries after files are deleted or renamed. Collapsed folders no longer re-expand on every refresh.
- Fixed import handling for invalid JSON, missing `contexts` arrays, and malformed entries so one invalid entry does not abort the entire import.
- Added URI validation for imported contexts; unsupported schemes and unsafe relative paths are rejected.
- Fixed imported contexts being stored under a key that differed from their own ID, allowing imported contexts to be found and switched to reliably.
- Fixed export dialogs opening at the first workspace folder when possible and made contexts with duplicate display names individually selectable by ID.
- Fixed workspace path matching so a workspace path cannot accidentally match a sibling directory with the same string prefix.
- Fixed persistence error handling so failed create/import/rename/delete/cleanup operations are not reported as successful and in-memory state is rolled back when a snapshot cannot be saved.
- Fixed Git change counters for staged, unstaged, mixed, and unmerged states. Unmerged entries remain visible as changes but are not counted as staged.

### Changed

- The Explorer context menu now presents one contextual pin/unpin command instead of several redundant commands. Pin state is exposed through context keys and a pinned-resource collection.
- Restoring a context preserves editor-group layout; tabs are restored in group order and the previously active tab is focused last.
- Reduced tab flicker during bulk pin/unpin by processing tabs that already have the target state first and relying on tab-change events where possible instead of fixed polling alone.
- Changed the default persistence scope for pins and contexts from `globalState` to `workspaceState`, preventing data from leaking between projects. Legacy data is migrated to the selected scope, and scope tracking prevents stale snapshots from being restored later.
- Bundled the extension with esbuild into a single production entry point and bundled `minimatch` rather than shipping it separately.
- Updated the build workflow so `compile` performs a TypeScript typecheck before bundling, and `watch` uses the esbuild watcher.
- Converted the build, clean, and release tools to TypeScript and added a dedicated typecheck for project scripts.
- Git contexts are named after their branch; changed/staged counters are shown in the context description.
- Internal commands are hidden from the Command Palette, and extension activation uses `onStartupFinished`.
- Declared settings for repository context files, editor-state capture, open-tab capture, and related context behavior in `package.json` so they are visible in VS Code Settings.
- Removed repeated onboarding prompts after context creation and switching while retaining initial onboarding.
- Updated the documentation website so Google Analytics loads only after explicit consent. Visitors can accept or reject analytics and change their choice later; query strings and URL fragments are omitted from analytics page locations.
- Added repository homepage and issue-tracker metadata and stricter ESLint checks for floating and misused promises.
