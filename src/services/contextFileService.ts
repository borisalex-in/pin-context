import * as vscode from 'vscode';
import { ContextEditorState, ContextOpenTab, PinContext } from '../types';
import { parseUri } from '../utils/tabUtils';
import { logger } from '../utils/logger';
import { t } from '../l10n';
import { sanitizeSnapshot } from './contextPersistenceService';

/** Shared context file, so a team can keep contexts in the repository. */
export const REPO_CONTEXTS_FILE = '.vscode/pin-contexts.json';
const FILE_VERSION = 1;
const SEP = '/';
// Windows separator as a constant: the helpers below stay free of escape sequences.
const BACKSLASH = String.fromCharCode(92);
// These are the same resource schemes that the extension can track and restore.
// In particular, do not let an imported context open command:, javascript:, http:, etc.
const ALLOWED_URI_SCHEMES = new Set(['file', 'vscode-remote', 'vscode-vfs', 'vscode-userdata']);

interface ContextFileLocation {
  path?: string;
  uri?: string;
}

interface ContextFileEditorState extends ContextFileLocation {
  line: number;
  character: number;
  scrollLine?: number;
}

interface ContextFileOpenTab extends ContextFileLocation {
  group: number;
  active?: boolean;
}

interface ContextFileEntry {
  name: string;
  paths?: string[];
  pinnedUris?: string[];
  editorStates?: ContextFileEditorState[];
  openTabs?: ContextFileOpenTab[];
}

interface ContextFile {
  version: number;
  contexts: ContextFileEntry[];
}

function toPosix(value: string): string {
  return value.split(BACKSLASH).join(SEP);
}

/** Workspace folder that owns a path (sub-folders of a multi-root workspace included). */
function folderFor(fsPath: string): vscode.WorkspaceFolder | undefined {
  const path = toPosix(fsPath);
  let best: vscode.WorkspaceFolder | undefined;

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = toPosix(folder.uri.fsPath);
    const owns = path === root || path.startsWith(`${root}${SEP}`);
    const bestRoot = best ? toPosix(best.uri.fsPath) : '';
    if (owns && (!best || root.length > bestRoot.length)) {
      best = folder;
    }
  }
  return best;
}

/**
 * Stores a file URI as a workspace-relative path when possible: an absolute path such as
 * "/home/dev/project/src/a.ts" is useless on a teammate's machine.
 */
function toRef(uriValue: string, base: vscode.Uri | undefined): string {
  const uri = parseUri(uriValue);
  if (!uri || uri.scheme !== 'file') {
    return uriValue;
  }

  const root = base ?? folderFor(uri.fsPath)?.uri;
  if (!root) {
    return uriValue;
  }

  const path = toPosix(uri.fsPath);
  const rootPath = toPosix(root.fsPath);
  if (!path.startsWith(`${rootPath}${SEP}`) || path.length <= rootPath.length + 1) {
    return uriValue;
  }
  return path.slice(rootPath.length + 1);
}

function fromRef(ref: string, base: vscode.Uri): string | undefined {
  if (typeof ref !== 'string' || !ref.trim()) {
    return undefined;
  }

  const direct = parseUri(ref);
  if (direct && direct.scheme) {
    return ALLOWED_URI_SCHEMES.has(direct.scheme.toLowerCase()) ? direct.toString() : undefined;
  }

  // Relative references are intended to be portable paths within the repository.
  // Reject traversal segments before joining so a hand-edited file cannot escape its base.
  const normalizedRef = toPosix(ref.trim());
  const parts = normalizedRef.split(SEP).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  if (parts.some((part) => part === '.' || part === '..')) {
    return undefined;
  }
  if (!ALLOWED_URI_SCHEMES.has(base.scheme.toLowerCase())) {
    return undefined;
  }
  return vscode.Uri.joinPath(base, ...parts).toString();
}

function toEditorStates(
  states: ContextEditorState[] | undefined,
  base: vscode.Uri | undefined
): ContextFileEditorState[] | undefined {
  if (!states || states.length === 0) {
    return undefined;
  }
  return states.map((state) => {
    const entry: ContextFileEditorState = {
      path: toRef(state.uri, base),
      line: state.line,
      character: state.character
    };
    if (state.scrollLine !== undefined) {
      entry.scrollLine = state.scrollLine;
    }
    return entry;
  });
}

function toOpenTabs(
  tabs: ContextOpenTab[] | undefined,
  base: vscode.Uri | undefined
): ContextFileOpenTab[] | undefined {
  if (!tabs || tabs.length === 0) {
    return undefined;
  }
  return tabs.map((tab) => {
    const entry: ContextFileOpenTab = { path: toRef(tab.uri, base), group: tab.group };
    if (tab.active) {
      entry.active = true;
    }
    return entry;
  });
}

function fromEditorStates(
  raw: ContextFileEditorState[] | undefined,
  base: vscode.Uri
): ContextEditorState[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const states = raw.flatMap((item): ContextEditorState[] => {
    const ref = item?.path ?? item?.uri;
    const resolved = ref ? fromRef(ref, base) : undefined;
    if (!resolved || !Number.isFinite(item.line)) {
      return [];
    }
    const state: ContextEditorState = {
      uri: resolved,
      line: Math.max(0, Math.floor(item.line)),
      character: Math.max(0, Math.floor(Number(item.character) || 0))
    };
    if (Number.isFinite(item.scrollLine)) {
      state.scrollLine = Math.max(0, Math.floor(item.scrollLine as number));
    }
    return [state];
  });
  return states.length > 0 ? states : undefined;
}

