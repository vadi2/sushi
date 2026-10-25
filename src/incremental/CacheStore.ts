import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { hashString } from './serialize';
import { PayloadStore } from './ExportSession';

export const CACHE_FORMAT = 1;

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

  constructor(readonly dir: string) {
    this.payloadDir = path.join(dir, 'p');
  }

  static forProject(projectDir: string): CacheStore {
    const dir = process.env.SUSHI_CACHE_DIR || path.join(projectDir, '.sushi-cache');
    return new CacheStore(path.resolve(dir));
  }

  /** Reads the manifest, or returns null if there is no usable one. */
  readManifest(): Manifest | null {
    try {
      const manifest = JSON.parse(this.readGz(path.join(this.dir, 'manifest.json.gz')));
      if (manifest?.format !== CACHE_FORMAT) {
        return null;
      }
      return manifest;
    } catch {
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
    if (!this.known.has(ref)) {
      this.writeGz(path.join(this.payloadDir, `${ref}.json.gz`), json);
      this.known.add(ref);
    }
    return ref;
  }

  getPayload(ref: string): any {
    if (!/^[A-Za-z0-9_-]+$/.test(ref)) {
      throw new Error('Invalid payload reference');
    }
    const json = this.readGz(path.join(this.payloadDir, `${ref}.json.gz`));
    if (hashString(json) !== ref) {
      throw new Error(`Corrupt cache payload ${ref}`);
    }
    return JSON.parse(json);
  }

  writeManifest(manifest: Manifest) {
    this.writeGz(path.join(this.dir, 'manifest.json.gz'), JSON.stringify(manifest));
  }

  /** Deletes the payloads that are no longer referenced. */
  collectGarbage(referenced: Set<string>) {
    for (const file of fs.readdirSync(this.payloadDir)) {
      const ref = file.endsWith('.json.gz') ? file.slice(0, -'.json.gz'.length) : null;
      if (ref == null || !referenced.has(ref)) {
        try {
          fs.unlinkSync(path.join(this.payloadDir, file));
          this.known.delete(ref);
        } catch {
          // another build may have removed it already
        }
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
