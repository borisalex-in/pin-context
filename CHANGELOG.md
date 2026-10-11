# Changelog

All notable changes to Pin Context are documented here.

## [0.0.8]

### Changed

- Made the burger menu the only site navigation on all viewport widths; opening and closing it no longer changes behavior at desktop breakpoints.
- Updated the release workflow so `release:ship` can safely finalize a version already prepared by `release:patch` without incrementing it twice, and added `release:push` to push the release commit and tag.

## [0.0.7]

### Added

- Added a unified Pin Context agent API and MCP server so compatible AI agents can read the active context, list contexts and pinned files, inspect workspace folders, and manage contexts or pins through shared, validated operations.
- Added explicit user confirmation for all agent-initiated state changes. Context deletion is marked as destructive for MCP clients. VS Code Chat uses the host confirmation dialog; external MCP clients use Pin Context’s own confirmation dialog.
- Added a loopback-only authenticated bridge with a random token and restrictive configuration-file permissions, plus a command to copy MCP client configuration.
- Added workspace-boundary validation for agent pin/unpin requests and English/Russian localization for agent confirmations and setup messages.
- Added bilingual MCP setup guidance to the documentation site, with Claude Code and OpenAI Codex as the primary clients and VS Code Chat and other compatible MCP clients as additional options.
- Added an AI-agent integration card to the features overview and an interactive context-flow diagram for Pin Context, MCP, Claude Code, and Codex.

### Changed

- Reworked the AI-agent documentation around Claude Code and OpenAI Codex, with responsive client tabs, platform-aware setup steps, and links to the official documentation.
- Reorganized the site navigation with an accessible burger menu for compact viewports, keyboard dismissal, outside-click handling, and section-link validation.
- Expanded the “Why Pin Context?” comparison to cover Explorer actions, context history, validated JSON transfer, keyboard workflows, MCP access, and approval for state changes.
- Kept the documentation content width at `min(1320px, calc(100% - 2.5rem))` across breakpoints and added an animated, keyboard-accessible AI context-flow diagram with reduced-motion support.
- Proofread the English and Russian interface copy, clarified context and pin-operation messages, localized context descriptions and status-bar tooltips, and aligned the documentation site’s minimum VS Code version with the package requirement.

### Fixed

- The documentation’s “test prompt copied” status now disappears after two seconds, and repeated clicks reset the timeout correctly.
- Restored the localized product-name suffix in the default context-export filename so export dialogs use a predictable, extension-specific name.
- The website version label in `docs/index.html` is now updated automatically alongside the README version badge during the npm version lifecycle.
- Removed redundant MCP-provider existence checks that triggered TypeScript TS2774 with the declared VS Code API baseline.
- Updated Explorer context-menu state tracking to match the selected resource by its full URI and file path, keeping the Pin/Unpin label and shortcut hint in sync after each change.
- Added visible shortcut hints and keyboard support for Pin File (`Ctrl+Alt+K` / `Cmd+Option+K`) and Unpin File (`Ctrl+Alt+L` / `Cmd+Option+L`) in Explorer. These shortcuts target the selected files in Explorer, not the active editor.
- Preserved clipboard contents while resolving Explorer selection for keyboard-triggered pin/unpin commands.

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
- Fixed Explorer context-menu actions so Pin File / Unpin File follow the selected resource instead of the active editor; added dedicated, localized commands for each action.
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

- The Explorer context menu now shows one state-aware action at a time: Pin File for unpinned resources or Unpin File for pinned resources.
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