function fromOpenTabs(
  raw: ContextFileOpenTab[] | undefined,
  base: vscode.Uri
): ContextOpenTab[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const tabs = raw.flatMap((item): ContextOpenTab[] => {
    const ref = item?.path ?? item?.uri;
    const resolved = ref ? fromRef(ref, base) : undefined;
    if (!resolved) {
      return [];
    }
    const tab: ContextOpenTab = {
      uri: resolved,
      group: Math.max(0, Math.floor(Number(item.group) || 0))
    };
    if (item.active === true) {
      tab.active = true;
    }
    return [tab];
  });
  return tabs.length > 0 ? tabs : undefined;
}

/** Serialises contexts to the shared JSON format. */
export function serializeContexts(contexts: PinContext[], base?: vscode.Uri): string {
  const file: ContextFile = {
    version: FILE_VERSION,
    contexts: contexts.map((context) => ({
      name: context.name,
      paths: context.pinnedUris.map((uri) => toRef(uri, base)),
      editorStates: toEditorStates(context.editorStates, base),
      openTabs: toOpenTabs(context.openTabs, base)
    }))
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Parses the shared JSON format. Contexts go through the same sanitizer as persisted state,
 * so a hand-edited file cannot smuggle unexpected values into the store.
 */
export function parseContexts(raw: string, base: vscode.Uri): PinContext[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn(`Context file is not valid JSON: ${String(error)}`);
    return [];
  }

  const entries =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Partial<ContextFile>).contexts
      : undefined;
  if (!Array.isArray(entries)) {
    logger.warn('Context file has no "contexts" array');
    return [];
  }

  const now = Date.now();
  return entries.flatMap((entry, index): PinContext[] => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.name !== 'string' ||
      !entry.name.trim()
    ) {
      return [];
    }

    const paths = Array.isArray(entry.paths) ? entry.paths : [];
    const pinnedUrisField = Array.isArray(entry.pinnedUris) ? entry.pinnedUris : [];
    if (
      (entry.paths !== undefined && !Array.isArray(entry.paths)) ||
      (entry.pinnedUris !== undefined && !Array.isArray(entry.pinnedUris))
    ) {
      logger.warn(`Skipping invalid path fields in context entry ${index}`);
      return [];
    }

    const pinnedUris = [...paths, ...pinnedUrisField]
      .filter((ref): ref is string => typeof ref === 'string')
      .map((ref) => fromRef(ref, base))
      .filter((uri): uri is string => Boolean(uri));

    const sanitized = sanitizeSnapshot({
      contexts: [{ id: `parsed:${index}`, name: entry.name, pinnedUris }],
      timeline: []
    });
    if (!sanitized || sanitized.contexts.length === 0) {
      return [];
    }

    const context = sanitized.contexts[0];
    return [
      {
        ...context,
        id: `repo:${base.fsPath}:${context.name}`,
        source: 'repo',
        workspaceFolder: base.fsPath,
        editorStates: fromEditorStates(entry.editorStates, base),
        openTabs: fromOpenTabs(entry.openTabs, base),
        createdAt: now,
        updatedAt: now
      }
    ];
  });
}

/** Reads/writes contexts as JSON, including the repository file `.vscode/pin-contexts.json`. */
export class ContextFileService {
  /** Repository context file of every workspace folder of the current window. */
  repoFileUris(): vscode.Uri[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => vscode.Uri.joinPath(folder.uri, '.vscode', 'pin-contexts.json'));
  }

  async loadRepoContexts(): Promise<PinContext[]> {
    if (!this.repoFileEnabled()) {
      return [];
    }

    const results: PinContext[] = [];
    for (const fileUri of this.repoFileUris()) {
      results.push(...(await this.read(fileUri)));
    }
    return results;
  }

  async read(fileUri: vscode.Uri): Promise<PinContext[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      return parseContexts(Buffer.from(bytes).toString('utf8'), this.baseFor(fileUri));
    } catch (error) {
      // A missing file is the normal case; anything else is worth a debug line.
      if (!isFileNotFound(error)) {
        logger.debug(`Could not read context file ${fileUri.fsPath}: ${String(error)}`);
      }
      return [];
    }
  }

  async write(fileUri: vscode.Uri, contexts: PinContext[]): Promise<boolean> {
    try {
      await vscode.workspace.fs.createDirectory(parentDirectory(fileUri));
      const payload = serializeContexts(contexts, this.baseFor(fileUri));
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(payload, 'utf8'));
      return true;
    } catch (error) {
      logger.error(`Failed to write context file ${fileUri.fsPath}`, error);
      void vscode.window.showErrorMessage(t('Pin Context: could not write the context file'));
      return false;
    }
  }

  /** Default target for export: the repository file of the first workspace folder. */
  defaultFileUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, '.vscode', 'pin-contexts.json') : undefined;
  }

  /** Paths are relative to the workspace folder the context file lives in. */
  private baseFor(fileUri: vscode.Uri): vscode.Uri {
    return folderFor(fileUri.fsPath)?.uri ?? parentDirectory(fileUri);
  }

  private repoFileEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('pin-context')
      .get<boolean>('contexts.repoContextsFile', true);
  }
}

function parentDirectory(uri: vscode.Uri): vscode.Uri {
  const parts = uri.path.split(SEP);
  parts.pop();
  return uri.with({ path: parts.length > 0 ? parts.join(SEP) : SEP });
}

function isFileNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /FileNotFound|ENOENT|does not exist|not found/i.test(message);
}
