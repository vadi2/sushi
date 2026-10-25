import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import temp from 'temp';
import { exportFHIR, Package } from '../../src/export';
import { FSHTank, RawFSH } from '../../src/import';
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

  function incrementalBuild(fsh = FSH, options: any = {}, change?: (tank: FSHTank) => void) {
    loggerSpy.reset();
    const build = new IncrementalBuild(projectDir, '9.9.9');
    const tank = build.importFSH(rawFSH(fsh), minimalConfig);
    change?.(tank);
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

    it.each(['payloadOf', 'checkAfterExport'])(
      'should build normally with a cache when %s fails, and not use that cache again',
      method => {
        const expected = plainBuild();
        incrementalBuild();
        failIn(method);
        const second = incrementalBuild();
        expect({ out: second.out, messages: second.messages }).toEqual(expected);
        // the cache this build used may be what made it fail, so the next build does not use it,
        // and exports everything once
        const third = incrementalBuild();
        expect({ out: third.out, messages: third.messages }).toEqual(expected);
        expect(third.summary).toBe('Incremental build: reused 4 of 4 files, 0 of 4 exports.');
        expect(third.notes).toContain(
          'Incremental build: exports were not reused, as the previous build could not save them.'
        );
        spy.mockRestore();
        spy = null;
        incrementalBuild();
        expect(incrementalBuild().summary).toBe(
          'Incremental build: reused 4 of 4 files, 4 of 4 exports.'
        );
      }
    );

    it('should keep the previous cache when preparing the export fails before using it', () => {
      const expected = plainBuild();
      incrementalBuild();
      failIn('fishSignature');
      const second = incrementalBuild();
      expect({ out: second.out, messages: second.messages }).toEqual(expected);
      expect(second.summary).toBe('Incremental build: reused 4 of 4 files, 0 of 4 exports.');
      expect(second.notes[0]).toBe(
        'Incremental build: exports were not reused, as the export could not be prepared.'
      );
      spy.mockRestore();
      spy = null;
      expect(incrementalBuild().summary).toBe(
        'Incremental build: reused 4 of 4 files, 4 of 4 exports.'
      );
    });

    it('should keep the previous cache when two definitions have the same name', () => {
      incrementalBuild();
      const second = incrementalBuild(FSH, {}, tank => {
        const all = tank.getAllValueSets.bind(tank);
        tank.getAllValueSets = () => [...all(), ...all()];
      });
      expect(second.notes[0]).toBe(
        'Incremental build: exports were not reused, as there are two definitions of FshValueSet:MyVS.'
      );
      expect(incrementalBuild().summary).toBe(
        'Incremental build: reused 4 of 4 files, 4 of 4 exports.'
      );
    });

    it('should report what happened when exporting everything again fails', () => {
      const expected = plainBuild();
      incrementalBuild();
      failIn('checkAfterExport');
      let original: FSHTank = null;
      const all = FSHTank.prototype.getAllInstances;
      const tankSpy = jest.spyOn(FSHTank.prototype, 'getAllInstances').mockImplementation(function (
        this: FSHTank
      ) {
        if (original != null && this !== original) {
          throw new Error('kaboom');
        }
        return all.call(this);
      });
      try {
        loggerSpy.reset();
        const build = new IncrementalBuild(projectDir, '9.9.9');
        original = build.importFSH(rawFSH(FSH), minimalConfig);
        expect(() => build.exportFHIR(original, defs, {}, minimalConfig)).toThrow('kaboom');
      } finally {
        tankSpy.mockRestore();
      }
      const own = loggerSpy.getAllMessages('info').filter(m => m.startsWith('Incremental build:'));
      expect(own[0]).toMatch(
        /cached results did not apply; exported everything\), before the export failed\.$/
      );
      expect(own).toContainEqual(
        expect.stringMatching(/exported everything again, because .*boom/)
      );
      expect(own).toContainEqual(expect.stringMatching(/exports cannot be reused \(.*kaboom/));
      expect(
        loggerSpy
          .getAllMessages('debug')
          .some(m => /unexpected error export: Error: kaboom/.test(m))
      ).toBe(true);
      // the records it used are not used again
      spy.mockRestore();
      spy = null;
      const third = incrementalBuild();
      expect({ out: third.out, messages: third.messages }).toEqual(expected);
      expect(third.notes).toContain(
        'Incremental build: exports were not reused, as the previous build could not save them.'
      );
    });

    it('should keep the previous cache when it was not used', () => {
      incrementalBuild();
      // the definitions cannot be copied, so the cache is not used, and this build cannot be saved
      failIn('payloadOf');
      const second = incrementalBuild(FSH, {}, tank => ((tank.docs[0] as any).extra = () => 1));
      expect(second.notes[0]).toMatch(/definitions could not be copied/);
      spy.mockRestore();
      spy = null;
      expect(incrementalBuild().summary).toBe(
        'Incremental build: reused 4 of 4 files, 4 of 4 exports.'
      );
    });

    it('should keep the stack of an unexpected error', () => {
      failIn('checkAfterExport');
      incrementalBuild();
      expect(
        loggerSpy
          .getAllMessages('debug')
          .some(m => /unexpected error while bookkeeping: Error: boom\n\s+at /.test(m))
      ).toBe(true);
    });
  });

  it('should say why nothing was reused when the options change', () => {
    incrementalBuild();
    const second = incrementalBuild(FSH, { snapshot: true });
    expect(second.notes).toEqual([
      'Incremental build: exports were not reused, as the options, configuration, dependencies or SUSHI changed.'
    ]);
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
    expect(second.notes).toContainEqual(
      expect.stringMatching(
        /^Incremental build: could not use \d+ cached result\(s\) \(first: ENOENT/
      )
    );
  });

  it('should reuse imports when the build cannot be identified', () => {
    incrementalBuild();
    const config = path.join(projectDir, 'sushi-config.yaml');
    fs.unlinkSync(config);
    fs.mkdirSync(config);
    const expected = plainBuild();
    const second = incrementalBuild();
    expect({ out: second.out, messages: second.messages }).toEqual(expected);
    expect(second.summary).toMatch(
      /^Incremental build: reused 4 of 4 files, but no exports, as the build could not be identified \(.*EISDIR/
    );
    fs.rmdirSync(config);
    fs.writeFileSync(config, 'id: test\n');
    // the exports recorded before are still there
    expect(incrementalBuild().summary).toBe(
      'Incremental build: reused 4 of 4 files, 4 of 4 exports.'
    );
  });

  it('should keep the cache out of git', () => {
    incrementalBuild();
    expect(fs.readFileSync(path.join(projectDir, '.sushi-cache', '.gitignore'), 'utf8')).toMatch(
      /^\*$/m
    );
  });
});
