import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import temp from 'temp';
import { exportFHIR, Package } from '../../src/export';
import { FSHTank, RawFSH } from '../../src/import';
import { FHIRDefinitions } from '../../src/fhirdefs';
import { IncrementalBuild } from '../../src/incremental/IncrementalBuild';
import { ParseCache } from '../../src/incremental/ParseCache';
import { CacheStore } from '../../src/incremental/CacheStore';
import { fillTank } from '../../src/utils/Processing';
import { stats } from '../../src/utils/FSHLogger';
import { getTestFHIRDefinitions, loggerSpy, testDefsPath } from '../testhelpers';
import { minimalConfig } from '../utils/minimalConfig';

const FSH = [
  'Profile: MyPatient\nParent: Patient\n* name 1..*\n',
  'ValueSet: MyVS\n* http://example.org#a "A"\n',
  'Instance: Pat\nInstanceOf: MyPatient\n* name.family = "Smith"\n',
  'Instance: Bad\nInstanceOf: Patient\n* notAnElement = "value"\n'
];

describe('IncrementalBuild', () => {
  let defs: FHIRDefinitions;
  let projectDir: string;
  let spy: jest.SpyInstance = null;

  beforeAll(async () => {
    temp.track();
    defs = await getTestFHIRDefinitions(true, testDefsPath('r4-definitions'));
  });

  beforeEach(() => {
    projectDir = temp.mkdirSync('sushi-test');
    fs.writeFileSync(path.join(projectDir, 'sushi-config.yaml'), 'id: test\n');
    loggerSpy.reset();
  });

  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });

  afterAll(() => {
    temp.cleanupSync();
  });

  function output(pkg: Package) {
    return JSON.stringify([
      pkg.profiles.map(sd => sd.toJSON(true)),
      pkg.valueSets.map(vs => vs.toJSON()),
      pkg.instances.map(i => i.toJSON()),
      [...pkg.fshMap.entries()]
    ]);
  }

  function messages() {
    return loggerSpy
      .getAllLogs()
      .filter(l => l.level === 'error' || l.level === 'warn')
      .map(l => `${l.level}: ${l.message}`);
  }

  function rawFSH(fsh: string[]) {
    return fsh.map((text, i) => new RawFSH(text, path.join(projectDir, `input/fsh/f${i}.fsh`)));
  }

  function plainBuild(fsh = FSH) {
    loggerSpy.reset();
    const pkg = exportFHIR(fillTank(rawFSH(fsh), minimalConfig), defs);
    return { out: output(pkg), messages: messages() };
  }

  function incrementalBuild(fsh = FSH, sushiVersion = '9.9.9') {
    loggerSpy.reset();
    const build = new IncrementalBuild(projectDir, sushiVersion);
    const tank: FSHTank = build.importFSH(rawFSH(fsh), minimalConfig);
    const pkg = exportFHIR(tank, defs);
    const result = { out: output(pkg), messages: messages() };
    build.logSummary();
    build.finish();
    const own = loggerSpy.getAllMessages('info').filter(m => m.startsWith('Incremental build:'));
    const summary = own.find(m => m.includes(' reused ')) ?? own[0];
    const notes = own.filter(m => m !== summary);
    return { ...result, summary, notes };
  }

  it('should produce the same output as a normal build, then reuse the imports', () => {
    const expected = plainBuild();
    const first = incrementalBuild();
    expect({ out: first.out, messages: first.messages }).toEqual(expected);
    expect(first.summary).toBe('Incremental build: reused 0 of 4 files.');
    expect(fs.existsSync(path.join(projectDir, '.sushi-cache', 'manifest.json.gz'))).toBe(true);
    const second = incrementalBuild();
    // the error from the bad instance is reported again, as in the normal build
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    expect(second.summary).toBe('Incremental build: reused 4 of 4 files.');
  });

  it('should follow a change to the FSH', () => {
    incrementalBuild();
    const changed = [...FSH];
    changed[0] = 'Profile: MyPatient\nParent: Patient\n* name 2..*\n';
    const expected = plainBuild(changed);
    const second = incrementalBuild(changed);
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    expect(second.summary).toBe('Incremental build: reused 3 of 4 files.');
  });

  it('should import a file again when an alias it uses changes', () => {
    const fsh = [
      'Alias: $EX = http://example.org\n',
      'ValueSet: AliasVS\n* $EX#a "A"\n',
      ...FSH.slice(2)
    ];
    incrementalBuild(fsh);
    const changed = [...fsh];
    changed[0] = 'Alias: $EX = http://example.org/changed\n';
    const expected = plainBuild(changed);
    const second = incrementalBuild(changed);
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    // the alias's own file and the ValueSet that uses it
    expect(second.summary).toBe('Incremental build: reused 2 of 4 files.');
  });

  it('should not reuse imports made by a different SUSHI', () => {
    incrementalBuild();
    expect(incrementalBuild(FSH, '9.9.8').summary).toBe('Incremental build: reused 0 of 4 files.');
  });

  it('should reuse a ValueSet with a regex filter', () => {
    const fsh = [
      ...FSH,
      'ValueSet: RegexVS\n* include codes from system http://example.org where display regex /^A.*/\n'
    ];
    const expected = plainBuild(fsh);
    incrementalBuild(fsh);
    const second = incrementalBuild(fsh);
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    expect(second.summary).toBe('Incremental build: reused 5 of 5 files.');
  });

  it('should count a failure to record what an import used', () => {
    const fsh = [
      ...FSH,
      'RuleSet: Named(family)\n* name.family = "{family}"\n',
      'Instance: Pat2\nInstanceOf: Patient\n* insert Named(Jones)\n'
    ];
    spy = jest.spyOn(ParseCache.prototype, 'hash').mockImplementation(() => {
      throw new Error('boom');
    });
    const first = incrementalBuild(fsh);
    expect(first.notes).toContain('Incremental build: could not write to the cache (boom).');
    expect(
      loggerSpy
        .getAllMessages('debug')
        .filter(m => /unexpected error while hashing the RuleSet Named for .*: Error: boom/.test(m))
    ).toHaveLength(1);
  });

  it('should count a failure to cache an import', () => {
    spy = jest.spyOn(ParseCache.prototype, 'encodeDoc').mockImplementation(() => {
      throw new Error('boom');
    });
    const expected = plainBuild();
    const first = incrementalBuild();
    expect({ out: first.out, messages: first.messages }).toEqual(expected);
    expect(first.notes).toContain('Incremental build: could not write to the cache (boom).');
    expect(
      loggerSpy
        .getAllMessages('debug')
        .some(m => /unexpected error while encoding the import of .*: Error: boom/.test(m))
    ).toBe(true);
  });

  it('should count a failure to store an import', () => {
    spy = jest.spyOn(CacheStore.prototype, 'putPayload').mockImplementation(() => {
      throw new Error('boom');
    });
    const expected = plainBuild();
    const first = incrementalBuild();
    expect({ out: first.out, messages: first.messages }).toEqual(expected);
    expect(first.notes).toContain('Incremental build: could not write to the cache (boom).');
    expect(
      loggerSpy
        .getAllMessages('debug')
        .some(m => /unexpected error while storing the import of .*: Error: boom/.test(m))
    ).toBe(true);
  });

  it('should explain why a file was not cached', () => {
    // the importer logs the error object for a filter with no value
    const fsh = [
      ...FSH,
      'ValueSet: FilteredVS\n* include codes from system http://x.org where concept is-a\n'
    ];
    const expected = plainBuild(fsh);
    const first = incrementalBuild(fsh);
    expect({ out: first.out, messages: first.messages }).toEqual(expected);
    expect(loggerSpy.getAllMessages('debug')).toContainEqual(
      expect.stringMatching(
        /^Incremental build: did not cache the import of .*f4\.fsh, as a message it logs could not be copied\.$/
      )
    );
  });

  it('should not count cache problems as warnings', () => {
    incrementalBuild();
    const payloadDir = path.join(projectDir, '.sushi-cache', 'p');
    fs.readdirSync(payloadDir).forEach(file =>
      fs.writeFileSync(path.join(payloadDir, file), zlib.gzipSync('corrupt'))
    );
    const warningsBefore = stats.numWarn;
    const expected = plainBuild();
    const expectedWarnings = stats.numWarn - warningsBefore;
    const second = incrementalBuild();
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    expect(stats.numWarn - warningsBefore).toBe(2 * expectedWarnings);
    expect(second.notes.some(n => /removed \d+ corrupt file\(s\) from the cache/.test(n))).toBe(
      true
    );
  });

  it('should build normally when the cache is corrupt', () => {
    incrementalBuild();
    const cacheDir = path.join(projectDir, '.sushi-cache');
    fs.writeFileSync(path.join(cacheDir, 'manifest.json.gz'), zlib.gzipSync('{"format":'));
    const expected = plainBuild();
    const second = incrementalBuild();
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    expect(second.summary).toBe('Incremental build: reused 0 of 4 files.');
    expect(second.notes).toEqual([
      'Incremental build: the cache could not be read (Unexpected end of JSON input), so nothing was reused.'
    ]);
    // and then uses the cache it rewrote
    expect(incrementalBuild().summary).toBe('Incremental build: reused 4 of 4 files.');
  });

  it('should build normally when cached payloads are missing', () => {
    incrementalBuild();
    const payloadDir = path.join(projectDir, '.sushi-cache', 'p');
    fs.readdirSync(payloadDir).forEach(file => fs.unlinkSync(path.join(payloadDir, file)));
    const expected = plainBuild();
    const second = incrementalBuild();
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    expect(second.summary).toBe('Incremental build: reused 0 of 4 files.');
    expect(second.notes).toContainEqual(
      expect.stringMatching(
        /^Incremental build: could not use \d+ cached result\(s\) \(first: ENOENT/
      )
    );
  });

  it('should build without the cache when the cache cannot be opened', () => {
    fs.writeFileSync(path.join(projectDir, '.sushi-cache'), 'not a directory');
    const expected = plainBuild();
    const first = incrementalBuild();
    expect({ out: first.out, messages: first.messages }).toEqual(expected);
    expect(first.summary).toMatch(/^Incremental build: not used, cache unavailable \(/);
  });

  it('should keep the cache out of git', () => {
    incrementalBuild();
    expect(fs.readFileSync(path.join(projectDir, '.sushi-cache', '.gitignore'), 'utf8')).toMatch(
      /^\*$/m
    );
  });

  it('should note a cache it cannot save', () => {
    fs.mkdirSync(path.join(projectDir, '.sushi-cache', 'manifest.json.gz'), { recursive: true });
    const expected = plainBuild();
    const first = incrementalBuild();
    expect({ out: first.out, messages: first.messages }).toEqual(expected);
    expect(first.notes).toContainEqual(
      expect.stringMatching(/^Incremental build: could not save the cache \(/)
    );
  });

  it('should note files it cannot remove from the cache', () => {
    incrementalBuild();
    const stuck = path.join(projectDir, '.sushi-cache', 'p', 'stuck.json.gz');
    fs.mkdirSync(stuck);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stuck, old, old);
    const second = incrementalBuild();
    expect(second.notes).toContainEqual(
      expect.stringMatching(/^Incremental build: could not remove some files from the cache \(/)
    );
  });
});
