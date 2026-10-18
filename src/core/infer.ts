import type * as A from 'pgsql-ast-parser';
import {
  Column,
  Schema,
  SqlDiagnostic,
  SqlType,
  UNKNOWN,
  normalizeTypeName,
  qualify,
  scalar,
} from './types';

interface Typed {
  type: SqlType;
  nullable: boolean;
}

interface Source {
  alias: string;
  columns: Column[];
  /** Every column may be NULL because of an outer join. */
  nullable: boolean;
  /** The relation could not be resolved; refs into it are not reported. */
  opaque: boolean;
  /** Columns joined with USING, which are not ambiguous and appear once in `*`. */
  using?: Set<string>;
}

class Scope {
  sources: Source[] = [];
  ctes = new Map<string, Column[]>();
  /** `sourceIndex:column` keys proven non-null by the WHERE clause. */
  notNull = new Set<string>();

  constructor(readonly parent?: Scope) {}

  cte(name: string): Column[] | undefined {
    return this.ctes.get(name) ?? this.parent?.cte(name);
  }
}

interface Resolved extends Typed {
  column?: Column;
}

const ok = (type: SqlType, nullable = true): Typed => ({ type, nullable });
const BOOL = scalar('bool');
const TEXT = scalar('text');
const INT4 = scalar('int4');
const INT8 = scalar('int8');
const NUMERIC = scalar('numeric');
const FLOAT8 = scalar('float8');
const JSON_T = scalar('json');
const JSONB = scalar('jsonb');
const TIMESTAMPTZ = scalar('timestamptz');

const NUMERIC_RANK = ['int2', 'int4', 'int8', 'numeric', 'float4', 'float8'];

function scalarName(t: SqlType): string | undefined {
  return t.kind === 'scalar' ? t.name : undefined;
}

export class Inferrer {
  readonly diagnostics: SqlDiagnostic[] = [];

  constructor(readonly schema: Schema) {}

  // ---------------------------------------------------------------- types

  resolveDataType(def: A.DataTypeDef): SqlType {
    if (def.kind === 'array') return { kind: 'array', of: this.resolveDataType(def.arrayOf) };
    const user = def.schema !== 'pg_catalog' ? this.findUserType(def.schema, def.name) : undefined;
    return user ?? scalar(normalizeTypeName(def.name));
  }

  private findUserType(schemaName: string | undefined, name: string): SqlType | undefined {
    const key = this.lookupKey(schemaName, name, (k) =>
      this.schema.enums.has(k) || this.schema.composites.has(k) || this.schema.domains.has(k),
    );
    if (!key) return undefined;
    if (this.schema.enums.has(key)) return scalar(key);
    if (this.schema.domains.has(key)) return this.schema.domains.get(key)!;
    return { kind: 'record', columns: this.schema.composites.get(key)! };
  }

  /** Resolves `name` against `public` first, then any schema, honouring an explicit schema. */
  private lookupKey(schemaName: string | undefined, name: string, has: (key: string) => boolean): string | undefined {
    if (schemaName) {
      const key = qualify(schemaName, name);
      return has(key) ? key : undefined;
    }
    const pub = qualify('public', name);
    if (has(pub)) return pub;
    for (const map of [this.schema.relations, this.schema.enums, this.schema.composites, this.schema.domains, this.schema.functions]) {
      for (const key of map.keys()) {
        if (key.endsWith(`.${name}`) && has(key)) return key;
      }
    }
    return undefined;
  }

  private report(node: A.PGNode | undefined, message: string) {
    const loc = node?._location;
    this.diagnostics.push({ message, start: loc?.start ?? 0, end: loc?.end ?? 0, severity: 'error' });
  }

  // ----------------------------------------------------------- statements

  /** Returns the row columns of a statement, or `null` when it returns no rows. */
  statement(stmt: A.Statement, parent?: Scope): Column[] | null {
    switch (stmt.type) {
      case 'select':
      case 'union':
      case 'union all':
      case 'values':
      case 'with':
      case 'with recursive':
      case 'insert':
      case 'update':
      case 'delete':
        return this.binding(stmt, parent);
      case 'prepare':
        return this.statement(stmt.statement, parent);
      case 'show':
        return [{ name: stmt.variable.name, type: TEXT, nullable: false }];
      default:
        return null;
    }
  }

