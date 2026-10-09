import * as vscode from 'vscode';

/**
 * Marks a user-facing string as translatable and resolves it from the active language pack.
 *
 * Keys are the English source strings, matching `l10n/bundle.l10n.json`. Argument substitution
 * uses the VS Code convention (`{0}`, `{1}`), so a translator can reorder arguments freely.
 */
export function t(message: string, ...args: Array<string | number | boolean>): string {
  return args.length > 0 ? vscode.l10n.t(message, ...args) : vscode.l10n.t(message);
}
