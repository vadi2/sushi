import * as fshtypes from '../fshtypes';
import * as rules from '../fshtypes/rules';
import * as importModule from '../import';
import { ClassRegistry, buildClassRegistry } from './serialize';

let definitions: ClassRegistry;

/** Classes that FSH definitions (and the documents that hold them) are made of. */
export function definitionRegistry(): ClassRegistry {
  definitions = definitions ?? buildClassRegistry(fshtypes, rules, importModule);
  return definitions;
}
