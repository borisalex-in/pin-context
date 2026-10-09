import * as vscode from 'vscode';
import { t } from '../l10n';
import { ContextStore } from '../stores/contextStore';
import {
  showCreateContextQuickPick,
  showDeleteContextQuickPick,
  showExportContextsQuickPick,
  showImportContextsQuickPick,
  showPinnedQuickOpen,
  showRenameContextQuickPick,
  showSwitchContextQuickPick,
  showTimelineQuickPick,
  switchToContext
} from '../ui/contextQuickPick';
import { GitContextService } from '../services/gitContextService';
import { BatchOutcome, PinStore } from '../stores/pinStore';
import { StatusBarManager } from '../ui/statusBar';
import { ContextItem, PinnedTreeViewProvider } from '../ui/pinnedTreeView';
import { initLogger, logger } from '../utils/logger';

const ONBOARDING_SHOWN_KEY = 'pin-context.onboarding.shown.v1';
const STALE_DISMISS_KEY = 'pin-context.stale.dismissed.v1';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger(context);

  const pinStore = new PinStore(context);
  const gitContextService = new GitContextService();
  const contextStore = new ContextStore(context, pinStore, gitContextService);
  const statusBar = new StatusBarManager();
  const pinnedTreeProvider = new PinnedTreeViewProvider(pinStore, contextStore);

  const treeView = vscode.window.createTreeView('pin-context.pinnedView', {
    treeDataProvider: pinnedTreeProvider,
    dragAndDropController: pinnedTreeProvider.dragAndDropController,
    showCollapseAll: true,
    canSelectMany: true
  });

  // Every disposable is registered. GitContextService used to be missing here, so its
  // polling timer kept running after the extension was deactivated.
  context.subscriptions.push(
    treeView,
    pinnedTreeProvider,
    pinStore,
    contextStore,
    gitContextService,
    statusBar
  );

  const updateTreeViewTitle = (): void => {
    const activeContext = contextStore.getActiveContext();
    treeView.title = activeContext ? `Pin Context (${activeContext.name})` : 'Pin Context';
  };

  const updateStatusBar = (): void => {
    statusBar.update(pinStore.getPinnedCount(), contextStore.getActiveContext()?.name);
  };

  context.subscriptions.push(
    contextStore.onDidChange(() => {
      updateTreeViewTitle();
      updateStatusBar();
    }),
    pinStore.onDidChange(updateStatusBar),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('pin-context.showPinnedCountInStatusBar')) {
        updateStatusBar();
      }
    })
  );

  registerCommands(context, pinStore, contextStore, pinnedTreeProvider);
  setupStaleContextCleanup(context, contextStore);

  updateTreeViewTitle();
  // Note: no unconditional `statusBar.show()` — it ignored `showPinnedCountInStatusBar`.
  updateStatusBar();

  // Commands and views are live at this point. Context initialization (git calls, restoring
  // a context) runs in the background, and a failure there can no longer prevent activation.
  void initializeInBackground(context, contextStore, pinStore);
}

async function initializeInBackground(
  context: vscode.ExtensionContext,
  contextStore: ContextStore,
  pinStore: PinStore
): Promise<void> {
  // Menu `when` clauses need the keys once the startup restore placed the tabs.
  await pinStore.whenReady();
  pinStore.updateContextKeys();

  try {
    await contextStore.initialize();
  } catch (error) {
    logger.error('Context initialization failed', error);
    void vscode.window.showErrorMessage(
      t(
        'Pin Context: failed to initialize contexts. See the "Pin Context" output channel for details.'
      )
    );
  }

  // Registered after initialization so that git contexts discovered at startup
  // do not trigger the "Context created" nudge.
  await showOnboardingIfNeeded(context).catch((error) => logger.error('Onboarding failed', error));
}

