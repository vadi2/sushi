import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import temp from 'temp';
import { CACHE_FORMAT, CacheStore } from '../../src/incremental/CacheStore';

describe('CacheStore', () => {
  let dir: string;
  let store: CacheStore;

  beforeAll(() => {
    temp.track();
  });

  beforeEach(() => {
    dir = path.join(temp.mkdirSync('sushi-test'), 'cache');
    store = new CacheStore(dir);
    store.open();
  });

  afterAll(() => {
    temp.cleanupSync();
  });

  it('should create the cache directory, ignored by git', () => {
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toMatch(/^\*$/m);
  });

  it('should store and read back payloads by their hash', () => {
    const ref = store.putPayload('{"a":1}');
    expect(store.putPayload('{"a":1}')).toBe(ref);
    expect(store.getPayload(ref)).toEqual({ a: 1 });
    // a new store sees the payloads that are already on disk
    const other = new CacheStore(dir);
    other.open();
    expect(other.getPayload(ref)).toEqual({ a: 1 });
  });

  it('should refuse a payload whose content does not match its hash', () => {
    const ref = store.putPayload('{"a":1}');
    fs.writeFileSync(path.join(dir, 'p', `${ref}.json.gz`), zlib.gzipSync('{"a":2}'));
    expect(() => store.getPayload(ref)).toThrow(/Corrupt/);
    // the corrupt file is removed, and written again when the payload is stored
    expect(fs.existsSync(path.join(dir, 'p', `${ref}.json.gz`))).toBe(false);
    expect(store.putPayload('{"a":1}')).toBe(ref);
    expect(store.getPayload(ref)).toEqual({ a: 1 });
  });

  it('should refuse a payload that is not gzipped or missing', () => {
    const ref = store.putPayload('{"a":1}');
    fs.writeFileSync(path.join(dir, 'p', `${ref}.json.gz`), '{"a":1}');
    expect(() => store.getPayload(ref)).toThrow();
    expect(() => store.getPayload('nothere')).toThrow();
    expect(() => store.getPayload('../manifest')).toThrow(/Invalid/);
  });

  it('should read back the manifest it wrote', () => {
    expect(store.readManifest()).toBeNull();
    const manifest = { format: CACHE_FORMAT, globalKey: 'g', parseKey: 'p', parse: { x: 1 } };
    store.writeManifest(manifest);
    expect(store.readManifest()).toEqual(manifest);
  });

  it('should ignore a manifest of another format, or one that cannot be read', () => {
    store.writeManifest({ format: CACHE_FORMAT + 1, globalKey: 'g', parseKey: 'p' });
    expect(store.readManifest()).toBeNull();
    expect(store.manifestProblem).toMatch(/different version/);
    fs.writeFileSync(path.join(dir, 'manifest.json.gz'), zlib.gzipSync('{not json'));
    expect(store.readManifest()).toBeNull();
    expect(store.manifestProblem).toMatch(/could not be read/);
    fs.writeFileSync(path.join(dir, 'manifest.json.gz'), 'garbage');
    expect(store.readManifest()).toBeNull();
  });

  it('should delete only the payloads that are not referenced', () => {
    const keep = store.putPayload('"keep"');
    const drop = store.putPayload('"drop"');
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, 'p', `${drop}.json.gz`), old, old);
    fs.writeFileSync(path.join(dir, 'p', 'leftover.tmp'), '');
    fs.utimesSync(path.join(dir, 'p', 'leftover.tmp'), old, old);
    store.collectGarbage(new Set([keep]));
    expect(fs.readdirSync(path.join(dir, 'p'))).toEqual([`${keep}.json.gz`]);
    // a payload that was collected is written again when needed
    expect(store.putPayload('"drop"')).toBe(drop);
    expect(store.getPayload(drop)).toBe('drop');
  });

  it('should keep files that another build may be using', () => {
    const old = new Date(Date.now() - 60 * 1000);
    fs.writeFileSync(path.join(dir, 'p', 'unused.json.gz'), zlib.gzipSync('"unused"'));
    fs.utimesSync(path.join(dir, 'p', 'unused.json.gz'), old, old);
    const later = new CacheStore(dir);
    later.open();
    // written after this build started, by another build
    fs.writeFileSync(path.join(dir, 'p', 'other.json.gz'), zlib.gzipSync('"other"'));
    fs.writeFileSync(path.join(dir, 'p', 'x.json.gz.123.abc.tmp'), '');
    later.collectGarbage(new Set());
    expect(fs.readdirSync(path.join(dir, 'p')).sort()).toEqual([
      'other.json.gz',
      'x.json.gz.123.abc.tmp'
    ]);
  });
});
