/** A Postgres type as far as type inference cares about it. */
export type SqlType =
  | { kind: 'scalar'; name: string }
  | { kind: 'array'; of: SqlType }
  | { kind: 'record'; columns: Column[] }
  | { kind: 'unknown' };

export interface Column {
  name: string;
  type: SqlType;
  nullable: boolean;
  /** Where the column comes from, for hovers ("users.email"). */
  source?: string;
  comment?: string;
}

export interface Relation {
  schema: string;
  name: string;
  columns: Column[];
  comment?: string;
  isView?: boolean;
}

export interface FunctionSignature {
  /** Scalar return type, or the columns of a `RETURNS TABLE (...)` / `SETOF table` function. */
  returns: SqlType;
  returnsSet: boolean;
}

export interface Schema {
  /** Keyed by `schema.name`. */
  relations: Map<string, Relation>;
  /** Enum labels, keyed by `schema.name`. */
  enums: Map<string, string[]>;
  /** Composite types, keyed by `schema.name`. */
  composites: Map<string, Column[]>;
  /** Domains resolve to their base type, keyed by `schema.name`. */
  domains: Map<string, SqlType>;
  /** User-defined functions, keyed by `schema.name`. */
  functions: Map<string, FunctionSignature>;
}

export interface SqlDiagnostic {
  message: string;
  /** Offsets into the SQL text. */
  start: number;
  end: number;
  severity: 'error' | 'warning';
}

export const scalar = (name: string): SqlType => ({ kind: 'scalar', name });
export const UNKNOWN: SqlType = { kind: 'unknown' };

export function emptySchema(): Schema {
  return {
    relations: new Map(),
    enums: new Map(),
    composites: new Map(),
    domains: new Map(),
    functions: new Map(),
  };
}

const TYPE_ALIASES: Record<string, string> = {
  int: 'int4',
  integer: 'int4',
  smallint: 'int2',
  bigint: 'int8',
  serial: 'int4',
  serial4: 'int4',
  smallserial: 'int2',
  serial2: 'int2',
  bigserial: 'int8',
  serial8: 'int8',
  real: 'float4',
  float: 'float8',
  'double precision': 'float8',
  decimal: 'numeric',
  boolean: 'bool',
  'character varying': 'varchar',
  character: 'bpchar',
  char: 'bpchar',
  timestamp: 'timestamp',
  'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz',
  time: 'time',
  'time without time zone': 'time',
  'time with time zone': 'timetz',
  'bit varying': 'varbit',
};

const SERIAL_TYPES = new Set(['serial', 'serial4', 'smallserial', 'serial2', 'bigserial', 'serial8']);

export function normalizeTypeName(name: string): string {
  const lower = name.toLowerCase();
  return TYPE_ALIASES[lower] ?? lower;
}

export function isSerialType(name: string): boolean {
  return SERIAL_TYPES.has(name.toLowerCase());
}

export const BUILTIN_TYPES = new Set([
  'int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money', 'oid',
  'text', 'varchar', 'bpchar', 'name', 'citext', 'uuid',
  'bool', 'date', 'timestamp', 'timestamptz', 'time', 'timetz', 'interval',
  'json', 'jsonb', 'bytea', 'inet', 'cidr', 'macaddr', 'macaddr8',
  'tsvector', 'tsquery', 'xml', 'bit', 'varbit', 'point', 'line', 'lseg', 'box',
  'path', 'polygon', 'circle', 'int4range', 'int8range', 'numrange', 'tsrange',
  'tstzrange', 'daterange', 'regclass', 'void', 'record', 'unknown',
]);

export function qualify(schema: string | undefined, name: string): string {
  return `${schema ?? 'public'}.${name}`;
}