function registerCommands(
  context: vscode.ExtensionContext,
  pinStore: PinStore,
  contextStore: ContextStore,
  pinnedTreeProvider: PinnedTreeViewProvider
): void {
  const registerCommand = (command: string, callback: (...args: any[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        try {
          return await callback(...args);
        } catch (error) {
          logger.error(`Command ${command} failed`, error);
          const message = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(t('Pin Context: {0}', message));
        }
      })
    );
  };

  registerCommand('pin-context.openPinnedFile', async (uri?: unknown) => {
    if (!(uri instanceof vscode.Uri)) {
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
    } catch (error) {
      await pinStore.unpinUri(uri);
      void vscode.window.showWarningMessage(
        t('{0} could not be opened and was removed from pins', vscode.workspace.asRelativePath(uri))
      );
      logger.debug(`Open failed for ${uri.toString()}: ${String(error)}`);
      return;
    }
    // Re-pin the tab: a file restored into the sidebar opens as a regular tab otherwise.
    await pinStore.pinUris([uri], { showProgress: false, openIfClosed: true });
  });

  registerCommand('pin-context.unpinFromTree', async (item?: unknown, selection?: unknown) => {
    const uris = collectUris(item, selection);
    if (uris.length > 0) {
      await pinStore.unpinUris(uris);
    }
  });

  registerCommand('pin-context.revealInExplorer', async (item?: unknown) => {
    const uri = getUriFromCommandArg(item);
    if (uri) {
      await vscode.commands.executeCommand('revealInExplorer', uri);
    }
  });

  registerCommand('pin-context.copyPathFromTree', async (item?: unknown, selection?: unknown) => {
    const uris = collectUris(item, selection);
    if (uris.length === 0) {
      return;
    }
    await vscode.env.clipboard.writeText(uris.map((uri) => uri.fsPath).join('\n'));
    void vscode.window.showInformationMessage(
      uris.length > 1
        ? t('{0} paths copied to clipboard', uris.length)
        : t('Path copied to clipboard')
    );
  });

  registerCommand('pin-context.toggleViewMode', async () => {
    const config = vscode.workspace.getConfiguration('pin-context');
    const nextMode = pinnedTreeProvider.getViewMode() === 'tree' ? 'list' : 'tree';

    // Never write the setting into the project's .vscode/settings.json unless the user
    // already overrides it there: that used to dirty the user's repository.
    const inspected = config.inspect<string>('viewMode');
    const target =
      inspected?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspected?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;

    await config.update('viewMode', nextMode, target);
    // The configuration listener refreshes the tree; this keeps the UI correct even if
    // the settings write is delayed.
    pinnedTreeProvider.setViewMode(nextMode);
    pinnedTreeProvider.refresh();
    void vscode.window.showInformationMessage(
      t('Pinned Files view mode: {0}', nextMode === 'tree' ? t('Tree') : t('List'))
    );
  });

  registerCommand('pin-context.pinCurrentEditor', async (arg?: unknown, selected?: unknown) => {
    const uris = collectUris(arg, selected);
    if (uris.length > 0) {
      const result = await pinStore.pinUris(uris, { openIfClosed: true });
      if (uris.length > 1) {
        showBatchResult('Pinned', result);
      }
      return;
    }
    await pinStore.pinCurrentEditor();
  });

  registerCommand('pin-context.unpinCurrentEditor', async (arg?: unknown, selected?: unknown) => {
    const uris = collectUris(arg, selected);
    if (uris.length > 0) {
      const result = await pinStore.unpinUris(uris);
      if (uris.length > 1) {
        showBatchResult('Unpinned', result);
      }
      return;
    }
    await pinStore.unpinCurrentEditor();
  });

  registerCommand(
    'pin-context.togglePinCurrentEditor',
    async (arg?: unknown, selected?: unknown) => {
      const uris = collectUris(arg, selected);
      if (uris.length > 0) {
        const alreadyPinned = uris.filter((uri) => pinStore.isUriPinned(uri));
        const notPinned = uris.filter((uri) => !pinStore.isUriPinned(uri));
        if (notPinned.length > 0) {
          await pinStore.pinUris(notPinned, { openIfClosed: true });
        }
        if (alreadyPinned.length > 0) {
          await pinStore.unpinUris(alreadyPinned);
        }
        return;
      }
      await pinStore.togglePinCurrentEditor();
    }
  );

  registerCommand('pin-context.pinAllEditors', async () => {
    const result = await pinStore.pinAllEditors();
    showBatchResult('Pinned', result);
  });

  registerCommand('pin-context.unpinAllEditors', async () => {
    const confirm = vscode.workspace
      .getConfiguration('pin-context')
      .get<boolean>('confirmBeforeUnpinAll', true);

    if (confirm) {
      // Modal dialogs already include a Cancel button. The action label is resolved once
      // and compared by identity so a translated button still matches.
      const yesLabel = t('Yes');
      const answer = await vscode.window.showWarningMessage(
        t('Unpin all editors? This will unpin every pinned tab.'),
        { modal: true },
        yesLabel
      );
      if (answer !== yesLabel) {
        return;
      }
    }

    const result = await pinStore.unpinAllEditors();
    showBatchResult('Unpinned', result);
  });

  registerCommand('pin-context.pinEditorsByPattern', async () => {
    const pattern = await vscode.window.showInputBox({
      prompt: t('Enter glob pattern (e.g., **/*.ts, src/**/*.js)'),
      placeHolder: '**/*.ts',
      validateInput: (value) => (value.trim().length === 0 ? t('Pattern is required') : undefined)
    });

    if (pattern && pattern.trim()) {
      const result = await pinStore.pinEditorsByPattern(pattern);
      showBatchResult('Pinned', result, t('matching "{0}"', pattern.trim()));
    }
  });

  registerCommand('pin-context.refreshPinnedView', async () => {
    await contextStore.refreshGitContexts();
    pinnedTreeProvider.refresh();
  });

  registerCommand('pin-context.createContext', async () => {
    await showCreateContextQuickPick(contextStore);
  });

  registerCommand('pin-context.renameContext', async (arg?: unknown) => {
    await showRenameContextQuickPick(contextStore, getContextIdFromArg(arg));
  });

  registerCommand('pin-context.deleteContext', async (arg?: unknown) => {
    await showDeleteContextQuickPick(contextStore, getContextIdFromArg(arg));
  });

  registerCommand('pin-context.switchContext', async () => {
    await contextStore.refreshGitContexts();
    await showSwitchContextQuickPick(contextStore);
  });

  registerCommand('pin-context.switchContextById', async (arg?: unknown) => {
    const contextId = getContextIdFromArg(arg);
    if (!contextId) {
      return;
    }
    await switchToContext(contextStore, contextId);
  });

  registerCommand('pin-context.saveCurrentToContext', async (arg?: unknown) => {
    const target = getContextIdFromArg(arg)
      ? contextStore.getContextById(getContextIdFromArg(arg) as string)
      : contextStore.getActiveContext();
    if (!target) {
      void vscode.window.showInformationMessage(t('No active context to save'));
      return;
    }
    if (await contextStore.saveCurrentPinsToContext(target.id)) {
      void vscode.window.showInformationMessage(t('Saved current pins to "{0}"', target.name));
    }
  });

  registerCommand('pin-context.openContextTimeline', async () => {
    await showTimelineQuickPick(contextStore);
  });

  registerCommand('pin-context.quickOpenPinned', async () => {
    await showPinnedQuickOpen(pinStore);
  });

  registerCommand('pin-context.exportContexts', async () => {
    await showExportContextsQuickPick(contextStore);
  });

  registerCommand('pin-context.importContexts', async () => {
    await showImportContextsQuickPick(contextStore);
  });
}

