/** Tool definitions shared by the in-extension API, VS Code chat tools, and MCP transport. */
export interface AgentToolDefinition {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  destructive?: boolean;
  inputSchema: Record<string, unknown>;
  confirmation: (input: Record<string, unknown>) => string;
}

const noArguments = {
  type: 'object',
  properties: {},
  additionalProperties: false
};

const contextIdArgument = {
  type: 'object',
  properties: {
    context_id: {
      type: 'string',
      minLength: 1,
      description: 'The exact context id returned by pin_context_list_contexts.'
    }
  },
  required: ['context_id'],
  additionalProperties: false
};

const filePathsArgument = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 4096
      },
      description:
        'Workspace-relative file paths, workspace-folder-name-prefixed paths in multi-root workspaces, absolute paths inside a workspace, or file:// URIs.'
    }
  },
  required: ['paths'],
  additionalProperties: false
};

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: 'pin_context_get_status',
    title: 'Get Pin Context status',
    description:
      'Read the active Pin Context, current pinned-file count, available context count, and workspace folders. Does not change state.',
    readOnly: true,
    inputSchema: noArguments,
    confirmation: () => 'Read Pin Context status'
  },
  {
    name: 'pin_context_get_active_context',
    title: 'Get active context',
    description:
      'Read the currently active Pin Context and its saved file list. Use this before making assumptions about the developer’s selected task context.',
    readOnly: true,
    inputSchema: noArguments,
    confirmation: () => 'Read the active Pin Context'
  },
  {
    name: 'pin_context_list_contexts',
    title: 'List contexts',
    description:
      'List available manual, Git, and repository contexts, with their ids, source, active status, and saved file count.',
    readOnly: true,
    inputSchema: noArguments,
    confirmation: () => 'List Pin Context contexts'
  },
  {
    name: 'pin_context_get_pinned_files',
    title: 'Get pinned files',
    description:
      'List currently pinned files, or the files saved in a specific context when context_id is provided. Returns paths and URIs, not file contents.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        context_id: {
          type: 'string',
          minLength: 1,
          description: 'Optional context id. Omit it to read the live pinned-file set.'
        }
      },
      additionalProperties: false
    },
    confirmation: (input) =>
      typeof input.context_id === 'string'
        ? `Read pinned files saved in context “${input.context_id}”`
        : 'Read the current pinned files'
  },
  {
    name: 'pin_context_get_workspace_info',
    title: 'Get workspace information',
    description:
      'Read the names and paths of the currently opened workspace folders. Does not scan or read file contents.',
    readOnly: true,
    inputSchema: noArguments,
    confirmation: () => 'Read workspace information'
  },
  {
    name: 'pin_context_switch_context',
    title: 'Switch context',
    description:
      'Switch the active Pin Context and apply its saved pinned-file set. User approval is required.',
    readOnly: false,
    inputSchema: contextIdArgument,
    confirmation: (input) => `Switch to context “${String(input.context_id ?? '')}”`
  },
  {
    name: 'pin_context_create_context',
    title: 'Create context',
    description:
      'Create and activate a manual context from the currently pinned files. User approval is required.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'Context name.' }
      },
      required: ['name'],
      additionalProperties: false
    },
    confirmation: (input) => `Create and activate context “${String(input.name ?? '')}”`
  },
  {
    name: 'pin_context_save_context',
    title: 'Save current pins to context',
    description:
      'Replace a context’s saved file set with the current pinned-file set. User approval is required.',
    readOnly: false,
    inputSchema: contextIdArgument,
    confirmation: (input) =>
      `Save the current pinned files to context “${String(input.context_id ?? '')}”`
  },
  {
    name: 'pin_context_rename_context',
    title: 'Rename context',
    description: 'Rename a context. User approval is required.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        context_id: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1, maxLength: 120 }
      },
      required: ['context_id', 'name'],
      additionalProperties: false
    },
    confirmation: (input) =>
      `Rename context “${String(input.context_id ?? '')}” to “${String(input.name ?? '')}”`
  },
  {
    name: 'pin_context_delete_context',
    title: 'Delete context',
    description:
      'Delete a manual context. Git-derived and repository contexts cannot be deleted through the agent API. User approval is required.',
    readOnly: false,
    destructive: true,
    inputSchema: contextIdArgument,
    confirmation: (input) => `Delete context “${String(input.context_id ?? '')}”`
  },
  {
    name: 'pin_context_pin_files',
    title: 'Pin files',
    description:
      'Add workspace files to Pin Context without opening them. Paths must resolve to files inside an open workspace. User approval is required.',
    readOnly: false,
    inputSchema: filePathsArgument,
    confirmation: (input) => describeFileMutation('Pin', input.paths)
  },
  {
    name: 'pin_context_unpin_files',
    title: 'Unpin files',
    description:
      'Remove workspace files from the Pin Context pinned set. Paths must resolve to files inside an open workspace. User approval is required.',
    readOnly: false,
    inputSchema: filePathsArgument,
    confirmation: (input) => describeFileMutation('Unpin', input.paths)
  }
];

function describeFileMutation(action: string, rawPaths: unknown): string {
  const paths = Array.isArray(rawPaths)
    ? rawPaths.filter((item): item is string => typeof item === 'string')
    : [];
  const shown = paths.slice(0, 6).map((item) => `“${item}”`);
  const remainder = paths.length > shown.length ? ` and ${paths.length - shown.length} more` : '';
  const fileLabel = paths.length === 1 ? 'file' : 'files';
  return `${action} ${paths.length} ${fileLabel}: ${shown.join(', ')}${remainder}`;
}

export function getAgentToolDefinition(name: string): AgentToolDefinition | undefined {
  return AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}
