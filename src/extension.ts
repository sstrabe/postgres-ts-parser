import * as vscode from 'vscode';
import { Config, resolveConfig } from './core/config';

const PLUGIN_NAME = 'postgres-ts-sql-plugin';
/** Answered by the tsserver plugin (see tsPlugin.ts). */
const TYPE_EDITS_COMMAND = '_postgresTs.typeEdits';
const TS_LANGUAGES = ['typescript', 'typescriptreact'];

interface TypeEdit {
  start: number;
  end: number;
  newText: string;
}

function readConfig(): Config & { updateOnSave: boolean } {
  const c = vscode.workspace.getConfiguration('postgresTs');
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
 * Types are provided by the tsserver plugin, which this extension registers and
 * configures. The extension itself adds the grammar and an explicit "write the types
 * into the file" command for code that must type-check without the plugin.
 */
export async function activate(context: vscode.ExtensionContext) {
  let config = readConfig();

  const configurePlugin = async () => {
    const tsExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
    if (!tsExtension) return;
    const api = (await tsExtension.activate())?.getAPI?.(0);
    const { updateOnSave: _, ...pluginConfig } = config;
    api?.configurePlugin(PLUGIN_NAME, pluginConfig);
  };

  const typeEdits = async (doc: vscode.TextDocument, range?: vscode.Range): Promise<vscode.TextEdit[]> => {
    if (!TS_LANGUAGES.includes(doc.languageId)) return []; // type arguments are TS syntax
    const response = await vscode.commands.executeCommand<{ body?: TypeEdit[] } | undefined>('typescript.tsserverRequest', TYPE_EDITS_COMMAND, {
      file: doc.uri.fsPath,
      start: range && doc.offsetAt(range.start),
      end: range && doc.offsetAt(range.end),
    });
    return (response?.body ?? []).map((e) => vscode.TextEdit.replace(new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.newText));
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('postgresTs')) return;
      config = readConfig();
      void configurePlugin();
    }),

    vscode.workspace.onWillSaveTextDocument((e) => {
      if (config.updateOnSave && TS_LANGUAGES.includes(e.document.languageId)) e.waitUntil(typeEdits(e.document));
    }),

    vscode.commands.registerCommand('postgresTs.updateTypes', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const edits = await typeEdits(editor.document);
      await editor.edit((b) => edits.forEach((e) => b.replace(e.range, e.newText)));
    }),

    // Re-sending the configuration makes the plugin reload every schema.
    vscode.commands.registerCommand('postgresTs.reloadSchema', configurePlugin),

    vscode.languages.registerCodeActionsProvider(
      TS_LANGUAGES.map((language) => ({ language })),
      {
        async provideCodeActions(doc, range) {
          const edits = await typeEdits(doc, range);
          if (!edits.length) return [];
          const action = new vscode.CodeAction(
            edits.length === 1 ? 'Write inferred SQL result type into the source' : `Write ${edits.length} inferred SQL result types into the source`,
            vscode.CodeActionKind.RefactorRewrite,
          );
          action.edit = new vscode.WorkspaceEdit();
          action.edit.set(doc.uri, edits);
          return [action];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
    ),
  );

  await configurePlugin();
}

export function deactivate() {}
