import { parse } from 'pgsql-ast-parser';
import type * as A from 'pgsql-ast-parser';
import { Inferrer } from './infer';
import { Column, Schema, emptySchema, isSerialType, qualify, scalar } from './types';

export interface MigrationFile {
  /** Path used for ordering and messages. */
  path: string;
  contents: string;
}

export interface MigrationWarning {
  path: string;
  message: string;
  statement: string;
}

export interface SplitStatement {
  text: string;
  /** Offset of `text` in the source. */
  start: number;
}

/**
 * Splits a SQL script on top-level semicolons, respecting quotes, dollar-quoted
 * bodies and comments.
 */
export function splitStatements(sql: string): SplitStatement[] {
  const out: SplitStatement[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const text = sql.slice(start, end);
    if (stripComments(text).trim()) out.push({ text, start });
    start = end + 1;
  };
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') (depth++, (i += 2));
        else if (sql[i] === '*' && sql[i + 1] === '/') (depth--, (i += 2));
        else i++;
      }
    } else if (ch === "'" || ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === ch && sql[i + 1] === ch) i += 2;
        else if (sql[i] === ch) break;
        else i++;
      }
      i++;
    } else if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end < 0 ? sql.length : end + m[0].length;
      } else {
        i++;
      }
    } else if (ch === ';') {
      push(i);
      i++;
    } else {
      i++;
    }
  }
  push(sql.length);
  return out;
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Keeps only the "up" half of migration tools that put both directions in one file. */
export function upSection(contents: string): string {
  const markers = [/^--\s*migrate:down\b/im, /^--\s*\+goose\s+down\b/im, /^--\s*\+migrate\s+down\b/im, /^--\s*!Down\b/im];
  let end = contents.length;
  for (const m of markers) {
    const hit = m.exec(contents);
    if (hit && hit.index < end) end = hit.index;
  }
  return contents.slice(0, end);
}

