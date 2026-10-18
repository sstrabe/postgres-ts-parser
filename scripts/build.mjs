// Bundles the extension and the tsserver plugin. VS Code loads TypeScript plugins by
// package name from the extension's node_modules, so the plugin is written there.
import { build, context } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const pluginDir = 'node_modules/postgres-ts-sql-plugin';
mkdirSync(pluginDir, { recursive: true });
writeFileSync(`${pluginDir}/package.json`, JSON.stringify({ name: 'postgres-ts-sql-plugin', version: '0.0.0', main: 'index.js' }, null, 2));

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node18', sourcemap: true, minify: !watch, logLevel: 'info' };
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  // The plugin uses the TypeScript instance of whichever tsserver loads it.
  { ...common, entryPoints: ['src/tsPlugin.ts'], outfile: `${pluginDir}/index.js`, external: ['typescript'] },
  { ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', external: ['typescript'], banner: { js: '#!/usr/bin/env node' } },
];

if (watch) {
  for (const b of builds) await (await context(b)).watch();
} else {
  await Promise.all(builds.map((b) => build(b)));
}
