import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { hashString } from './serialize';
import { PayloadStore } from './ExportSession';

export const CACHE_FORMAT = 1;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface Manifest {
  format: number;
  globalKey: string;
  parseKey: string;
  export?: any;
  parse?: any;
}

/**
 * The on-disk cache of an incremental build: one manifest, plus content-addressed payloads that
 * the manifest refers to. Every read is checked, and every write goes to a temporary file that is
 * renamed into place, so an interrupted or concurrent build can leave unused files behind but can
 * never leave a payload or manifest that is read back wrong.
 */
export class CacheStore implements PayloadStore {
  private readonly payloadDir: string;
  private readonly known = new Set<string>();
  // Files changed after this may belong to another build running at the same time (with some
  // slack, as file times can lag the clock slightly)
  private readonly startedAt = Date.now() - 1000;
  /** Why the manifest could not be used, if there was one */
  manifestProblem: string = null;
  /** The first failure to write to the cache, if any */
  writeError: string = null;
  /** How many payloads were found corrupt (and removed) */
  corruptPayloads = 0;

  constructor(readonly dir: string) {
    this.payloadDir = path.join(dir, 'p');
  }

  static forProject(projectDir: string): CacheStore {
    const dir = process.env.SUSHI_CACHE_DIR || path.join(projectDir, '.sushi-cache');
    return new CacheStore(path.resolve(dir));
  }

  /** Reads the manifest, or returns null if there is no usable one. */
  readManifest(): Manifest | null {
    const file = path.join(this.dir, 'manifest.json.gz');
    if (!fs.existsSync(file)) {
      return null;
    }
    try {
      const manifest = JSON.parse(this.readGz(file));
      if (manifest?.format !== CACHE_FORMAT) {
        this.manifestProblem = 'the cache was made by a different version of SUSHI';
        return null;
      }
      return manifest;
    } catch (e) {
      this.manifestProblem = `the cache could not be read (${e.message})`;
      return null;
    }
  }

  open() {
    fs.mkdirSync(this.payloadDir, { recursive: true });
    const ignore = path.join(this.dir, '.gitignore');
    if (!fs.existsSync(ignore)) {
      fs.writeFileSync(ignore, '# SUSHI incremental build cache\n*\n');
    }
    for (const file of fs.readdirSync(this.payloadDir)) {
      if (file.endsWith('.json.gz')) {
        this.known.add(file.slice(0, -'.json.gz'.length));
      }
    }
  }

  putPayload(json: string): string {
    const ref = hashString(json);
    if (this.known.has(ref)) {
      this.touch(ref);
    } else {
      try {
        this.writeGz(path.join(this.payloadDir, `${ref}.json.gz`), json);
      } catch (e) {
        this.writeError = this.writeError ?? e.message;
        throw e;
      }
      this.known.add(ref);
    }
    return ref;
  }

  getPayload(ref: string): any {
    if (!/^[A-Za-z0-9_-]+$/.test(ref)) {
      throw new Error('Invalid payload reference');
    }
    const file = path.join(this.payloadDir, `${ref}.json.gz`);
    // Failing to read the file (it is missing, or the system refused) says nothing about its
    // content, but content that does not unzip, match its hash or parse is corrupt
    const data = fs.readFileSync(file);
    try {
      const json = zlib.gunzipSync(data).toString('utf8');
      if (hashString(json) !== ref) {
        throw new Error(`Corrupt cache payload ${ref}`);
      }
      const value = JSON.parse(json);
      this.touch(ref);
      return value;
    } catch (e) {
      // Remove it, so it is written again if this build produces it
      this.corruptPayloads++;
      this.known.delete(ref);
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone
      }
      throw e;
    }
  }

  /** Marks a payload as in use, so a concurrent build does not collect it. */
  private touch(ref: string) {
    try {
      const now = new Date();
      fs.utimesSync(path.join(this.payloadDir, `${ref}.json.gz`), now, now);
    } catch {
      // it is only a hint
    }
  }

  writeManifest(manifest: Manifest) {
    try {
      this.writeGz(path.join(this.dir, 'manifest.json.gz'), JSON.stringify(manifest));
    } catch (e) {
      this.writeError = this.writeError ?? e.message;
      throw e;
    }
  }

  /**
   * Deletes the payloads that are no longer referenced. Payloads used or written in the last hour
   * (or since this build started), and temporary files less than a day old, may be in use by
   * another build, so they are kept.
   */
  collectGarbage(referenced: Set<string>) {
    for (const file of fs.readdirSync(this.payloadDir)) {
      const ref = file.endsWith('.json.gz') ? file.slice(0, -'.json.gz'.length) : null;
      if (ref != null && referenced.has(ref)) {
        continue;
      }
      const full = path.join(this.payloadDir, file);
      try {
        const changed = fs.statSync(full).mtimeMs;
        const keepAfter =
          ref == null ? Date.now() - DAY : Math.min(this.startedAt, Date.now() - HOUR);
        if (changed >= keepAfter) {
          continue;
        }
        fs.unlinkSync(full);
        this.known.delete(ref);
      } catch {
        // another build may have removed it already
      }
    }
  }

  private readGz(file: string): string {
    return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  }

  private writeGz(file: string, text: string) {
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temp, zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 1 }));
      fs.renameSync(temp, file);
    } catch (e) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // nothing to clean up
      }
      throw e;
    }
  }
}