  private binding(stmt: A.WithStatementBinding | A.ValuesStatement, parent?: Scope): Column[] | null {
    switch (stmt.type) {
      case 'select':
        return this.select(stmt, new Scope(parent));
      case 'union':
      case 'union all': {
        const left = this.binding(stmt.left, parent) ?? [];
        const right = this.binding(stmt.right, parent) ?? [];
        return left.map((c, i) => ({
          ...c,
          type: c.type.kind === 'unknown' && right[i] ? right[i].type : c.type,
          nullable: c.nullable || (right[i]?.nullable ?? true),
        }));
      }
      case 'values':
        return this.values(stmt, new Scope(parent));
      case 'with': {
        const scope = new Scope(parent);
        for (const b of stmt.bind) {
          scope.ctes.set(b.alias.name, this.binding(b.statement, scope) ?? []);
        }
        return this.binding(stmt.in, scope);
      }
      case 'with recursive': {
        const scope = new Scope(parent);
        // Type the non-recursive term first, then let the recursive term see it.
        const seed = this.binding(stmt.bind.left, scope) ?? [];
        const named = (cols: Column[]) =>
          stmt.columnNames.length ? cols.map((c, i) => ({ ...c, name: stmt.columnNames[i]?.name ?? c.name })) : cols;
        scope.ctes.set(stmt.alias.name, named(seed));
        scope.ctes.set(stmt.alias.name, named(this.binding(stmt.bind, scope) ?? seed));
        return this.binding(stmt.in, scope);
      }
      case 'insert':
        return this.insert(stmt, new Scope(parent));
      case 'update':
        return this.update(stmt, new Scope(parent));
      case 'delete':
        return this.delete(stmt, new Scope(parent));
    }
  }

  private values(stmt: A.ValuesStatement, scope: Scope): Column[] {
    const rows = stmt.values.map((row) => row.map((e) => this.expr(e, scope)));
    const width = Math.max(0, ...rows.map((r) => r.length));
    return Array.from({ length: width }, (_, i) => {
      const cells = rows.map((r) => r[i]).filter(Boolean);
      const known = cells.find((c) => c.type.kind !== 'unknown');
      return {
        name: `column${i + 1}`,
        type: known?.type ?? UNKNOWN,
        nullable: cells.some((c) => c.nullable),
      };
    });
  }

  private select(stmt: A.SelectFromStatement, scope: Scope): Column[] {
    for (const from of stmt.from ?? []) this.addFrom(from, scope);
    if (stmt.where) {
      this.expr(stmt.where, scope);
      this.collectNotNull(stmt.where, scope);
    }
    if (stmt.having) this.expr(stmt.having, scope);
    return this.selectList(stmt.columns ?? [], scope);
  }

  private insert(stmt: A.InsertStatement, scope: Scope): Column[] | null {
    const target = this.addTable(stmt.into, stmt.into.alias ?? stmt.into.name, scope);
    if (target && !target.opaque) {
      for (const col of stmt.columns ?? []) {
        if (!target.columns.some((c) => c.name === col.name)) {
          this.report(col, `Column "${col.name}" does not exist on "${stmt.into.name}".`);
        }
      }
    }
    // The inserted rows are typed in their own scope; RETURNING only sees the target.
    this.binding(stmt.insert, scope.parent);
    if (stmt.onConflict && typeof stmt.onConflict.do === 'object') {
      for (const set of stmt.onConflict.do.sets) this.expr(set.value, scope);
    }
    return stmt.returning ? this.selectList(stmt.returning, scope) : null;
  }

