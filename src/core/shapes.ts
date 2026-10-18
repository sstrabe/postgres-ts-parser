import type * as TS from 'typescript';
import { SqlTemplate } from './templates';

/**
 * What a tag's type argument means: `row` for `sql<Row>` (e.g. @vercel/postgres or a
 * hand-written wrapper), `array` for `sql<Row[]>` (postgres.js), `none` when the tag
 * isn't generic and must not be given a type argument at all.
 */
export type TagShape = 'row' | 'array' | 'none';

/** Reads each template tag's call signature to decide the shape of its type argument. */
export function detectTagShapes(ts: typeof TS, program: TS.Program, fileName: string, templates: SqlTemplate[]): Map<string, TagShape> {
  const shapes = new Map<string, TagShape>();
  const source = program.getSourceFile(fileName);
  if (!source || !templates.length) return shapes;
  const checker = program.getTypeChecker();
  const wanted = new Map(templates.map((t) => [t.tagStart, t]));

  const visit = (node: TS.Node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      const template = wanted.get(node.tag.getStart(source));
      if (template && !shapes.has(template.tag)) shapes.set(template.tag, shapeOf(ts, checker, node.tag));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return shapes;
}

function shapeOf(ts: typeof TS, checker: TS.TypeChecker, tag: TS.Expression): TagShape {
  const signatures = checker.getSignaturesOfType(checker.getTypeAtLocation(tag), ts.SignatureKind.Call);
  // Overloads such as postgres.js's `sql(object)` helpers don't take a TemplateStringsArray.
  const forTemplates = signatures.filter((sig) => {
    const first = sig.parameters[0];
    return first && checker.typeToString(checker.getTypeOfSymbol(first)).includes('TemplateStringsArray');
  });
  const generic = (forTemplates.length ? forTemplates : signatures).find((sig) => sig.typeParameters?.length);
  if (!generic) return 'none';
  const constraint = checker.getBaseConstraintOfType(generic.typeParameters![0]);
  if (!constraint || constraint.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) return 'row';
  return checker.isArrayLikeType(constraint) ? 'array' : 'row';
}
