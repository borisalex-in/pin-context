import * as vscode from 'vscode';
import * as path from 'path';
import { ContextStore } from './contextStore';
import { ContextTimelineEntry, PinContext } from './contextTypes';
import { PinStore } from './pinStore';
import { PinRecord } from './tabUtils';

export class PinnedTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly uri?: vscode.Uri,
        public readonly folderPath?: string
    ) {
        super(label, collapsibleState);
    }
}

export class PinnedFolderItem extends PinnedTreeItem {
    constructor(
        public readonly folderPath: string,
        public readonly fileCount: number
    ) {
        const folderName = path.basename(folderPath);
        super(folderName, vscode.TreeItemCollapsibleState.Expanded);
        
        this.description = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
        this.iconPath = new vscode.ThemeIcon('folder');
        this.tooltip = folderPath;
        this.contextValue = 'pinnedFolder';
    }
}

export class PinnedFileItem extends PinnedTreeItem {
    constructor(
        public readonly uri: vscode.Uri,
        public readonly fileName: string
    ) {
        super(fileName, vscode.TreeItemCollapsibleState.None, uri);
        
        this.iconPath = vscode.ThemeIcon.File;
        this.tooltip = uri.fsPath;
        this.resourceUri = uri;
        this.contextValue = 'pinnedFile';
        
        this.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [uri]
        };
    }
}

export class PinnedListItem extends vscode.TreeItem {
    constructor(
        public readonly uri: vscode.Uri,
        public readonly label: string,
        public readonly folderPath: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        
        this.iconPath = vscode.ThemeIcon.File;
        this.tooltip = uri.fsPath;
        this.resourceUri = uri;
        this.contextValue = 'pinnedFile';
        this.description = path.basename(folderPath);
        
        this.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [uri]
        };
    }
}

class EmptyPinnedItem extends vscode.TreeItem {
    constructor() {
        super('No pinned files', vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'pinnedEmpty';
        this.iconPath = new vscode.ThemeIcon('info');
        this.description = 'Pin files to see them here';
    }
}

class ContextSectionItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly section: 'active' | 'contexts' | 'timeline' | 'pinnedFiles'
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = `contextSection:${section}`;
        this.iconPath = new vscode.ThemeIcon('symbol-folder');
    }
}

class ContextItem extends vscode.TreeItem {
    constructor(public readonly context: PinContext, active: boolean) {
        super(context.name, vscode.TreeItemCollapsibleState.None);
        this.description = active ? 'Active' : context.source;
        this.contextValue = 'pinContext';
        this.iconPath = new vscode.ThemeIcon(active ? 'check' : 'bookmark');
        this.command = {
            command: 'pin-context.switchContextById',
            title: 'Switch Context',
            arguments: [context.id]
        };
    }
}

class TimelineHeaderItem extends vscode.TreeItem {
    constructor(public readonly key: 'today' | 'yesterday' | 'older', label: string) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'timelineHeader';
        this.iconPath = new vscode.ThemeIcon('history');
    }
}

class TimelineEntryItem extends vscode.TreeItem {
    constructor(public readonly entry: ContextTimelineEntry) {
        super(entry.contextName, vscode.TreeItemCollapsibleState.None);
        this.description = entry.action;
        this.tooltip = new Date(entry.timestamp).toLocaleString();
        this.contextValue = 'timelineEntry';
        this.command = {
            command: 'pin-context.switchContextById',
            title: 'Switch Context',
            arguments: [entry.contextId]
        };
    }
}

export class PinnedTreeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private pinnedItems: PinRecord[] = [];
    private viewMode: 'tree' | 'list' = 'tree';
    private readonly storeDisposable: vscode.Disposable;
    private readonly contextDisposable: vscode.Disposable;
    private folderCache = new Map<string, PinRecord[]>();
    private readonly activeContextSection = new ContextSectionItem('Active Context', 'active');
    private readonly contextsSection = new ContextSectionItem('Contexts', 'contexts');
    private readonly timelineSection = new ContextSectionItem('Recent Contexts', 'timeline');
    private readonly pinnedFilesSection = new ContextSectionItem('Pinned Files', 'pinnedFiles');

    constructor(
        private readonly pinStore: PinStore,
        private readonly contextStore: ContextStore
    ) {
        this.loadPinnedItems();
        this.storeDisposable = this.pinStore.onDidChange(() => this.refresh());
        this.contextDisposable = this.contextStore.onDidChange(() => this.refresh());
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        this.storeDisposable.dispose();
        this.contextDisposable.dispose();
    }

    setViewMode(mode: 'tree' | 'list'): void {
        this.viewMode = mode;
    }

    refresh(): void {
        this.loadPinnedItems();
        this._onDidChangeTreeData.fire();
    }

    private loadPinnedItems(): void {
        this.pinnedItems = this.pinStore.getPinnedItems();
        this.folderCache = new Map<string, PinRecord[]>();
        for (const item of this.pinnedItems) {
            const bucket = this.folderCache.get(item.folder);
            if (bucket) {
                bucket.push(item);
            } else {
                this.folderCache.set(item.folder, [item]);
            }
        }
    }
    
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }
    
    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            return [this.activeContextSection, this.contextsSection, this.timelineSection, this.pinnedFilesSection];
        }

        if (element instanceof ContextSectionItem) {
            if (element.section === 'active') {
                const active = this.contextStore.getActiveContext();
                return active
                    ? [new ContextItem(active, true)]
                    : [new vscode.TreeItem('No active context', vscode.TreeItemCollapsibleState.None)];
            }

            if (element.section === 'contexts') {
                const activeId = this.contextStore.getActiveContext()?.id;
                return this.contextStore.getAllContexts().map(context => new ContextItem(context, context.id === activeId));
            }

            if (element.section === 'timeline') {
                const buckets = this.contextStore.getTimelineBuckets();
                const headers: TimelineHeaderItem[] = [];
                if (buckets.today.length > 0) headers.push(new TimelineHeaderItem('today', 'Today'));
                if (buckets.yesterday.length > 0) headers.push(new TimelineHeaderItem('yesterday', 'Yesterday'));
                if (buckets.older.length > 0) headers.push(new TimelineHeaderItem('older', 'Older'));
                return headers.length > 0 ? headers : [new vscode.TreeItem('No recent contexts', vscode.TreeItemCollapsibleState.None)];
            }

            if (this.pinnedItems.length === 0) {
                return [new EmptyPinnedItem()];
            }
            if (this.viewMode === 'list') {
                return this.pinnedItems.map(item => new PinnedListItem(item.uri, item.label, item.folder));
            }
            const folderItems: PinnedFolderItem[] = [];
            for (const [folderPath, files] of this.folderCache) {
                folderItems.push(new PinnedFolderItem(folderPath, files.length));
            }
            folderItems.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
            return folderItems;
        }

        if (element instanceof TimelineHeaderItem) {
            const buckets = this.contextStore.getTimelineBuckets();
            const entries = element.key === 'today' ? buckets.today : element.key === 'yesterday' ? buckets.yesterday : buckets.older;
            return entries.map(entry => new TimelineEntryItem(entry));
        }

        if (element instanceof PinnedFolderItem) {
            const folderFiles = this.folderCache.get(element.folderPath) ?? [];
            const fileItems = folderFiles.map(file => new PinnedFileItem(file.uri, file.label));
            fileItems.sort((a, b) => a.fileName.localeCompare(b.fileName));
            return fileItems;
        }

        return [];
    }

    async unpinFile(uri: vscode.Uri): Promise<void> {
        await this.pinStore.unpinUri(uri);
    }
}
