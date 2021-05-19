import { FSHTank } from '../import/FSHTank';
import { CodeSystem, CodeSystemConcept, StructureDefinition } from '../fhirtypes';
import { setPropertyOnInstance, applyInsertRules } from '../fhirtypes/common';
import { FshCodeSystem } from '../fshtypes';
import { CaretValueRule, ConceptRule, CodeCaretValueRule } from '../fshtypes/rules';
import { logger } from '../utils/FSHLogger';
import { MasterFisher, Type, resolveSoftIndexing } from '../utils';
import { Package } from '.';
import { CannotResolvePathError } from '../errors';

export class CodeSystemExporter {
  constructor(
    private readonly tank: FSHTank,
    private readonly pkg: Package,
    private fisher: MasterFisher
  ) {}

  private setMetadata(codeSystem: CodeSystem, fshDefinition: FshCodeSystem): void {
    codeSystem.setName(fshDefinition.name, fshDefinition.sourceInfo);
    codeSystem.setId(fshDefinition.id, fshDefinition.sourceInfo);
    if (fshDefinition.title) codeSystem.title = fshDefinition.title;
    if (fshDefinition.description) codeSystem.description = fshDefinition.description;
    // Version is set to value provided in config, will be overriden if reset by rules
    codeSystem.version = this.tank.config.version;
    codeSystem.url = `${this.tank.config.canonical}/CodeSystem/${codeSystem.id}`;
  }

  private setConcepts(codeSystem: CodeSystem, concepts: ConceptRule[]): void {
    if (concepts.length > 0) {
      codeSystem.concept = [];
      concepts.forEach(concept => {
        let conceptContainer = codeSystem.concept;
        const newConcept: CodeSystemConcept = { code: concept.code };
        if (concept.display) {
          newConcept.display = concept.display;
        }
        if (concept.definition) {
          newConcept.definition = concept.definition;
        }
        for (const ancestorCode of concept.hierarchy) {
          const ancestorConcept = conceptContainer.find(
            ancestorConcept => ancestorConcept.code === ancestorCode
          );
          if (ancestorConcept) {
            if (!ancestorConcept.concept) {
              ancestorConcept.concept = [];
            }
            conceptContainer = ancestorConcept.concept;
          } else {
            logger.error(
              `Could not find ${ancestorCode} in concept hierarchy to use as ancestor of ${concept.code}.`,
              concept.sourceInfo
            );
            return;
          }
        }
        conceptContainer.push(newConcept);
      });
    }
  }

  private setCaretRules(
    codeSystem: CodeSystem,
    csStructureDefinition: StructureDefinition,
    rules: CaretValueRule[]
  ): void {
    resolveSoftIndexing(rules);
    for (const rule of rules) {
      try {
        const { assignedValue, pathParts } = csStructureDefinition.validateValueAtPath(
          rule.caretPath,
          rule.value,
          this.fisher
        );
        setPropertyOnInstance(codeSystem, pathParts, assignedValue, this.fisher);
      } catch (e) {
        logger.error(e.message, rule.sourceInfo);
      }
    }
  }

  private setCodeCaretRules(
    codeSystem: CodeSystem,
    csStructureDefinition: StructureDefinition,
    rules: CodeCaretValueRule[]
  ) {
    for (const rule of rules) {
      try {
        const conceptPath = this.findConceptPath(codeSystem, rule.codePath);
        const { assignedValue, pathParts } = csStructureDefinition.validateValueAtPath(
          `${conceptPath}.${rule.caretPath}`,
          rule.value,
          this.fisher
        );
        setPropertyOnInstance(codeSystem, pathParts, assignedValue, this.fisher);
      } catch (e) {
        logger.error(e.message, rule.sourceInfo);
      }
    }
  }

  private findConceptPath(codeSystem: CodeSystem, codePath: string[]): string {
    const conceptIndices: number[] = [];
    let conceptList = codeSystem.concept ?? [];
    for (const codeStep of codePath) {
      const stepIndex = conceptList.findIndex(concept => concept.code === codeStep);
      if (stepIndex === -1) {
        throw new CannotResolvePathError(codePath.map(code => `#${code}`).join(' '));
      }
      conceptIndices.push(stepIndex);
      conceptList = conceptList[stepIndex].concept ?? [];
    }
    return conceptIndices.map(conceptIndex => `concept[${conceptIndex}]`).join('.');
  }

  private countConcepts(concepts: CodeSystemConcept[]): number {
    if (concepts) {
      return (
        concepts.length +
        concepts
          .map(concept => this.countConcepts(concept.concept))
          .reduce((sum, next) => sum + next, 0)
      );
    } else {
      return 0;
    }
  }

  private updateCount(codeSystem: CodeSystem, fshDefinition: FshCodeSystem): void {
    // We can only derive a true count if the content is #complete
    if (codeSystem.content === 'complete') {
      const actualCount = this.countConcepts(codeSystem.concept) || undefined;
      if (codeSystem.count == null && actualCount != null) {
        codeSystem.count = actualCount;
      } else if (codeSystem.count !== actualCount) {
        const countRule = fshDefinition.rules.find(
          r => r instanceof CaretValueRule && r.caretPath === 'count'
        );
        const sourceInfo = countRule?.sourceInfo ?? fshDefinition.sourceInfo;
        logger.warn(
          `The user-specified ^count (${codeSystem.count}) does not match the specified number of concepts ` +
            `(${
              actualCount ?? 0
            }). If this is not a "complete" CodeSystem, set the ^content property to the appropriate ` +
            'value; otherwise fix or remove the ^count.',
          sourceInfo
        );
      }
    }
  }

  exportCodeSystem(fshDefinition: FshCodeSystem): CodeSystem {
    if (this.pkg.codeSystems.some(cs => cs.name === fshDefinition.name)) {
      return;
    }
    const codeSystem = new CodeSystem();
    this.setMetadata(codeSystem, fshDefinition);
    // fshDefinition.rules may include insert rules, which must be expanded before applying other rules
    applyInsertRules(fshDefinition, this.tank);
    const csStructureDefinition = StructureDefinition.fromJSON(
      this.fisher.fishForFHIR('CodeSystem', Type.Resource)
    );
    this.setCaretRules(
      codeSystem,
      csStructureDefinition,
      fshDefinition.rules.filter(rule => rule instanceof CaretValueRule) as CaretValueRule[]
    );
    this.setConcepts(
      codeSystem,
      fshDefinition.rules.filter(rule => rule instanceof ConceptRule) as ConceptRule[]
    );
    this.setCodeCaretRules(
      codeSystem,
      csStructureDefinition,
      fshDefinition.rules.filter(rule => rule instanceof CodeCaretValueRule) as CodeCaretValueRule[]
    );

    // check for another code system with the same id
    // see https://www.hl7.org/fhir/resource.html#id
    if (this.pkg.codeSystems.some(cs => codeSystem.id === cs.id)) {
      logger.error(
        `Multiple code systems with id ${codeSystem.id}. Each code system must have a unique id.`,
        fshDefinition.sourceInfo
      );
    }

    this.updateCount(codeSystem, fshDefinition);
    this.pkg.codeSystems.push(codeSystem);
    return codeSystem;
  }

  export(): Package {
    const codeSystems = this.tank.getAllCodeSystems();
    for (const cs of codeSystems) {
      try {
        this.exportCodeSystem(cs);
      } catch (e) {
        logger.error(e.message, cs.sourceInfo);
      }
    }
    if (codeSystems.length > 0) {
      logger.info(`Converted ${codeSystems.length} FHIR CodeSystems.`);
    }
    return this.pkg;
  }
}
