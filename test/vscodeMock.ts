/* Minimal in-memory stand-in for the `vscode` module, enough to run the extension logic. */

type Listener<T> = (e: T) => unknown;

export class Disposable {
  constructor(private readonly fn: () => void = () => {}) {}
  dispose(): void {
    this.fn();
  }
}

export class EventEmitter<T> {
  private listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value?: T): void {
    for (const l of [...this.listeners]) l(value as T);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string
  ) {}
  static file(p: string): Uri {
    return new Uri('file', p.replace(/\\/g, '/'));
  }
  static parse(value: string, strict = false): Uri {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/)?(.*)$/.exec(value);
    if (!m) {
      if (strict) throw new Error('[UriError]: Scheme is missing');
      return new Uri('file', value.startsWith('/') ? value : `/${value}`);
    }
    return new Uri(m[1], m[2].startsWith('/') ? m[2] : `/${m[2]}`);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = segments.reduce(
      (acc, segment) => {
        const clean = String(segment).replace(/^\/+/, '');
        return clean ? `${acc}/${clean}` : acc;
      },
      base.path.replace(/\/+$/, '')
    );
    return new Uri(base.scheme, joined);
  }
  get fsPath(): string {
    return this.path;
  }
  with(change: { path?: string }): Uri {
    return new Uri(this.scheme, change.path ?? this.path);
  }
  toString(_skipEncoding?: boolean): string {
    return `${this.scheme}://${this.path}`;
  }
}

export class FileSystemError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

export class TabInputText {
  constructor(readonly uri: Uri) {}
}
export class TabInputTextDiff {
  constructor(
    readonly original: Uri,
    readonly modified: Uri
  ) {}
}
export class TabInputNotebook {
  constructor(readonly uri: Uri) {}
}
export class TabInputNotebookDiff {}
export class TabInputCustom {
  constructor(readonly uri: Uri) {}
}
export class TabInputWebview {}
export class TabInputTerminal {}

export enum ViewColumn {
  One = 1
}
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}
export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  command?: unknown;
  resourceUri?: Uri;
  constructor(
    public label: string,
    public collapsibleState?: TreeItemCollapsibleState
  ) {}
}
export class ThemeIcon {
  static File = new ThemeIcon('file');
  constructor(readonly id: string) {}
}
export class DataTransferItem {
  constructor(readonly value: unknown) {}
  async asString(): Promise<string> {
    return String(this.value);
  }
}
export enum QuickPickItemKind {
  Separator = -1
}
export enum StatusBarAlignment {
  Right = 2
}
export enum ProgressLocation {
  Notification = 15
}
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3
}
export enum FileType {
  File = 1,
  Directory = 2
}
export class CancellationTokenSource {
  private cancelled = false;
  readonly token = {
    get isCancellationRequested(): boolean {
      return false;
    }
  } as { isCancellationRequested: boolean };
  constructor() {
    const self = this;
    Object.defineProperty(this.token, 'isCancellationRequested', { get: () => self.cancelled });
  }
  cancel(): void {
    this.cancelled = true;
  }
  dispose(): void {}
}

// ---- Fake window / tabs ----------------------------------------------------------------

interface FakeTab {
  input: unknown;
  isPinned: boolean;
  group: { viewColumn: ViewColumn };
}

const tabGroup = {
  viewColumn: ViewColumn.One,
  tabs: [] as FakeTab[],
  activeTab: undefined as FakeTab | undefined
};
const tabsChanged = new EventEmitter<void>();
const windowState = new EventEmitter<{ focused: boolean }>();

const tabUri = (tab: FakeTab): string => (tab.input as TabInputText).uri.toString();

function notifyTabs(): void {
  setImmediate(() => tabsChanged.fire());
}

const settingsDefaults: Record<string, unknown> = {
  viewMode: 'tree',
  showPinnedCountInStatusBar: true,
  persistenceScope: 'workspaceState',
  restoreBehavior: 'keepInTree',
  batchSize: 8,
  'contexts.autoGitContexts': true,
  'contexts.restoreLastContext': false,
  'contexts.timelineEnabled': true,
  'contexts.maxTimelineEntries': 100,
  'contexts.persistenceScope': 'workspaceState',
  'contexts.autoSwitchOnGitBranchChange': true
};

