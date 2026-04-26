import * as vscode from 'vscode';
import { ContextSnapshot } from '../types';

const CONTEXTS_STATE_KEY = 'pin-context.contexts.snapshot';

export class ContextPersistenceService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  load(): ContextSnapshot | undefined {
    try {
      return this.context.workspaceState.get<ContextSnapshot | undefined>(CONTEXTS_STATE_KEY);
    } catch (error) {
      console.error('[pin-context] Failed to load contexts snapshot', error);
      void vscode.window.showErrorMessage('Failed to load contexts data');
      return undefined;
    }
  }

  async save(snapshot: ContextSnapshot): Promise<boolean> {
    try {
      await this.context.workspaceState.update(CONTEXTS_STATE_KEY, snapshot);
      return true;
    } catch (error) {
      console.error('[pin-context] Failed to persist contexts snapshot', error);
      void vscode.window.showErrorMessage('Failed to save context data');
      return false;
    }
  }
}