/** Natural ordering so that `2_x.sql` sorts before `10_x.sql`. */
export function compareMigrationPaths(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export function buildSchema(files: MigrationFile[]): { schema: Schema; warnings: MigrationWarning[] } {
  const builder = new SchemaBuilder();
  for (const file of [...files].sort((a, b) => compareMigrationPaths(a.path, b.path))) {
    builder.applyScript(upSection(file.contents), file.path);
  }
  return { schema: builder.schema, warnings: builder.warnings };
}

export class SchemaBuilder {
  readonly schema: Schema = emptySchema();
  readonly warnings: MigrationWarning[] = [];

  applyScript(sql: string, path = '<sql>') {
    for (const { text } of splitStatements(sql)) {
      let statements: A.Statement[];
      try {
        statements = parse(text);
      } catch (err) {
        if (!this.applyFallback(text)) {
          this.warnings.push({ path, statement: text.trim(), message: firstLine(err) });
        }
        continue;
      }
      for (const stmt of statements) {
        try {
          this.apply(stmt);
        } catch (err) {
          this.warnings.push({ path, statement: text.trim(), message: firstLine(err) });
        }
      }
    }
  }

  private get inferrer() {
    return new Inferrer(this.schema);
  }

  private relationKey(name: A.QName): string {
    if (name.schema) return qualify(name.schema, name.name);
    const pub = qualify('public', name.name);
    if (this.schema.relations.has(pub)) return pub;
    for (const key of this.schema.relations.keys()) if (key.endsWith(`.${name.name}`)) return key;
    return pub;
  }

  private typeKey(name: A.QName, map: Map<string, unknown>): string {
    if (name.schema) return qualify(name.schema, name.name);
    const pub = qualify('public', name.name);
    if (map.has(pub)) return pub;
    for (const key of map.keys()) if (key.endsWith(`.${name.name}`)) return key;
    return pub;
  }

  private column(def: A.CreateColumnDef, table: string): Column {
    const constraints = def.constraints ?? [];
    const notNull =
      isSerialType(def.dataType.kind === 'array' ? '' : def.dataType.name) ||
      constraints.some(
        (c) =>
          c.type === 'not null' ||
          c.type === 'primary key' ||
          // GENERATED ... AS IDENTITY is always NOT NULL; GENERATED ... AS (expr) STORED is not.
          (c.type === 'add generated' && !c.expression),
      );
    return {
      name: def.name.name,
      type: this.inferrer.resolveDataType(def.dataType),
      nullable: !notNull,
      source: `${table}.${def.name.name}`,
    };
  }

  apply(stmt: A.Statement) {
    const s = this.schema;
    switch (stmt.type) {
      case 'create table': {
        const key = this.relationKey(stmt.name);
        if (s.relations.has(key) && stmt.ifNotExists) return;
        const columns: Column[] = [];
        for (const parent of stmt.inherits ?? []) {
          columns.push(...(s.relations.get(this.relationKey(parent))?.columns ?? []));
        }
        for (const c of stmt.columns) {
          if (c.kind === 'like table') {
            const like = s.relations.get(this.relationKey(c.like));
            columns.push(...(like?.columns ?? []).map((col) => ({ ...col, source: `${stmt.name.name}.${col.name}` })));
          } else {
            columns.push(this.column(c, stmt.name.name));
          }
        }
        for (const constraint of stmt.constraints ?? []) {
          if (constraint.type === 'primary key') {
            for (const col of constraint.columns) {
              const target = columns.find((c) => c.name === col.name);
              if (target) target.nullable = false;
            }
          }
        }
        s.relations.set(key, { schema: stmt.name.schema ?? 'public', name: stmt.name.name, columns });
        return;
      }
      case 'alter table': {
        const key = this.relationKey(stmt.table);
        const rel = s.relations.get(key);
        if (!rel) {
          if (!stmt.ifExists) throw new Error(`ALTER TABLE on unknown table "${stmt.table.name}"`);
          return;
        }
        for (const change of stmt.changes) {
          switch (change.type) {
            case 'rename': {
              s.relations.delete(key);
              rel.name = change.to.name;
              for (const c of rel.columns) c.source = `${rel.name}.${c.name}`;
              s.relations.set(qualify(rel.schema, rel.name), rel);
              break;
            }
            case 'rename column': {
              const col = rel.columns.find((c) => c.name === change.column.name);
              if (col) {
                col.name = change.to.name;
                col.source = `${rel.name}.${col.name}`;
              }
              break;
            }
            case 'add column': {
              if (rel.columns.some((c) => c.name === change.column.name.name)) {
                if (change.ifNotExists) break;
                throw new Error(`Column "${change.column.name.name}" already exists on "${rel.name}"`);
              }
              rel.columns.push(this.column(change.column, rel.name));
              break;
            }
            case 'drop column':
              rel.columns = rel.columns.filter((c) => c.name !== change.column.name);
              break;
            case 'alter column': {
              const col = rel.columns.find((c) => c.name === change.column.name);
              if (!col) break;
              const alter = change.alter;
              if (alter.type === 'set type') col.type = this.inferrer.resolveDataType(alter.dataType);
              else if (alter.type === 'set not null') col.nullable = false;
              else if (alter.type === 'drop not null') col.nullable = true;
              else if (alter.type === 'add generated' && !alter.expression) col.nullable = false;
              break;
            }
            case 'add constraint': {
              const c = change.constraint;
              if (c.type === 'primary key') {
                for (const name of c.columns) {
                  const col = rel.columns.find((x) => x.name === name.name);
                  if (col) col.nullable = false;
                }
              }
              break;
            }
          }
        }
        return;
      }
      case 'drop table':
        for (const name of stmt.names) s.relations.delete(this.relationKey(name));
        return;
      case 'drop type':
        for (const name of stmt.names) {
          s.enums.delete(this.typeKey(name, s.enums));
          s.composites.delete(this.typeKey(name, s.composites));
        }
        return;
      case 'create enum':
        s.enums.set(qualify(stmt.name.schema, stmt.name.name), stmt.values.map((v) => v.value));
        return;
      case 'alter enum': {
        const key = this.typeKey(stmt.name, s.enums);
        const values = s.enums.get(key);
        if (!values) return;
        if (stmt.change.type === 'add value') {
          values.push(stmt.change.add.value);
        } else {
          s.enums.delete(key);
          s.enums.set(qualify(stmt.change.to.schema ?? stmt.name.schema, stmt.change.to.name), values);
          this.retargetType(key, qualify(stmt.change.to.schema ?? stmt.name.schema, stmt.change.to.name));
        }
        return;
      }
      case 'create composite type':
        s.composites.set(
          qualify(stmt.name.schema, stmt.name.name),
          stmt.attributes.map((a) => ({
            name: a.name.name,
            type: this.inferrer.resolveDataType(a.dataType),
            nullable: true,
          })),
        );
        return;
      case 'create view':
      case 'create materialized view': {
        const inferrer = this.inferrer;
        let columns = inferrer.statement(stmt.query) ?? [];
        if (stmt.columnNames) columns = columns.map((c, i) => ({ ...c, name: stmt.columnNames![i]?.name ?? c.name }));
        s.relations.set(qualify(stmt.name.schema, stmt.name.name), {
          schema: stmt.name.schema ?? 'public',
          name: stmt.name.name,
          columns: columns.map((c) => ({ ...c, source: c.source ?? `${stmt.name.name}.${c.name}` })),
          isView: true,
        });
        return;
      }
      case 'create function': {
        const ret = stmt.returns;
        if (!ret) return;
        const inferrer = this.inferrer;
        const returns =
          'kind' in ret && ret.kind === 'table'
            ? {
                kind: 'record' as const,
                columns: ret.columns.map((c) => ({ name: c.name.name, type: inferrer.resolveDataType(c.type), nullable: true })),
              }
            : inferrer.resolveDataType(ret as A.DataTypeDef);
        s.functions.set(qualify(stmt.name.schema, stmt.name.name), {
          returns,
          returnsSet: 'kind' in ret && ret.kind === 'table',
        });
        return;
      }
      case 'drop function':
        s.functions.delete(qualify(stmt.name.schema, stmt.name.name));
        return;
      case 'comment': {
        if (stmt.on.type === 'column') {
          const target = stmt.on.column;
          const rel = s.relations.get(this.relationKey({ name: target.table, schema: target.schema }));
          const col = rel?.columns.find((c) => c.name === target.column);
          if (col) col.comment = stmt.comment;
        } else if (stmt.on.type === 'table' || stmt.on.type === 'view' || stmt.on.type === 'materialized view') {
          const rel = s.relations.get(this.relationKey(stmt.on.name));
          if (rel) rel.comment = stmt.comment;
        }
        return;
      }
    }
  }

  /** Statements pgsql-ast-parser doesn't understand but which matter for types. */
  private applyFallback(text: string): boolean {
    const sql = stripComments(text).trim();
    const ident = `("(?:[^"]|"")+"|[A-Za-z_][\\w$]*)`;
    const qname = `(?:${ident}\\.)?${ident}`;
    const unquote = (n: string | undefined) =>
      n === undefined ? undefined : n.startsWith('"') ? n.slice(1, -1).replace(/""/g, '"') : n.toLowerCase();

    const domain = new RegExp(`^create\\s+domain\\s+${qname}\\s+(?:as\\s+)?([\\s\\S]+?)(?:\\s+(?:not\\s+null|null|default|check|constraint|collate)\\b[\\s\\S]*)?$`, 'i').exec(sql);
    if (domain) {
      const [, schemaName, name, typeText] = domain;
      const type = this.parseTypeText(typeText);
      this.schema.domains.set(qualify(unquote(schemaName), unquote(name)!), type);
      return true;
    }

    const dropView = new RegExp(`^drop\\s+(?:materialized\\s+)?view\\s+(?:if\\s+exists\\s+)?([\\s\\S]+?)(?:\\s+(?:cascade|restrict))?$`, 'i').exec(sql);
    if (dropView) {
      for (const part of dropView[1].split(',')) {
        const m = new RegExp(`^\\s*${qname}\\s*$`).exec(part);
        if (m) this.schema.relations.delete(this.relationKey({ schema: unquote(m[1]), name: unquote(m[2])! }));
      }
      return true;
    }

    const renameView = new RegExp(`^alter\\s+(?:materialized\\s+)?view\\s+(?:if\\s+exists\\s+)?${qname}\\s+rename\\s+to\\s+${ident}$`, 'i').exec(sql);
    if (renameView) {
      const key = this.relationKey({ schema: unquote(renameView[1]), name: unquote(renameView[2])! });
      const rel = this.schema.relations.get(key);
      if (rel) {
        this.schema.relations.delete(key);
        rel.name = unquote(renameView[3])!;
        this.schema.relations.set(qualify(rel.schema, rel.name), rel);
      }
      return true;
    }

    // Statements with no effect on result types.
    return /^(create|drop|alter)\s+(trigger|policy|role|user|publication|subscription|rule|event\s+trigger|statistics|server|foreign\s+data\s+wrapper|operator|aggregate|collation|text\s+search)\b|^(grant|revoke|insert|update|delete|select|set|reset|do|begin|commit|rollback|analyze|vacuum|cluster|reindex|notify|lock|security\s+label|call)\b|^(alter\s+(default\s+privileges|database|schema|index|sequence|function|procedure|type\s+\S+\s+owner|table\s+\S+\s+(owner|enable|disable|force|no\s+force)))\b|^create\s+(or\s+replace\s+)?(procedure|language)\b/i.test(sql);
  }

  private parseTypeText(text: string) {
    try {
      const [stmt] = parse(`SELECT NULL::${text}`);
      if (stmt.type === 'select' && stmt.columns?.[0]?.expr.type === 'cast') {
        return this.inferrer.resolveDataType(stmt.columns[0].expr.to);
      }
    } catch {
      // fall through
    }
    return scalar(text.trim().toLowerCase());
  }

  private retargetType(from: string, to: string) {
    const visit = (cols: Column[]) => {
      for (const c of cols) {
        let t = c.type;
        while (t.kind === 'array') t = t.of;
        if (t.kind === 'scalar' && t.name === from) (t as { name: string }).name = to;
      }
    };
    for (const rel of this.schema.relations.values()) visit(rel.columns);
    for (const cols of this.schema.composites.values()) visit(cols);
  }
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n').filter(Boolean)[0] ?? message;
}
