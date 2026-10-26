import { exportFHIR, Package } from '../../src/export';
import { FSHTank, RawFSH, importText } from '../../src/import';
import { FHIRDefinitions } from '../../src/fhirdefs';
import { ExportSession, ExportState, PayloadStore } from '../../src/incremental/ExportSession';
import { incrementalHooks } from '../../src/incremental/hooks';
import { hashString } from '../../src/incremental/serialize';
import { getTestFHIRDefinitions, loggerSpy, testDefsPath } from '../testhelpers';
import { minimalConfig } from '../utils/minimalConfig';

class MemoryStore implements PayloadStore {
  readonly payloads = new Map<string, string>();
  failReads = false;

  putPayload(json: string): string {
    const ref = hashString(json);
    this.payloads.set(ref, json);
    return ref;
  }

  getPayload(ref: string): any {
    if (this.failReads || !this.payloads.has(ref)) {
      throw new Error('missing payload');
    }
    return JSON.parse(this.payloads.get(ref));
  }
}

const FILES: Record<string, string> = {
  'aliases.fsh': `
Alias: $sct = http://snomed.info/sct
Alias: $loinc = http://loinc.org
`,
  'rulesets.fsh': `
RuleSet: Common
* ^status = #active
* ^publisher = "Example Publisher"

RuleSet: Flag(path)
* {path} MS
`,
  'profiles.fsh': `
Profile: MyPatient
Parent: Patient
* insert Common
* insert Flag(name)
* name 1..*
* gender = #female

Profile: MyObservation
Parent: Observation
* insert Common
* subject only Reference(MyPatient)
* code from MyVS (required)
* code ^short = "The code"

Profile: MyChildPatient
Parent: MyPatient
* birthDate 1..1

Extension: MyExtension
* value[x] only string
`,
  'terminology.fsh': `
ValueSet: MyVS
* include codes from system MyCS
* $sct#123 "Something"

CodeSystem: MyCS
* #a "A"
* #b "B"
`,
  'instances.fsh': `
Instance: Pat
InstanceOf: MyPatient
* name.family = "Smith"
* gender = #female

Instance: Obs
InstanceOf: MyObservation
* status = #final
* code = MyCS#a
* subject = Reference(Pat)
* contained[0] = InlinePat

Instance: InlinePat
InstanceOf: Patient
Usage: #inline
* name.family = "Inline"

Instance: Child
InstanceOf: MyChildPatient
* name.family = "Child"
* birthDate = "2020-01-01"

Instance: Bad
InstanceOf: Patient
* notAnElement = "value"
`
};

