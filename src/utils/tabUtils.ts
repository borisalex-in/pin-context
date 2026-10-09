import * as path from 'path';
import * as vscode from 'vscode';

export interface PinRecord {
  key: string;
  uri: vscode.Uri;
  label: string;
  folder: string;
}

/**
 * Only real, re-openable resources are tracked. Untitled buffers, `git:` diff sides,
 * output channels and similar virtual documents can never be restored after a reload,
 * so persisting them would leave dead entries in the sidebar forever.
 */
const TRACKABLE_SCHEMES = new Set(['file', 'vscode-remote', 'vscode-vfs', 'vscode-userdata']);

export function isTrackableUri(uri: vscode.Uri): boolean {
  return TRACKABLE_SCHEMES.has(uri.scheme);
}

/**
 * Strict parse: a string without an explicit scheme (for example plain text dropped
 * on the view) is rejected instead of being silently interpreted as `file:///text`.
 */
export function parseUri(value: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.parse(value, true);
  } catch {
    return undefined;
  }
}

/**
 * Diff editors are intentionally not tracked: they share the URI of the real file and
 * made the pinned state of the file flap between the diff tab and the regular tab.
 */
export function getTabInputUris(tab: vscode.Tab): vscode.Uri[] {
  const { input } = tab;
  if (input instanceof vscode.TabInputText) {
    return [input.uri];
  }
  if (input instanceof vscode.TabInputNotebook) {
    return [input.uri];
  }
  if (input instanceof vscode.TabInputCustom) {
    return [input.uri];
  }
  return [];
}

export function getPrimaryTabUri(tab: vscode.Tab): vscode.Uri | undefined {
  return getTabInputUris(tab)[0];
}

export function toPinRecord(uri: vscode.Uri): PinRecord {
  const fsLikePath = uri.scheme === 'file' ? uri.fsPath : uri.path;
  return {
    key: toUriKey(uri),
    uri,
    label: path.basename(fsLikePath),
    folder: path.dirname(fsLikePath)
  };
}

export function toUriKey(uri: vscode.Uri): string {
  return uri.toString(true);
}

export function isSameOrNested(key: string, baseKey: string): boolean {
  if (key === baseKey) {
    return true;
  }
  const prefix = baseKey.endsWith('/') ? baseKey : `${baseKey}/`;
  return key.startsWith(prefix);
}