function showBatchResult(action: 'Pinned' | 'Unpinned', result: BatchOutcome, suffix = ''): void {
  const detail = suffix ? ` ${suffix}` : '';

  if (result.success === 0 && result.failed === 0) {
    void vscode.window.showInformationMessage(
      action === 'Pinned' ? t('No editors to pin{0}', detail) : t('No editors to unpin{0}', detail)
    );
    return;
  }

  // Whole phrases are translated (not word fragments) so the translator can pick the
  // correct word order and case for the count.
  const parts = [
    action === 'Pinned'
      ? t('Pinned {0} editor(s)', result.success)
      : t('Unpinned {0} editor(s)', result.success)
  ];
  if (result.skipped > 0) {
    parts.push(t('skipped {0}', result.skipped));
  }
  if (result.failed > 0) {
    parts.push(t('failed {0}', result.failed));
  }
  const message = `${parts.join(', ')}${detail}`;

  if (result.failed > 0) {
    void vscode.window.showWarningMessage(message);
    // The first error used to be logged only with `debug` on; failures should be traceable.
    for (const error of result.errors.slice(0, 5)) {
      logger.warn(error);
    }
    return;
  }
  void vscode.window.showInformationMessage(message);
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

/**
 * Menu commands receive `(clickedItem, allSelectedItems)`. Multi-selection used to be
 * ignored, so only the clicked file was affected.
 */
function collectUris(arg: unknown, selected: unknown): vscode.Uri[] {
  const candidates = Array.isArray(selected) && selected.length > 0 ? selected : [arg];
  const unique = new Map<string, vscode.Uri>();
  for (const candidate of candidates) {
    const uri = getUriFromCommandArg(candidate);
    if (uri) {
      unique.set(uri.toString(), uri);
    }
  }
  return [...unique.values()];
}

function getContextIdFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg instanceof ContextItem) {
    return arg.context.id;
  }
  return undefined;
}

