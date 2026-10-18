import * as path from 'node:path';
import ts from 'typescript';
import * as vscode from 'vscode';
import { TypeEdit, typeArgumentEdit } from './core/templates';
import { Config, SchemaStore, resolveConfig, virtualize } from './core/virtual';

const PLUGIN_NAME = 'postgres-ts-sql-plugin';
const TS_LANGUAGES = ['typescript', 'typescriptreact'];

function readConfig(scope?: vscode.Uri): Config & { updateOnSave: boolean } {
  const c = vscode.workspace.getConfiguration('postgresTs', scope);
  const pick = <K extends keyof Config>(k: K) => c.get<Config[K]>(k);
  return {
    ...resolveConfig({
      migrationsDir: pick('migrationsDir'),
      migrationsExclude: pick('migrationsExclude'),
      tags: pick('tags'),
      typeTemplate: pick('typeTemplate'),
      typeOverrides: pick('typeOverrides'),
      diagnostics: pick('diagnostics'),
      reportParseErrors: pick('reportParseErrors'),
    }),
    updateOnSave: c.get('updateOnSave', false),
  };
}

/**
 * Types are provided by the tsserver plugin (see tsPlugin.ts), which this extension
 * registers and configures. The extension itself adds the grammar and an explicit
 * "write the types into the file" command for code that must type-check without the plugin.
 */
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Postgres TS SQL');
  let config = readConfig();
  const store = new SchemaStore(() => config, undefined, (loaded) => {
    output.appendLine(`Loaded ${loaded.fileCount} migration file(s) from ${loaded.dir}: ${loaded.schema.relations.size} table(s)/view(s).`);
    for (const w of loaded.warnings) output.appendLine(`  skipped statement in ${w.path}: ${w.message}\n    ${w.statement.split('\n')[0]}`);
  });

  const configurePlugin = async () => {
    const tsExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
    if (!tsExtension) return;
    const api = (await tsExtension.activate())?.getAPI?.(0);
    const { updateOnSave: _, ...pluginConfig } = config;
    api?.configurePlugin(PLUGIN_NAME, pluginConfig);
  };

  const editsFor = (doc: vscode.TextDocument, range?: vscode.Range): TypeEdit[] => {
    if (!TS_LANGUAGES.includes(doc.languageId)) return []; // type arguments are TS syntax
    const virtual = virtualize(ts, doc.fileName, doc.getText(), store.forFile(doc.uri.fsPath), config);
    if (!virtual.loaded) return [];
    return virtual.templates
      .filter(({ template }) => !range || (doc.offsetAt(range.start) <= template.end && doc.offsetAt(range.end) >= template.start))
      .map(({ template, analysis }) =>
        typeArgumentEdit(template, analysis, virtual.loaded!.schema, { typeTemplate: config.typeTemplate, overrides: config.typeOverrides }),
      )
      .filter((e): e is TypeEdit => !!e);
  };

  const toTextEdit = (doc: vscode.TextDocument, e: TypeEdit) =>
    vscode.TextEdit.replace(new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.newText);

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.sql');
  const onSqlChange = (uri: vscode.Uri) => {
    if (store.dirs.some((dir) => !path.relative(dir, uri.fsPath).startsWith('..'))) store.clear();
  };

  context.subscriptions.push(
    output,
    watcher,
    watcher.onDidChange(onSqlChange),
    watcher.onDidCreate(onSqlChange),
    watcher.onDidDelete(onSqlChange),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('postgresTs')) return;
      config = readConfig();
      store.clear();
      void configurePlugin();
    }),

    vscode.workspace.onWillSaveTextDocument((e) => {
      if (!config.updateOnSave) return;
      const edits = editsFor(e.document).map((x) => toTextEdit(e.document, x));
      if (edits.length) e.waitUntil(Promise.resolve(edits));
    }),

    vscode.commands.registerCommand('postgresTs.updateTypes', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      if (!store.forFile(doc.uri.fsPath)) {
        vscode.window.showWarningMessage(`No "${config.migrationsDir}" folder found above ${path.basename(doc.fileName)}.`);
        return;
      }
      const edits = editsFor(doc);
      await editor.edit((b) => edits.forEach((x) => b.replace(toTextEdit(doc, x).range, x.newText)));
    }),

    vscode.commands.registerCommand('postgresTs.reloadSchema', async () => {
      store.clear();
      // Re-sending the configuration makes the tsserver plugin reload too.
      await configurePlugin();
      output.show(true);
    }),

    vscode.languages.registerCodeActionsProvider(
      TS_LANGUAGES.map((language) => ({ language })),
      {
        provideCodeActions(doc, range) {
          const edits = editsFor(doc, range);
          if (!edits.length) return [];
          const action = new vscode.CodeAction(
            edits.length === 1 ? 'Write inferred SQL result type into the source' : `Write ${edits.length} inferred SQL result types into the source`,
            vscode.CodeActionKind.RefactorRewrite,
          );
          action.edit = new vscode.WorkspaceEdit();
          for (const e of edits) action.edit.replace(doc.uri, toTextEdit(doc, e).range, e.newText);
          return [action];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
    ),
  );

  await configurePlugin();
}

export function deactivate() {}