  private update(stmt: A.UpdateStatement, scope: Scope): Column[] | null {
    const target = this.addTable(stmt.table, stmt.table.alias ?? stmt.table.name, scope);
    if (stmt.from) this.addFrom(stmt.from, scope);
    for (const set of stmt.sets) {
      if (target && !target.opaque && !target.columns.some((c) => c.name === set.column.name)) {
        this.report(set.column, `Column "${set.column.name}" does not exist on "${stmt.table.name}".`);
      }
      this.expr(set.value, scope);
    }
    if (stmt.where) {
      this.expr(stmt.where, scope);
      this.collectNotNull(stmt.where, scope);
    }
    return stmt.returning ? this.selectList(stmt.returning, scope) : null;
  }

  private delete(stmt: A.DeleteStatement, scope: Scope): Column[] | null {
    this.addTable(stmt.from, stmt.from.alias ?? stmt.from.name, scope);
    if (stmt.where) {
      this.expr(stmt.where, scope);
      this.collectNotNull(stmt.where, scope);
    }
    return stmt.returning ? this.selectList(stmt.returning, scope) : null;
  }

  // ---------------------------------------------------------------- FROM

  private addTable(name: A.QName, alias: string, scope: Scope): Source | undefined {
    let columns: Column[] | undefined;
    if (!name.schema) columns = scope.cte(name.name);
    if (!columns) {
      const key = this.lookupKey(name.schema, name.name, (k) => this.schema.relations.has(k));
      columns = key ? this.schema.relations.get(key)!.columns : undefined;
    }
    if (!columns) {
      this.report(name, `Table "${name.schema ? `${name.schema}.` : ''}${name.name}" is not defined by any migration.`);
    }
    const source: Source = { alias, columns: columns ?? [], nullable: false, opaque: !columns };
    scope.sources.push(source);
    return source;
  }

  private addFrom(from: A.From, scope: Scope) {
    const before = scope.sources.length;
    let source: Source;
    switch (from.type) {
      case 'table': {
        source = this.addTable(from.name, from.name.alias ?? from.name.name, scope)!;
        if (from.name.columnNames) source.columns = renameColumns(source.columns, from.name.columnNames);
        break;
      }
      case 'statement': {
        // Subqueries see outer sources only when LATERAL.
        const columns = this.binding(from.statement, from.lateral ? scope : scope.parent) ?? [];
        source = {
          alias: from.alias,
          columns: from.columnNames ? renameColumns(columns, from.columnNames) : columns,
          nullable: false,
          opaque: false,
        };
        scope.sources.push(source);
        break;
      }
      case 'call': {
        source = this.fromCall(from, scope);
        scope.sources.push(source);
        break;
      }
    }

    const join = from.join;
    if (!join) return;
    if (join.type === 'LEFT JOIN' || join.type === 'FULL JOIN') source.nullable = true;
    if (join.type === 'RIGHT JOIN' || join.type === 'FULL JOIN') {
      for (let i = 0; i < before; i++) scope.sources[i].nullable = true;
    }
    if (join.using) {
      const names = new Set(join.using.map((u) => u.name));
      source.using = names;
      for (const u of join.using) {
        const left = scope.sources.slice(0, before).some((s) => s.opaque || s.columns.some((c) => c.name === u.name));
        if (!source.opaque && !source.columns.some((c) => c.name === u.name)) {
          this.report(u, `Column "${u.name}" does not exist on "${source.alias}".`);
        } else if (!left) {
          this.report(u, `Column "${u.name}" does not exist on the left side of the join.`);
        }
      }
    }
    if (join.on) this.expr(join.on, scope);
  }

  private fromCall(from: A.FromCall, scope: Scope): Source {
    const alias = from.alias?.name ?? from.function.name;
    const fnKey = this.lookupKey(from.function.schema, from.function.name, (k) => this.schema.functions.has(k));
    const userFn = fnKey ? this.schema.functions.get(fnKey) : undefined;
    let columns: Column[];
    if (userFn?.returns.kind === 'record') {
      columns = userFn.returns.columns;
    } else {
      const result = this.call(from, scope);
      columns = [{ name: alias, type: result.type, nullable: result.nullable }];
    }
    if (from.alias?.columns) columns = renameColumns(columns, from.alias.columns);
    if (from.withOrdinality) columns = [...columns, { name: 'ordinality', type: INT8, nullable: false }];
    return { alias, columns, nullable: false, opaque: false };
  }

