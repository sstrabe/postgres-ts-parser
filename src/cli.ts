// Type-checks a project the way the editor sees it: `postgres-ts-tsc [-p tsconfig.json]`
// is a drop-in for `tsc --noEmit` that knows the inferred types of sql`...` queries.
import * as path from 'node:path';
import type * as TS from 'typescript';
import { TagShape, detectTagShapes } from './core/shapes';
import { Config, SchemaStore, VirtualFile, resolveConfig, virtualize } from './core/virtual';

const PLUGIN_NAME = 'postgres-ts-sql-plugin';

function loadTypeScript(cwd: string): typeof TS {
  // Prefer the project's own TypeScript, like tsc would.
  try {
    return require(require.resolve('typescript', { paths: [cwd] }));
  } catch {
    return require('typescript');
  }
}

function main(argv: string[]): number {
  const cwd = process.cwd();
  const ts = loadTypeScript(cwd);
  const pIndex = argv.findIndex((a) => a === '-p' || a === '--project');
  const configPath = path.resolve(cwd, pIndex >= 0 ? argv[pIndex + 1] : 'tsconfig.json');

  const formatHost: TS.FormatDiagnosticsHost = {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => cwd,
    getNewLine: () => ts.sys.newLine,
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => process.stderr.write(ts.formatDiagnostic(d, formatHost)),
  });
  if (!parsed) return 2;

  const pluginEntry = (parsed.options.plugins as Array<{ name: string } & Partial<Config>> | undefined)?.find((p) => p.name === PLUGIN_NAME);
  const config = resolveConfig(pluginEntry);
  const store = new SchemaStore(() => config, () => path.dirname(configPath));

  const host = ts.createCompilerHost(parsed.options);
  const originals = new Map<string, TS.SourceFile>();
  const virtuals = new Map<string, VirtualFile>();
  /** Tag shapes per file; filled in after the first program, as in the tsserver plugin. */
  const shapes = new Map<string, Map<string, TagShape>>();
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const original = originals.get(fileName) ?? getSourceFile(fileName, languageVersion, onError, shouldCreate);
    if (!original || original.isDeclarationFile || fileName.includes('/node_modules/')) return original;
    originals.set(fileName, original);
    const known = shapes.get(fileName);
    const virtual = virtualize(ts, fileName, original.text, store.forFile(fileName), config, (t) => known?.get(t.tag));
    virtuals.set(fileName, virtual);
    if (!virtual.regions.length) return original;
    return ts.createSourceFile(fileName, virtual.text, languageVersion, true);
  };

  const createProgram = (oldProgram?: TS.Program) =>
    ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host, projectReferences: parsed.projectReferences, oldProgram });
  let program = createProgram();
  let reshaped = false;
  for (const [fileName, virtual] of virtuals) {
    if (!virtual.loaded || !virtual.templates.length) continue;
    shapes.set(fileName, detectTagShapes(ts, program, fileName, virtual.templates.map((t) => t.template)));
    reshaped = true;
  }
  if (reshaped) program = createProgram(program);

  const sqlDiagnostics: TS.Diagnostic[] = [];
  if (config.diagnostics !== 'off') {
    for (const [fileName, virtual] of virtuals) {
      for (const { template, analysis } of virtual.templates) {
        const found = [...analysis.diagnostics];
        if (analysis.parseError && config.reportParseErrors) found.push(analysis.parseError);
        for (const d of found) {
          const start = template.toDocumentOffset(d.start);
          sqlDiagnostics.push({
            file: originals.get(fileName),
            start,
            length: Math.max(template.toDocumentOffset(d.end) - start, 1),
            messageText: d.message,
            category: config.diagnostics === 'warning' ? ts.DiagnosticCategory.Warning : ts.DiagnosticCategory.Error,
            code: 99001,
          });
        }
      }
    }
  }

  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program), ...sqlDiagnostics]
    // Report against the real file text, and drop anything in the appended aliases.
    .map((d) => (d.file && originals.has(d.file.fileName) ? { ...d, file: originals.get(d.file.fileName)! } : d))
    .filter((d) => !d.file || d.start === undefined || d.start < d.file.text.length);

  if (diagnostics.length) {
    const pretty = process.stdout.isTTY ? ts.formatDiagnosticsWithColorAndContext : ts.formatDiagnostics;
    process.stdout.write(pretty(ts.sortAndDeduplicateDiagnostics(diagnostics), formatHost));
  }
  const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).length;
  if (errors) process.stdout.write(`\nFound ${errors} error${errors === 1 ? '' : 's'}.\n`);
  return errors ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
