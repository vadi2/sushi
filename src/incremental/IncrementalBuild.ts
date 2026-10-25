import fs from 'fs';
import path from 'path';
import { FSHImporter, FSHTank, RawFSH } from '../import';
import { ParseCache } from './ParseCache';
import { exportFHIR, Package } from '../export';
import { FHIRDefinitions } from '../fhirdefs';
import { Configuration } from '../fshtypes';
import { logger } from '../utils/FSHLogger';
import { fillTank } from '../utils/Processing';
import { incrementalHooks } from './hooks';
import { CACHE_FORMAT, CacheStore, Manifest } from './CacheStore';
import { ExportSession, ExportStats } from './ExportSession';
import { exportKey, toolKey } from './cacheKey';
import { decode, encode } from './serialize';
import { holdLogs } from './logCapture';
import { definitionRegistry } from './registries';

/**
 * Coordinates an incremental build. Every step falls back to doing the work normally if anything
 * about the cache is missing, unreadable, or does not fit, so an incremental build always produces
 * the same output as a normal one; it is only faster when the cache can be used.
 */
export class IncrementalBuild {
  private readonly store: CacheStore;
  private manifest: Manifest | null = null;
  private tool: string;
  private key: string = null;
  private session: ExportSession = null;
  private disabled: string = null;
  private redone = false;

  constructor(
    private readonly projectDir: string,
    sushiVersion: string
  ) {
    this.store = CacheStore.forProject(projectDir);
    try {
      this.tool = toolKey(sushiVersion);
      this.store.open();
      this.manifest = this.store.readManifest();
      if (this.store.manifestProblem != null) {
        this.note(`${this.store.manifestProblem}, so nothing was reused`);
      }
    } catch (e) {
      this.disabled = `cache unavailable (${e.message})`;
    }
  }

  importFSH(rawFSH: RawFSH[], config: Configuration): FSHTank {
    if (this.disabled != null) {
      return fillTank(rawFSH, config);
    }
    const old = this.manifest?.parseKey === this.tool ? (this.manifest.parse ?? null) : null;
    this.parseCache = new ParseCache(this.store, old);
    logger.info('Importing FSH text...');
    const docs = new FSHImporter().import(rawFSH, this.parseCache);
    return new FSHTank(docs, config);
  }

  private parseCache: ParseCache = null;

  exportFHIR(tank: FSHTank, defs: FHIRDefinitions, options: any, config: Configuration): Package {
    if (this.disabled == null) {
      try {
        this.key = exportKey(this.tool, options, config, this.readConfigText(), defs);
      } catch (e) {
        this.disabled = `could not identify the build (${e.message})`;
      }
    }
    if (this.disabled != null) {
      return exportFHIR(tank, defs);
    }
    let old =
      this.manifest?.globalKey === this.key && this.manifest.export != null
        ? this.manifest.export
        : null;
    let snapshot: string = null;
    if (old != null) {
      // Replaying can be abandoned partway through, and the export changes the definitions in the
      // tank, so keep a copy of them to start over from
      try {
        snapshot = JSON.stringify(encode(tank.docs, definitionRegistry()));
      } catch (e) {
        old = null;
        this.note(`exports were not reused, as the definitions could not be copied (${e.message})`);
      }
    }
    const first = new ExportSession(this.store, old);
    // If the export is redone, nothing the first attempt logged may be kept, including what is
    // logged before the session starts (such as errors from applying insert rules)
    const held = old != null ? holdLogs() : null;
    let pkg: Package;
    try {
      pkg = this.runSession(first, () => exportFHIR(tank, defs), old != null);
    } catch (e) {
      held?.release(true);
      throw e;
    }
    if (pkg != null && !first.aborted) {
      held?.release(true);
      this.session = first;
      return pkg;
    }
    held?.release(false);
    this.note(`exported everything again, because ${first.abortReason ?? 'of an unknown problem'}`);
    // Start over from the original definitions, and export everything without replaying
    this.redone = true;
    const fresh = new FSHTank(decode(JSON.parse(snapshot), definitionRegistry()), tank.config);
    const second = new ExportSession(this.store, null);
    this.session = second;
    this.abandoned = first.stats;
    return this.runSession(second, () => exportFHIR(fresh, defs), false);
  }

