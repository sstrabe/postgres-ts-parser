// Packages the .vsix from a staging folder. vsce drops node_modules when run with
// --no-dependencies (needed for pnpm), but VS Code loads TypeScript server plugins from
// the extension's node_modules, so the staged manifest declares the bundled plugin as
// its only dependency and vsce packages it with npm semantics.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stage = join(root, '.vsix-stage');
const plugin = 'node_modules/postgres-ts-sql-plugin';

execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit', cwd: root });

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, plugin), { recursive: true });
for (const f of ['README.md', 'LICENSE', 'dist/extension.js', 'syntaxes', `${plugin}/index.js`, `${plugin}/package.json`]) {
  cpSync(join(root, f), join(stage, f), { recursive: true });
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
delete manifest.scripts;
delete manifest.devDependencies;
delete manifest.bin;
delete manifest.pnpm;
manifest.dependencies = { 'postgres-ts-sql-plugin': '0.0.0' };
writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));

const vsce = join(root, 'node_modules/@vscode/vsce/vsce');
const out = join(root, `${manifest.name}-${manifest.version}.vsix`);
execFileSync(process.execPath, [vsce, 'package', '--out', out], { stdio: 'inherit', cwd: stage });
rmSync(stage, { recursive: true, force: true });
