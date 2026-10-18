# Postgres TS SQL

A VS Code extension for inline Postgres in TypeScript:

- **Syntax highlighting** inside `` sql`...` `` (and `` db.sql`...` ``, `` SQL`...` ``, `` /* sql */ `...` ``), with `${...}` interpolations still highlighted as TypeScript.
- **Live inferred result types.** Each query is parsed into an AST ([pgsql-ast-parser](https://github.com/oguimbal/pgsql-ast-parser)) and typed against a schema built from your migrations folder — no running database. A TypeScript server plugin hands the type to the compiler as the tag's type argument **in memory only**: your source is never edited, and types update as you type or when a migration changes.

  ```ts
  const [user] = await sql`SELECT id, name, role FROM users WHERE id = ${id}`;
  user. // → id, name, role
  // hover: const user: { id: number; name: string | null; role: "admin" | "member" }
  ```

- **Diagnostics** for unknown tables and columns, ambiguous columns, and bad `INSERT`/`UPDATE` targets, reported by TypeScript itself (code `TS99001`).
- **Hover** on the tag lists each column with its origin (`users.email`) and its `COMMENT ON COLUMN`.
- **`postgres-ts-tsc`**, a drop-in for `tsc --noEmit` that sees the same types, for CI.

## How it works

1. The nearest `migrations` folder (setting `postgresTs.migrationsDir`) is found by walking up from the edited file, so every package in a pnpm workspace can have its own.
2. All `.sql` files in it are applied in natural order (`2_x.sql` before `10_x.sql`): `CREATE/ALTER/DROP TABLE`, enums, domains, composite types, views, functions, comments. Down migrations are skipped (`*.down.sql`, dbmate `-- migrate:down`, goose `-- +goose Down`). Statements that don't affect types (triggers, grants, policies, …) are ignored; anything unparseable is listed in the TypeScript server log.
3. Each tagged template becomes SQL with `$1, $2, …` for interpolations, is parsed, and every select item is typed: joins (outer joins make columns nullable), `USING`, subqueries, `LATERAL`, CTEs (incl. recursive), `UNION`, `VALUES`, `RETURNING`, casts, `CASE`, `COALESCE`, aggregates and window functions, JSON operators, and common built-in functions. `WHERE x IS NOT NULL` / `WHERE x = …` narrow `x` to non-null.
4. The plugin reads each tag's signature from the type checker to decide between `Row` and `Row[]`, then gives TypeScript a rewritten copy of the file in which `` sql`SELECT …` `` reads `` sql<{ … }>` …` ``. The type argument takes the place of the start of the SQL text, which doesn't matter to the type checker, so **every other character keeps its offset** and errors, completions and refactors line up with the real file. When the type is longer than that text, a short alias (`sql<SqlRow0>`) is used and declared after the end of the file; hovers and error messages show the full type instead of the alias name.

Type arguments you write yourself (e.g. `` sql<User>`...` ``) are respected and left alone.

## Type-checking outside the editor

Plain `tsc` doesn't load language-service plugins, so in CI it sees the tag's default type. Use the bundled CLI instead of `tsc --noEmit`:

```yaml
# pnpm-workspace.yaml — pnpm 10 only runs dependency build scripts you allow
onlyBuiltDependencies:
  - postgres-ts-sql
```

```sh
pnpm add -D github:sstrabe/postgres-ts-parser
pnpm postgres-ts-tsc -p tsconfig.json
```

It reads the plugin's options from `tsconfig.json`, which also works for editors other than VS Code:

```jsonc
{
  "compilerOptions": {
    "plugins": [{ "name": "postgres-ts-sql-plugin", "migrationsDir": "db", "typeTemplate": "{{row}}[]" }]
  }
}
```

If you'd rather have the types in the source, *Postgres TS: Write inferred SQL result types into this file* (or the refactoring on a query, or `postgresTs.updateOnSave`) writes them in.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `postgresTs.migrationsDir` | `migrations` | Relative (searched upwards) or absolute path. |
| `postgresTs.migrationsExclude` | `**/*.down.sql`, … | Globs relative to the migrations folder. |
| `postgresTs.tags` | `["sql"]` | Tag names that get typed. |
| `postgresTs.typeTemplate` | `auto` | `auto` reads the tag's signature: `Row[]` for tags whose generic is the result array (**postgres.js**), `Row` otherwise, nothing for non-generic tags. Or force a template such as `{{row}}[]`. |
| `postgresTs.updateOnSave` | `false` | Also write the types into the source on save. |
| `postgresTs.typeOverrides` | `{}` | e.g. `{ "int8": "bigint", "jsonb": "MyJson" }`. |
| `postgresTs.diagnostics` | `error` | `error`, `warning` or `off`. |
| `postgresTs.reportParseErrors` | `false` | Report SQL the parser can't handle (off because fragments like `` sql`AND x = 1` `` are common). |

Default type mapping follows node-postgres/postgres.js: `int2/int4/float4/float8 → number`, `int8/numeric → string`, `bool → boolean`, `date/timestamp/timestamptz → Date`, `json/jsonb → unknown`, `bytea → Buffer`, enums → string literal unions, arrays → `T[]`, text-like → `string`.

The tag's call signature decides what type argument it gets: postgres.js (`sql<T extends readonly (object | undefined)[]>`) gets `Row[]`, a row-generic tag like `@vercel/postgres` or your own `sql<T>(…): Promise<T[]>` gets `Row`, and a non-generic tag gets none (highlighting and SQL diagnostics still work).

## Limitations

- Parameter types (`${...}`) are not checked against columns.
- Only SQL [pgsql-ast-parser](https://github.com/oguimbal/pgsql-ast-parser) understands gets typed; other queries are left alone.
- Queries built from interpolated fragments (`` sql`SELECT * FROM ${table}` ``) can't be typed.
- Type arguments are TypeScript syntax, so `.js` files get highlighting, hovers and diagnostics only.
- Queries whose text before the first `${...}` is shorter than about 10 characters (e.g. `` sql`${fragment}` ``) can't carry a type in memory.
- In script files (no `import`/`export`) only types that fit inline are applied, since an alias would be global.

## Development

```sh
pnpm install
pnpm test        # unit tests, incl. the plugin on a real TypeScript language service
pnpm test:e2e    # runs the extension in VS Code (needs a display; use xvfb-run on Linux)
pnpm package     # builds postgres-ts-sql-<version>.vsix (bundles the tsserver plugin)
code --install-extension postgres-ts-sql-0.1.0.vsix
```
