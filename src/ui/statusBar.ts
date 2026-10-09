import * as vscode from 'vscode';
import { t } from '../l10n';

export class StatusBarManager implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private lastText = '';
  private lastTooltip = '';
  private isVisible = false;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'pin-context.togglePinCurrentEditor';
  }

  update(pinnedCount: number, activeContextName?: string): void {
    const showInStatusBar = vscode.workspace
      .getConfiguration('pin-context')
      .get<boolean>('showPinnedCountInStatusBar', true);

    if (!showInStatusBar) {
      this.hide();
      return;
    }

    const nextText = pinnedCount > 0 ? `$(pinned) ${pinnedCount}` : '$(pin) 0';
    if (nextText !== this.lastText) {
      this.statusBarItem.text = nextText;
      this.lastText = nextText;
    }

    const nextTooltip = [
      t('Pin Context'),
      activeContextName ? `Active context: ${activeContextName}` : undefined,
      'Click to toggle pin on the current editor'
    ]
      .filter(Boolean)
      .join('\n');
    if (nextTooltip !== this.lastTooltip) {
      this.statusBarItem.tooltip = nextTooltip;
      this.lastTooltip = nextTooltip;
    }

    if (!this.isVisible) {
      this.statusBarItem.show();
      this.isVisible = true;
    }
  }

  hide(): void {
    if (this.isVisible) {
      this.statusBarItem.hide();
      this.isVisible = false;
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
