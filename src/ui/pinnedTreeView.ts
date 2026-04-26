import * as vscode from 'vscode';
import * as path from 'path';
import { ContextStore } from '../stores/contextStore';
import { ContextTimelineEntry, PinContext } from '../types';
import { PinStore } from '../stores/pinStore';
import { PinRecord } from '../utils/tabUtils';

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
    this.command = {
      command: 'pin-context.pinCurrentEditor',
      title: 'Pin Current Editor'
    };
  }
}

class EmptyContextsItem extends vscode.TreeItem {
  constructor() {
    super('No contexts yet', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'contextsEmpty';
    this.iconPath = new vscode.ThemeIcon('lightbulb');
    this.description = 'Save current tabs and switch instantly';
    this.tooltip =
      'Save your current pinned tabs as a context and restore them instantly when switching tasks.';
    this.command = {
      command: 'pin-context.createContext',
      title: 'Create Context'
    };
  }
}

class SavePinnedAsContextHintItem extends vscode.TreeItem {
  constructor() {
    super('Turn pinned files into a context', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'contextsHint';
    this.iconPath = new vscode.ThemeIcon('save');
    this.description = 'Capture this setup for fast switching';
    this.tooltip = 'Create a context now to switch back to this exact set of tabs later.';
    this.command = {
      command: 'pin-context.createContext',
      title: 'Create Context'
    };
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
  constructor(
    public readonly context: PinContext,
    active: boolean
  ) {
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
  constructor(
    public readonly key: 'today' | 'yesterday' | 'older',
    label: string
  ) {
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

class PinnedTreeDragAndDropController implements vscode.TreeDragAndDropController<vscode.TreeItem> {
  readonly dragMimeTypes = ['application/vnd.code.tree.pin-context.pinnedView'];
  readonly dropMimeTypes = [
    'text/uri-list',
    'text/plain',
    'application/vnd.code.tree.explorer',
    'application/vnd.code.tree.pin-context.pinnedView',
    'application/vnd.code.files'
  ];

  constructor(
    private readonly pinStore: PinStore,
    private readonly contextStore: ContextStore
  ) {}

  async handleDrag(
    source: readonly vscode.TreeItem[],
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const uris = source
      .map((item) => this.getItemUri(item))
      .filter((uri): uri is vscode.Uri => Boolean(uri))
      .map((uri) => uri.toString());

    if (uris.length === 0) {
      return;
    }

    dataTransfer.set(
      'application/vnd.code.tree.pin-context.pinnedView',
      new vscode.DataTransferItem(JSON.stringify(uris))
    );
  }

  async handleDrop(
    target: vscode.TreeItem | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const uris = await this.extractUris(dataTransfer);
    if (uris.length === 0) {
      return;
    }

    await this.pinStore.pinUris(uris, { showProgress: false });
    const activeContext = this.contextStore.getActiveContext();
    if (activeContext) {
      await this.contextStore.saveCurrentPinsToContext(activeContext.id);
    }
    void vscode.window.showInformationMessage(`Pinned ${uris.length} item(s) via drag and drop`);
  }

  private async extractUris(dataTransfer: vscode.DataTransfer): Promise<vscode.Uri[]> {
    const uriSet = new Map<string, vscode.Uri>();
    const uriList = dataTransfer.get('text/uri-list');
    if (uriList) {
      const value = await uriList.asString();
      for (const uri of this.parseUriList(value)) {
        if (uri.scheme === 'file') {
          uriSet.set(uri.toString(), uri);
        }
      }
    }

    const internal = dataTransfer.get('application/vnd.code.tree.pin-context.pinnedView');
    if (internal) {
      const value = await internal.asString();
      try {
        const items = JSON.parse(value);
        if (Array.isArray(items)) {
          for (const raw of items) {
            if (typeof raw !== 'string') {
              continue;
            }
            try {
              const uri = vscode.Uri.parse(raw);
              if (uri.scheme === 'file') {
                uriSet.set(uri.toString(), uri);
              }
            } catch {}
          }
        }
      } catch {}
    }

    const explorerTree = dataTransfer.get('application/vnd.code.tree.explorer');
    if (explorerTree) {
      let value: string;

      try {
        value = await explorerTree.asString();
      } catch {
        value = '';
      }

      if (!value && (explorerTree as any)?.value) {
        value = String((explorerTree as any).value);
      }

      if (value) {
        this.extractUrisFromUnknownPayload(value).forEach((uri) => {
          if (uri.scheme === 'file') {
            uriSet.set(uri.toString(), uri);
          }
        });
      }
    }

    const codeFiles = dataTransfer.get('application/vnd.code.files');
    if (codeFiles) {
      let value: string;

      try {
        value = await codeFiles.asString();
      } catch {
        value = '';
      }

      if (!value && (codeFiles as any)?.value) {
        value = String((codeFiles as any).value);
      }

      if (value) {
        this.extractUrisFromUnknownPayload(value).forEach((uri) => {
          if (uri.scheme === 'file') {
            uriSet.set(uri.toString(), uri);
          }
        });
      }
    }

    const plainText = dataTransfer.get('text/plain');
    if (plainText) {
      const value = await plainText.asString();
      for (const uri of this.parseUriList(value)) {
        if (uri.scheme === 'file') {
          uriSet.set(uri.toString(), uri);
        }
      }
    }

    return [...uriSet.values()];
  }

  private getItemUri(item: vscode.TreeItem): vscode.Uri | undefined {
    if (item instanceof PinnedFileItem || item instanceof PinnedListItem) {
      return item.uri;
    }
    return undefined;
  }

  private parseUriList(raw: string): vscode.Uri[] {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => {
        try {
          return vscode.Uri.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter((uri): uri is vscode.Uri => Boolean(uri));
  }

  private extractUrisFromUnknownPayload(raw: string): vscode.Uri[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.extractUrisFromUnknownValue(parsed);
    } catch {
      try {
        return [vscode.Uri.parse(raw)];
      } catch {
        return [];
      }
    }
  }

  private extractUrisFromUnknownValue(value: unknown): vscode.Uri[] {
    const uris: vscode.Uri[] = [];
    const visit = (candidate: unknown): void => {
      if (!candidate) {
        return;
      }

      if (typeof candidate === 'string') {
        try {
          uris.push(vscode.Uri.parse(candidate));
        } catch {}
        return;
      }

      if (Array.isArray(candidate)) {
        candidate.forEach((item) => visit(item));
        return;
      }

      if (typeof candidate === 'object') {
        const record = candidate as Record<string, unknown>;
        if (typeof record.resourceUri === 'string') {
          visit(record.resourceUri);
        }
        if (typeof record.uri === 'string') {
          visit(record.uri);
        }
        if (typeof record.fsPath === 'string') {
          try {
            uris.push(vscode.Uri.file(record.fsPath));
          } catch {}
        }
        Object.values(record).forEach((item) => visit(item));
      }
    };

    visit(value);
    return uris;
  }
}

export class PinnedTreeViewProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private pinnedItems: PinRecord[] = [];
  private viewMode: 'tree' | 'list' = 'tree';
  private readonly storeDisposable: vscode.Disposable;
  private readonly contextDisposable: vscode.Disposable;
  private folderCache = new Map<string, PinRecord[]>();
  private readonly pinnedFilesSection = new ContextSectionItem('Pinned Files', 'pinnedFiles');
  private readonly contextsSection = new ContextSectionItem('Contexts', 'contexts');
  private readonly timelineSection = new ContextSectionItem('Recent Contexts', 'timeline');
  readonly dragAndDropController: vscode.TreeDragAndDropController<vscode.TreeItem>;

  constructor(
    private readonly pinStore: PinStore,
    private readonly contextStore: ContextStore
  ) {
    this.loadPinnedItems();
    this.storeDisposable = this.pinStore.onDidChange(() => this.refresh());
    this.contextDisposable = this.contextStore.onDidChange(() => this.refresh());
    this.dragAndDropController = new PinnedTreeDragAndDropController(
      this.pinStore,
      this.contextStore
    );
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
    this.pinStore.syncWithOpenTabs();
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
      return [this.pinnedFilesSection, this.contextsSection, this.timelineSection];
    }

    if (element instanceof ContextSectionItem) {
      if (element.section === 'contexts') {
        const activeId = this.contextStore.getActiveContext()?.id;
        const contexts = this.contextStore
          .getAllContexts()
          .map((context) => new ContextItem(context, context.id === activeId));
        if (contexts.length > 0) {
          return contexts;
        }

        if (this.pinnedItems.length > 0) {
          return [new EmptyContextsItem(), new SavePinnedAsContextHintItem()];
        }

        return [new EmptyContextsItem()];
      }

      if (element.section === 'timeline') {
        const buckets = this.contextStore.getTimelineBuckets();
        const headers: TimelineHeaderItem[] = [];
        if (buckets.today.length > 0) headers.push(new TimelineHeaderItem('today', 'Today'));
        if (buckets.yesterday.length > 0)
          headers.push(new TimelineHeaderItem('yesterday', 'Yesterday'));
        if (buckets.older.length > 0) headers.push(new TimelineHeaderItem('older', 'Older'));
        return headers.length > 0
          ? headers
          : [new vscode.TreeItem('No recent contexts', vscode.TreeItemCollapsibleState.None)];
      }

      if (this.pinnedItems.length === 0) {
        return [new EmptyPinnedItem()];
      }
      if (this.viewMode === 'list') {
        return this.pinnedItems.map(
          (item) => new PinnedListItem(item.uri, item.label, item.folder)
        );
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
      const entries =
        element.key === 'today'
          ? buckets.today
          : element.key === 'yesterday'
            ? buckets.yesterday
            : buckets.older;
      return entries.map((entry) => new TimelineEntryItem(entry));
    }

    if (element instanceof PinnedFolderItem) {
      const folderFiles = this.folderCache.get(element.folderPath) ?? [];
      const fileItems = folderFiles.map((file) => new PinnedFileItem(file.uri, file.label));
      fileItems.sort((a, b) => a.fileName.localeCompare(b.fileName));
      return fileItems;
    }

    return [];
  }

  async unpinFile(uri: vscode.Uri): Promise<void> {
    await this.pinStore.unpinUri(uri);
  }
}
