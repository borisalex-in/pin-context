import * as vscode from 'vscode';
import { t } from '../l10n';
import { ContextStore } from '../stores/contextStore';
import { ContextQuickPickItem } from '../types';
import { PinStore } from '../stores/pinStore';

function describeContext(context: { source: string; changed?: number; staged?: number }): string {
  if (context.source !== 'git') {
    return t('Manual context');
  }
  const changed = context.changed ?? 0;
  const staged = context.staged ?? 0;
  return changed || staged
    ? `Git context · changed: ${changed}, staged: ${staged}`
    : t('Git context');
}

export async function switchToContext(
  contextStore: ContextStore,
  contextId: string,
  label?: string
): Promise<boolean> {
  const target = contextStore.getContextById(contextId);
  if (!target) {
    void vscode.window.showWarningMessage(t('This context no longer exists'));
    return false;
  }
  const ok = await contextStore.switchContext(contextId);
  // `false` means the switch was superseded by a newer one; stay quiet in that case.
  if (ok && label !== undefined) {
    void vscode.window.showInformationMessage(t('Switched context: {0}', label));
  }
  return ok;
}

export async function showSwitchContextQuickPick(contextStore: ContextStore): Promise<void> {
  const activeId = contextStore.getActiveContext()?.id;
  const items: ContextQuickPickItem[] = contextStore.getAllContexts().map((context) => ({
    contextId: context.id,
    label: context.id === activeId ? `$(check) ${context.name}` : context.name,
    description: describeContext(context),
    detail: context.id === activeId ? 'Active' : undefined
  }));

  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      t('No contexts yet. Run "Pin Context: Create Context" to save your current pins.')
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: t('Switch Context'),
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) {
    return;
  }
  const name = contextStore.getContextById(picked.contextId)?.name ?? picked.label;
  await switchToContext(contextStore, picked.contextId, name);
}

export async function showCreateContextQuickPick(contextStore: ContextStore): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: t('Create Context'),
    prompt: t('Context name'),
    validateInput: (value) => {
      if (value.trim().length === 0) {
        return t('Name is required');
      }
      return contextStore.hasManualContextName(value)
        ? 'A context with this name already exists'
        : undefined;
    }
  });
  if (!name) {
    return;
  }
  const trimmed = name.trim();
  const created = await contextStore.createManualContext(trimmed);
  if (created) {
    void vscode.window.showInformationMessage(t('Created context: {0}', trimmed));
  }
}

export async function showRenameContextQuickPick(
  contextStore: ContextStore,
  contextId?: string
): Promise<void> {
  const picked = contextId
    ? toPickedItem(contextStore, contextId)
    : await pickContext(contextStore, t('Rename Context'));
  if (!picked) {
    return;
  }
  if (contextStore.getContextById(picked.contextId)?.source === 'git') {
    void vscode.window.showInformationMessage(t('Git contexts are named after the branch'));
    return;
  }
  const nextName = await vscode.window.showInputBox({
    title: t('Rename Context'),
    value: picked.label,
    validateInput: (value) => {
      if (value.trim().length === 0) {
        return t('Name is required');
      }
      return contextStore.hasManualContextName(value, picked.contextId)
        ? 'A context with this name already exists'
        : undefined;
    }
  });
  if (!nextName) {
    return;
  }
  const renamed = await contextStore.renameContext(picked.contextId, nextName.trim());
  if (renamed) {
    void vscode.window.showInformationMessage(t('Context renamed to: {0}', nextName.trim()));
  }
}

export async function showDeleteContextQuickPick(
  contextStore: ContextStore,
  contextId?: string
): Promise<void> {
  const picked = contextId
    ? toPickedItem(contextStore, contextId)
    : await pickContext(contextStore, t('Delete Context'));
  if (!picked) {
    return;
  }
  if (contextStore.getContextById(picked.contextId)?.source === 'git') {
    void vscode.window.showInformationMessage(t('Git contexts are managed automatically'));
    return;
  }
  // Modal dialogs already get a built-in Cancel button; adding our own produced two.
  // The action label is compared by identity, so it is resolved once and reused.
  const deleteLabel = t('Delete');
  const confirm = await vscode.window.showWarningMessage(
    t('Delete context "{0}"?', picked.label),
    { modal: true },
    deleteLabel
  );
  if (confirm !== deleteLabel) {
    return;
  }
  if (await contextStore.deleteContext(picked.contextId)) {
    void vscode.window.showInformationMessage(t('Deleted context: {0}', picked.label));
  }
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

  if (items.length === 0) {
    void vscode.window.showInformationMessage(t('Context timeline is empty'));
    return;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: t('Context Timeline'),
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked || picked.contextId === '__header__') {
    return;
  }
  await switchToContext(contextStore, picked.contextId, picked.label);
}

