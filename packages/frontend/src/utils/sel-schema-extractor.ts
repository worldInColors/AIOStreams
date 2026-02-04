import { SELPropertyTree } from './sel-schema-types';
import schemaData from './sel-schema.json';

export type {
  SELPropertyTree,
  SELPropertyType,
  MatchHighlight,
} from './sel-schema-types';

/**
 * Get the SEL property tree for autocomplete suggestions.
 */
export function extractSELProperties(): SELPropertyTree[] {
  return schemaData as SELPropertyTree[];
}

export const SEL_PROPERTY_TREE: SELPropertyTree[] =
  schemaData as SELPropertyTree[];
