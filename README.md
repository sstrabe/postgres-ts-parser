# Postgres TS SQL

A VS Code extension for inline Postgres in TypeScript:

- **Syntax highlighting** inside `` sql`...` `` (and `` db.sql`...` ``, `` SQL`...` ``, `` /* sql */ `...` ``), with `${...}` interpolations still highlighted as TypeScript.
- **Inferred result types.** Each query is parsed into an AST ([pgsql-ast-parser](https://github.com/oguimbal/pgsql-ast-parser)) and typed against a schema built from your migrations folder — no running database. The row type is written into the tag's type argument, so the TypeScript language service gives you real autocompletion and type checking on query results:

  ```ts
  // before save
  const [user] = await sql`SELECT id, name, role FROM users WHERE id = ${id}`;
  // after save
  const [user] = await sql<{ id: number; name: string | null; role: "admin" | "member" }>`SELECT id, name, role FROM users WHERE id = ${id}`;
  user. // → id, name, role
  ```

- **Diagnostics** for unknown tables and columns, ambiguous columns, and bad `INSERT`/`UPDATE` targets.
- **Hover** on the tag shows the row type with each column's origin (`users.email`) and its `COMMENT ON COLUMN`.

## How it works

1. The nearest `migrations` folder (setting `postgresTs.migrationsDir`) is found by walking up from the edited file to the workspace root, so every package in a pnpm workspace can have its own.
2. All `.sql` files in it are applied in natural order (`2_x.sql` before `10_x.sql`): `CREATE/ALTER/DROP TABLE`, enums, domains, composite types, views, functions, comments. Down migrations are skipped (`*.down.sql`, dbmate `-- migrate:down`, goose `-- +goose Down`). Statements that don't affect types (triggers, grants, policies, …) are ignored; anything unparseable is listed in the *Postgres TS SQL* output channel.
3. Each tagged template becomes SQL with `$1, $2, …` for interpolations, is parsed, and every select item is typed: joins (outer joins make columns nullable), `USING`, subqueries, `LATERAL`, CTEs (incl. recursive), `UNION`, `VALUES`, `RETURNING`, casts, `CASE`, `COALESCE`, aggregates and window functions, JSON operators, and common built-in functions. `WHERE x IS NOT NULL` / `WHERE x = …` narrow `x` to non-null.
4. On save (or via the quick fix / *Postgres TS: Update SQL result types in this file*), the `<...>` type argument is inserted or refreshed. Type arguments the extension didn't write (e.g. `` sql<User>`...` ``) are never touched.

Changes to migration files are picked up automatically.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `postgresTs.migrationsDir` | `migrations` | Relative (searched upwards) or absolute path. |
| `postgresTs.migrationsExclude` | `**/*.down.sql`, … | Globs relative to the migrations folder. |
| `postgresTs.tags` | `["sql"]` | Tag names that get typed. |
| `postgresTs.typeTemplate` | `{{row}}` | Use `{{row}}[]` for libraries whose generic is the result array, e.g. **postgres.js** (`` sql<Row[]>`...` ``). |
| `postgresTs.updateOnSave` | `true` | Write types on save. |
| `postgresTs.typeOverrides` | `{}` | e.g. `{ "int8": "bigint", "jsonb": "MyJson" }`. |
| `postgresTs.diagnostics` | `error` | `error`, `warning` or `off`. |
| `postgresTs.reportParseErrors` | `false` | Report SQL the parser can't handle (off because fragments like `` sql`AND x = 1` `` are common). |

Default type mapping follows node-postgres/postgres.js: `int2/int4/float4/float8 → number`, `int8/numeric → string`, `bool → boolean`, `date/timestamp/timestamptz → Date`, `json/jsonb → unknown`, `bytea → Buffer`, enums → string literal unions, arrays → `T[]`, text-like → `string`.

Your `sql` tag must accept a type argument (postgres.js, `@vercel/postgres`, `@neondatabase/serverless`, or your own wrapper do).

## Limitations

- Parameter types (`${...}`) are not checked against columns.
- Only SQL [pgsql-ast-parser](https://github.com/oguimbal/pgsql-ast-parser) understands gets typed; other queries are left alone.
- Queries built from interpolated fragments (`` sql`SELECT * FROM ${table}` ``) can't be typed.
- Type arguments are TypeScript syntax, so `.js` files get highlighting, hovers and diagnostics only.

## Development

```sh
pnpm install
pnpm test        # unit tests
pnpm test:e2e    # runs the extension in VS Code (needs a display; use xvfb-run on Linux)
pnpm package     # builds postgres-ts-sql-<version>.vsix
code --install-extension postgres-ts-sql-0.1.0.vsix
```
