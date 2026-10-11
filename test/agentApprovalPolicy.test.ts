import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRelyOnHostApproval } from '../src/agent/approvalPolicy';

test('ordinary VS Code MCP mutations may rely on the host confirmation', () => {
  assert.equal(canRelyOnHostApproval({ origin: 'vscode-mcp', approvedByHost: true }), true);
});

test('destructive mutations require Pin Context confirmation even when the host is trusted', () => {
  assert.equal(
    canRelyOnHostApproval({
      origin: 'vscode-mcp',
      approvedByHost: true,
      requireOwnConfirmation: true
    }),
    false
  );
});

test('external MCP and public API mutations always require Pin Context confirmation', () => {
  assert.equal(canRelyOnHostApproval({ origin: 'mcp', approvedByHost: false }), false);
  assert.equal(canRelyOnHostApproval({ origin: 'extension-api' }), false);
  assert.equal(canRelyOnHostApproval({}), false);
});
