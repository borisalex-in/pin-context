# Pin Context AI Agent Integration

Pin Context exposes context operations through a versioned public VS Code extension API and an MCP server. AI agents can inspect the active context and pinned-file sets; every change to a context or its pins requires user approval. Pin Context does not send file contents to the model. The connected agent reads file contents through its own workspace tools.

## Claude Code

1. Build and install the extension from this checkout with `npm ci` and `npm run reinstall:local`, or install a build that already contains MCP support.
2. Open the target workspace in VS Code, wait for Pin Context to activate, and run **Pin Context: Copy MCP Client Configuration**.
3. Copy the object under `mcpServers.pin-context` from the generated JSON. Register it in Claude Code with `claude mcp add-json pin-context '<copied JSON object>' --scope user`; preserve the generated command, arguments, and environment exactly.
4. Verify with `claude mcp list` and `/mcp`. Keep the same VS Code workspace open while using these tools.
5. If the bridge config becomes invalid after a VS Code reload, copy the configuration again and update the Claude Code server entry.

See the [official Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

## OpenAI Codex

1. Build and install the extension if testing this checkout, then activate Pin Context in the target VS Code workspace.
2. Run **Pin Context: Copy MCP Client Configuration** from the Command Palette.
3. Copy the `command`, ordered `args`, and `env.PIN_CONTEXT_VERSION` values into `~/.codex/config.toml` under a `[mcp_servers.pin-context]` table. Codex CLI and its IDE extension share this user-level MCP configuration.
4. Verify with `codex mcp list`; in the Codex TUI, `/mcp` shows active servers. Keep the exposed VS Code workspace open. If the bridge config expires after a reload, update the config with freshly copied values.

Use the [official Codex MCP guide](https://developers.openai.com/codex/mcp) for client-specific configuration details.

## VS Code Chat / Copilot

The extension registers a native Pin Context MCP provider on the declared VS Code API baseline. Open Chat, use the tool picker, and enable Pin Context. VS Code handles approval for mutating tools. Read-only tools do not change extension state.

## Other MCP clients (including Koda)

1. Open the target project in VS Code and make sure Pin Context is activated.
2. Run **Pin Context: Copy MCP Client Configuration** from the Command Palette.
3. Paste the generated `mcpServers.pin-context` entry into the client's stdio MCP configuration. Keep `command`, ordered `args`, and `env` unchanged.
4. Keep the VS Code workspace open and verify that the client discovers Pin Context tools. If Node.js is not available in the client environment, set `command` to the absolute path returned by `which node`.

Koda Desktop users can follow the [official Koda MCP guide](https://docs.kodacode.ru/desktop/features/mcp.html).

## Tools

### Read-only

- `pin_context_get_status` — active context, total pins, context count, workspace folders.
- `pin_context_get_active_context` — active context metadata and its saved pinned-file list.
- `pin_context_list_contexts` — list visible manual, Git, and repository contexts.
- `pin_context_get_pinned_files` — live pinned files, or a context's saved files when `context_id` is provided.
- `pin_context_get_workspace_info` — open workspace folder paths and URIs.

### State-changing (approval required)

- `pin_context_switch_context` — switch to an existing context.
- `pin_context_create_context` — create and activate a manual context.
- `pin_context_save_context` — save the current pin set to a context.
- `pin_context_rename_context` — rename a non-repository context.
- `pin_context_delete_context` — delete a manual context.
- `pin_context_pin_files` / `pin_context_unpin_files` — change the pinned-file set. File operations are restricted to files inside an opened workspace.

VS Code Chat uses its own approval dialog for MCP calls that change state. External MCP clients and extensions that call the public API receive a Pin Context confirmation dialog describing the requested change; the user can cancel the operation. The bridge does not expose a generic command execution tool or a file-content reading tool.

## Public extension API

Other VS Code extensions can call the object returned by Pin Context's `activate()` function through VS Code's extension registry. The API exposes `apiVersion: 1`, read methods (`getStatus`, `getActiveContext`, `listContexts`, `getPinnedFiles`, `getWorkspaceInfo`), and `executeTool(name, input)` for the shared tool catalogue. Mutating `executeTool` calls display the same Pin Context confirmation UI. Check the returned `apiVersion` before depending on the API contract.

```ts
const extension = vscode.extensions.getExtension('borisalex-in.pin-context');
if (extension) {
  const api = await extension.activate();
  if (api?.apiVersion === 1) {
    const status = await api.getStatus();
    // Use status.activeContext to understand the developer-selected scope.
  }
}
```

## Agent behavior guidance

1. Start with `pin_context_get_status` or `pin_context_get_active_context` before assuming which files are in scope.
2. Treat the active context and pins as developer intent, not as a complete list of all relevant files. Inspect additional files when the task requires it.
3. Use exact context IDs from `pin_context_list_contexts`; do not infer IDs from names.
4. Never retry a cancelled operation without fresh user authorization.
5. For pin/unpin calls, use workspace-relative paths or workspace-folder-prefixed paths in multi-root workspaces. Do not request paths outside open workspace folders.
6. Report when files are only listed as paths; Pin Context does not return their contents.
