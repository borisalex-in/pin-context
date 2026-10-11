import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOL_DEFINITIONS, getAgentToolDefinition } from '../src/agent/toolDefinitions';

test('agent tool catalogue has unique names and explicitly separates reads from writes', () => {
  const names = AGENT_TOOL_DEFINITIONS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  assert.equal(AGENT_TOOL_DEFINITIONS.length, 12);
  assert.ok(AGENT_TOOL_DEFINITIONS.every((tool) => tool.inputSchema.type === 'object'));
  assert.ok(
    AGENT_TOOL_DEFINITIONS.every((tool) => tool.inputSchema.additionalProperties === false)
  );

  const reads = AGENT_TOOL_DEFINITIONS.filter((tool) => tool.readOnly);
  const writes = AGENT_TOOL_DEFINITIONS.filter((tool) => !tool.readOnly);
  assert.equal(reads.length, 5);
  assert.equal(writes.length, 7);
  assert.ok(
    writes.every((tool) => /confirm|confirmation|approval/i.test(tool.description)),
    'every state-changing tool must clearly require user confirmation or approval'
  );
  assert.equal(getAgentToolDefinition('pin_context_delete_context')?.destructive, true);
  assert.equal(getAgentToolDefinition('unknown-tool'), undefined);
});

test('file mutation tools cap batch size and reject extra schema fields', () => {
  const pin = getAgentToolDefinition('pin_context_pin_files');
  assert.ok(pin);
  assert.equal(pin.inputSchema.additionalProperties, false);
  const paths = (pin.inputSchema.properties as Record<string, { maxItems?: number }>).paths;
  assert.equal(paths.maxItems, 100);
});
