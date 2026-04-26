import * as path from 'path';
import * as vscode from 'vscode';

export interface PinRecord {
  key: string;
  uri: vscode.Uri;
  label: string;
  folder: string;
}

export function getTabInputUris(tab: vscode.Tab): vscode.Uri[] {
  const { input } = tab;
  if (input instanceof vscode.TabInputText) {
    return [input.uri];
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return [input.modified];
  }
  if (input instanceof vscode.TabInputNotebook) {
    return [input.uri];
  }
  if (input instanceof vscode.TabInputNotebookDiff) {
    return [input.modified];
  }
  if (input instanceof vscode.TabInputCustom) {
    return [input.uri];
  }
  if (input instanceof vscode.TabInputWebview) {
    return [];
  }
  if (input instanceof vscode.TabInputTerminal) {
    return [];
  }
  return [];
}

export function getPrimaryTabUri(tab: vscode.Tab): vscode.Uri | undefined {
  return getTabInputUris(tab)[0];
}

export function toPinRecord(uri: vscode.Uri): PinRecord {
  return {
    key: toUriKey(uri),
    uri,
    label: path.basename(uri.fsPath),
    folder: path.dirname(uri.fsPath)
  };
}

export function toUriKey(uri: vscode.Uri): string {
  return uri.toString(true);
}
