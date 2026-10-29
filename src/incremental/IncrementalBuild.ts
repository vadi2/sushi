import { FSHImporter, FSHTank, RawFSH } from '../import';
import { ParseCache } from './ParseCache';
import { Configuration } from '../fshtypes';
import { logger } from '../utils/FSHLogger';
import { fillTank } from '../utils/Processing';
import { CACHE_FORMAT, CacheStore, Manifest } from './CacheStore';
import { toolKey } from './cacheKey';

/**
 * Coordinates an incremental build. Every step falls back to doing the work normally if anything
 * about the cache is missing, unreadable, or does not fit, so an incremental build always produces
 * the same output as a normal one; it is only faster when the cache can be used.
 */
export class IncrementalBuild {
  private readonly store: CacheStore;
  private manifest: Manifest | null = null;
  private tool: string;
  private disabled: string = null;
  private parseCache: ParseCache = null;
  private notes: string[] = [];

  constructor(projectDir: string, sushiVersion: string) {
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

  /** Something the summary should explain */
  private note(text: string) {
    this.notes.push(text);
  }

  /** Logs how much of the import was reused. */
  logSummary() {
    if (this.disabled != null) {
      logger.info(`Incremental build: not used, ${this.disabled}.`);
      return;
    }
    const parse = this.parseCache;
    logger.info(`Incremental build: reused ${parse.hits} of ${parse.hits + parse.misses} files.`);
    const notes = [...this.notes];
    if (this.store.corruptPayloads > 0) {
      notes.push(`removed ${this.store.corruptPayloads} corrupt file(s) from the cache`);
    }
    if (this.store.readFailures > 0) {
      notes.push(
        `could not use ${this.store.readFailures} cached result(s) (first: ${this.store.readError})`
      );
    }
    if (this.store.writeError != null) {
      notes.push(`could not write to the cache (${this.store.writeError})`);
    }
    // Cache problems are reported as information, so the error and warning counts stay those of
    // a normal build
    notes.forEach(text => logger.info(`Incremental build: ${text}.`));
    parse.errors.forEach(error => logger.debug(`Incremental build: unexpected error ${error}`));
    parse.skippedFiles.forEach(text => logger.debug(`Incremental build: ${text}.`));
  }

  /** Saves what this build recorded, for the next build. Must be called after the output is written. */
  finish() {
    if (this.disabled != null) {
      return;
    }
    try {
      const manifest: Manifest = {
        format: CACHE_FORMAT,
        parseKey: this.tool,
        parse: this.parseCache.entries
      };
      this.store.writeManifest(manifest);
      const referenced = new Set<string>();
      Object.values(this.parseCache.entries).forEach(entry => referenced.add(entry.ref));
      this.store.collectGarbage(referenced);
      if (this.store.cleanupError != null) {
        logger.info(
          `Incremental build: could not remove some files from the cache (${this.store.cleanupError}).`
        );
      }
    } catch (e) {
      // The cache is only an optimization; the next build will just do more work
      logger.info(`Incremental build: could not save the cache (${e.message}).`);
    }
  }
}
