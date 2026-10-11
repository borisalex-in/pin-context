import { build, context } from 'esbuild';
import { rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  platform: 'node' as const,
  format: 'cjs' as const,
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info' as const
};

const options = [
  {
    ...common,
    entryPoints: [path.join(root, 'src/core/extension.ts')],
    outfile: path.join(root, 'out/extension.js'),
    // The `vscode` module is provided by the host, never bundled.
    external: ['vscode']
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/agent/mcpServer.ts')],
    outfile: path.join(root, 'out/mcp-server.js'),
    // A standalone Node process; it must not depend on the VS Code module.
    external: []
  }
];

async function main(): Promise<void> {
  if (watch) {
    const contexts = await Promise.all(options.map((option) => context(option)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[build] watching extension and MCP server...');
    return;
  }

  rmSync(path.join(root, 'out'), { recursive: true, force: true });
  await Promise.all(options.map((option) => build(option)));
}

void main().catch((error: unknown) => {
  console.error('[build] failed', error);
  process.exitCode = 1;
});
