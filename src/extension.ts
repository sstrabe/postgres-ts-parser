import * as path from 'node:path';
import * as vscode from 'vscode';
import { LoadedSchema, findMigrationsDir, loadSchema } from './core/loader';
import { QueryAnalysis, SqlTemplate, TypeEdit, analyzeQuery, findSqlTemplates, typeArgumentEdit } from './core/templates';
import { applyTemplate, columnType, rowType } from './core/typegen';

const LANGUAGES = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];
const SELECTOR = LANGUAGES.map((language) => ({ language }));

interface Settings {
  migrationsDir: string;
  migrationsExclude: string[];
  tags: string[];
  typeTemplate: string;
  updateOnSave: boolean;
  typeOverrides: Record<string, string>;
  diagnostics: 'error' | 'warning' | 'off';
  reportParseErrors: boolean;
}

function settings(scope?: vscode.Uri): Settings {
  const c = vscode.workspace.getConfiguration('postgresTs', scope);
  return {
    migrationsDir: c.get('migrationsDir', 'migrations'),
    migrationsExclude: c.get('migrationsExclude', []),
    tags: c.get('tags', ['sql']),
    typeTemplate: c.get('typeTemplate', '{{row}}'),
    updateOnSave: c.get('updateOnSave', true),
    typeOverrides: c.get('typeOverrides', {}),
    diagnostics: c.get('diagnostics', 'error'),
    reportParseErrors: c.get('reportParseErrors', false),
  };
}

interface AnalyzedTemplate {
  template: SqlTemplate;
  analysis: QueryAnalysis;
}

interface DocumentAnalysis {
  version: number;
  loaded?: LoadedSchema;
  templates: AnalyzedTemplate[];
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Postgres TS SQL');
  const diagnostics = vscode.languages.createDiagnosticCollection('postgres-ts-sql');
  const schemas = new Map<string, LoadedSchema>();
  const analyses = new WeakMap<vscode.TextDocument, DocumentAnalysis>();
  const timers = new Map<string, NodeJS.Timeout>();

  const schemaFor = (doc: vscode.TextDocument): LoadedSchema | undefined => {
    const s = settings(doc.uri);
    const root = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
    const dir = findMigrationsDir(doc.uri.fsPath, root, s.migrationsDir);
    if (!dir) return undefined;
    let loaded = schemas.get(dir);
    if (!loaded) {
      try {
        loaded = loadSchema(dir, s.migrationsExclude);
      } catch (err) {
        output.appendLine(`Failed to load ${dir}: ${err instanceof Error ? err.message : err}`);
        return undefined;
      }
      schemas.set(dir, loaded);
      output.appendLine(`Loaded ${loaded.fileCount} migration file(s) from ${dir}: ${loaded.schema.relations.size} table(s)/view(s).`);
      for (const w of loaded.warnings) {
        output.appendLine(`  skipped statement in ${w.path}: ${w.message}\n    ${w.statement.split('\n')[0]}`);
      }
    }
    return loaded;
  };

  const analyze = (doc: vscode.TextDocument): DocumentAnalysis => {
    const cached = analyses.get(doc);
    if (cached && cached.version === doc.version) return cached;
    const loaded = schemaFor(doc);
    const templates = findSqlTemplates(doc.fileName, doc.getText(), settings(doc.uri).tags).map((template) => ({
      template,
      analysis: loaded ? analyzeQuery(template.sql, loaded.schema) : { columns: null, diagnostics: [] },
    }));
    const result = { version: doc.version, loaded, templates };
    analyses.set(doc, result);
    return result;
  };

  const editsFor = (doc: vscode.TextDocument, only?: AnalyzedTemplate[]): TypeEdit[] => {
    if (!doc.languageId.startsWith('typescript')) return []; // type arguments are TS syntax
    const { loaded, templates } = analyze(doc);
    if (!loaded) return [];
    const s = settings(doc.uri);
    return (only ?? templates)
      .map((t) => typeArgumentEdit(t.template, t.analysis, loaded.schema, { typeTemplate: s.typeTemplate, overrides: s.typeOverrides }))
      .filter((e): e is TypeEdit => !!e);
  };

  const toTextEdit = (doc: vscode.TextDocument, e: TypeEdit) =>
    vscode.TextEdit.replace(new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.newText);

