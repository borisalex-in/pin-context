import * as vscode from 'vscode';
import { t } from '../l10n';
import * as path from 'path';
import { ContextStore } from '../stores/contextStore';
import { ContextTimelineEntry, PinContext } from '../types';
import { PinStore } from '../stores/pinStore';
import { PinRecord, isTrackableUri, parseUri } from '../utils/tabUtils';

type ViewMode = 'tree' | 'list';

const INTERNAL_DRAG_MIME = 'application/vnd.code.tree.pin-context.pinnedView';
const REFRESH_DEBOUNCE_MS = 40;
const MAX_PAYLOAD_DEPTH = 6;

function openPinnedCommand(uri: vscode.Uri): vscode.Command {
  // Opens the file and pins its tab again. A plain `vscode.open` left the tab unpinned.
  return {
    command: 'pin-context.openPinnedFile',
    title: t('Open Pinned File'),
    arguments: [uri]
  };
}

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
    super(path.basename(folderPath) || folderPath, vscode.TreeItemCollapsibleState.Expanded);

    const relative = vscode.workspace.asRelativePath(folderPath);
    const count = t('Files: {0}', fileCount);
    this.id = `pin-folder:${folderPath}`;
    this.description = relative !== path.basename(folderPath) ? `${count} · ${relative}` : count;
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

    this.id = `pin-file:${uri.toString()}`;
    this.iconPath = vscode.ThemeIcon.File;
    this.tooltip = uri.fsPath;
    this.resourceUri = uri;
    this.contextValue = 'pinnedFile';
    this.command = openPinnedCommand(uri);
  }
}

export class PinnedListItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly label: string,
    public readonly folderPath: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.id = `pin-list-file:${uri.toString()}`;
    this.iconPath = vscode.ThemeIcon.File;
    this.tooltip = uri.fsPath;
    this.resourceUri = uri;
    this.contextValue = 'pinnedFile';
    this.description = path.basename(folderPath);
    this.command = openPinnedCommand(uri);
  }
}

class EmptyPinnedItem extends vscode.TreeItem {
  constructor() {
    super(t('No pinned files'), vscode.TreeItemCollapsibleState.None);
    this.id = 'pin-empty';
    this.contextValue = 'pinnedEmpty';
    this.iconPath = new vscode.ThemeIcon('info');
    this.description = t('Pin files to see them here');
    this.command = {
      command: 'pin-context.pinCurrentEditor',
      title: t('Pin Current File')
    };
  }
}

class EmptyContextsItem extends vscode.TreeItem {
  constructor() {
    super(t('No contexts yet'), vscode.TreeItemCollapsibleState.None);
    this.id = 'contexts-empty';
    this.contextValue = 'contextsEmpty';
    this.iconPath = new vscode.ThemeIcon('lightbulb');
    this.description = t('Save current tabs and switch instantly');
    this.tooltip = t(
      'Save your current pinned tabs as a context and restore them instantly when switching tasks.'
    );
    this.command = {
      command: 'pin-context.createContext',
      title: t('Create Context')
    };
  }
}

class SavePinnedAsContextHintItem extends vscode.TreeItem {
  constructor() {
    super(t('Turn pinned files into a context'), vscode.TreeItemCollapsibleState.None);
    this.id = 'contexts-hint';
    this.contextValue = 'contextsHint';
    this.iconPath = new vscode.ThemeIcon('save');
    this.description = t('Capture this setup for fast switching');
    this.tooltip = t('Create a context now to switch back to this exact set of tabs later.');
    this.command = {
      command: 'pin-context.createContext',
      title: t('Create Context')
    };
  }
}

class ContextSectionItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly section: 'active' | 'contexts' | 'timeline' | 'pinnedFiles'
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `section:${section}`;
    this.contextValue = `contextSection:${section}`;
    this.iconPath = new vscode.ThemeIcon('symbol-folder');
  }
}

