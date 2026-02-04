import {
  SELPropertyTree,
  SELPropertyType,
  MatchHighlight,
  extractSELProperties,
} from './sel-schema-extractor';
import { CursorContext } from './sel-parser';
import { SEL_OPERATORS } from './sel-operators-extractor';
import type { OperatorCategory, SELOperator } from './sel-operators-types';

export interface Suggestion {
  label: string;
  insertText: string;
  type: SELPropertyType | 'operator';
  description?: string;
  path: string;
  sortPriority: number;
  typeIcon?: string;
  enumValues?: string[];
  matchHighlight?: MatchHighlight;
  cursorOffset?: number;
  hasConditionalBlock?: boolean;
}

const TYPE_ICONS: Record<SELPropertyType, string> = {
  string: '𝐒',
  number: '#',
  boolean: '◯',
  array: '[]',
  object: '{}',
  enum: '⊞',
  unknown: '?',
};

const OPERATOR_CATEGORY_ICONS: Record<OperatorCategory, string> = {
  string: '𝐒',
  number: '#',
  array: '[]',
  boolean: '◯',
  comparison: '⟷',
  comparator: '⊕',
  function: 'ƒ',
};

function navigateToPath(
  tree: SELPropertyTree[],
  path: string[]
): SELPropertyTree | null {
  if (path.length === 0) return null;

  const [current, ...rest] = path;
  const property = tree.find(
    (p) => p.name.toLowerCase() === current.toLowerCase()
  );

  if (!property) return null;
  if (rest.length === 0) return property;
  if (!property.children) return null;

  return navigateToPath(property.children, rest);
}

function getPropertiesAtPath(
  tree: SELPropertyTree[],
  path: string[]
): SELPropertyTree[] {
  if (path.length === 0) return tree;

  const property = navigateToPath(tree, path);
  return property?.children || [];
}

/**
 * Sort operators and filter by partial match
 */
function getSortedOperators(partial: string = ''): SELOperator[] {
  const partialLower = partial.toLowerCase();

  // Filter by partial match
  let filtered = SEL_OPERATORS;
  if (partial) {
    filtered = SEL_OPERATORS.filter(
      (op) =>
        op.name.toLowerCase().includes(partialLower) ||
        op.label.toLowerCase().includes(partialLower)
    );
  }

  // Sort: exact match first, then starts with, then contains
  return filtered.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();

    // Exact match
    if (aName === partialLower && bName !== partialLower) return -1;
    if (bName === partialLower && aName !== partialLower) return 1;

    // Starts with
    const aStarts = aName.startsWith(partialLower);
    const bStarts = bName.startsWith(partialLower);
    if (aStarts && !bStarts) return -1;
    if (bStarts && !aStarts) return 1;

    // Alphabetical
    return aName.localeCompare(bName);
  });
}

/**
 * Generate operator suggestions when user types ::
 */
function generateOperatorSuggestions(context: CursorContext): Suggestion[] {
  const partial = context.currentOperator || '';
  const operators = getSortedOperators(partial);
  const partialLower = partial.toLowerCase();

  // Filter out operators that exactly match what's already typed
  const filtered = operators.filter((op) => {
    return op.name.toLowerCase() !== partialLower;
  });

  return filtered.map((op, index) => {
    // Calculate match highlight
    let matchHighlight: MatchHighlight | undefined;
    if (partial) {
      const matchIndex = op.name.toLowerCase().indexOf(partialLower);
      if (matchIndex !== -1) {
        matchHighlight = {
          start: matchIndex,
          end: matchIndex + partial.length,
        };
      }
    }

    return {
      label: op.label,
      insertText: op.insertText,
      type: 'operator' as const,
      path: `operator::${op.name}`,
      sortPriority: index,
      typeIcon: OPERATOR_CATEGORY_ICONS[op.category],
      matchHighlight,
      cursorOffset: op.cursorOffset,
      hasConditionalBlock: op.hasConditionalBlock,
    };
  });
}

