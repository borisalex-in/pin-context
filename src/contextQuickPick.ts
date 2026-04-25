import * as vscode from 'vscode';
import { ContextStore } from './contextStore';
import { ContextQuickPickItem } from './types';
import { PinStore } from './pinStore';

export async function showSwitchContextQuickPick(contextStore: ContextStore): Promise<void> {
  const activeId = contextStore.getActiveContext()?.id;
  const items: ContextQuickPickItem[] = contextStore.getAllContexts().map((context) => ({
    contextId: context.id,
    label: context.name,
    description: context.source === 'git' ? 'Git context' : 'Manual context',
    detail: context.id === activeId ? 'Active' : undefined
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Switch Context',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) {
    return;
  }
  await contextStore.switchContext(picked.contextId);
  vscode.window.showInformationMessage(`Switched context: ${picked.label}`);
}

export async function showCreateContextQuickPick(contextStore: ContextStore): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Create Context',
    prompt: 'Context name',
    validateInput: (value) => (value.trim().length === 0 ? 'Name is required' : undefined)
  });
  if (!name) {
    return;
  }
  await contextStore.createManualContext(name.trim());
  vscode.window.showInformationMessage(`Created context: ${name.trim()}`);
}

export async function showRenameContextQuickPick(contextStore: ContextStore): Promise<void> {
  const picked = await pickContext(contextStore, 'Rename Context');
  if (!picked) {
    return;
  }
  const nextName = await vscode.window.showInputBox({
    title: 'Rename Context',
    value: picked.label,
    validateInput: (value) => (value.trim().length === 0 ? 'Name is required' : undefined)
  });
  if (!nextName) {
    return;
  }
  await contextStore.renameContext(picked.contextId, nextName.trim());
  vscode.window.showInformationMessage(`Context renamed to: ${nextName.trim()}`);
}

export async function showDeleteContextQuickPick(contextStore: ContextStore): Promise<void> {
  const picked = await pickContext(contextStore, 'Delete Context');
  if (!picked) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete context "${picked.label}"?`,
    { modal: true },
    'Delete',
    'Cancel'
  );
  if (confirm !== 'Delete') {
    return;
  }
  await contextStore.deleteContext(picked.contextId);
  vscode.window.showInformationMessage(`Deleted context: ${picked.label}`);
}

export async function showTimelineQuickPick(contextStore: ContextStore): Promise<void> {
  const buckets = contextStore.getTimelineBuckets();
  const items: ContextQuickPickItem[] = [];
  for (const [title, values] of [
    ['Today', buckets.today],
    ['Yesterday', buckets.yesterday],
    ['Older', buckets.older]
  ] as const) {
    if (values.length === 0) {
      continue;
    }
    items.push({
      contextId: '__header__',
      label: title,
      kind: vscode.QuickPickItemKind.Separator
    });
    for (const entry of values) {
      items.push({
        contextId: entry.contextId,
        label: entry.contextName,
        description: entry.action,
        detail: new Date(entry.timestamp).toLocaleString()
      });
    }
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Context Timeline',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked || picked.contextId === '__header__') {
    return;
  }
  await contextStore.switchContext(picked.contextId);
}

export async function showPinnedQuickOpen(pinStore: PinStore): Promise<void> {
  const items = pinStore.getPinnedItems().map((item) => ({
    label: item.label,
    description: item.folder,
    uri: item.uri
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Open Pinned File',
    matchOnDescription: true
  });
  if (!picked) {
    return;
  }
  await vscode.window.showTextDocument(picked.uri, { preserveFocus: false, preview: false });
}

async function pickContext(
  contextStore: ContextStore,
  title: string
): Promise<ContextQuickPickItem | undefined> {
  const activeId = contextStore.getActiveContext()?.id;
  const manualContexts = contextStore
    .getAllContexts()
    .filter((context) => context.source === 'manual');
  const items: ContextQuickPickItem[] = manualContexts.map((context) => ({
    contextId: context.id,
    label: context.name,
    description: context.id === activeId ? 'Active' : undefined
  }));
  if (items.length === 0) {
    vscode.window.showInformationMessage('No manual contexts found');
    return undefined;
  }
  return vscode.window.showQuickPick(items, {
    title,
    matchOnDescription: true
  });
}
