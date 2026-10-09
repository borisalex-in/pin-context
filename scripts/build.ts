import { build, context } from 'esbuild';
import { rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const options = {
  entryPoints: [path.join(root, 'src/core/extension.ts')],
  bundle: true,
  outfile: path.join(root, 'out/extension.js'),
  platform: 'node' as const,
  format: 'cjs' as const,
  target: 'node18',
  // The `vscode` module is provided by the host, never bundled.
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info' as const
};

async function main(): Promise<void> {
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log('[build] watching for changes...');
    return;
  }

  rmSync(path.join(root, 'out'), { recursive: true, force: true });
  await build(options);
}

void main().catch((error: unknown) => {
  console.error('[build] failed', error);
  process.exitCode = 1;
});