async function showOnboardingIfNeeded(context: vscode.ExtensionContext): Promise<void> {
  const shown = context.globalState.get<boolean>(ONBOARDING_SHOWN_KEY, false);
  if (shown) {
    return;
  }

  await context.globalState.update(ONBOARDING_SHOWN_KEY, true);

  // Labels are resolved once and compared by identity so translated buttons still match.
  const createLabel = t('Create Context');
  const commandsLabel = t('Open Commands');

  const selection = await vscode.window.showInformationMessage(
    t(
      'Pin Context: Save and restore working tabs as contexts. Git branch contexts are enabled by default.'
    ),
    createLabel,
    commandsLabel
  );

  if (selection === createLabel) {
    await vscode.commands.executeCommand('pin-context.createContext');
    return;
  }

  if (selection === commandsLabel) {
    await vscode.commands.executeCommand('workbench.action.quickOpen', '>Pin Context: ');
  }
}

/**
 * Offers to remove git contexts whose branch no longer exists. The store keeps such
 * contexts forever otherwise: they can never be reached by a branch switch again.
 * A "Keep" answer is remembered so the same stale set is not offered on every refresh.
 */
function setupStaleContextCleanup(
  context: vscode.ExtensionContext,
  contextStore: ContextStore
): void {
  context.subscriptions.push(
    contextStore.onDidFindStaleContexts(() => {
      void (async () => {
        if (context.globalState.get<boolean>(STALE_DISMISS_KEY, false)) {
          return;
        }
        const stale = contextStore.getStaleContexts();
        if (stale.length === 0) {
          return;
        }
        const names = stale
          .slice(0, 3)
          .map((item) => item.name)
          .join(', ');
        const more = stale.length > 3 ? ` (+${stale.length - 3})` : '';
        const removeLabel = t('Remove');
        const keepLabel = t('Keep');
        const answer = await vscode.window.showWarningMessage(
          t(
            'Pin Context: {0} context(s) belong to branches that no longer exist ({1}{2}). Remove them?',
            stale.length,
            names,
            more
          ),
          removeLabel,
          keepLabel
        );
        if (answer === removeLabel) {
          const removed = await contextStore.removeStaleContexts();
          void vscode.window.showInformationMessage(t('Removed {0} stale context(s)', removed));
        } else if (answer === keepLabel) {
          await context.globalState.update(STALE_DISMISS_KEY, true);
        }
        // Dismissed without choosing: ask again the next time stale contexts are found.
      })();
    })
  );
}

export function deactivate(): void {
  // No-op: all resources are disposed through extension subscriptions.
}
