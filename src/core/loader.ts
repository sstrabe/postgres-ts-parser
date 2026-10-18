import * as fs from 'node:fs';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import { MigrationFile, MigrationWarning, buildSchema } from './migrations';
import { Schema } from './types';

export interface LoadedSchema {
  dir: string;
  schema: Schema;
  warnings: MigrationWarning[];
  fileCount: number;
}

/**
 * Finds the migrations folder for a source file: an absolute setting is used as is,
 * a relative one is looked up from the file's directory upwards to `root`, so each
 * package of a pnpm workspace can have its own `migrations/`.
 */
export function findMigrationsDir(filePath: string, root: string | undefined, setting: string): string | undefined {
  if (path.isAbsolute(setting)) return isDir(setting) ? setting : undefined;
  let dir = path.dirname(filePath);
  const stop = root ? path.resolve(root) : path.parse(dir).root;
  for (;;) {
    const candidate = path.join(dir, setting);
    if (isDir(candidate)) return candidate;
    if (path.resolve(dir) === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir || !isInside(parent, stop)) break;
    dir = parent;
  }
  return undefined;
}

export function loadSchema(dir: string, exclude: string[]): LoadedSchema {
  const files: MigrationFile[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(full);
      } else if (entry.name.endsWith('.sql') && !exclude.some((g) => minimatch(rel, g, { dot: true }))) {
        files.push({ path: rel, contents: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(dir);
  const { schema, warnings } = buildSchema(files);
  return { dir, schema, warnings, fileCount: files.length };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
