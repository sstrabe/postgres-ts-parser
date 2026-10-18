import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSchema, splitStatements } from '../src/core/migrations';
import { analyzeQuery, findSqlTemplates, typeArgumentEdit } from '../src/core/templates';
import { rowType } from '../src/core/typegen';

const dir = join(__dirname, 'fixtures/migrations');
const files = readdirSync(dir)
  .filter((f) => !f.endsWith('.down.sql'))
  .map((f) => ({ path: f, contents: readFileSync(join(dir, f), 'utf8') }));
const { schema, warnings } = buildSchema(files);

function typeOf(sql: string) {
  const a = analyzeQuery(sql, schema);
  expect(a.parseError).toBeUndefined();
  expect(a.diagnostics).toEqual([]);
  return rowType(a.columns!, schema);
}

describe('migrations', () => {
  it('applies migrations in natural order without warnings', () => {
    expect(warnings).toEqual([]);
    expect([...schema.relations.keys()].sort()).toEqual(['public.post_counts', 'public.posts', 'public.users']);
  });

  it('splits around strings, comments and dollar quotes', () => {
    const parts = splitStatements(`select ';'; -- ;\nselect $x$ ; $x$; /* ; */ select 1`);
    expect(parts.map((p) => p.text.trim())).toEqual([`select ';'`, `-- ;\nselect $x$ ; $x$`, `/* ; */ select 1`]);
  });
});

describe('inference', () => {
  it('types select * with renames, domains and enums', () => {
    expect(typeOf('SELECT * FROM users')).toBe(
      '{ id: number; email: string; name: string | null; role: "admin" | "member" | "owner"; balance: string; created_at: Date; updated_at: Date | null }',
    );
  });

  it('handles joins, aliases, aggregates and outer-join nullability', () => {
    expect(
      typeOf(`SELECT u.id, u.email AS address, p.title, count(p.id) AS posts, max(p.title) top
              FROM users u LEFT JOIN posts p ON p.author_id = u.id GROUP BY u.id, p.title`),
    ).toBe('{ id: number; address: string; title: string | null; posts: string; top: string | null }');
  });

  it('narrows nullability from WHERE', () => {
    expect(typeOf('SELECT name FROM users WHERE name IS NOT NULL')).toBe('{ name: string }');
  });

  it('types RETURNING, CTEs, views, casts and json', () => {
    expect(typeOf('INSERT INTO posts (author_id, title, body) VALUES ($1, $2, $3) RETURNING id, tags')).toBe('{ id: string; tags: string[] }');
    expect(typeOf(`WITH c AS (SELECT author_id, n FROM post_counts) SELECT n::int, meta->>'k' AS k FROM c JOIN posts USING (author_id)`)).toBe(
      '{ n: number; k: string | null }',
    );
    expect(analyzeQuery('UPDATE users SET name = $1 WHERE id = $2', schema).columns).toBeNull();
    expect(typeOf(`SELECT 1 AS one, coalesce(name, email) AS label, count(*) FILTER (WHERE true) FROM users`)).toBe(
      '{ one: number; label: string; count: string }',
    );
  });

  it('reports unknown tables and columns', () => {
    const a = analyzeQuery('SELECT nope FROM users u JOIN missing m ON true', schema);
    expect(a.diagnostics.map((d) => d.message)).toEqual(['Table "missing" is not defined by any migration.']);
    const b = analyzeQuery('SELECT u.nope, wat FROM users u', schema);
    expect(b.diagnostics.map((d) => d.message)).toEqual(['Column "nope" does not exist on "u".', 'Column "wat" does not exist.']);
  });
});

describe('templates', () => {
  const source = [
    'const a = await sql`SELECT id, name FROM users WHERE id = ${id}`;',
    'const b = await db.sql<{ old: string }>`SELECT email FROM users`;',
    'const c = await sql<User>`SELECT * FROM users`;',
    'const d = await sql`UPDATE users SET name = ${n}`;',
  ].join('\n');
  const templates = findSqlTemplates('x.ts', source, ['sql']);

  it('extracts SQL with placeholders and maps offsets back', () => {
    expect(templates.map((t) => t.sql)).toEqual([
      'SELECT id, name FROM users WHERE id = $1',
      'SELECT email FROM users',
      'SELECT * FROM users',
      'UPDATE users SET name = $1',
    ]);
    const t = templates[0];
    expect(source.slice(t.toDocumentOffset(t.sql.indexOf('name')), t.toDocumentOffset(t.sql.indexOf('name')) + 4)).toBe('name');
    expect(source.slice(t.toDocumentOffset(t.sql.indexOf('$1'))).startsWith('id}')).toBe(true);
  });

  it('inserts or replaces generated type arguments only', () => {
    const opts = { typeTemplate: '{{row}}' };
    const edits = templates.map((t) => typeArgumentEdit(t, analyzeQuery(t.sql, schema), schema, opts));
    expect(edits[0]?.newText).toBe('<{ id: number; name: string | null }>');
    expect(edits[0]?.start).toBe(edits[0]?.end);
    expect(source.slice(edits[1]!.start, edits[1]!.end)).toBe('<{ old: string }>');
    expect(edits[1]?.newText).toBe('<{ email: string }>');
    expect(edits[2]).toBeUndefined(); // user-written named type is left alone
    expect(edits[3]).toBeUndefined(); // no rows returned
  });
});

describe('loader', () => {
  it('finds the nearest migrations folder and skips down migrations', async () => {
    const { findMigrationsDir, loadSchema } = await import('../src/core/loader');
    const root = join(__dirname, '..');
    const found = findMigrationsDir(join(__dirname, 'fixtures/src/deep/file.ts'), root, 'migrations');
    expect(found).toBe(dir);
    const loaded = loadSchema(found!, ['**/*.down.sql']);
    expect(loaded.fileCount).toBe(3);
    expect(loaded.schema.relations.has('public.posts')).toBe(true);
    expect(findMigrationsDir(join(root, 'src/x.ts'), root, 'migrations')).toBeUndefined();
  });
});