export class ContextItem extends vscode.TreeItem {
  constructor(
    public readonly context: PinContext,
    active: boolean
  ) {
    super(context.name, vscode.TreeItemCollapsibleState.None);

    const parts: string[] = [];
    parts.push(
      active
        ? t('Active')
        : context.source === 'git'
          ? t('Git context')
          : context.source === 'repo'
            ? t('Repository context')
            : t('Manual context')
    );
    if (context.source === 'git' && (context.changed || context.staged)) {
      parts.push(
        t('Git context · changed: {0}, staged: {1}', context.changed ?? 0, context.staged ?? 0)
      );
    }

    this.id = `context:${context.id}`;
    this.description = parts.join(' · ');
    this.tooltip = `${context.name}\n${t('Pinned files: {0}', context.pinnedUris.length)}`;
    // Git contexts cannot be renamed or deleted, so they get a different contextValue
    // that the menus can target.
    this.contextValue = context.source === 'git' ? 'pinContextGit' : 'pinContext';
    this.iconPath = new vscode.ThemeIcon(active ? 'check' : 'bookmark');
    this.command = {
      command: 'pin-context.switchContextById',
      title: t('Switch Context'),
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
    this.id = `timeline:${key}`;
    this.contextValue = 'timelineHeader';
    this.iconPath = new vscode.ThemeIcon('history');
  }
}

class TimelineEntryItem extends vscode.TreeItem {
  constructor(public readonly entry: ContextTimelineEntry) {
    super(entry.contextName, vscode.TreeItemCollapsibleState.None);
    this.id = `timeline-entry:${entry.id}`;
    this.description = entry.action;
    this.tooltip = new Date(entry.timestamp).toLocaleString();
    this.contextValue = 'timelineEntry';
    this.command = {
      command: 'pin-context.switchContextById',
      title: t('Switch Context'),
      arguments: [entry.contextId]
    };
  }
}

class PinnedTreeDragAndDropController implements vscode.TreeDragAndDropController<vscode.TreeItem> {
  readonly dragMimeTypes = [INTERNAL_DRAG_MIME];
  readonly dropMimeTypes = [
    'text/uri-list',
    'text/plain',
    'application/vnd.code.tree.explorer',
    INTERNAL_DRAG_MIME,
    'application/vnd.code.files'
  ];

  constructor(private readonly pinStore: PinStore) {}

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

    dataTransfer.set(INTERNAL_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify(uris)));
  }

  async handleDrop(
    _target: vscode.TreeItem | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const uris = await this.extractUris(dataTransfer);
    if (uris.length === 0) {
      return;
    }

    // Context sync happens automatically through pinStore events; the explicit
    // "save to context" call that used to be here only spammed the timeline.
    const result = await this.pinStore.pinUris(uris, { showProgress: false, openIfClosed: true });

    if (result.success === 0 && result.failed === 0) {
      void vscode.window.showInformationMessage(
        t('Nothing to pin (folders and missing files are skipped)')
      );
      return;
    }
    const failed = result.failed > 0 ? t('; failed: {0}', result.failed) : '';
    void vscode.window.showInformationMessage(
      t('Pin operation completed. Successfully pinned: {0}{1}', result.success, failed)
    );
  }

  private async extractUris(dataTransfer: vscode.DataTransfer): Promise<vscode.Uri[]> {
    const uriSet = new Map<string, vscode.Uri>();
    const add = (uri: vscode.Uri | undefined): void => {
      if (uri && uri.scheme === 'file' && isTrackableUri(uri)) {
        uriSet.set(uri.toString(), uri);
      }
    };

    const readString = async (mime: string): Promise<string> => {
      const item = dataTransfer.get(mime);
      if (!item) {
        return '';
      }
      try {
        const value = await item.asString();
        if (value) {
          return value;
        }
      } catch {
        // fall through to the raw value below
      }
      const raw = (item as { value?: unknown }).value;
      return typeof raw === 'string' ? raw : '';
    };

    for (const uri of this.parseUriList(await readString('text/uri-list'))) {
      add(uri);
    }

    const internal = await readString(INTERNAL_DRAG_MIME);
    if (internal) {
      try {
        const items: unknown = JSON.parse(internal);
        if (Array.isArray(items)) {
          for (const raw of items) {
            if (typeof raw === 'string') {
              add(parseUri(raw));
            }
          }
        }
      } catch {
        // malformed internal payload: ignore
      }
    }

    for (const mime of ['application/vnd.code.tree.explorer', 'application/vnd.code.files']) {
      const value = await readString(mime);
      if (value) {
        this.extractUrisFromUnknownPayload(value).forEach(add);
      }
    }

    // Plain text is only accepted when it clearly is a file reference. Previously any
    // dropped text (e.g. "hello") was parsed as `file:///hello` and got pinned.
    for (const uri of this.parseUriList(await readString('text/plain'))) {
      add(uri);
    }

    return [...uriSet.values()];
  }

  private getItemUri(item: vscode.TreeItem): vscode.Uri | undefined {
    if (item instanceof PinnedFileItem || item instanceof PinnedListItem) {
      return item.uri;
    }
    return undefined;
  }

  private parseLine(line: string): vscode.Uri | undefined {
    if (/^file:/i.test(line)) {
      return parseUri(line);
    }
    if (path.isAbsolute(line)) {
      return vscode.Uri.file(line);
    }
    return undefined;
  }

  private parseUriList(raw: string): vscode.Uri[] {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => this.parseLine(line))
      .filter((uri): uri is vscode.Uri => Boolean(uri));
  }

  private extractUrisFromUnknownPayload(raw: string): vscode.Uri[] {
    try {
      return this.extractUrisFromUnknownValue(JSON.parse(raw) as unknown);
    } catch {
      return this.parseUriList(raw);
    }
  }

  private extractUrisFromUnknownValue(value: unknown): vscode.Uri[] {
    const uris: vscode.Uri[] = [];
    const visit = (candidate: unknown, depth: number): void => {
      if (!candidate || depth > MAX_PAYLOAD_DEPTH) {
        return;
      }

      if (typeof candidate === 'string') {
        const uri = this.parseLine(candidate.trim());
        if (uri) {
          uris.push(uri);
        }
        return;
      }

      if (Array.isArray(candidate)) {
        candidate.forEach((item) => visit(item, depth + 1));
        return;
      }

      if (typeof candidate === 'object') {
        const record = candidate as Record<string, unknown>;
        if (typeof record.fsPath === 'string' && path.isAbsolute(record.fsPath)) {
          uris.push(vscode.Uri.file(record.fsPath));
        }
        Object.values(record).forEach((item) => visit(item, depth + 1));
      }
    };

    visit(value, 0);
    return uris;
  }
}