  // --------------------------------------------------------- select list

  private selectList(list: A.SelectedColumn[], scope: Scope): Column[] {
    const out: Column[] = [];
    for (const item of list) {
      const e = item.expr;
      if (e.type === 'ref' && e.name === '*') {
        out.push(...this.star(e, scope));
        continue;
      }
      const t = this.expr(e, scope);
      const resolved = t as Resolved;
      out.push({
        name: item.alias?.name ?? columnName(e),
        type: t.type,
        nullable: t.nullable,
        source: resolved.column?.source,
        comment: resolved.column?.comment,
      });
    }
    return out;
  }

  private star(ref: A.ExprRef, scope: Scope): Column[] {
    const sources = ref.table ? scope.sources.filter((s) => s.alias === ref.table!.name) : scope.sources;
    if (ref.table && !sources.length) {
      this.report(ref.table, `Missing FROM-clause entry for "${ref.table.name}".`);
      return [];
    }
    const out: Column[] = [];
    const seenUsing = new Set<string>();
    for (const source of sources) {
      const index = scope.sources.indexOf(source);
      for (const c of source.columns) {
        if (!ref.table && source.using?.has(c.name)) {
          if (seenUsing.has(c.name)) continue;
        }
        if (!ref.table) seenUsing.add(c.name);
        out.push({ ...c, nullable: this.columnNullable(scope, index, source, c) });
      }
    }
    return out;
  }

  private columnNullable(scope: Scope, index: number, source: Source, c: Column): boolean {
    if (scope.notNull.has(`${index}:${c.name}`)) return false;
    return c.nullable || source.nullable;
  }

  // ---------------------------------------------------------- narrowing

  /** Marks columns that the WHERE clause proves are non-null (`x IS NOT NULL`, `x = $1`, ...). */
  private collectNotNull(where: A.Expr, scope: Scope) {
    const mark = (e: A.Expr) => {
      if (e.type !== 'ref' || e.name === '*') return;
      const hit = this.findColumn(e, scope);
      if (hit) scope.notNull.add(`${hit.index}:${e.name}`);
    };
    const visit = (e: A.Expr) => {
      if (e.type === 'binary') {
        if (e.op === 'AND') {
          visit(e.left);
          visit(e.right);
        } else if (['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'ILIKE', 'IN'].includes(e.op)) {
          mark(e.left);
          mark(e.right);
        }
      } else if (e.type === 'unary' && (e.op === 'IS NOT NULL' || e.op === 'IS TRUE' || e.op === 'IS FALSE')) {
        mark(e.operand);
      } else if (e.type === 'ternary' && e.op === 'BETWEEN') {
        mark(e.value);
      }
    };
    visit(where);
  }

  // ---------------------------------------------------------- column refs

  private findColumn(ref: A.ExprRef, scope: Scope): { index: number; source: Source; column?: Column } | undefined {
    const candidates = ref.table ? scope.sources.filter((s) => s.alias === ref.table!.name) : scope.sources;
    for (const source of candidates) {
      const column = source.columns.find((c) => c.name === ref.name);
      if (column || source.opaque) return { index: scope.sources.indexOf(source), source, column };
    }
    return undefined;
  }

  private ref(ref: A.ExprRef, scope: Scope): Resolved {
    if (ref.name === '*') return ok(UNKNOWN);
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      if (ref.table && !s.sources.some((src) => src.alias === ref.table!.name)) continue;
      const matches = (ref.table ? s.sources.filter((src) => src.alias === ref.table!.name) : s.sources)
        .map((source) => ({ source, column: source.columns.find((c) => c.name === ref.name) }))
        .filter((m) => m.column || m.source.opaque);
      if (!matches.length) {
        // `SELECT u FROM users u` / `row_to_json(u)` reference the whole row.
        const whole = !ref.table && s.sources.find((src) => src.alias === ref.name);
        if (whole) return ok({ kind: 'record', columns: whole.columns }, whole.nullable);
        if (ref.table) {
          this.report(ref, `Column "${ref.name}" does not exist on "${ref.table.name}".`);
          return ok(UNKNOWN);
        }
        continue;
      }
      const real = matches.filter((m) => m.column);
      if (real.length > 1 && !real.every((m) => m.source.using?.has(ref.name) || real[0] === m)) {
        this.report(ref, `Column reference "${ref.name}" is ambiguous.`);
      }
      const hit = real[0] ?? matches[0];
      if (!hit.column) return ok(UNKNOWN);
      const index = s.sources.indexOf(hit.source);
      return { type: hit.column.type, nullable: this.columnNullable(s, index, hit.source, hit.column), column: hit.column };
    }
    if (ref.table) {
      this.report(ref.table, `Missing FROM-clause entry for "${ref.table.name}".`);
    } else if (!this.anyOpaque(scope)) {
      this.report(ref, `Column "${ref.name}" does not exist.`);
    }
    return ok(UNKNOWN);
  }