export async function showPinnedQuickOpen(pinStore: PinStore): Promise<void> {
  const items = pinStore.getPinnedItems().map((item) => ({
    label: item.label,
    description: vscode.workspace.asRelativePath(item.folder),
    detail: item.uri.fsPath,
    uri: item.uri
  }));

  if (items.length === 0) {
    void vscode.window.showInformationMessage(t('No pinned files yet'));
    return;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: t('Open Pinned File'),
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) {
    return;
  }
  // `vscode.open` supports every editor type; showTextDocument breaks images/notebooks.
  await vscode.commands.executeCommand('vscode.open', picked.uri, { preview: false });
}

function toPickedItem(
  contextStore: ContextStore,
  contextId: string
): ContextQuickPickItem | undefined {
  const target = contextStore.getContextById(contextId);
  if (!target) {
    void vscode.window.showWarningMessage(t('This context no longer exists'));
    return undefined;
  }
  return { contextId: target.id, label: target.name };
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
    void vscode.window.showInformationMessage(t('No manual contexts found'));
    return undefined;
  }
  return vscode.window.showQuickPick(items, {
    title,
    matchOnDescription: true
  });
}

/** Default file name of the export dialog; contexts can appear in the name, so it is localized. */
function suggestedExportFileName(): string {
  const active = contextFileNamePart(vscode.l10n.t('Pin Context'));
  return `pin-contexts${active ? `-${active}` : ''}.json`;
}

function contextFileNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function showExportContextsQuickPick(contextStore: ContextStore): Promise<void> {
  const contexts = contextStore.getExportableContexts();
  if (contexts.length === 0) {
    void vscode.window.showInformationMessage(t('No manual contexts to export'));
    return;
  }

  type ContextExportPickItem = vscode.QuickPickItem & { contextId?: string; all?: boolean };
  const items: ContextExportPickItem[] = contexts.map((context) => ({
    label: context.name,
    description: t('{0} files', context.pinnedUris.length),
    contextId: context.id
  }));
  const allItem: ContextExportPickItem = {
    label: t('All contexts'),
    description: t('{0} contexts', contexts.length),
    all: true
  };
  items.push(allItem);

  const picked = await vscode.window.showQuickPick(items, {
    title: t('Export Contexts'),
    canPickMany: true,
    placeHolder: t('Select contexts to export (or pick "All contexts")')
  });
  if (!picked || picked.length === 0) {
    return;
  }

  const selected = picked.some((item) => item.all)
    ? contexts
    : contexts.filter((context) => picked.some((item) => item.contextId === context.id));

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({
    title: t('Export Contexts'),
    ...(workspaceRoot
      ? { defaultUri: vscode.Uri.joinPath(workspaceRoot, suggestedExportFileName()) }
      : {}),
    filters: { JSON: ['json'] }
  });
  if (!target) {
    return;
  }

  if (await contextStore.exportContexts(target, selected)) {
    void vscode.window.showInformationMessage(
      t('Exported {0} context(s) to {1}', selected.length, vscode.workspace.asRelativePath(target))
    );
  }
}

export async function showImportContextsQuickPick(contextStore: ContextStore): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: t('Import Contexts'),
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { JSON: ['json'] }
  });
  const source = picked?.[0];
  if (!source) {
    return;
  }

  const result = await contextStore.importContexts(source);
  if (!result.saved) {
    void vscode.window.showErrorMessage(t('Import failed because context data could not be saved'));
    return;
  }
  if (result.added === 0 && result.updated === 0) {
    void vscode.window.showWarningMessage(t('No contexts found in the file'));
    return;
  }
  void vscode.window.showInformationMessage(
    t('Imported {0} new, updated {1} context(s)', result.added, result.updated)
  );
}