export class PinnedTreeViewProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private pinnedItems: PinRecord[] = [];
  private viewMode: ViewMode = 'tree';
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private folderCache = new Map<string, PinRecord[]>();
  private readonly pinnedFilesSection = new ContextSectionItem(t('Pinned Files'), 'pinnedFiles');
  private readonly contextsSection = new ContextSectionItem(t('Contexts'), 'contexts');
  private readonly timelineSection = new ContextSectionItem(t('Recent Contexts'), 'timeline');
  readonly dragAndDropController: vscode.TreeDragAndDropController<vscode.TreeItem>;

  constructor(
    private readonly pinStore: PinStore,
    private readonly contextStore: ContextStore
  ) {
    this.viewMode = this.readViewMode();
    this.loadPinnedItems();

    this.disposables.push(
      this.pinStore.onDidChange(() => this.refresh()),
      this.contextStore.onDidChange(() => this.refresh()),
      // Changing `pin-context.viewMode` in the settings UI used to have no effect until reload.
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pin-context.viewMode')) {
          this.viewMode = this.readViewMode();
          this.refresh();
        }
      })
    );
    this.dragAndDropController = new PinnedTreeDragAndDropController(this.pinStore);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
  }

  /** Coalesces bursts of pin/context events into a single tree refresh. */
  refresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.loadPinnedItems();
      this._onDidChangeTreeData.fire();
    }, REFRESH_DEBOUNCE_MS);
  }

  private readViewMode(): ViewMode {
    const mode = vscode.workspace.getConfiguration('pin-context').get<string>('viewMode', 'tree');
    return mode === 'list' ? 'list' : 'tree';
  }

  private loadPinnedItems(): void {
    // No `syncWithOpenTabs()` here: PinStore already tracks tabs through events, and
    // forcing a sync in the middle of a pin/unpin batch dropped records.
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
        if (buckets.today.length > 0) headers.push(new TimelineHeaderItem('today', t('Today')));
        if (buckets.yesterday.length > 0)
          headers.push(new TimelineHeaderItem('yesterday', t('Yesterday')));
        if (buckets.older.length > 0) headers.push(new TimelineHeaderItem('older', t('Older')));
        if (headers.length > 0) {
          return headers;
        }
        const empty = new vscode.TreeItem(
          t('No recent contexts'),
          vscode.TreeItemCollapsibleState.None
        );
        empty.id = 'timeline-empty';
        return [empty];
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
