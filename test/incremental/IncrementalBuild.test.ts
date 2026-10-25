import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import temp from 'temp';
import { exportFHIR, Package } from '../../src/export';
import { RawFSH } from '../../src/import';
import { FHIRDefinitions } from '../../src/fhirdefs';
import { IncrementalBuild } from '../../src/incremental/IncrementalBuild';
import { ExportSession } from '../../src/incremental/ExportSession';
import { incrementalHooks } from '../../src/incremental/hooks';
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
    incrementalHooks.session = null;
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

  function incrementalBuild(fsh = FSH, options: any = {}) {
    loggerSpy.reset();
    const build = new IncrementalBuild(projectDir, '9.9.9');
    const tank = build.importFSH(rawFSH(fsh), minimalConfig);
    const pkg = build.exportFHIR(tank, defs, options, minimalConfig);
    const result = { out: output(pkg), messages: messages() };
    build.logSummary();
    build.finish();
    const own = loggerSpy.getAllMessages('info').filter(m => m.startsWith('Incremental build:'));
    const summary = own.find(m => m.includes(' reused ')) ?? own[0];
    const notes = own.filter(m => m !== summary);
    return { ...result, summary, notes };
  }

  it('should produce the same output as a normal build, then reuse it', () => {
    const expected = plainBuild();
    const first = incrementalBuild();
    expect({ out: first.out, messages: first.messages }).toEqual(expected);
    expect(first.summary).toBe('Incremental build: reused 0 of 4 files, 0 of 4 exports.');
    expect(fs.existsSync(path.join(projectDir, '.sushi-cache', 'manifest.json.gz'))).toBe(true);
    const second = incrementalBuild();
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    // the error from the bad instance is reported again, as in the normal build
    expect(second.summary).toBe('Incremental build: reused 4 of 4 files, 4 of 4 exports.');
  });

  it('should not reuse exports when the options change', () => {
    incrementalBuild();
    const second = incrementalBuild(FSH, { snapshot: true });
    expect(second.summary).toBe('Incremental build: reused 4 of 4 files, 0 of 4 exports.');
  });

  it('should not reuse exports when the configuration file changes', () => {
    incrementalBuild();
    fs.writeFileSync(path.join(projectDir, 'sushi-config.yaml'), 'id: test\n# changed\n');
    const second = incrementalBuild();
    expect(second.summary).toBe('Incremental build: reused 4 of 4 files, 0 of 4 exports.');
  });

  it('should follow a change to the FSH', () => {
    incrementalBuild();
    const changed = [...FSH];
    changed[0] = 'Profile: MyPatient\nParent: Patient\n* name 2..*\n';
    const expected = plainBuild(changed);
    const second = incrementalBuild(changed);
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    // the profile and its instance are exported again; the others are not affected
    expect(second.summary).toBe('Incremental build: reused 3 of 4 files, 2 of 4 exports.');
  });

  it('should report messages once when cached results are abandoned and everything is exported again', () => {
    const fsh = [...FSH, 'Profile: Inserted\nParent: Patient\n* insert MissingRuleSet\n'];
    incrementalBuild(fsh);
    // a Mapping that uses a replayed profile after the main export abandons the replay
    const withMapping = [
      ...fsh,
      'Mapping: MyMapping\nSource: MyPatient\nTarget: "http://example.org"\n* -> "Patient"\n'
    ];
    let errorsBefore = stats.numError;
    const expected = plainBuild(withMapping);
    const expectedErrors = stats.numError - errorsBefore;
    expect(expected.messages.some(m => /MissingRuleSet/.test(m))).toBe(true);
    errorsBefore = stats.numError;
    const second = incrementalBuild(withMapping);
    expect(second.summary).toMatch(/cached results did not apply/);
    expect(second.notes).toEqual([
      expect.stringMatching(/^Incremental build: exported everything again, because .+\.$/)
    ]);
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    expect(stats.numError - errorsBefore).toBe(expectedErrors);
  });

  describe('when its own bookkeeping fails', () => {
    let spy: jest.SpyInstance = null;

    afterEach(() => {
      spy?.mockRestore();
      spy = null;
    });

    function failIn(method: string) {
      spy = jest.spyOn(ExportSession.prototype as any, method).mockImplementation(() => {
        throw new Error('boom');
      });
    }

    it.each(['fishSignature', 'payloadOf', 'checkAfterExport'])(
      'should build normally without a cache when %s fails',
      method => {
        const expected = plainBuild();
        failIn(method);
        const first = incrementalBuild();
        expect({ out: first.out, messages: first.messages }).toEqual(expected);
        expect(first.notes).toEqual([
          expect.stringMatching(/exports cannot be reused \(.*boom.*\)/)
        ]);
      }
    );

    it.each(['fishSignature', 'payloadOf', 'checkAfterExport'])(
      'should build normally with a cache when %s fails, and keep the cache',
      method => {
        const expected = plainBuild();
        incrementalBuild();
        failIn(method);
        const second = incrementalBuild();
        expect({ out: second.out, messages: second.messages }).toEqual(expected);
        spy.mockRestore();
        spy = null;
        // what the first build recorded is still there to be used
        expect(incrementalBuild().summary).toBe(
          'Incremental build: reused 4 of 4 files, 4 of 4 exports.'
        );
      }
    );
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
    expect(second.summary).toBe('Incremental build: reused 5 of 5 files, 5 of 5 exports.');
  });

  it('should build normally when the cache is corrupt', () => {
    incrementalBuild();
    const cacheDir = path.join(projectDir, '.sushi-cache');
    fs.writeFileSync(path.join(cacheDir, 'manifest.json.gz'), zlib.gzipSync('{"format":'));
    const expected = plainBuild();
    const second = incrementalBuild();
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    expect(second.summary).toBe('Incremental build: reused 0 of 4 files, 0 of 4 exports.');
    expect(second.notes).toEqual([
      'Incremental build: the cache could not be read (Unexpected end of JSON input), so nothing was reused.'
    ]);
    // and then uses the cache it rewrote
    expect(incrementalBuild().summary).toBe(
      'Incremental build: reused 4 of 4 files, 4 of 4 exports.'
    );
  });

  it('should build normally when cached payloads are missing', () => {
    incrementalBuild();
    const payloadDir = path.join(projectDir, '.sushi-cache', 'p');
    fs.readdirSync(payloadDir).forEach(file => fs.unlinkSync(path.join(payloadDir, file)));
    const expected = plainBuild();
    const second = incrementalBuild();
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    expect(second.summary).toBe('Incremental build: reused 0 of 4 files, 0 of 4 exports.');
  });

  it('should keep the cache out of git', () => {
    incrementalBuild();
    expect(fs.readFileSync(path.join(projectDir, '.sushi-cache', '.gitignore'), 'utf8')).toMatch(
      /^\*$/m
    );
  });
});