export function generateSuggestions(
  context: CursorContext,
  template?: string
): Suggestion[] {
  if (!context.inExpression) {
    return [];
  }

  // Don't show autocomplete when inside quoted strings
  if (context.inQuotedString) {
    return [];
  }

  // Generate operator suggestions when after ::
  if (context.afterOperator) {
    return generateOperatorSuggestions(context);
  }

  const propertyTree = extractSELProperties();
  const properties = getPropertiesAtPath(propertyTree, context.currentPath);

  const partial = context.currentPartial;
  const partialLower = partial.toLowerCase();

  let fullWord = partial;
  if (template) {
    // Look for the end of the current word
    let endPos = context.suggestionStartIndex + partial.length;
    while (endPos < template.length) {
      const char = template[endPos];
      if (char === '.' || char === '}' || char === ':' || char === ' ') break;
      endPos++;
    }
    const wordAfterCursor = template.slice(
      context.suggestionStartIndex + partial.length,
      endPos
    );
    fullWord = partial + wordAfterCursor;
  }

  const cursorInMiddleOfWord = fullWord.length > partial.length;
  const exactMatch =
    fullWord.length > 0
      ? properties.find((p) => p.name.toLowerCase() === fullWord.toLowerCase())
      : null;

  // If cursor is in the middle of an exact match, dont show suggestions
  if (exactMatch && cursorInMiddleOfWord) {
    return [];
  }

  let filtered = properties;

  if (partial) {
    filtered = properties.filter((p) => {
      const name = p.name.toLowerCase();

      // If there's an exact match at cursor, only show properties that extend it
      if (exactMatch && !cursorInMiddleOfWord) {
        return name.startsWith(partialLower) && name.length > partial.length;
      }

      return name.startsWith(partialLower) || name.includes(partialLower);
    });
  }

  const suggestions: Suggestion[] = filtered.map((property, index) => {
    let insertText = property.name;

    let matchHighlight: MatchHighlight | undefined;
    if (partial) {
      const name = property.name.toLowerCase();
      const matchIndex = name.indexOf(partialLower);
      if (matchIndex !== -1) {
        matchHighlight = {
          start: matchIndex,
          end: matchIndex + partial.length,
        };
      }
    }

    return {
      label: property.name,
      insertText,
      type: property.type,
      description: property.description,
      path: property.path,
      sortPriority: getSortPriority(property, partial, index),
      typeIcon: TYPE_ICONS[property.type],
      enumValues: property.enumValues,
      matchHighlight,
    };
  });

  suggestions.sort((a, b) => a.sortPriority - b.sortPriority);

  return suggestions;
}

function getSortPriority(
  property: SELPropertyTree,
  partial: string,
  index: number
): number {
  let priority = 100 + index;

  const name = property.name.toLowerCase();
  const partialLower = partial.toLowerCase();

  if (name === partialLower) {
    priority = 0;
  } else if (name.startsWith(partialLower)) {
    priority = 10 + index;
  } else if (name.includes(partialLower)) {
    priority = 50 + index;
  }

  const commonProperties = [
    'size',
    'type',
    'resolution',
    'quality',
    'cached',
    'service',
    'addon',
    'parsedFile',
    'stream',
    'seeders',
    'age',
    'filename',
    'indexer',
  ];

  if (commonProperties.includes(property.name)) {
    priority -= 5;
  }

  return priority;
}

export function applySuggestion(
  template: string,
  context: CursorContext,
  suggestion: Suggestion
): { newTemplate: string; newCursorPosition: number } {
  const before = template.slice(0, context.suggestionStartIndex);
  const after = template.slice(context.suggestionEndIndex);

  let insertText = suggestion.insertText;
  let newCursorPosition = context.suggestionStartIndex + insertText.length;

  // Handle operator suggestions
  if (suggestion.type === 'operator') {
    // For operators with cursor offset (functions/conditionals), position cursor inside
    if (suggestion.cursorOffset !== undefined) {
      newCursorPosition =
        context.suggestionStartIndex +
        insertText.length -
        suggestion.cursorOffset;
    }

    const newTemplate = before + insertText + after;
    return { newTemplate, newCursorPosition };
  }

  // If the property is an object, add a dot
  if (suggestion.type === 'object' && suggestion.path !== 'debug') {
    // Check if there's already a dot after
    if (!after.startsWith('.') && !after.startsWith('}')) {
      insertText += '.';
      newCursorPosition = context.suggestionStartIndex + insertText.length;
    }
  }

  // If there's no closing brace and the property is a primitive, add one
  if (!context.expression?.isClosed && suggestion.type !== 'object') {
    insertText += '}';
    // Put cursor before the closing brace if we added it
    newCursorPosition = context.suggestionStartIndex + insertText.length - 1;
  }

  const newTemplate = before + insertText + after;

  return { newTemplate, newCursorPosition };
}
