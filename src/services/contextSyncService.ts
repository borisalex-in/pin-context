import * as vscode from 'vscode';
import { PinContext } from '../types';
import { PinStore } from '../stores/pinStore';
import { toUriKey } from '../utils/tabUtils';

export interface PinDiff {
  toPin: vscode.Uri[];
  toUnpin: vscode.Uri[];
}

export class ContextSyncService {
  constructor(private readonly pinStore: PinStore) {}

  buildPinDiff(targetContext: PinContext): PinDiff {
    const targetUris = targetContext.pinnedUris.map((value) => vscode.Uri.parse(value));
    const current = this.pinStore.getPinnedUris();
    const currentKeys = new Set(current.map((uri) => toUriKey(uri)));
    const targetKeys = new Set(targetUris.map((uri) => toUriKey(uri)));

    return {
      toUnpin: current.filter((uri) => !targetKeys.has(toUriKey(uri))),
      toPin: targetUris.filter((uri) => !currentKeys.has(toUriKey(uri)))
    };
  }

  getPinnedUriStrings(): string[] {
    return this.pinStore.getPinnedUris().map((uri) => uri.toString());
  }
}
