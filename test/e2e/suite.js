const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, tries = 60) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (last.ok) return last;
    await wait(1000);
  }
  assert.fail(`${what}: ${JSON.stringify(last.value)}`);
}

async function completionsAfter(doc, needle) {
  const pos = doc.positionAt(doc.getText().indexOf(needle) + needle.length);
  const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, pos, '.');
  return list.items.map((it) => (typeof it.label === 'string' ? it.label : it.label.label));
}

exports.run = async function run() {
  const file = path.resolve(__dirname, 'workspace/packages/api/src/queries.ts');
  const migration = path.resolve(__dirname, 'workspace/packages/api/db/020_nickname.sql');
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);
  const original = doc.getText();
  try {
    // Type `user.` without saving: completions come from the inferred row type.
    const typed = original.replace('return user;', 'return user.;').replace('return rows[0];', 'return rows[0].;');
    await editor.edit((b) => b.replace(new vscode.Range(0, 0, doc.lineCount, 0), typed));
    await until('row completions', async () => {
      const labels = await completionsAfter(doc, 'return user.');
      return { ok: ['id', 'name', 'role'].every((l) => labels.includes(l)), value: labels };
    });
    // Long queries use an alias declared past the end of the file; completions still work.
    await until('aliased row completions', async () => {
      const labels = await completionsAfter(doc, 'rows[0].');
      return { ok: ['email', 'balance', 'updated_at'].every((l) => labels.includes(l)), value: labels };
    });

    // Hovering the result shows the real type.
    const hover = async (needle) => {
      const pos = doc.positionAt(doc.getText().indexOf(needle) + 1);
      const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, pos);
      return hovers.flatMap((h) => h.contents.map((c) => c.value ?? c)).join('\n');
    };
    await until('hover on the result', async () => {
      const text = await hover('[user]');
      return { ok: /user: \{\s*id: number;\s*name: string \| null;\s*role: "admin" \| "member" \| "owner";?\s*\}/.test(text), value: text };
    });
    await until('hover on the tag', async () => {
      const text = await hover('sql`SELECT id, name');
      return { ok: /SQL result[\s\S]*`role: "admin" \| "member" \| "owner"` — `users.role`/.test(text), value: text };
    });

    // SQL problems are reported by TypeScript, at the right place.
    await until('sql diagnostics', async () => {
      const d = vscode.languages.getDiagnostics(doc.uri).filter((x) => /does not exist/.test(x.message));
      return { ok: d.length === 1, value: vscode.languages.getDiagnostics(doc.uri).map((x) => x.message) };
    });
    const sqlDiag = vscode.languages.getDiagnostics(doc.uri).find((x) => /does not exist/.test(x.message));
    assert.strictEqual(doc.getText(sqlDiag.range), 'nope');
    const tsErrors = vscode.languages.getDiagnostics(doc.uri).filter((x) => !/does not exist/.test(x.message));
    assert.deepStrictEqual(tsErrors.map((x) => x.message).filter((m) => !/Identifier expected/.test(m)), []);

    // The source itself was never rewritten.
    assert.ok(doc.getText().includes('await sql`SELECT id, name, role FROM users'), doc.getText());

    // A new migration shows up without touching the file.
    fs.writeFileSync(migration, 'ALTER TABLE users ADD COLUMN nickname text NOT NULL;\n');
    await until('completions after migration change', async () => {
      const labels = await completionsAfter(doc, 'rows[0].');
      return { ok: labels.includes('nickname'), value: labels };
    });

    console.log('E2E OK: live types, completions, hover, SQL diagnostics, migration reload, no source edits');
  } finally {
    fs.rmSync(migration, { force: true });
    await editor.edit((b) => b.replace(new vscode.Range(0, 0, doc.lineCount, 0), original));
    await doc.save();
  }
};
