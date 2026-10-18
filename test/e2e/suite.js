const assert = require('node:assert');
const path = require('node:path');
const vscode = require('vscode');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function run() {
  const file = path.resolve(__dirname, 'workspace/packages/api/src/queries.ts');
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);
  const original = doc.getText();
  try {
    await wait(1500);

    const diags = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'postgres-ts-sql');
    assert.deepStrictEqual(diags.map((d) => d.message), ['Column "nope" does not exist.']);
    assert.strictEqual(doc.getText(diags[0].range), 'nope');

    const tag = doc.positionAt(doc.getText().indexOf('sql`SELECT id') + 1);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, tag);
    const hoverText = hovers.flatMap((h) => h.contents.map((c) => c.value ?? c)).join('\n');
    assert.match(hoverText, /role: "admin" \| "member" \| "owner"/);

    await vscode.commands.executeCommand('postgresTs.updateTypes');
    const updated = editor.document.getText();
    assert.ok(updated.includes('sql<{ id: number; name: string | null; role: "admin" | "member" | "owner" }>`SELECT id, name, role'), updated);

    // The TypeScript language service now sees real types: completions on the row.
    const probe = updated.replace('return user;', 'return user.');
    await editor.edit((b) => b.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), probe));
    const pos = editor.document.positionAt(probe.indexOf('user.') + 'user.'.length);
    let labels = [];
    for (let i = 0; i < 30 && !labels.includes('role'); i++) {
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, pos, '.');
      labels = list.items.map((it) => (typeof it.label === 'string' ? it.label : it.label.label));
      if (!labels.includes('role')) await wait(1000);
    }
    assert.deepStrictEqual(['id', 'name', 'role'].filter((l) => labels.includes(l)), ['id', 'name', 'role'], labels.join(','));
    console.log('E2E OK: diagnostics, hover, type insertion and TS completions');
  } finally {
    await editor.edit((b) => b.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), original));
    await editor.document.save();
  }
};
