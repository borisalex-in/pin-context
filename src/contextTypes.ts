import * as vscode from 'vscode';

export type ContextSource = 'manual' | 'git';

export interface PinContext {
    id: string;
    name: string;
    source: ContextSource;
    workspaceFolder?: string;
    branch?: string;
    pinnedUris: string[];
    createdAt: number;
    updatedAt: number;
}

export interface ContextTimelineEntry {
    id: string;
    contextId: string;
    contextName: string;
    timestamp: number;
    action: 'switch' | 'save' | 'create' | 'restore';
}

export interface ContextSnapshot {
    contexts: PinContext[];
    activeContextId?: string;
    lastActiveContextId?: string;
    timeline: ContextTimelineEntry[];
}

export interface ContextQuickPickItem extends vscode.QuickPickItem {
    contextId: string;
}

