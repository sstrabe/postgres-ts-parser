import type * as TS from 'typescript';
import { parse } from 'pgsql-ast-parser';
import type * as A from 'pgsql-ast-parser';
import { Inferrer } from './infer';
import { Column, Schema, SqlDiagnostic } from './types';
import { TypegenOptions, applyTemplate, rowType } from './typegen';

export interface SqlTemplate {
  /** The SQL with every `${...}` replaced by `$1`, `$2`, ... */
  sql: string;
  /** Document range of the tag expression (`sql`, `db.sql`). */
  tagStart: number;
  tagEnd: number;
  /** Document range of the whole tagged template. */
  start: number;
  end: number;
  /** Offset of the opening backtick, and of the first `${` or the closing backtick. */
  templateStart: number;
  headEnd: number;
  /** Range of an existing `<...>` type argument list, if any. */
  typeArgs?: { start: number; end: number; text: string; generated: boolean };
  /** Maps an offset in `sql` back to an offset in the document. */
  toDocumentOffset(sqlOffset: number): number;
}

interface Segment {
  sqlStart: number;
  docStart: number;
  length: number;
  /** Placeholders map every offset to the start of the interpolation. */
  placeholder: boolean;
}

export interface FoundTemplates {
  templates: SqlTemplate[];
  /** The file has imports or exports, so declarations appended to it stay file-local. */
  isModule: boolean;
}

/** `ts` is passed in so the tsserver plugin can use the editor's own TypeScript. */
export function findSqlTemplates(ts: typeof TS, fileName: string, text: string, tags: string[]): SqlTemplate[] {
  return scanSqlTemplates(ts, fileName, text, tags).templates;
}

export function scanSqlTemplates(ts: typeof TS, fileName: string, text: string, tags: string[]): FoundTemplates {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const tagSet = new Set(tags);
  const out: SqlTemplate[] = [];

  const visit = (node: TS.Node) => {
    if (ts.isTaggedTemplateExpression(node) && tagSet.has(tagName(ts, node.tag))) {
      out.push(toTemplate(ts, node, source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const isModule = source.statements.some(
    (st) =>
      ts.isImportDeclaration(st) ||
      ts.isImportEqualsDeclaration(st) ||
      ts.isExportDeclaration(st) ||
      ts.isExportAssignment(st) ||
      (ts.canHaveModifiers(st) && !!ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)),
  );
  return { templates: out, isModule };
}

function tagName(ts: typeof TS, tag: TS.Expression): string {
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text;
  return '';
}

function toTemplate(ts: typeof TS, node: TS.TaggedTemplateExpression, source: TS.SourceFile): SqlTemplate {
  const text = source.text;
  const segments: Segment[] = [];
  let sql = '';
  const addText = (docStart: number, docEnd: number) => {
    segments.push({ sqlStart: sql.length, docStart, length: docEnd - docStart, placeholder: false });
    sql += text.slice(docStart, docEnd);
  };

  const tpl = node.template;
  if (ts.isNoSubstitutionTemplateLiteral(tpl)) {
    addText(tpl.getStart(source) + 1, tpl.end - 1);
  } else {
    // Head: `...${   spans: expr }...${  last: expr }...`
    addText(tpl.head.getStart(source) + 1, tpl.head.end - 2);
    tpl.templateSpans.forEach((span, i) => {
      const placeholder = `$${i + 1}`;
      segments.push({ sqlStart: sql.length, docStart: span.expression.getStart(source), length: placeholder.length, placeholder: true });
      sql += placeholder;
      const lit = span.literal;
      const isTail = ts.isTemplateTail(lit);
      addText(lit.getStart(source) + 1, lit.end - (isTail ? 1 : 2));
    });
  }

  let typeArgs: SqlTemplate['typeArgs'];
  if (node.typeArguments?.length) {
    const start = node.tag.end;
    const end = node.template.getStart(source);
    const only = node.typeArguments.length === 1 ? node.typeArguments[0] : undefined;
    typeArgs = { start, end, text: text.slice(start, end).trim(), generated: !!only && looksGenerated(ts, only) };
  }
  const templateStart = tpl.getStart(source);
  const headEnd = ts.isNoSubstitutionTemplateLiteral(tpl) ? tpl.end - 1 : tpl.head.end - 2;

  return {
    sql,
    tagStart: node.tag.getStart(source),
    tagEnd: node.tag.end,
    templateStart,
    headEnd,
    start: node.getStart(source),
    end: node.end,
    typeArgs,
    toDocumentOffset(offset: number) {
      let seg = segments[0];
      for (const s of segments) {
        if (s.sqlStart <= offset) seg = s;
        else break;
      }
      if (!seg) return node.template.getStart(source);
      if (seg.placeholder) return seg.docStart;
      return seg.docStart + Math.min(offset - seg.sqlStart, seg.length);
    },
  };
}

/** True for type arguments this extension writes: `{ ... }`, `{ ... }[]`, `Record<string, never>`. */
function looksGenerated(ts: typeof TS, type: TS.TypeNode): boolean {
  if (ts.isTypeLiteralNode(type)) return true;
  if (ts.isArrayTypeNode(type)) return looksGenerated(ts, type.elementType);
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    if (type.typeName.text === 'Record') return true;
    if ((type.typeName.text === 'Array' || type.typeName.text === 'ReadonlyArray') && type.typeArguments?.length === 1) {
      return looksGenerated(ts, type.typeArguments[0]);
    }
  }
  return false;
}

export interface QueryAnalysis {
  /** Result row columns; `null` when the statement returns no rows or couldn't be typed. */
  columns: Column[] | null;
  diagnostics: SqlDiagnostic[];
  parseError?: SqlDiagnostic;
}

export function analyzeQuery(sql: string, schema: Schema): QueryAnalysis {
  let statements: A.Statement[];
  try {
    statements = parse(sql, { locationTracking: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const pos = parseErrorOffset(sql, message);
    return {
      columns: null,
      diagnostics: [],
      parseError: { message: `SQL syntax error: ${message.split('\n')[0]}`, start: pos, end: Math.min(sql.length, pos + 1), severity: 'error' },
    };
  }
  if (!statements.length) return { columns: null, diagnostics: [] };
  const inferrer = new Inferrer(schema);
  let columns: Column[] | null = null;
  for (const stmt of statements) columns = inferrer.statement(stmt);
  return { columns, diagnostics: inferrer.diagnostics };
}

function parseErrorOffset(sql: string, message: string): number {
  const m = /line (\d+) col (\d+)/.exec(message);
  if (!m) return 0;
  const lines = sql.split('\n');
  const line = Math.min(Number(m[1]) - 1, lines.length - 1);
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i].length + 1;
  return offset + Number(m[2]) - 1;
}

export interface TypeEdit {
  start: number;
  end: number;
  newText: string;
}

/** The edit that writes the inferred row type into the template's type argument, if one is needed. */
export function typeArgumentEdit(
  template: SqlTemplate,
  analysis: QueryAnalysis,
  schema: Schema,
  opts: TypegenOptions & { typeTemplate: string },
): TypeEdit | undefined {
  if (!analysis.columns || analysis.diagnostics.length) return undefined;
  if (template.typeArgs && !template.typeArgs.generated) return undefined;
  const newText = `<${applyTemplate(opts.typeTemplate, rowType(analysis.columns, schema, opts))}>`;
  if (template.typeArgs) {
    if (template.typeArgs.text === newText) return undefined;
    return { start: template.typeArgs.start, end: template.typeArgs.end, newText };
  }
  return { start: template.tagEnd, end: template.tagEnd, newText };
}