  private anyOpaque(scope: Scope): boolean {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      if (s.sources.some((src) => src.opaque)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------- expressions

  expr(e: A.Expr, scope: Scope): Typed {
    switch (e.type) {
      case 'ref':
        return this.ref(e, scope);
      case 'parameter':
        return ok(UNKNOWN);
      case 'integer':
        return ok(INT4, false);
      case 'numeric':
        return ok(NUMERIC, false);
      case 'string':
        return ok(TEXT, false);
      case 'boolean':
        return ok(BOOL, false);
      case 'null':
        return ok(UNKNOWN, true);
      case 'default':
        return ok(UNKNOWN);
      case 'constant':
        return ok(this.resolveDataType(e.dataType), e.value === null);
      case 'cast': {
        const inner = this.expr(e.operand, scope);
        return { type: this.resolveDataType(e.to), nullable: inner.nullable };
      }
      case 'keyword':
        return ok(keywordType(e.keyword), false);
      case 'extract':
        return ok(NUMERIC, this.expr(e.from, scope).nullable);
      case 'substring':
      case 'overlay': {
        const v = this.expr(e.value, scope);
        for (const x of e.type === 'overlay' ? [e.placing, e.from, e.for] : [e.from, e.for]) if (x) this.expr(x, scope);
        return ok(TEXT, v.nullable);
      }
      case 'member': {
        const operand = this.expr(e.operand, scope);
        return ok(e.op === '->>' ? TEXT : scalarName(operand.type) === 'json' ? JSON_T : JSONB, true);
      }
      case 'arrayIndex': {
        const arr = this.expr(e.array, scope);
        this.expr(e.index, scope);
        return ok(arr.type.kind === 'array' ? arr.type.of : UNKNOWN, true);
      }
      case 'list':
      case 'array': {
        const items = e.expressions.map((x) => this.expr(x, scope));
        const elem = items.find((i) => i.type.kind !== 'unknown')?.type ?? UNKNOWN;
        return e.type === 'array' ? ok({ kind: 'array', of: elem }, false) : ok(elem, items.some((i) => i.nullable));
      }
      case 'array select': {
        const cols = this.binding(e.select, scope);
        return ok({ kind: 'array', of: cols?.[0]?.type ?? UNKNOWN }, false);
      }
      case 'unary': {
        const operand = this.expr(e.operand, scope);
        if (e.op === '+' || e.op === '-') return operand;
        if (e.op === 'NOT') return ok(BOOL, operand.nullable);
        return ok(BOOL, false);
      }
      case 'ternary': {
        const parts = [e.value, e.lo, e.hi].map((x) => this.expr(x, scope));
        return ok(BOOL, parts.some((p) => p.nullable));
      }
      case 'binary':
        return this.binary(e, scope);
      case 'case': {
        if (e.value) this.expr(e.value, scope);
        const branches = e.whens.map((w) => {
          this.expr(w.when, scope);
          return this.expr(w.value, scope);
        });
        if (e.else) branches.push(this.expr(e.else, scope));
        const known = branches.find((b) => b.type.kind !== 'unknown');
        return ok(known?.type ?? UNKNOWN, !e.else || branches.some((b) => b.nullable));
      }
      case 'call':
        return this.call(e, scope);
      case 'select':
      case 'union':
      case 'union all':
      case 'values':
      case 'with':
      case 'with recursive': {
        const cols = this.binding(e, scope);
        return ok(cols?.[0]?.type ?? UNKNOWN, true);
      }
      default:
        return ok(UNKNOWN);
    }
  }

  private binary(e: A.ExprBinary, scope: Scope): Typed {
    const l = this.expr(e.left, scope);
    const r = this.expr(e.right, scope);
    const nullable = l.nullable || r.nullable;
    switch (e.op) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
      case '^':
        return ok(arithmetic(e.op, l.type, r.type), nullable);
      case '||': {
        if (l.type.kind === 'array') return ok(l.type, nullable);
        if (r.type.kind === 'array') return ok(r.type, nullable);
        if (scalarName(l.type) === 'jsonb' || scalarName(r.type) === 'jsonb') return ok(JSONB, nullable);
        return ok(TEXT, nullable);
      }
      case '#-':
        return ok(JSONB, nullable);
      case '#>>':
        return ok(TEXT, true);
      case 'AT TIME ZONE':
        return ok(scalarName(l.type) === 'timestamptz' ? scalar('timestamp') : TIMESTAMPTZ, nullable);
      case '|':
      case '&':
      case '#':
      case '<<':
      case '>>':
        return ok(l.type.kind !== 'unknown' ? l.type : r.type, nullable);
      default:
        // Comparison, logic, LIKE, IN, containment, ...
        return ok(BOOL, nullable);
    }
  }

  private call(e: A.ExprCall, scope: Scope): Typed {
    const args = e.args.map((a) => this.expr(a, scope));
    if (e.filter) this.expr(e.filter, scope);
    for (const o of e.orderBy ?? []) this.expr(o.by, scope);
    for (const p of e.over?.partitionBy ?? []) this.expr(p, scope);
    for (const o of e.over?.orderBy ?? []) this.expr(o.by, scope);

    const fnKey = e.function.schema !== 'pg_catalog'
      ? this.lookupKey(e.function.schema, e.function.name, (k) => this.schema.functions.has(k))
      : undefined;
    if (fnKey) {
      const fn = this.schema.functions.get(fnKey)!;
      return ok(fn.returns, true);
    }

    const name = e.function.name.toLowerCase();
    const first = args[0] ?? ok(UNKNOWN);
    const anyNullable = args.some((a) => a.nullable);
    const firstKnown = args.find((a) => a.type.kind !== 'unknown')?.type ?? UNKNOWN;
    switch (name) {
      case 'count':
        return ok(INT8, false);
      case 'row_number':
      case 'rank':
      case 'dense_rank':
      case 'ntile':
        return ok(INT8, false);
      case 'percent_rank':
      case 'cume_dist':
        return ok(FLOAT8, false);
      case 'sum': {
        const t = scalarName(first.type);
        if (t === 'int2' || t === 'int4') return ok(INT8, true);
        if (t === 'float4' || t === 'float8' || t === 'money' || t === 'interval') return ok(first.type, true);
        return ok(NUMERIC, true);
      }
      case 'avg': {
        const t = scalarName(first.type);
        return ok(t === 'float4' || t === 'float8' ? FLOAT8 : t === 'interval' ? first.type : NUMERIC, true);
      }
      case 'min':
      case 'max':
      case 'any_value':
      case 'first_value':
      case 'last_value':
      case 'nth_value':
      case 'lag':
      case 'lead':
        return ok(first.type, true);
      case 'stddev':
      case 'stddev_pop':
      case 'stddev_samp':
      case 'variance':
      case 'var_pop':
      case 'var_samp':
        return ok(scalarName(first.type)?.startsWith('float') ? FLOAT8 : NUMERIC, true);
      case 'bool_and':
      case 'bool_or':
      case 'every':
        return ok(BOOL, true);
      case 'array_agg':
        return ok(first.type.kind === 'array' ? first.type : { kind: 'array', of: first.type }, true);
      case 'string_agg':
        return ok(TEXT, true);
      case 'json_agg':
      case 'json_object_agg':
        return ok(JSON_T, true);
      case 'jsonb_agg':
      case 'jsonb_object_agg':
        return ok(JSONB, true);
      case 'coalesce':
        return ok(firstKnown, args.every((a) => a.nullable));
      case 'nullif':
        return ok(first.type, true);
      case 'greatest':
      case 'least':
        return ok(firstKnown, args.every((a) => a.nullable));
      case 'exists':
        return ok(BOOL, false);
      case 'any':
      case 'all':
      case 'some':
        return ok(first.type.kind === 'array' ? first.type.of : first.type, first.nullable);
      case 'now':
      case 'transaction_timestamp':
      case 'statement_timestamp':
      case 'clock_timestamp':
        return ok(TIMESTAMPTZ, false);
      case 'date_trunc':
        return ok(args[1]?.type.kind === 'scalar' ? args[1].type : TIMESTAMPTZ, anyNullable);
      case 'date_part':
        return ok(FLOAT8, anyNullable);
      case 'age':
        return ok(scalar('interval'), anyNullable);
      case 'to_timestamp':
        return ok(TIMESTAMPTZ, anyNullable);
      case 'to_date':
        return ok(scalar('date'), anyNullable);
      case 'make_interval':
        return ok(scalar('interval'), anyNullable);
      case 'gen_random_uuid':
      case 'uuid_generate_v4':
      case 'uuid_generate_v1':
        return ok(scalar('uuid'), false);
      case 'random':
        return ok(FLOAT8, false);
      case 'length':
      case 'char_length':
      case 'character_length':
      case 'octet_length':
      case 'strpos':
      case 'position':
      case 'array_length':
      case 'cardinality':
      case 'array_position':
        return ok(INT4, true);
      case 'abs':
      case 'ceil':
      case 'ceiling':
      case 'floor':
      case 'round':
      case 'trunc':
      case 'sign':
        return ok(first.type, anyNullable);
      case 'sqrt':
      case 'power':
      case 'pow':
      case 'exp':
      case 'ln':
      case 'log':
        return ok(scalarName(first.type) === 'numeric' ? NUMERIC : FLOAT8, anyNullable);
      case 'concat':
      case 'concat_ws':
        return ok(TEXT, false);
      case 'lower':
      case 'upper':
      case 'initcap':
      case 'trim':
      case 'btrim':
      case 'ltrim':
      case 'rtrim':
      case 'replace':
      case 'regexp_replace':
      case 'substr':
      case 'left':
      case 'right':
      case 'lpad':
      case 'rpad':
      case 'repeat':
      case 'reverse':
      case 'md5':
      case 'format':
      case 'to_char':
      case 'quote_ident':
      case 'quote_literal':
      case 'split_part':
      case 'translate':
      case 'encode':
      case 'array_to_string':
      case 'jsonb_typeof':
      case 'json_typeof':
      case 'pg_typeof':
        return ok(TEXT, anyNullable);
      case 'to_json':
      case 'row_to_json':
      case 'json_build_object':
      case 'json_build_array':
      case 'array_to_json':
      case 'json_object':
        return ok(JSON_T, name === 'json_build_object' || name === 'json_build_array' ? false : anyNullable);
      case 'to_jsonb':
      case 'jsonb_build_object':
      case 'jsonb_build_array':
      case 'jsonb_set':
      case 'jsonb_insert':
      case 'jsonb_strip_nulls':
      case 'jsonb_path_query_first':
        return ok(JSONB, name === 'jsonb_build_object' || name === 'jsonb_build_array' ? false : anyNullable);
      case 'json_extract_path_text':
      case 'jsonb_extract_path_text':
        return ok(TEXT, true);
      case 'array_append':
      case 'array_prepend':
      case 'array_cat':
      case 'array_remove':
      case 'array_replace':
        return ok(args.find((a) => a.type.kind === 'array')?.type ?? UNKNOWN, anyNullable);
      case 'unnest':
        return ok(first.type.kind === 'array' ? first.type.of : UNKNOWN, true);
      case 'generate_series':
        return ok(firstKnown, false);
      case 'regexp_match':
      case 'regexp_split_to_array':
      case 'string_to_array':
        return ok({ kind: 'array', of: TEXT }, true);
      case 'regexp_split_to_table':
        return ok(TEXT, false);
      case 'starts_with':
      case 'isfinite':
        return ok(BOOL, anyNullable);
      case 'nextval':
      case 'currval':
      case 'lastval':
        return ok(INT8, false);
      case 'current_setting':
      case 'version':
        return ok(TEXT, false);
      case 'to_tsvector':
        return ok(scalar('tsvector'), anyNullable);
      case 'to_tsquery':
      case 'plainto_tsquery':
      case 'websearch_to_tsquery':
      case 'phraseto_tsquery':
        return ok(scalar('tsquery'), anyNullable);
      case 'ts_rank':
      case 'ts_rank_cd':
        return ok(scalar('float4'), anyNullable);
      default:
        return ok(UNKNOWN);
    }
  }
}

function arithmetic(op: string, l: SqlType, r: SqlType): SqlType {
  const ln = scalarName(l);
  const rn = scalarName(r);
  if (l.kind === 'unknown') return r;
  if (r.kind === 'unknown') return l;
  const li = NUMERIC_RANK.indexOf(ln ?? '');
  const ri = NUMERIC_RANK.indexOf(rn ?? '');
  if (li >= 0 && ri >= 0) {
    const t = NUMERIC_RANK[Math.max(li, ri)];
    return scalar(op === '^' && t !== 'numeric' ? 'float8' : t);
  }
  const temporal = new Set(['date', 'timestamp', 'timestamptz', 'time', 'timetz']);
  if (ln && rn && temporal.has(ln) && temporal.has(rn) && op === '-') {
    return ln === 'date' && rn === 'date' ? INT4 : scalar('interval');
  }
  if (ln === 'date' && rn === 'interval') return scalar('timestamp');
  if (ln === 'interval' && rn === 'date') return scalar('timestamp');
  if (ln && temporal.has(ln)) return l;
  if (rn && temporal.has(rn)) return r;
  return l;
}

function keywordType(k: A.ValueKeyword): SqlType {
  switch (k) {
    case 'current_date':
      return scalar('date');
    case 'current_timestamp':
      return TIMESTAMPTZ;
    case 'localtimestamp':
      return scalar('timestamp');
    case 'current_time':
      return scalar('timetz');
    case 'localtime':
      return scalar('time');
    default:
      return scalar('name');
  }
}

/** The column name Postgres assigns to an un-aliased select item. */
export function columnName(e: A.Expr): string {
  switch (e.type) {
    case 'ref':
      return e.name;
    case 'call':
      return e.function.name;
    case 'cast':
      return e.operand.type === 'ref' || e.operand.type === 'call' || e.operand.type === 'cast'
        ? columnName(e.operand)
        : e.to.kind === 'array'
          ? '?column?'
          : normalizeTypeName(e.to.name);
    case 'keyword':
      return e.keyword;
    case 'case':
      return 'case';
    case 'array':
    case 'array select':
      return 'array';
    case 'extract':
      return 'extract';
    case 'substring':
      return 'substring';
    case 'overlay':
      return 'overlay';
    case 'select':
    case 'union':
    case 'union all':
    case 'with': {
      const sel = e.type === 'select' ? e : undefined;
      const first = sel?.columns?.[0];
      return first ? (first.alias?.name ?? columnName(first.expr)) : '?column?';
    }
    default:
      return '?column?';
  }
}

function renameColumns(columns: Column[], names: A.Name[]): Column[] {
  return columns.map((c, i) => (names[i] ? { ...c, name: names[i].name } : c));
}
