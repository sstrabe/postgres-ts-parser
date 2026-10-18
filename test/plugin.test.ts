import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import init from '../src/tsPlugin';

/** Runs the plugin on a real language service over files on disk, with in-memory edits. */
function createService(rootFile: string, config: Record<string, unknown>) {
  const texts = new Map<string, string>();
  const versions = new Map<string, number>();
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  };
  let projectVersion = 0;
  const host: ts.LanguageServiceHost = {
    // Like tsserver: the program is only rebuilt when this changes.
    getProjectVersion: () => String(projectVersion),
    getCompilationSettings: () => options,
    getScriptFileNames: () => [rootFile],
    getScriptVersion: (f) => String(versions.get(f) ?? 0),
    getScriptSnapshot: (f) => {
      const text = texts.get(f) ?? ts.sys.readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dirname(rootFile),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const languageService = ts.createLanguageService(host);
  const project = {
    projectService: { logger: { info: () => {} } },
    getProjectName: () => 'test',
    containsFile: () => true,
    refreshDiagnostics: () => {},
  };
  const plugin = init({ typescript: ts as never });
  const service = plugin.create({
    project,
    languageService,
    languageServiceHost: host,
    config,
    serverHost: {},
  } as never) as ts.LanguageService;
  return {
    service,
    edit(f: string, text: string) {
      texts.set(f, text);
      versions.set(f, (versions.get(f) ?? 0) + 1);
      projectVersion++;
    },
  };
}

const members = (service: ts.LanguageService, file: string, text: string, needle: string) =>
  service.getCompletionsAtPosition(file, text.indexOf(needle) + needle.length, {})?.entries.map((e) => e.name) ?? [];

describe('tsserver plugin', () => {
  it('types postgres.js queries as Row[] without errors', () => {
    const file = join(__dirname, 'e2e/workspace/packages/app/src/users.ts');
    const { service, edit } = createService(file, { migrationsDir: 'db' });
    const errors = service.getSemanticDiagnostics(file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(errors).toEqual([]);
    const text = readFileSync(file, 'utf8');
    const quick = service.getQuickInfoAtPosition(file, text.indexOf('const users') + 7);
    expect(ts.displayPartsToString(quick?.displayParts)).toMatch(/RowList<\{ id: string; username: string; display_name: string \| null; .*\}\[\]>/);
    const probe = text.replace('return users[0];', 'return users[0].;');
    edit(file, probe);
    expect(members(service, file, probe, 'users[0].')).toEqual(expect.arrayContaining(['username', 'avatar_file_id', 'owner_id']));
  });

  it('types row-style tags, inline and through aliases', () => {
    const file = join(__dirname, 'e2e/workspace/packages/api/src/queries.ts');
    const { service, edit } = createService(file, { migrationsDir: 'db' });
    const text = readFileSync(file, 'utf8').replace('return user;', 'return user.;').replace('return rows[0];', 'return rows[0].;');
    edit(file, text);
    expect(members(service, file, text, 'return user.')).toEqual(expect.arrayContaining(['id', 'name', 'role']));
    expect(members(service, file, text, 'rows[0].')).toEqual(expect.arrayContaining(['email', 'balance', 'updated_at']));
  });
});
