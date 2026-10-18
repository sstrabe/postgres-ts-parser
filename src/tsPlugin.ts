import type * as TS from 'typescript/lib/tsserverlibrary';
import { columnType } from './core/typegen';
import { Config, SchemaStore, VirtualFile, expandAliases, mayContainTemplates, resolveConfig, restoreOriginal, virtualize } from './core/virtual';

/** Diagnostic code for SQL problems, so they're easy to tell apart from TypeScript's own. */
const SQL_DIAGNOSTIC_CODE = 99001;

function init({ typescript: ts }: { typescript: typeof TS }): TS.server.PluginModule {
  let external: Partial<Config> | undefined;
  const instances = new Set<() => void>();

  return {
    onConfigurationChanged(config: Partial<Config>) {
      external = config;
      for (const reload of instances) reload();
    },

    create(info) {
      const project = info.project;
      const log = (msg: string) => project.projectService.logger.info(`[postgres-ts-sql] ${msg}`);
      const config = () => resolveConfig(info.config as Partial<Config>, external);
      const store = new SchemaStore(config, undefined, (loaded) => {
        log(`loaded ${loaded.fileCount} migration file(s) from ${loaded.dir}`);
        for (const w of loaded.warnings) log(`skipped statement in ${w.path}: ${w.message}`);
        watch(loaded.dir);
      });

      const watchers = new Map<string, TS.FileWatcher>();
      const watch = (dir: string) => {
        if (watchers.has(dir) || !info.serverHost.watchDirectory) return;
        watchers.set(dir, info.serverHost.watchDirectory(dir, (f) => f.endsWith('.sql') && reload(), true));
      };
      const reload = () => {
        store.clear();
        files.clear();
        (project as unknown as { markAsDirty?: () => void }).markAsDirty?.();
        project.refreshDiagnostics?.();
      };
      instances.add(reload);

      // ------------------------------------------------- the virtual source files

      const files = new Map<string, { source: string; virtual: VirtualFile }>();
      const host = info.languageServiceHost;
      const getScriptSnapshot = host.getScriptSnapshot.bind(host);
      const getScriptVersion = host.getScriptVersion.bind(host);

      const virtualFor = (fileName: string): VirtualFile | undefined => {
        const snapshot = getScriptSnapshot(fileName);
        if (!snapshot || fileName.endsWith('.d.ts') || fileName.includes('/node_modules/')) return undefined;
        const text = snapshot.getText(0, snapshot.getLength());
        const cached = files.get(fileName);
        if (cached?.source === text) return cached.virtual;
        const cfg = config();
        if (!mayContainTemplates(text, cfg.tags)) {
          files.delete(fileName);
          return undefined;
        }
        let virtual: VirtualFile;
        try {
          virtual = virtualize(ts, fileName, text, store.forFile(fileName), cfg);
        } catch (err) {
          log(`failed to type ${fileName}: ${err instanceof Error ? err.stack : err}`);
          return undefined;
        }
        files.set(fileName, { source: text, virtual });
        return virtual;
      };

      host.getScriptSnapshot = (fileName) => {
        const virtual = virtualFor(fileName);
        return virtual?.regions.length ? ts.ScriptSnapshot.fromString(virtual.text) : getScriptSnapshot(fileName);
      };
      // Migrations changing must re-type files whose own text didn't change.
      host.getScriptVersion = (fileName) => `${getScriptVersion(fileName)}@${store.generation}`;

      // ----------------------------------------------------- language service

      const ls = info.languageService;
      const proxy: TS.LanguageService = Object.create(null);
      for (const k of Object.keys(ls) as Array<keyof TS.LanguageService>) {
        const fn = ls[k];
        (proxy as unknown as Record<string, unknown>)[k] = typeof fn === 'function' ? (...args: unknown[]) => (fn as Function).apply(ls, args) : fn;
      }

      const inRange = (fileName: string) => {
        const length = files.get(fileName)?.virtual.originalLength;
        return (d: { start?: number }) => length === undefined || d.start === undefined || d.start < length;
      };
      const aliasesOf = (fileName: string) => files.get(fileName)?.virtual.aliases ?? new Map<string, string>();
      const expandChain = (m: string | TS.DiagnosticMessageChain, aliases: Map<string, string>): string | TS.DiagnosticMessageChain =>
        typeof m === 'string'
          ? expandAliases(m, aliases)
          : { ...m, messageText: expandAliases(m.messageText, aliases), next: m.next?.map((n) => expandChain(n, aliases) as TS.DiagnosticMessageChain) };
      const tidy = <D extends TS.Diagnostic>(fileName: string, diagnostics: readonly D[]): D[] => {
        const aliases = aliasesOf(fileName);
        return diagnostics.filter(inRange(fileName)).map((d) => (aliases.size ? { ...d, messageText: expandChain(d.messageText, aliases) } : d));
      };
      const expandParts = (fileName: string, parts: TS.SymbolDisplayPart[] | undefined) => {
        const aliases = aliasesOf(fileName);
        return parts?.map((p) => (aliases.has(p.text) ? { ...p, text: aliases.get(p.text)! } : p));
      };

      proxy.getSyntacticDiagnostics = (fileName) => tidy(fileName, ls.getSyntacticDiagnostics(fileName));

      proxy.getSemanticDiagnostics = (fileName) => {
        const base = tidy(fileName, ls.getSemanticDiagnostics(fileName));
        const cfg = config();
        const virtual = virtualFor(fileName);
        if (!virtual?.loaded || cfg.diagnostics === 'off') return base;
        const source = ls.getProgram()?.getSourceFile(fileName);
        const category = cfg.diagnostics === 'warning' ? ts.DiagnosticCategory.Warning : ts.DiagnosticCategory.Error;
        const extra: TS.Diagnostic[] = [];
        for (const { template, analysis } of virtual.templates) {
          const found = [...analysis.diagnostics];
          if (analysis.parseError && cfg.reportParseErrors) found.push(analysis.parseError);
          for (const d of found) {
            const start = template.toDocumentOffset(d.start);
            const end = Math.max(template.toDocumentOffset(d.end), start + 1);
            extra.push({ file: source, start, length: end - start, messageText: d.message, category, code: SQL_DIAGNOSTIC_CODE, source: 'postgres-ts-sql' });
          }
        }
        return [...base, ...extra];
      };

      proxy.getSuggestionDiagnostics = (fileName) => tidy(fileName, ls.getSuggestionDiagnostics(fileName));

      proxy.getCompletionEntryDetails = (fileName, ...rest) => {
        const details = ls.getCompletionEntryDetails(fileName, ...rest);
        return details && { ...details, displayParts: expandParts(fileName, details.displayParts)! };
      };

      // The aliases live past the end of the real file; there is nothing there to navigate to.
      const realDefinitions = <T extends { fileName: string; textSpan: TS.TextSpan }>(defs: readonly T[] | undefined) =>
        defs?.filter((d) => d.textSpan.start < (files.get(d.fileName)?.virtual.originalLength ?? Infinity));
      proxy.getDefinitionAtPosition = (...args) => realDefinitions(ls.getDefinitionAtPosition(...args));
      proxy.getTypeDefinitionAtPosition = (...args) => realDefinitions(ls.getTypeDefinitionAtPosition(...args));
      proxy.getDefinitionAndBoundSpan = (...args) => {
        const r = ls.getDefinitionAndBoundSpan(...args);
        return r && { ...r, definitions: realDefinitions(r.definitions) };
      };

      proxy.getQuickInfoAtPosition = (fileName, position, ...rest) => {
        const raw = ls.getQuickInfoAtPosition(fileName, position, ...rest);
        const quick = raw && { ...raw, displayParts: expandParts(fileName, raw.displayParts) };
        const virtual = virtualFor(fileName);
        const hit = virtual?.templates.find((t) => position >= t.template.tagStart && position <= t.template.tagEnd);
        if (!virtual?.loaded || !hit) return quick;
        const opts = { overrides: config().typeOverrides };
        let doc: string;
        if (hit.analysis.parseError) doc = hit.analysis.parseError.message;
        else if (!hit.analysis.columns) doc = 'Statement returns no rows.';
        else
          doc = hit.analysis.columns
            .map((c) => `- \`${c.name}: ${columnType(c, virtual.loaded!.schema, opts)}\`${c.source ? ` — \`${c.source}\`` : ''}${c.comment ? ` — ${c.comment}` : ''}`)
            .join('\n');
        const documentation = [...(quick?.documentation ?? []), { kind: 'markdown', text: `**SQL result**\n\n${doc}` }];
        return quick
          ? { ...quick, documentation }
          : { kind: ts.ScriptElementKind.unknown, kindModifiers: '', textSpan: { start: hit.template.tagStart, length: hit.template.tagEnd - hit.template.tagStart }, documentation };
      };

      // Never let edits computed from the virtual text write it into the real file.
      const regionsOf = (fileName: string) => files.get(fileName)?.virtual.regions ?? [];
      const overlaps = (fileName: string, span: TS.TextSpan) =>
        regionsOf(fileName).some((r) => span.start < r.end && span.start + span.length > r.start);
      const cleanChanges = (changes: readonly TS.FileTextChanges[]): TS.FileTextChanges[] =>
        changes.map((fc) => ({
          ...fc,
          textChanges: fc.textChanges.map((c) => ({ ...c, newText: restoreOriginal(c.newText, regionsOf(fc.fileName)) })),
        }));

      proxy.getFormattingEditsForRange = (fileName, ...rest) =>
        ls.getFormattingEditsForRange(fileName, ...rest).filter((e) => !overlaps(fileName, e.span));
      proxy.getFormattingEditsForDocument = (fileName, ...rest) =>
        ls.getFormattingEditsForDocument(fileName, ...rest).filter((e) => !overlaps(fileName, e.span));
      proxy.getFormattingEditsAfterKeystroke = (fileName, ...rest) =>
        ls.getFormattingEditsAfterKeystroke(fileName, ...rest).filter((e) => !overlaps(fileName, e.span));
      proxy.getCodeFixesAtPosition = (...args) =>
        ls.getCodeFixesAtPosition(...args).map((fix) => ({ ...fix, changes: cleanChanges(fix.changes) }));
      proxy.getCombinedCodeFix = (...args) => {
        const r = ls.getCombinedCodeFix(...args);
        return { ...r, changes: cleanChanges(r.changes) };
      };
      proxy.getEditsForRefactor = (...args) => {
        const r = ls.getEditsForRefactor(...args);
        return r && { ...r, edits: cleanChanges(r.edits) };
      };

      log(`attached to ${project.getProjectName()}`);
      return proxy;
    },
  };
}

export = init;