  private abandoned: ExportStats = null;
  private notes: string[] = [];

  /** Something the summary should explain */
  private note(text: string) {
    this.notes.push(text);
  }

  /**
   * Runs an export with the session active. If the export throws, a session that may have
   * replayed something is abandoned (returning null), so the export can be redone; otherwise its
   * output is kept, and the error is passed on as it would be without a session.
   */
  private runSession(session: ExportSession, run: () => Package, canRedo: boolean): Package {
    incrementalHooks.session = session;
    try {
      return run();
    } catch (e) {
      session.abortReason = session.abortReason ?? `the export failed: ${e?.message}`;
      session.dispose(!canRedo);
      incrementalHooks.session = null;
      if (canRedo) {
        return null;
      }
      throw e;
    } finally {
      if (session.aborted && incrementalHooks.session === session) {
        incrementalHooks.session = null;
      }
    }
  }

  /** Logs how much of the export was reused. */
  logSummary() {
    if (this.session == null) {
      if (this.disabled != null) {
        logger.info(`Incremental build: not used, ${this.disabled}.`);
      }
      return;
    }
    const stats = this.session.stats;
    const redo = this.redone ? ' (cached results did not apply; exported everything)' : '';
    const parse = this.parseCache;
    const files = parse != null ? `${parse.hits} of ${parse.hits + parse.misses} files, ` : '';
    logger.info(
      `Incremental build: reused ${files}${stats.replayed} of ${stats.exported} exports${redo}.`
    );
    const notes = [...this.notes];
    if (!this.session.saveable) {
      notes.push(
        `this build's exports cannot be reused (${this.session.abortReason ?? 'unknown reason'})`
      );
    } else if (this.session.unstable) {
      notes.push('the next build will not reuse exports, as a definition changed unexpectedly');
    }
    notes.forEach(text => logger.info(`Incremental build: ${text}.`));
  }

  /** Saves what this build recorded, for the next build. Must be called after the output is written. */
  finish() {
    incrementalHooks.session = null;
    if (this.disabled != null) {
      return;
    }
    try {
      const session = this.session;
      let exportState = session?.saveable ? session.getState() : null;
      if (exportState == null && this.manifest?.globalKey === this.key) {
        // Keep what the previous build recorded; it is checked before it is used, like any record
        exportState = this.manifest.export ?? null;
      }
      const manifest: Manifest = {
        format: CACHE_FORMAT,
        globalKey: this.key ?? '',
        parseKey: this.tool,
        export: exportState,
        parse: this.parseCache?.entries
      };
      this.store.writeManifest(manifest);
      const referenced = new Set<string>();
      Object.values(this.parseCache?.entries ?? {}).forEach(entry => referenced.add(entry.ref));
      for (const rec of Object.values(exportState?.records ?? {})) {
        if (rec.payloadRef) {
          referenced.add(rec.payloadRef);
        }
        if (rec.afterRef) {
          referenced.add(rec.afterRef);
        }
      }
      this.store.collectGarbage(referenced);
      if (this.store.writeError != null) {
        logger.warn(
          `Incremental build: could not write to the cache (${this.store.writeError}); the next ` +
            'build may reuse less.'
        );
      }
      if (process.env.SUSHI_INCREMENTAL_DEBUG) {
        fs.writeFileSync(
          path.join(this.store.dir, 'last-run.json'),
          JSON.stringify(
            { ...session?.stats, redone: this.redone, abandoned: this.abandoned },
            null,
            2
          )
        );
      }
    } catch (e) {
      // The cache is only an optimization; the next build will just do more work
      logger.warn(`Incremental build: could not save the cache (${e.message}).`);
    }
  }

  private readConfigText(): string {
    for (const name of ['sushi-config.yaml', 'sushi-config.yml']) {
      const file = path.join(this.projectDir, name);
      if (fs.existsSync(file)) {
        return `${name}\n${fs.readFileSync(file, 'utf8')}`;
      }
    }
    return '';
  }
}
