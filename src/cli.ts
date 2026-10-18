// Type-checks a project the way the editor sees it: `postgres-ts-tsc [-p tsconfig.json]`
// is a drop-in for `tsc --noEmit` that knows the inferred types of sql`...` queries.
import * as path from 'node:path';
import type * as TS from 'typescript';
import { Config, SchemaStore, resolveConfig, virtualize } from './core/virtual';

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
  const sqlDiagnostics: TS.Diagnostic[] = [];
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const original = getSourceFile(fileName, languageVersion, onError, shouldCreate);
    if (!original || original.isDeclarationFile || fileName.includes('/node_modules/')) return original;
    const virtual = virtualize(ts, fileName, original.text, store.forFile(fileName), config);
    originals.set(original.fileName, original);
    if (virtual.loaded && config.diagnostics !== 'off') {
      for (const { template, analysis } of virtual.templates) {
        const found = [...analysis.diagnostics];
        if (analysis.parseError && config.reportParseErrors) found.push(analysis.parseError);
        for (const d of found) {
          const start = template.toDocumentOffset(d.start);
          sqlDiagnostics.push({
            file: original,
            start,
            length: Math.max(template.toDocumentOffset(d.end) - start, 1),
            messageText: d.message,
            category: config.diagnostics === 'warning' ? ts.DiagnosticCategory.Warning : ts.DiagnosticCategory.Error,
            code: 99001,
          });
        }
      }
    }
    if (!virtual.regions.length) return original;
    return ts.createSourceFile(fileName, virtual.text, languageVersion, true);
  };

  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host, projectReferences: parsed.projectReferences });
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