export const testHarness = {
  messages: [] as string[],
  inputBoxAnswers: [] as string[],
  // Scripted answers for the pickers/dialogs; each call shifts one off.
  quickPickAnswers: [] as unknown[],
  openDialogAnswers: [] as (Uri | undefined)[][],
  saveDialogAnswers: [] as (Uri | undefined)[],
  findFilesAnswers: [] as Uri[][],
  clipboardReads: [] as string[],
  clipboardWrites: [] as string[],
  // In-memory file system: writtenFiles mirrors readableFiles so export→import round-trips work.
  readableFiles: new Map<string, string>(),
  writtenFiles: new Map<string, string>(),
  fsWrites: [] as string[],
  openFiles: new Set<string>(),
  // `setContext` calls recorded as key → last value, so menu context keys are assertable.
  contextKeys: new Map<string, unknown>(),
  activeEditorChanged: new EventEmitter<{ textEditor: unknown }>(),
  // All registered commands, including internal ones like `pin-context.pinnedResourceState`.
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  fireActiveEditorChange(): void {
    setImmediate(() => this.activeEditorChanged.fire({ textEditor: undefined }));
  },
  workspaceRoot: '/ws',
  settings: { ...settingsDefaults },
  reset(): void {
    tabGroup.tabs.length = 0;
    tabGroup.activeTab = undefined;
    // A stale `isPinned` from the previous test would leak through early assertions.
    this.contextKeys.set('pin-context.isPinned', false);
    this.contextKeys.set('pin-context.hasActiveEditor', false);
    this.messages.length = 0;
    this.inputBoxAnswers.length = 0;
    this.quickPickAnswers.length = 0;
    this.openDialogAnswers.length = 0;
    this.saveDialogAnswers.length = 0;
    this.findFilesAnswers.length = 0;
    this.clipboardReads.length = 0;
    this.clipboardWrites.length = 0;
    this.readableFiles.clear();
    this.writtenFiles.clear();
    this.fsWrites.length = 0;
    this.contextKeys.clear();
    this.commands.clear();
    Object.assign(this.settings, settingsDefaults);
  },
  openTab(uri: Uri, pinned = false): void {
    const tab: FakeTab = { input: new TabInputText(uri), isPinned: pinned, group: tabGroup };
    tabGroup.tabs.push(tab);
    tabGroup.activeTab = tab;
    notifyTabs();
  },
  pinnedUris(): string[] {
    return tabGroup.tabs
      .filter((t) => t.isPinned)
      .map(tabUri)
      .sort();
  },
  allUris(): string[] {
    return tabGroup.tabs.map(tabUri).sort();
  },
  activeUri(): string | undefined {
    return tabGroup.activeTab ? tabUri(tabGroup.activeTab) : undefined;
  },
  closeTab(uri: Uri): void {
    const i = tabGroup.tabs.findIndex((t) => tabUri(t) === uri.toString());
    if (i >= 0) {
      const [removed] = tabGroup.tabs.splice(i, 1);
      if (tabGroup.activeTab === removed)
        tabGroup.activeTab = tabGroup.tabs[tabGroup.tabs.length - 1];
      notifyTabs();
    }
  },
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  gitRoot: undefined as string | undefined,
  // Fake `vscode.git` API surface. Undefined by default: getExtension('vscode.git')
  // returns undefined and consumers fall back to the git CLI, like a VS Code without
  // the git extension.
  gitApi: undefined as unknown,
  gitExtensionById(id: string): { activate(): Promise<unknown> } | undefined {
    if (id !== 'vscode.git' || !this.gitApi) {
      return undefined;
    }
    const api = this.gitApi;
    return {
      activate: async () => ({
        enabled: true,
        getAPI: () => api
      })
    };
  }
};

const commands = {
  registerCommand(id: string, fn: (...args: unknown[]) => unknown): Disposable {
    testHarness.registeredCommands.set(id, fn);
    testHarness.commands.set(id, fn);
    return new Disposable(() => testHarness.registeredCommands.delete(id));
  },
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    if (id === 'setContext') {
      testHarness.contextKeys.set(args[0] as string, args[1]);
      return undefined;
    }
    if (id === 'vscode.open') {
      const uri = args[0] as Uri;
      const existing = tabGroup.tabs.find((t) => tabUri(t) === uri.toString());
      if (existing) {
        tabGroup.activeTab = existing;
      } else {
        testHarness.openTab(uri);
      }
      notifyTabs();
      return undefined;
    }
    if (id === 'workbench.action.pinEditor' || id === 'workbench.action.unpinEditor') {
      if (tabGroup.activeTab)
        tabGroup.activeTab.isPinned = id.endsWith('pinEditor') && !id.includes('unpin');
      notifyTabs();
      return undefined;
    }
    const registered = testHarness.registeredCommands.get(id);
    if (registered) return registered(...args);
    return undefined;
  }
};

const resolved = (): Promise<undefined> => Promise.resolve(undefined);
const record =
  (prefix: string) =>
  (message: string): Promise<undefined> => {
    testHarness.messages.push(`${prefix}: ${message}`);
    return resolved();
  };

