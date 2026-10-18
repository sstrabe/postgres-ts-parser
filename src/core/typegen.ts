import { Column, Schema, SqlType } from './types';

export interface TypegenOptions {
  /** Postgres type name → TypeScript type, overriding the defaults below. */
  overrides?: Record<string, string>;
}

/** Defaults follow what node-postgres and postgres.js return. */
const DEFAULT_TS_TYPES: Record<string, string> = {
  int2: 'number',
  int4: 'number',
  float4: 'number',
  float8: 'number',
  oid: 'number',
  int8: 'string',
  numeric: 'string',
  money: 'string',
  bool: 'boolean',
  date: 'Date',
  timestamp: 'Date',
  timestamptz: 'Date',
  json: 'unknown',
  jsonb: 'unknown',
  bytea: 'Buffer',
  void: 'void',
  unknown: 'unknown',
  record: 'unknown',
};

const STRING_TYPES = new Set([
  'text', 'varchar', 'bpchar', 'name', 'citext', 'uuid', 'time', 'timetz', 'interval',
  'inet', 'cidr', 'macaddr', 'macaddr8', 'tsvector', 'tsquery', 'xml', 'bit', 'varbit',
  'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange', 'daterange', 'regclass',
  'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle',
]);

export function tsType(type: SqlType, schema: Schema, opts: TypegenOptions = {}): string {
  switch (type.kind) {
    case 'unknown':
      return 'unknown';
    case 'array': {
      const inner = tsType(type.of, schema, opts);
      return /^[\w.]+$/.test(inner) ? `${inner}[]` : `(${inner})[]`;
    }
    case 'record':
      return rowType(type.columns, schema, opts);
    case 'scalar': {
      const short = type.name.startsWith('public.') ? type.name.slice('public.'.length) : type.name;
      const override = opts.overrides?.[type.name] ?? opts.overrides?.[short];
      if (override) return override;
      const labels = schema.enums.get(type.name);
      if (labels) return labels.length ? labels.map((l) => JSON.stringify(l)).join(' | ') : 'never';
      if (type.name in DEFAULT_TS_TYPES) return DEFAULT_TS_TYPES[type.name];
      if (STRING_TYPES.has(type.name)) return 'string';
      return 'unknown';
    }
  }
}

export function columnType(column: Column, schema: Schema, opts: TypegenOptions = {}): string {
  const t = tsType(column.type, schema, opts);
  if (!column.nullable || t === 'unknown') return t;
  return `${t} | null`;
}

export function rowType(columns: Column[], schema: Schema, opts: TypegenOptions = {}): string {
  // Later columns with the same name win, as with node-postgres row objects.
  const byName = new Map<string, Column>();
  for (const c of columns) byName.set(c.name, c);
  if (!byName.size) return 'Record<string, never>';
  const fields = [...byName.values()].map((c) => `${propertyName(c.name)}: ${columnType(c, schema, opts)}`);
  return `{ ${fields.join('; ')} }`;
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

export function applyTemplate(template: string, row: string): string {
  return template.split('{{row}}').join(row);
}