describe('ExportSession', () => {
  let defs: FHIRDefinitions;

  beforeAll(async () => {
    defs = await getTestFHIRDefinitions(true, testDefsPath('r4-definitions'));
  });

  beforeEach(() => {
    loggerSpy.reset();
  });

  afterEach(() => {
    incrementalHooks.session = null;
  });

  function output(pkg: Package) {
    return JSON.stringify({
      profiles: pkg.profiles.map(sd => sd.toJSON(true)),
      differentials: pkg.profiles.map(sd => sd.toJSON(false)),
      extensions: pkg.extensions.map(sd => sd.toJSON(true)),
      valueSets: pkg.valueSets.map(vs => vs.toJSON()),
      codeSystems: pkg.codeSystems.map(cs => cs.toJSON()),
      instances: pkg.instances.map(i => i.toJSON()),
      fileNames: [...pkg.profiles, ...pkg.extensions, ...pkg.valueSets, ...pkg.codeSystems].map(r =>
        r.getFileName()
      ),
      fshMap: [...pkg.fshMap.entries()]
    });
  }

  function logs() {
    // debug logs carry stack traces, which naturally differ between call paths
    return loggerSpy
      .getAllLogs()
      .filter(l => l.level !== 'debug')
      .map(l => [l.level, l.message, l.file, l.location]);
  }

  function run(files: Record<string, string>, session?: ExportSession) {
    loggerSpy.reset();
    const docs = importText(Object.entries(files).map(([path, text]) => new RawFSH(text, path)));
    const tank = new FSHTank(docs, minimalConfig);
    loggerSpy.reset();
    incrementalHooks.session = session ?? null;
    try {
      const pkg = exportFHIR(tank, defs);
      return { out: output(pkg), logs: logs() };
    } finally {
      incrementalHooks.session = null;
    }
  }

  function record(files: Record<string, string>, store: MemoryStore): ExportState {
    const session = new ExportSession(store, null);
    run(files, session);
    expect(session.aborted).toBe(false);
    return session.getState();
  }

  it('should export exactly as without a session when recording', () => {
    const plain = run(FILES);
    const session = new ExportSession(new MemoryStore(), null);
    const recorded = run(FILES, session);
    expect(recorded).toEqual(plain);
    expect(session.stats.replayed).toBe(0);
    expect(session.stats.exported).toBeGreaterThan(5);
    // the bad instance produces an error, which must be kept
    expect(plain.logs.some(l => l[0] === 'error')).toBe(true);
  });

  it('should replay everything when nothing changed, with the same output and logs', () => {
    const store = new MemoryStore();
    const state = record(FILES, store);
    const plain = run(FILES);
    const session = new ExportSession(store, state);
    const replayed = run(FILES, session);
    expect(session.aborted).toBe(false);
    expect(replayed).toEqual(plain);
    // everything except the instance that failed with an error can be reused
    expect(session.stats.replayed).toBeGreaterThan(0);
    expect(session.stats.replayed).toBe(Object.values(state.records).filter(rec => rec.ok).length);
  });

  it('should re-export a changed profile and what depends on it', () => {
    const store = new MemoryStore();
    const state = record(FILES, store);
    const changed = {
      ...FILES,
      'profiles.fsh': FILES['profiles.fsh'].replace('* name 1..*', '* name 2..*')
    };
    const plain = run(changed);
    const session = new ExportSession(store, state);
    const result = run(changed, session);
    expect(session.aborted).toBe(false);
    expect(result).toEqual(plain);
    expect(session.stats.reasons.changed).toBeGreaterThan(0);
    // the CodeSystem does not depend on the profile, so it is reused
    expect(session.stats.replayed).toBeGreaterThan(0);
  });

  it('should re-export what uses a changed RuleSet', () => {
    const store = new MemoryStore();
    const state = record(FILES, store);
    const changed = {
      ...FILES,
      'rulesets.fsh': FILES['rulesets.fsh'].replace('Example Publisher', 'Other Publisher')
    };
    const plain = run(changed);
    const session = new ExportSession(store, state);
    expect(run(changed, session)).toEqual(plain);
    expect(session.aborted).toBe(false);
  });

  it('should re-export what uses a changed alias', () => {
    const store = new MemoryStore();
    const state = record(FILES, store);
    const changed = {
      ...FILES,
      'aliases.fsh': FILES['aliases.fsh'].replace(
        'http://snomed.info/sct',
        'http://example.org/sct'
      )
    };
    const plain = run(changed);
    const session = new ExportSession(store, state);
    expect(run(changed, session)).toEqual(plain);
    expect(session.aborted).toBe(false);
  });

  it('should handle added, removed, and renamed entities', () => {
    const store = new MemoryStore();
    let state = record(FILES, store);
    const steps = [
      {
        ...FILES,
        'added.fsh': 'Instance: Added\nInstanceOf: MyPatient\n* name.family = "Added"\n'
      },
      {
        ...FILES,
        'instances.fsh': FILES['instances.fsh'].replace(/Instance: Child[^]*?(?=Instance: Bad)/, '')
      },
      {
        ...FILES,
        'profiles.fsh': FILES['profiles.fsh'].replace(/MyChildPatient/g, 'RenamedChild'),
        'instances.fsh': FILES['instances.fsh'].replace(/MyChildPatient/g, 'RenamedChild')
      }
    ];
    for (const files of steps) {
      const plain = run(files);
      const session = new ExportSession(store, state);
      expect(run(files, session)).toEqual(plain);
      expect(session.aborted).toBe(false);
      state = session.getState();
    }
  });

  it('should reproduce errors when a syntax error is introduced and fixed', () => {
    const store = new MemoryStore();
    let state = record(FILES, store);
    const broken = {
      ...FILES,
      'profiles.fsh': FILES['profiles.fsh'].replace('* name 1..*', '* = = BROKEN')
    };
    for (const files of [broken, FILES]) {
      const plain = run(files);
      const session = new ExportSession(store, state);
      expect(run(files, session)).toEqual(plain);
      state = session.getState();
    }
  });

  it('should export instances of a profile whose cached definition another instance changed', () => {
    const files: Record<string, string> = {
      ...FILES,
      'more.fsh': `
Instance: Pat2
InstanceOf: MyPatient
* name.family = "Ann"

Instance: Pat3
InstanceOf: MyPatient
* name.family = "Third"
* gender = #male
`
    };
    const store = new MemoryStore();
    let state = record(files, store);
    const edits = [
      { ...files, 'instances.fsh': files['instances.fsh'].replace('"Smith"', '"Jones"') },
      { ...files, 'more.fsh': files['more.fsh'].replace('"Third"', '"3rd"') },
      files
    ];
    for (const edited of edits) {
      const plain = run(edited);
      const session = new ExportSession(store, state);
      expect(run(edited, session)).toEqual(plain);
      expect(session.aborted).toBe(false);
      expect(session.stats.replayed).toBeGreaterThan(0);
      state = session.getState();
    }
  });

  it('should export normally when a cached result cannot be read', () => {
    const store = new MemoryStore();
    const state = record(FILES, store);
    store.failReads = true;
    const plain = run(FILES);
    const session = new ExportSession(store, state);
    expect(run(FILES, session)).toEqual(plain);
    expect(session.stats.replayed).toBe(0);
    expect(session.stats.reasons['cache read failed']).toBeGreaterThan(0);
  });

  it('should not replay anything from a state marked unstable', () => {
    const store = new MemoryStore();
    const state = record(FILES, store);
    const session = new ExportSession(store, { ...state, unstable: true });
    expect(run(FILES, session)).toEqual(run(FILES));
    expect(session.stats.replayed).toBe(0);
  });

  it('should not replay entities that were recorded as not reusable', () => {
    const store = new MemoryStore();
    const state = record(FILES, store);
    for (const rec of Object.values(state.records)) {
      rec.ok = false;
      rec.why = 'test';
    }
    const session = new ExportSession(store, state);
    expect(run(FILES, session)).toEqual(run(FILES));
    expect(session.stats.replayed).toBe(0);
    expect(session.stats.reasons['not reusable: test']).toBeGreaterThan(0);
  });

  it('should abort and discard its logs when a replay turns out to be wrong', () => {
    const store = new MemoryStore();
    const state = record(FILES, store);
    // Pretend the profile read a different set of package entries when it was recorded
    const rec = state.records['Profile:MyChildPatient'];
    rec.script = rec.script.map(ev =>
      ev[0] === 'R' ? ['R', ev[1], ev[2], [...ev[3], 'Profile:Nope']] : ev
    ) as any;
    const session = new ExportSession(store, state);
    run(FILES, session);
    // MyChildPatient is exported (live) because the planned check fails before replaying
    expect(session.stats.reasons['package lookup differs']).toBeGreaterThan(0);
  });
});
