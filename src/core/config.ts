export interface Config {
  migrationsDir: string;
  migrationsExclude: string[];
  tags: string[];
  /** `auto` asks the type checker whether the tag wants `Row` or `Row[]`; otherwise a template like `{{row}}[]`. */
  typeTemplate: string;
  typeOverrides: Record<string, string>;
  diagnostics: 'error' | 'warning' | 'off';
  reportParseErrors: boolean;
}

export const DEFAULT_CONFIG: Config = {
  migrationsDir: 'migrations',
  migrationsExclude: ['**/*.down.sql', '**/down.sql', '**/revert/**', '**/verify/**'],
  tags: ['sql'],
  typeTemplate: 'auto',
  typeOverrides: {},
  diagnostics: 'error',
  reportParseErrors: false,
};

export function resolveConfig(...partials: Array<Partial<Config> | undefined>): Config {
  const out = { ...DEFAULT_CONFIG };
  for (const p of partials) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) if (v !== undefined && k in DEFAULT_CONFIG) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
