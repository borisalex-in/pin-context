# Contributing to Pin Context

Thanks for helping improve Pin Context. Changes should preserve the extension's keyboard-first workflow, English/Russian localization, workspace isolation, and compatibility with VS Code `1.102.0` and newer.

## Development setup

1. Install Node.js 22 and Git.
2. Clone the repository and run `npm ci`.
3. Run `npm run precommit:check` before submitting a change.
4. For changes that affect activation, tabs, Git contexts, the MCP bridge, or the public API, also run the real Extension Host integration suite:

   ```bash
   npm run test:integration:install
   npm run test:integration
   ```

   Linux CI runs the suite under Xvfb (`xvfb-run -a npm run test:integration`).

## Change expectations

- Add regression tests for bug fixes and tests for new behavior.
- Keep `package.nls.json` and `package.nls.ru.json` in sync for contributed strings; keep `l10n/bundle.l10n.json` and `l10n/bundle.l10n.ru.json` synchronized for runtime messages.
- Do not bypass approval prompts for agent-driven state changes, and keep agent file operations bounded to the current workspace.
- Changes to `api.d.ts`, public API method behavior, MCP tool names, input schemas, or result semantics must follow the compatibility policy in `README.md`. Starting with `1.0.0`, breaking changes require a major version.
- Keep generated output (`out/`, `.vsix`, coverage) out of source control.
- Do not add real MCP tokens, workspace-specific configuration, or personal data to tests or documentation.

## Pull requests

Describe the user-facing change, include a short test summary, and note any migration or compatibility impact. For UI changes, attach screenshots or a short recording from a real VS Code instance where relevant.
