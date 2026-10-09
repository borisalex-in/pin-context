import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLogger(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Pin Context', { log: true });
  context.subscriptions.push(channel);
}

function isDebugEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration('pin-context').get<boolean>('debug', false);
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export const logger = {
  debug(message: string): void {
    if (!isDebugEnabled()) {
      return;
    }
    if (channel) {
      channel.info(`[debug] ${message}`);
    } else {
      console.log(`[pin-context] ${message}`);
    }
  },

  info(message: string): void {
    if (channel) {
      channel.info(message);
    } else {
      console.log(`[pin-context] ${message}`);
    }
  },

  warn(message: string): void {
    if (channel) {
      channel.warn(message);
    } else {
      console.warn(`[pin-context] ${message}`);
    }
  },

  error(message: string, error?: unknown): void {
    const text = error === undefined ? message : `${message}: ${formatError(error)}`;
    if (channel) {
      channel.error(text);
    } else {
      console.error(`[pin-context] ${text}`);
    }
  }
};