  const refreshDiagnostics = (doc: vscode.TextDocument) => {
    if (!LANGUAGES.includes(doc.languageId)) return;
    const s = settings(doc.uri);
    if (s.diagnostics === 'off') {
      diagnostics.delete(doc.uri);
      return;
    }
    const { loaded, templates } = analyze(doc);
    if (!loaded) {
      diagnostics.delete(doc.uri);
      return;
    }
    const severity = s.diagnostics === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
    const out: vscode.Diagnostic[] = [];
    for (const { template, analysis } of templates) {
      const found = [...analysis.diagnostics];
      if (analysis.parseError && s.reportParseErrors) found.push(analysis.parseError);
      for (const d of found) {
        const start = doc.positionAt(template.toDocumentOffset(d.start));
        const end = doc.positionAt(Math.max(template.toDocumentOffset(d.end), template.toDocumentOffset(d.start) + 1));
        const diag = new vscode.Diagnostic(new vscode.Range(start, end), d.message, severity);
        diag.source = 'postgres-ts-sql';
        out.push(diag);
      }
    }
    diagnostics.set(doc.uri, out);
  };

  const schedule = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => (timers.delete(key), refreshDiagnostics(doc)), 250));
  };

  const reloadAll = () => {
    schemas.clear();
    for (const doc of vscode.workspace.textDocuments) {
      analyses.delete(doc);
      refreshDiagnostics(doc);
    }
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.sql');
  const onSqlChange = (uri: vscode.Uri) => {
    let changed = false;
    for (const dir of [...schemas.keys()]) {
      const rel = path.relative(dir, uri.fsPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        schemas.delete(dir);
        changed = true;
      }
    }
    if (changed) reloadAll();
  };

  context.subscriptions.push(
    output,
    diagnostics,
    watcher,
    watcher.onDidChange(onSqlChange),
    watcher.onDidCreate(onSqlChange),
    watcher.onDidDelete(onSqlChange),
    vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('postgresTs') && reloadAll()),

    vscode.workspace.onWillSaveTextDocument((e) => {
      if (!LANGUAGES.includes(e.document.languageId) || !settings(e.document.uri).updateOnSave) return;
      const edits = editsFor(e.document).map((x) => toTextEdit(e.document, x));
      if (edits.length) e.waitUntil(Promise.resolve(edits));
    }),

    vscode.commands.registerCommand('postgresTs.updateTypes', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      if (!schemaFor(doc)) {
        vscode.window.showWarningMessage(`No "${settings(doc.uri).migrationsDir}" folder found above ${path.basename(doc.fileName)}.`);
        return;
      }
      const edits = editsFor(doc);
      await editor.edit((b) => edits.forEach((x) => b.replace(toTextEdit(doc, x).range, x.newText)));
    }),

    vscode.commands.registerCommand('postgresTs.reloadSchema', () => {
      reloadAll();
      output.show(true);
    }),

    vscode.languages.registerCodeActionsProvider(
      SELECTOR,
      {
        provideCodeActions(doc, range) {
          const { templates } = analyze(doc);
          const hits = templates.filter(
            (t) => doc.offsetAt(range.start) <= t.template.end && doc.offsetAt(range.end) >= t.template.start,
          );
          const edits = editsFor(doc, hits);
          if (!edits.length) return [];
          const action = new vscode.CodeAction(
            edits.length === 1 ? 'Write inferred SQL result type' : `Write ${edits.length} inferred SQL result types`,
            vscode.CodeActionKind.QuickFix,
          );
          action.edit = new vscode.WorkspaceEdit();
          for (const e of edits) action.edit.replace(doc.uri, toTextEdit(doc, e).range, e.newText);
          action.isPreferred = true;
          return [action];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),

    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover(doc, position) {
        const offset = doc.offsetAt(position);
        const { loaded, templates } = analyze(doc);
        const hit = templates.find((t) => offset >= t.template.tagStart && offset <= t.template.tagEnd);
        if (!hit) return undefined;
        const md = new vscode.MarkdownString();
        if (!loaded) {
          md.appendText(`No "${settings(doc.uri).migrationsDir}" folder found for this file.`);
        } else if (hit.analysis.parseError) {
          md.appendText(hit.analysis.parseError.message);
        } else if (!hit.analysis.columns) {
          md.appendText('Statement returns no rows.');
        } else {
          const s = settings(doc.uri);
          const opts = { overrides: s.typeOverrides };
          md.appendCodeblock(applyTemplate(s.typeTemplate, rowType(hit.analysis.columns, loaded.schema, opts)), 'typescript');
          for (const c of hit.analysis.columns) {
            const from = c.source ? ` — \`${c.source}\`` : '';
            const comment = c.comment ? ` — ${c.comment}` : '';
            md.appendMarkdown(`\n- \`${c.name}: ${columnType(c, loaded.schema, opts)}\`${from}${comment}`);
          }
        }
        return new vscode.Hover(md, new vscode.Range(doc.positionAt(hit.template.tagStart), doc.positionAt(hit.template.tagEnd)));
      },
    }),
  );

  for (const doc of vscode.workspace.textDocuments) refreshDiagnostics(doc);
}

export function deactivate() {}
