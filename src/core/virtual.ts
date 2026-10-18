import type * as TS from 'typescript';
import { LoadedSchema, findMigrationsDir, loadSchema } from './loader';
import { QueryAnalysis, SqlTemplate, analyzeQuery, scanSqlTemplates } from './templates';
import { Config } from './config';
import { TagShape } from './shapes';
import { applyTemplate, rowType } from './typegen';

export { Config, DEFAULT_CONFIG, resolveConfig } from './config';

/** Caches one schema per migrations folder. */
export class SchemaStore {
  private cache = new Map<string, LoadedSchema>();
  /** Bumped whenever a schema is dropped, so callers can invalidate derived state. */
  generation = 0;

  constructor(
    private readonly config: () => Config,
    private readonly root?: () => string | undefined,
    private readonly onLoad?: (loaded: LoadedSchema) => void,
  ) {}

  forFile(fileName: string): LoadedSchema | undefined {
    const cfg = this.config();
    const dir = findMigrationsDir(fileName, this.root?.(), cfg.migrationsDir);
    if (!dir) return undefined;
    let loaded = this.cache.get(dir);
    if (!loaded) {
      loaded = loadSchema(dir, cfg.migrationsExclude);
      this.cache.set(dir, loaded);
      this.onLoad?.(loaded);
    }
    return loaded;
  }

  get dirs(): string[] {
    return [...this.cache.keys()];
  }

  clear() {
    this.cache.clear();
    this.generation++;
  }
}

export interface AnalyzedTemplate {
  template: SqlTemplate;
  analysis: QueryAnalysis;
}

export interface Region {
  start: number;
  end: number;
  original: string;
  replacement: string;
}

export interface VirtualFile {
  /** The text TypeScript should see. Offsets inside the original length are unchanged. */
  text: string;
  originalLength: number;
  templates: AnalyzedTemplate[];
  /** Spans of the original text that were rewritten. */
  regions: Region[];
  /** Aliases declared after the end of the file, by name. */
  aliases: Map<string, string>;
  loaded?: LoadedSchema;
}

const TS_FILE = /\.(c|m)?tsx?$/;

/** Cheap pre-check so files without SQL templates are never parsed twice. */
export function mayContainTemplates(text: string, tags: string[]): boolean {
  return tags.some((t) => text.includes(`${t}\``) || text.includes(`${t}<`) || text.includes(`${t} \``));
}

/**
 * Gives every typeable `sql\`...\`` template its inferred row type as a type argument,
 * without moving any other character: the type argument takes the place of the start of
 * the template's (type-irrelevant) SQL text. When it doesn't fit, a short alias is used
 * and declared after the end of the file.
 */
export function virtualize(
  ts: typeof TS,
  fileName: string,
  text: string,
  loaded: LoadedSchema | undefined,
  cfg: Config,
  /** The shape of a template's tag, once known (see detectTagShapes). */
  shapeOf: (template: SqlTemplate) => TagShape | undefined = () => undefined,
): VirtualFile {
  const found = scanSqlTemplates(ts, fileName, text, cfg.tags);
  const templates = found.templates.map((template) => ({
    template,
    analysis: loaded ? analyzeQuery(template.sql, loaded.schema) : { columns: null, diagnostics: [] },
  }));
  const result: VirtualFile = { text, originalLength: text.length, templates, regions: [], aliases: new Map(), loaded };
  if (!loaded || !TS_FILE.test(fileName) || fileName.endsWith('.d.ts')) return result;

  let out = '';
  let cursor = 0;
  for (const { template, analysis } of templates) {
    if (template.typeArgs || !analysis.columns || analysis.diagnostics.length) continue;
    const typeTemplate = resolveTypeTemplate(cfg, shapeOf(template));
    if (!typeTemplate) continue;
    const type = applyTemplate(typeTemplate, rowType(analysis.columns, loaded.schema, { overrides: cfg.typeOverrides }));
    // The span from the end of the tag to the first `${` (or closing backtick) is free to rewrite.
    const start = template.tagEnd;
    const end = template.headEnd;
    const original = text.slice(start, end);
    let prefix = `<${type}>\``;
    if (prefix.length > original.length) {
      if (!found.isModule) continue; // an alias in a script file would be global
      const alias = `SqlRow${result.aliases.size}`;
      prefix = `<${alias}>\``;
      if (prefix.length > original.length) continue;
      result.aliases.set(alias, type);
    }
    // Keep line breaks where they were so line numbers line up too.
    let filler = '';
    for (let i = prefix.length; i < original.length; i++) filler += original[i] === '\n' || original[i] === '\r' ? original[i] : ' ';
    const replacement = prefix + filler;
    out += text.slice(cursor, start) + replacement;
    cursor = end;
    result.regions.push({ start, end, original, replacement });
  }
  if (!result.regions.length) return result;
  out += text.slice(cursor);
  if (result.aliases.size) out += `\n;${[...result.aliases].map(([name, type]) => `type ${name} = ${type};`).join('')}`;
  result.text = out;
  return result;
}

/** Puts original source back into text produced from the virtual file (refactors, code fixes). */
export function restoreOriginal(text: string, regions: Region[]): string {
  for (const r of regions) {
    if (r.replacement.trim()) text = text.split(r.replacement).join(r.original);
  }
  return text;
}

/** Shows the row type instead of the generated alias name in user-facing text. */
export function expandAliases(text: string, aliases: Map<string, string>): string {
  if (!aliases.size) return text;
  return text.replace(/\bSqlRow\d+\b/g, (name) => aliases.get(name) ?? name);
}

/** The type argument template for a tag, or undefined when it must not get one (yet). */
export function resolveTypeTemplate(cfg: Config, shape: TagShape | undefined): string | undefined {
  if (shape === 'none') return undefined;
  if (cfg.typeTemplate !== 'auto') return cfg.typeTemplate;
  if (!shape) return undefined;
  return shape === 'array' ? '{{row}}[]' : '{{row}}';
}
