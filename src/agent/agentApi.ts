import * as path from 'node:path';
import * as vscode from 'vscode';
import { ContextStore } from '../stores/contextStore';
import { PinStore } from '../stores/pinStore';
import { PinContext } from '../types';
import { logger } from '../utils/logger';
import { t } from '../l10n';
import { canRelyOnHostApproval } from './approvalPolicy';
import { AGENT_TOOL_DEFINITIONS, getAgentToolDefinition } from './toolDefinitions';
import {
  PinContextAgentApi,
  PinContextAgentContextSummary,
  PinContextAgentFile,
  PinContextAgentStatus,
  PinContextAgentToolName
} from './publicApi';

type InvocationOrigin = 'mcp' | 'extension-api' | 'vscode-mcp';
interface InvocationOptions {
  origin?: InvocationOrigin;
  /** The in-editor MCP host displays a confirmation for each tool not marked read-only. */
  approvedByHost?: boolean;
  /** Destructive operations always keep Pin Context's own confirmation, even if the host is trusted. */
  requireOwnConfirmation?: boolean;
}

type FileDto = PinContextAgentFile;

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwnKey(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireString(input: Record<string, unknown>, key: string, maxLength = 4096): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(
      `Expected “${key}” to be a non-empty string of at most ${maxLength} characters.`
    );
  }
  return value.trim();
}

