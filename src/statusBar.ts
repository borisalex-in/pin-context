import * as vscode from 'vscode';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private lastText = '';
    private isVisible = false;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'pin-context.togglePinCurrentEditor';
        this.statusBarItem.tooltip = 'Pin Context\nClick to toggle pin current editor';
    }

    update(pinnedCount: number): void {
        const config = vscode.workspace.getConfiguration('pin-context');
        const showInStatusBar = config.get<boolean>('showPinnedCountInStatusBar', true);

        if (!showInStatusBar) {
            if (this.isVisible) {
                this.statusBarItem.hide();
                this.isVisible = false;
            }
            return;
        }

        const nextText = pinnedCount > 0 ? `$(pinned) ${pinnedCount}` : '$(pin) 0';
        if (nextText !== this.lastText) {
            this.statusBarItem.text = nextText;
            this.lastText = nextText;
        }
        if (!this.isVisible) {
            this.statusBarItem.show();
            this.isVisible = true;
        }
    }

    show(): void {
        this.statusBarItem.show();
        this.isVisible = true;
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}
