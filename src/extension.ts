import * as vscode from 'vscode';
import { ContextStore } from './contextStore';
import {
  showCreateContextQuickPick,
  showDeleteContextQuickPick,
  showPinnedQuickOpen,
  showRenameContextQuickPick,
  showSwitchContextQuickPick,
  showTimelineQuickPick
} from './contextQuickPick';
import { GitContextService } from './gitContextService';
import { PinStore } from './pinStore';
import { StatusBarManager } from './statusBar';
import { PinnedTreeViewProvider, PinnedFileItem } from './pinnedTreeView';
import { toUriKey } from './tabUtils';

export async function activate(context: vscode.ExtensionContext) {
  const pinStore = new PinStore(context);
  const gitContextService = new GitContextService();
  const contextStore = new ContextStore(context, pinStore, gitContextService);
  await contextStore.initialize();
  const statusBar = new StatusBarManager();

  const pinnedTreeProvider = new PinnedTreeViewProvider(pinStore, contextStore);
  const treeView = vscode.window.createTreeView('pin-context.pinnedView', {
    treeDataProvider: pinnedTreeProvider,
    dragAndDropController: pinnedTreeProvider.dragAndDropController,
    showCollapseAll: true,
    canSelectMany: true
  });

  const updateTreeViewTitle = () => {
    const activeContext = contextStore.getActiveContext();
    if (activeContext) {
      treeView.title = `📌 Pinned Files (${activeContext.name})`;
    } else {
      treeView.title = '📌 Pinned Files';
    }
  };

  updateTreeViewTitle();

  context.subscriptions.push(
    contextStore.onDidChange(() => {
      pinnedTreeProvider.refresh();
      updateTreeViewTitle();
    })
  );

  context.subscriptions.push(
    pinStore.onDidChange(() => {
      updateTreeViewTitle();
    })
  );

  context.subscriptions.push(treeView, pinStore, contextStore, statusBar, {
    dispose: () => pinnedTreeProvider.dispose()
  });

  const registerCommand = <T extends unknown[]>(
    command: string,
    callback: (...args: T) => unknown
  ) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  registerCommand('pin-context.unpinFromTree', async (item: PinnedFileItem) => {
    if (item && item.uri) {
      await pinStore.unpinUri(item.uri);
    }
  });

  registerCommand('pin-context.revealInExplorer', async (item: PinnedFileItem) => {
    if (item && item.uri) {
      await vscode.commands.executeCommand('revealInExplorer', item.uri);
    }
  });

  registerCommand('pin-context.copyPathFromTree', async (item: PinnedFileItem) => {
    if (item && item.uri) {
      await vscode.env.clipboard.writeText(item.uri.fsPath);
      vscode.window.showInformationMessage('Path copied to clipboard');
    }
  });

  registerCommand('pin-context.toggleViewMode', async () => {
    const config = vscode.workspace.getConfiguration('pin-context');
    const currentMode = config.get<string>('viewMode', 'tree');
    const newMode = currentMode === 'tree' ? 'list' : 'tree';
    const target = getConfigTarget();
    await config.update('viewMode', newMode, target);
    vscode.window.showInformationMessage(
      `Pinned Files view mode: ${newMode === 'tree' ? 'Tree' : 'List'}`
    );
    pinnedTreeProvider.setViewMode(newMode as 'tree' | 'list');
    pinnedTreeProvider.refresh();
  });

  registerCommand('pin-context.pinCurrentEditor', async (arg?: unknown) => {
    const uri = getUriFromCommandArg(arg);
    if (uri) {
      await pinStore.pinUris([uri]);
      pinnedTreeProvider.refresh();
      return;
    }
    await pinStore.pinCurrentEditor();
    pinnedTreeProvider.refresh();
  });

  registerCommand('pin-context.unpinCurrentEditor', async (arg?: unknown) => {
    const uri = getUriFromCommandArg(arg);
    if (uri) {
      await pinStore.unpinUris([uri]);
      pinnedTreeProvider.refresh();
      return;
    }
    await pinStore.unpinCurrentEditor();
    pinnedTreeProvider.refresh();
  });

  registerCommand('pin-context.togglePinCurrentEditor', async (arg?: unknown) => {
    const uri = getUriFromCommandArg(arg);
    if (uri) {
      const pinnedNow = pinStore.getPinnedItems().some((item) => item.key === toUriKey(uri));
      if (pinnedNow) {
        await pinStore.unpinUris([uri]);
      } else {
        await pinStore.pinUris([uri]);
      }
      pinnedTreeProvider.refresh();
      return;
    }
    await pinStore.togglePinCurrentEditor();
    pinnedTreeProvider.refresh();
  });

  registerCommand('pin-context.pinAllEditors', async () => {
    const result = await pinStore.pinAllEditors();
    showBatchResult('Pinned', result);
  });

  registerCommand('pin-context.unpinAllEditors', async () => {
    const config = vscode.workspace.getConfiguration('pin-context');
    const confirm = config.get<boolean>('confirmBeforeUnpinAll', true);

    if (confirm) {
      const answer = await vscode.window.showWarningMessage(
        'Unpin all editors? This will unpin every pinned tab.',
        { modal: true },
        'Yes',
        'Cancel'
      );
      if (answer !== 'Yes') {
        return;
      }
    }

    const result = await pinStore.unpinAllEditors();
    showBatchResult('Unpinned', result);
  });

  registerCommand('pin-context.pinEditorsByPattern', async () => {
    const pattern = await vscode.window.showInputBox({
      prompt: 'Enter glob pattern (e.g., **/*.ts, src/**/*.js)',
      placeHolder: '**/*.ts'
    });

    if (pattern) {
      const result = await pinStore.pinEditorsByPattern(pattern);
      showBatchResult('Pinned', result, `matching "${pattern}"`);
    }
  });

  registerCommand('pin-context.refreshPinnedView', () => {
    void contextStore.refreshGitContexts();
    pinnedTreeProvider.refresh();
  });

  registerCommand('pin-context.createContext', async () => {
    await showCreateContextQuickPick(contextStore);
  });

  registerCommand('pin-context.renameContext', async () => {
    await showRenameContextQuickPick(contextStore);
  });

  registerCommand('pin-context.deleteContext', async () => {
    await showDeleteContextQuickPick(contextStore);
  });

  registerCommand('pin-context.switchContext', async () => {
    await contextStore.refreshGitContexts();
    await showSwitchContextQuickPick(contextStore);
  });

  registerCommand('pin-context.switchContextById', async (contextId: string) => {
    await contextStore.switchContext(contextId);
  });

  registerCommand('pin-context.saveCurrentToContext', async () => {
    const active = contextStore.getActiveContext();
    if (!active) {
      vscode.window.showInformationMessage('No active context to save');
      return;
    }
    await contextStore.saveCurrentPinsToContext(active.id);
    vscode.window.showInformationMessage(`Saved current pins to "${active.name}"`);
  });

  registerCommand('pin-context.openContextTimeline', async () => {
    await showTimelineQuickPick(contextStore);
  });

  registerCommand('pin-context.quickOpenPinned', async () => {
    await showPinnedQuickOpen(pinStore);
  });

  const config = vscode.workspace.getConfiguration('pin-context');
  const savedViewMode = config.get<string>('viewMode', 'tree');
  pinnedTreeProvider.setViewMode(savedViewMode as 'tree' | 'list');

  const updateStatusBar = () => statusBar.update(pinStore.getPinnedCount());
  context.subscriptions.push(pinStore.onDidChange(updateStatusBar));
  context.subscriptions.push(contextStore.onDidChange(() => pinnedTreeProvider.refresh()));

  updateStatusBar();
  statusBar.show();
}

function getConfigTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function showBatchResult(
  action: 'Pinned' | 'Unpinned',
  result: { success: number; failed: number; skipped: number; errors: string[] },
  suffix = ''
): void {
  const parts = [`${action} ${result.success}`];
  if (result.skipped > 0) {
    parts.push(`skipped ${result.skipped}`);
  }
  if (result.failed > 0) {
    parts.push(`failed ${result.failed}`);
  }
  const detail = suffix ? ` ${suffix}` : '';
  const message = `${parts.join(', ')} editor(s)${detail}`;
  if (result.failed > 0) {
    void vscode.window.showWarningMessage(message);
    const firstError = result.errors[0];
    if (firstError && isDebugEnabled()) {
      console.error(`[pin-context] ${firstError}`);
    }
    return;
  }
  void vscode.window.showInformationMessage(message);
}

function isDebugEnabled(): boolean {
  const config = vscode.workspace.getConfiguration('pin-context');
  return config.get<boolean>('debug', false);
}

function getUriFromCommandArg(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (arg && typeof arg === 'object' && 'uri' in (arg as Record<string, unknown>)) {
    const uri = (arg as { uri?: unknown }).uri;
    if (uri instanceof vscode.Uri) {
      return uri;
    }
  }
  return undefined;
}

export function deactivate() {
  // No-op: resources are disposed through extension subscriptions.
}