function validateToolInput(input: Record<string, unknown>, schema: Record<string, unknown>): void {
  const properties = isObject(schema.properties) ? schema.properties : {};
  if (schema.additionalProperties === false) {
    const unexpected = Object.keys(input).filter((key) => !hasOwnKey(properties, key));
    if (unexpected.length > 0) {
      throw new Error(`Unexpected tool input fields: ${unexpected.join(', ')}.`);
    }
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  for (const key of required) {
    if (!hasOwnKey(input, key)) throw new Error(`Missing required tool input field: ${key}.`);
  }

  for (const [key, propertyValue] of Object.entries(properties)) {
    if (!hasOwnKey(input, key) || !isObject(propertyValue)) continue;
    const value = input[key];
    const type = propertyValue.type;
    if (type === 'string') {
      if (typeof value !== 'string') throw new Error(`Tool input field “${key}” must be a string.`);
      if (typeof propertyValue.minLength === 'number' && value.length < propertyValue.minLength) {
        throw new Error(`Tool input field “${key}” is too short.`);
      }
      if (typeof propertyValue.maxLength === 'number' && value.length > propertyValue.maxLength) {
        throw new Error(`Tool input field “${key}” is too long.`);
      }
    } else if (type === 'array') {
      if (!Array.isArray(value)) throw new Error(`Tool input field “${key}” must be an array.`);
      if (typeof propertyValue.minItems === 'number' && value.length < propertyValue.minItems) {
        throw new Error(`Tool input field “${key}” has too few items.`);
      }
      if (typeof propertyValue.maxItems === 'number' && value.length > propertyValue.maxItems) {
        throw new Error(`Tool input field “${key}” has too many items.`);
      }
      const itemSchema = isObject(propertyValue.items) ? propertyValue.items : undefined;
      if (itemSchema) {
        value.forEach((item, index) => {
          if (itemSchema.type === 'string' && typeof item !== 'string') {
            throw new Error(`Item ${index + 1} in “${key}” must be a string.`);
          }
          if (
            typeof item === 'string' &&
            typeof itemSchema.maxLength === 'number' &&
            item.length > itemSchema.maxLength
          ) {
            throw new Error(`Item ${index + 1} in “${key}” is too long.`);
          }
          if (
            typeof item === 'string' &&
            typeof itemSchema.minLength === 'number' &&
            item.length < itemSchema.minLength
          ) {
            throw new Error(`Item ${index + 1} in “${key}” is too short.`);
          }
        });
      }
    }
  }
}

function contextSummary(
  item: PinContext,
  activeContextId: string | undefined
): PinContextAgentContextSummary {
  return {
    id: item.id,
    name: item.name,
    source: item.source,
    active: item.id === activeContextId,
    pinnedFileCount: item.pinnedUris.length,
    ...(item.branch ? { branch: item.branch } : {}),
    ...(typeof item.changed === 'number' ? { unstagedChanges: item.changed } : {}),
    ...(typeof item.staged === 'number' ? { stagedChanges: item.staged } : {}),
    ...(item.workspaceFolder ? { workspaceFolder: item.workspaceFolder } : {}),
    updatedAt: item.updatedAt
  };
}

export class PinContextAgentService {
  private mcpProviderRegistered = false;

  constructor(
    private readonly contexts: ContextStore,
    private readonly pins: PinStore,
    private readonly whenReady: () => Promise<void>
  ) {}

  setMcpProviderRegistered(registered: boolean): void {
    this.mcpProviderRegistered = registered;
  }

  async executeTool(
    name: PinContextAgentToolName | string,
    rawInput: unknown = {},
    options: InvocationOptions = {}
  ): Promise<unknown> {
    await this.whenReady();
    const definition = getAgentToolDefinition(name);
    if (!definition) {
      throw new Error(`Unknown Pin Context agent tool “${name}”.`);
    }
    if (!isObject(rawInput)) {
      throw new Error('Tool input must be a JSON object.');
    }
    const input = rawInput;
    validateToolInput(input, definition.inputSchema);
    options = { ...options, requireOwnConfirmation: definition.destructive === true };

    switch (name) {
      case 'pin_context_get_status':
        return this.getStatus();
      case 'pin_context_get_active_context':
        return this.getActiveContext();
      case 'pin_context_list_contexts':
        return this.listContexts();
      case 'pin_context_get_pinned_files':
        return this.getPinnedFiles(
          typeof input.context_id === 'string' ? input.context_id : undefined
        );
      case 'pin_context_get_workspace_info':
        return this.getWorkspaceInfo();
      case 'pin_context_switch_context': {
        const id = requireString(input, 'context_id', 300);
        const target = this.findVisibleContext(id);
        await this.confirmMutation(t('Switch to context "{0}"', target.name), options);
        const switched = await this.contexts.switchContext(id);
        if (!switched) throw new Error(`Could not switch to context “${target.name}”.`);
        return { success: true, activeContext: await this.getActiveContext() };
      }
      case 'pin_context_create_context': {
        const name = requireString(input, 'name', 120);
        if (this.contexts.hasManualContextName(name)) {
          throw new Error(`A manual context named “${name}” already exists.`);
        }
        await this.confirmMutation(t('Create and activate context "{0}"', name), options);
        const created = await this.contexts.createManualContext(name);
        if (!created) throw new Error('Pin Context could not persist the new context.');
        return {
          success: true,
          context: contextSummary(created, this.contexts.getActiveContext()?.id)
        };
      }
      case 'pin_context_save_context': {
        const id = requireString(input, 'context_id', 300);
        const target = this.findVisibleContext(id);
        await this.confirmMutation(
          t('Save the current pinned files to context "{0}"', target.name),
          options
        );
        const saved = await this.contexts.saveCurrentPinsToContext(id);
        if (!saved) throw new Error(`Could not save the current pins to context “${target.name}”.`);
        return { success: true, context: await this.contextById(id) };
      }
      case 'pin_context_rename_context': {
        const id = requireString(input, 'context_id', 300);
        const name = requireString(input, 'name', 120);
        const target = this.findVisibleContext(id);
        if (target.source === 'repo')
          throw new Error('Repository contexts cannot be renamed by agents.');
        if (this.contexts.hasManualContextName(name, id)) {
          throw new Error(`A manual context named “${name}” already exists.`);
        }
        await this.confirmMutation(t('Rename context "{0}" to "{1}"', target.name, name), options);
        const renamed = await this.contexts.renameContext(id, name);
        if (!renamed) throw new Error(`Could not rename context “${target.name}”.`);
        return { success: true, context: await this.contextById(id) };
      }
      case 'pin_context_delete_context': {
        const id = requireString(input, 'context_id', 300);
        const target = this.findVisibleContext(id);
        if (target.source !== 'manual') {
          throw new Error('Only manual contexts can be deleted through the agent API.');
        }
        await this.confirmMutation(t('Delete context "{0}"', target.name), options);
        const deleted = await this.contexts.deleteContext(id);
        if (!deleted) throw new Error(`Could not delete context “${target.name}”.`);
        return { success: true, deletedContextId: id };
      }
      case 'pin_context_pin_files':
      case 'pin_context_unpin_files': {
        const paths = input.paths;
        if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) {
          throw new Error('“paths” must be an array containing between 1 and 100 file paths.');
        }
        if (!paths.every((item) => typeof item === 'string' && item.trim().length > 0)) {
          throw new Error('Every path must be a non-empty string.');
        }
        const shouldPin = name === 'pin_context_pin_files';
        const uris = await Promise.all(
          (paths as string[]).map((raw) => this.resolveWorkspaceFile(raw, shouldPin))
        );
        const uniqueUris = [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];
        const displayPaths = uniqueUris.map((uri) => this.displayPath(uri));
        const shownPaths = displayPaths
          .slice(0, 6)
          .map((item) => `“${item}”`)
          .join(', ');
        const remainingPaths =
          displayPaths.length > 6 ? t('and {0} more', displayPaths.length - 6) : '';
        const pathSummary = `${shownPaths}${remainingPaths ? `, ${remainingPaths}` : ''}`;
        const confirmation = shouldPin
          ? t('Pin the selected workspace files ({0}): {1}', displayPaths.length, pathSummary)
          : t('Unpin the selected workspace files ({0}): {1}', displayPaths.length, pathSummary);
        await this.confirmMutation(confirmation, options);
        if (name === 'pin_context_pin_files') {
          const result = await this.pins.pinUris(uniqueUris, {
            openIfClosed: false,
            showProgress: uniqueUris.length > 15
          });
          const pinned = uniqueUris.filter((uri) => this.pins.isUriPinned(uri));
          return {
            success: pinned.length === uniqueUris.length,
            requested: uniqueUris.length,
            pinned: pinned.map((uri) => this.fileDto(uri)),
            failed: result.failed,
            skipped: result.skipped,
            errors: result.errors
          };
        }
        const result = await this.pins.unpinUris(uniqueUris, {
          showProgress: uniqueUris.length > 15
        });
        const stillPinned = uniqueUris.filter((uri) => this.pins.isUriPinned(uri));
        return {
          success: stillPinned.length === 0,
          requested: uniqueUris.length,
          unpinned: uniqueUris
            .filter((uri) => !this.pins.isUriPinned(uri))
            .map((uri) => this.fileDto(uri)),
          failed: result.failed,
          skipped: result.skipped,
          errors: result.errors
        };
      }
      default:
        logger.warn(`Agent tool definition “${name}” was not implemented.`);
        throw new Error(`Pin Context agent tool “${name}” is not implemented.`);
    }
  }

  getPublicApi(): PinContextAgentApi {
    return {
      apiVersion: 1,
      getStatus: async () => {
        await this.whenReady();
        return this.getStatus();
      },
      getActiveContext: async () => {
        await this.whenReady();
        return this.getActiveContext();
      },
      listContexts: async () => {
        await this.whenReady();
        return this.listContexts();
      },
      getPinnedFiles: async (contextId) => {
        await this.whenReady();
        return this.getPinnedFiles(contextId);
      },
      getWorkspaceInfo: async () => {
        await this.whenReady();
        return this.getWorkspaceInfo();
      },
      executeTool: (name, input = {}) => this.executeTool(name, input, { origin: 'extension-api' })
    };
  }

  private async confirmMutation(confirmation: string, options: InvocationOptions): Promise<void> {
    // VS Code's MCP host asks for confirmation for every non-read-only tool. External MCP
    // clients and calls through the public extension API must be confirmed by this extension.
    if (canRelyOnHostApproval(options)) return;
    const allow = t('Allow');
    const choice = await vscode.window.showWarningMessage(
      t('Allow Pin Context agent to make this change?'),
      { modal: true, detail: `${confirmation}\n\n${t('No changes will be made if you cancel.')}` },
      allow,
      t('Cancel')
    );
    if (choice !== allow) {
      throw new Error('The user cancelled this operation. No changes were made.');
    }
  }

  private getStatus(): PinContextAgentStatus {
    return {
      version: 1,
      activeContext: this.getActiveContext(),
      pinnedFileCount: this.pins.getPinnedCount(),
      contextCount: this.contexts.getAllContexts().length,
      mcpProviderRegistered: this.mcpProviderRegistered,
      workspaceFolders: this.getWorkspaceInfo()
    };
  }

  private getActiveContext(): PinContextAgentContextSummary | null {
    const item = this.contexts.getActiveContext();
    return item
      ? {
          ...contextSummary(item, item.id),
          pinnedFiles: item.pinnedUris.map((value) => this.savedFileDtoFromUriString(value))
        }
      : null;
  }

  private listContexts(): PinContextAgentContextSummary[] {
    const activeId = this.contexts.getActiveContext()?.id;
    return this.contexts.getAllContexts().map((item) => contextSummary(item, activeId));
  }

  private getPinnedFiles(contextId?: string): PinContextAgentFile[] {
    if (contextId) {
      const item = this.findVisibleContext(contextId);
      return item.pinnedUris.map((value) => this.savedFileDtoFromUriString(value));
    }
    return this.pins.getPinnedUris().map((uri) => this.fileDto(uri));
  }

  private getWorkspaceInfo(): PinContextAgentStatus['workspaceFolders'] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath,
      uri: folder.uri.toString()
    }));
  }

  private async contextById(id: string): Promise<PinContextAgentContextSummary> {
    const item = this.findVisibleContext(id);
    return contextSummary(item, this.contexts.getActiveContext()?.id);
  }

  private findVisibleContext(id: string): PinContext {
    const item = this.contexts.getAllContexts().find((context) => context.id === id);
    if (!item) throw new Error(`Context “${id}” was not found in the current workspace.`);
    return item;
  }

  private async resolveWorkspaceFile(
    raw: string,
    requireExistingFile: boolean
  ): Promise<vscode.Uri> {
    const value = raw.trim();
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0)
      throw new Error('Open a workspace before using agent file operations.');

    let uri: vscode.Uri;
    if (path.isAbsolute(value)) {
      // Windows drive letters (C:\\...) are paths, not URI schemes.
      uri = vscode.Uri.file(value);
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
      uri = vscode.Uri.parse(value);
      if (uri.scheme !== 'file') throw new Error(`Only local file:// URIs are allowed: ${value}`);
    } else {
      const normalized = value.replace(/\\/g, '/');
      // Folder-name prefixes are only needed to disambiguate multi-root workspaces.
      // In a single-root workspace, `folder/file.ts` may be a real relative path.
      const folderCandidates =
        folders.length > 1
          ? folders.filter((folder) => normalized.startsWith(`${folder.name}/`))
          : [];
      if (folderCandidates.length > 1) {
        throw new Error(
          `Workspace folder name is ambiguous for path “${value}”. Use an absolute path.`
        );
      }
      if (folderCandidates.length === 1) {
        const folder = folderCandidates[0];
        uri = vscode.Uri.joinPath(
          folder.uri,
          ...normalized.slice(folder.name.length + 1).split('/')
        );
      } else if (folders.length === 1) {
        uri = vscode.Uri.joinPath(folders[0].uri, ...normalized.split('/'));
      } else {
        throw new Error(
          `Use “workspaceFolderName/path” or an absolute path for “${value}” in this multi-root workspace.`
        );
      }
    }

    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) throw new Error(`File is outside the opened workspace: ${value}`);
    const relative = path.relative(path.resolve(folder.uri.fsPath), path.resolve(uri.fsPath));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`File is outside the opened workspace: ${value}`);
    }
    if (requireExistingFile) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory)
          throw new Error(`Expected a file, got a folder: ${value}`);
      } catch (error) {
        if (error instanceof Error && /Expected a file/.test(error.message)) throw error;
        throw new Error(`File does not exist or cannot be accessed: ${value}`);
      }
    }
    return uri;
  }

  private displayPath(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false);
  }

  private fileDto(uri: vscode.Uri): FileDto {
    return { path: this.displayPath(uri), uri: uri.toString(), pinned: this.pins.isUriPinned(uri) };
  }

  private savedFileDtoFromUriString(value: string): FileDto {
    try {
      const uri = vscode.Uri.parse(value);
      return { path: this.displayPath(uri), uri: uri.toString(), pinned: true };
    } catch {
      return { path: value, uri: value, pinned: true };
    }
  }
}

export { AGENT_TOOL_DEFINITIONS };