export const window = {
  tabGroups: {
    get all() {
      return [tabGroup];
    },
    get activeTabGroup() {
      return tabGroup;
    },
    onDidChangeTabs: tabsChanged.event,
    onDidChangeTabGroups: new EventEmitter<unknown>().event
  },
  state: { focused: false },
  activeTextEditor: undefined,
  onDidChangeActiveTextEditor: testHarness.activeEditorChanged.event,
  onDidChangeWindowState: windowState.event,
  createTreeView: (_id: string, _opts: unknown) => ({ title: '', dispose() {} }),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: '',
    show() {},
    hide() {},
    dispose() {}
  }),
  createOutputChannel: () => ({
    info() {},
    warn() {},
    error(m: string) {
      testHarness.messages.push(`log-error: ${m}`);
    },
    dispose() {}
  }),
  showInformationMessage: record('info'),
  showWarningMessage: record('warn'),
  showErrorMessage: record('error'),
  showInputBox: async () => testHarness.inputBoxAnswers.shift(),
  showQuickPick: async (items?: unknown) => {
    const answer = testHarness.quickPickAnswers.shift();
    if (typeof answer === 'function') {
      return answer(items);
    }
    return answer;
  },
  showOpenDialog: async () => {
    const answer = testHarness.openDialogAnswers.shift();
    return answer;
  },
  // Mirrors the real API: resolves to the picked Uri itself, not a wrapper object.
  showSaveDialog: async () => testHarness.saveDialogAnswers.shift(),
  withProgress: async (_o: unknown, cb: (p: { report(): void }) => unknown) => cb({ report() {} })
};

export const workspace = {
  isTrusted: true,
  get workspaceFolders() {
    return [{ uri: Uri.file(testHarness.workspaceRoot), name: 'ws', index: 0 }];
  },
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, fallback?: T): T =>
      (key in testHarness.settings ? testHarness.settings[key] : fallback) as T,
    inspect: () => undefined,
    update: async () => undefined
  }),
  onDidChangeConfiguration: new EventEmitter<unknown>().event,
  onDidChangeWorkspaceFolders: new EventEmitter<unknown>().event,
  onDidGrantWorkspaceTrust: new EventEmitter<unknown>().event,
  onDidDeleteFiles: new EventEmitter<{ files: Uri[] }>().event,
  onDidRenameFiles: new EventEmitter<unknown>().event,
  findFiles: async () => testHarness.findFilesAnswers.shift() ?? ([] as Uri[]),
  asRelativePath: (v: Uri | string) => (typeof v === 'string' ? v : v.path),
  fs: {
    async stat(uri: Uri) {
      const text = testHarness.readableFiles.get(uri.fsPath);
      if (text !== undefined) {
        return {
          type: FileType.File,
          ctime: 0,
          mtime: 0,
          size: Buffer.byteLength(text, 'utf8')
        };
      }
      if (uri.path.includes('/missing')) throw new FileSystemError('not found', 'FileNotFound');
      return { type: uri.path.endsWith('/dir') ? FileType.Directory : FileType.File };
    },
    async readFile(uri: Uri) {
      const text = testHarness.readableFiles.get(uri.fsPath);
      if (text === undefined) throw new FileSystemError('not found', 'FileNotFound');
      return new Uint8Array(Buffer.from(text, 'utf8'));
    },
    async writeFile(uri: Uri, content: Uint8Array) {
      const text = Buffer.from(content).toString('utf8');
      testHarness.readableFiles.set(uri.fsPath, text);
      testHarness.writtenFiles.set(uri.fsPath, text);
      testHarness.fsWrites.push(uri.fsPath);
    },
    async createDirectory() {
      return undefined;
    },
    async delete(uri: Uri) {
      testHarness.readableFiles.delete(uri.fsPath);
    }
  }
};

export { commands };
export const env = {
  clipboard: {
    writeText: async (value: string) => {
      testHarness.clipboardWrites.push(value);
    },
    readText: async () => testHarness.clipboardReads.shift() ?? ''
  }
};
export const l10n = {
  // Mirrors VS Code: the English source string is the key, arguments fill `{n}` slots.
  t: (message: string, ...args: Array<string | number>): string =>
    args.length > 0
      ? message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]))
      : message
};
export const extensions = {
  getExtension: (id: string) => testHarness.gitExtensionById(id)
};

export function createExtensionContext() {
  const memento = () => {
    const store = new Map<string, unknown>();
    return {
      store,
      get: <T>(key: string, fallback?: T): T =>
        store.has(key) ? (store.get(key) as T) : (fallback as T),
      update: async (key: string, value: unknown) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
      keys: () => [...store.keys()]
    };
  };
  return {
    subscriptions: [] as { dispose(): unknown }[],
    globalState: memento(),
    workspaceState: memento()
  };
}
