import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

test('AI-agent test prompt copy confirmation disappears after two seconds', async () => {
  const scriptPath = path.join(__dirname, '..', 'docs', 'script.js');
  const source = fs.readFileSync(scriptPath, 'utf8');
  const functionMatch = source.match(
    /function initializeAgentIntegration\(\) \{[\s\S]*?\n\}\n\ndocument\.addEventListener/
  );
  assert.ok(functionMatch, 'initializeAgentIntegration must exist in docs/script.js');

  const functionSource = functionMatch[0].replace(/\n\ndocument\.addEventListener$/, '');
  let clickHandler: (() => Promise<void>) | undefined;
  const status = { textContent: '' };
  const prompt = { textContent: 'Check Pin Context MCP tools without changing any data.' };
  const copyButton = {
    addEventListener(event: string, handler: () => Promise<void>) {
      if (event === 'click') clickHandler = handler;
    }
  };
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const clearedTimers: number[] = [];
  let nextTimerId = 0;
  const documentMock = {
    querySelectorAll() {
      return [];
    },
    getElementById(id: string) {
      return (
        (
          {
            copyAgentTestPrompt: copyButton,
            agentTestPrompt: prompt,
            agentCopyStatus: status
          } as Record<string, unknown>
        )[id] ?? null
      );
    }
  };
  const windowMock = {
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id: number) {
      clearedTimers.push(id);
      timers.delete(id);
    }
  };
  const context = {
    document: documentMock,
    window: windowMock,
    navigator: { clipboard: { writeText: async () => undefined } },
    tr: (_key: string, fallback: string) => fallback
  };

  vm.createContext(context);
  vm.runInContext(`${functionSource}\ninitializeAgentIntegration();`, context);
  assert.ok(clickHandler, 'copy button should have a click handler');

  await clickHandler();
  assert.equal(status.textContent, 'Test prompt copied.');
  assert.equal(timers.size, 1);

  const firstTimer = [...timers.entries()][0];
  assert.ok(firstTimer);
  assert.equal(firstTimer[1].delay, 2000);
  timers.delete(firstTimer[0]);
  firstTimer[1].callback();
  assert.equal(status.textContent, '', 'success status should clear after the timer fires');

  await clickHandler();
  const previousTimer = [...timers.entries()][0];
  assert.ok(previousTimer);
  await clickHandler();
  assert.ok(
    clearedTimers.includes(previousTimer[0]),
    'a repeated click should cancel the previous timeout'
  );
  assert.equal(timers.size, 1, 'only the latest timeout should remain active');

  const latestTimer = [...timers.entries()][0];
  assert.ok(latestTimer);
  assert.equal(latestTimer[1].delay, 2000);
  timers.delete(latestTimer[0]);
  latestTimer[1].callback();
  assert.equal(
    status.textContent,
    '',
    'the latest success status should also clear after two seconds'
  );
});
