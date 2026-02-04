export interface SELExpression {
  fullText: string;
  content: string;
  startIndex: number;
  endIndex: number;
  isClosed: boolean;
}

export interface CursorContext {
  inExpression: boolean;
  inQuotedString: boolean;
  currentPath: string[];
  currentPartial: string;
  suggestionStartIndex: number;
  suggestionEndIndex: number;
  expression?: SELExpression;
  afterOperator: boolean;
  currentOperator?: string;
  operatorStartIndex?: number;
  operatorEndIndex?: number;
}

export function parseSELTemplate(template: string): SELExpression[] {
  const expressions: SELExpression[] = [];
  let i = 0;

  while (i < template.length) {
    // Find opening brace
    const openBrace = template.indexOf('{', i);
    if (openBrace === -1) break;

    // Find the matching closing brace
    let closeBrace = template.indexOf('}', openBrace + 1);
    let isClosed = true;

    if (closeBrace === -1) {
      // Unclosed expression. Treat rest of string as expression
      closeBrace = template.length;
      isClosed = false;
    }

    const fullText = template.slice(openBrace, closeBrace + (isClosed ? 1 : 0));
    const content = template.slice(openBrace + 1, closeBrace);

    expressions.push({
      fullText,
      content,
      startIndex: openBrace,
      endIndex: closeBrace,
      isClosed,
    });

    i = closeBrace + 1;
  }

  return expressions;
}

export function isInExpression(
  template: string,
  cursorPosition: number
): boolean {
  let lastOpenBrace = -1;
  for (let i = cursorPosition - 1; i >= 0; i--) {
    if (template[i] === '{') {
      lastOpenBrace = i;
      break;
    } else if (template[i] === '}') {
      // We hit a closing brace first, so we're not in an expression
      return false;
    }
  }

  if (lastOpenBrace === -1) return false;

  for (let i = lastOpenBrace + 1; i < cursorPosition; i++) {
    if (template[i] === '}') {
      return false;
    }
  }

  return true;
}

export function getCurrentContext(
  template: string,
  cursorPosition: number
): CursorContext {
  const defaultContext: CursorContext = {
    inExpression: false,
    inQuotedString: false,
    currentPath: [],
    currentPartial: '',
    suggestionStartIndex: cursorPosition,
    suggestionEndIndex: cursorPosition,
    afterOperator: false,
  };

  let lastOpenBrace = -1;
  for (let i = cursorPosition - 1; i >= 0; i--) {
    if (template[i] === '{') {
      lastOpenBrace = i;
      break;
    } else if (template[i] === '}') {
      return defaultContext;
    }
  }

  if (lastOpenBrace === -1) return defaultContext;

  let closingBrace = -1;
  for (let i = cursorPosition; i < template.length; i++) {
    if (template[i] === '}') {
      closingBrace = i;
      break;
    } else if (template[i] === '{') {
      break;
    }
  }

  const isClosed = closingBrace !== -1;

  const contentBeforeCursor = template.slice(lastOpenBrace + 1, cursorPosition);

  // Check if cursor is inside a quoted string or a coniditional block after an operator

  let inDoubleQuote = false;
  let inSingleQuote = false;
  let bracketDepth = 0;
  let foundOperator = false;

  for (let i = 0; i < contentBeforeCursor.length; i++) {
    const char = contentBeforeCursor[i];
    const prevChar = i > 0 ? contentBeforeCursor[i - 1] : '';
    const nextChar =
      i < contentBeforeCursor.length - 1 ? contentBeforeCursor[i + 1] : '';

    // Track if we've seen ::
    if (char === ':' && nextChar === ':') {
      foundOperator = true;
    }

    // Track bracket depth (only after an operator)
    if (foundOperator && !inDoubleQuote && !inSingleQuote) {
      if (char === '[') bracketDepth++;
      if (char === ']') bracketDepth--;
    }

    if (char === '"' && prevChar !== '\\' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === "'" && prevChar !== '\\' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    }
  }

  const inQuotedString = inDoubleQuote || inSingleQuote;
  const inConditionalBlock = foundOperator && bracketDepth > 0;

  // If we're inside quotes or inside a conditional block, disable autocomplete
  if (inQuotedString || inConditionalBlock) {
    return {
      inExpression: true,
      inQuotedString: inQuotedString || inConditionalBlock,
      currentPath: [],
      currentPartial: '',
      suggestionStartIndex: cursorPosition,
      suggestionEndIndex: cursorPosition,
      afterOperator: false,
      expression: {
        fullText: template.slice(
          lastOpenBrace,
          isClosed ? closingBrace + 1 : template.length
        ),
        content: template.slice(
          lastOpenBrace + 1,
          isClosed ? closingBrace : template.length
        ),
        startIndex: lastOpenBrace,
        endIndex: isClosed ? closingBrace : template.length,
        isClosed,
      },
    };
  }

  // Check if we're after an operator
  const operatorMatch = contentBeforeCursor.match(/::([a-zA-Z0-9=<>^$~]*)$/);
  if (operatorMatch) {
    const operatorStartIndex = cursorPosition - operatorMatch[1].length;

    // Find where the operator ends
    let operatorEndIndex = cursorPosition;
    for (let i = cursorPosition; i < template.length; i++) {
      const char = template[i];
      if (
        char === ':' ||
        char === '[' ||
        char === ']' ||
        char === '}' ||
        char === ' '
      ) {
        break;
      }
      if (/[a-zA-Z0-9=<>^$~()]/.test(char)) {
        operatorEndIndex = i + 1;
      } else {
        break;
      }
    }

    return {
      inExpression: true,
      inQuotedString: false,
      currentPath: [],
      currentPartial: '',
      suggestionStartIndex: operatorStartIndex,
      suggestionEndIndex: operatorEndIndex,
      afterOperator: true,
      currentOperator: operatorMatch[1],
      operatorStartIndex,
      operatorEndIndex,
      expression: {
        fullText: template.slice(
          lastOpenBrace,
          isClosed ? closingBrace + 1 : template.length
        ),
        content: template.slice(
          lastOpenBrace + 1,
          isClosed ? closingBrace : template.length
        ),
        startIndex: lastOpenBrace,
        endIndex: isClosed ? closingBrace : template.length,
        isClosed,
      },
    };
  }

  const contentWithoutOperators = contentBeforeCursor.split('::')[0];

  const parts = contentWithoutOperators.split('.');

  const currentPartial = parts.pop() || '';
  const currentPath = parts;

  const suggestionStartIndex = cursorPosition - currentPartial.length;

  // Find where the current identifier ends
  let suggestionEndIndex = cursorPosition;
  for (let i = cursorPosition; i < template.length; i++) {
    const char = template[i];
    if (
      char === '.' ||
      char === '}' ||
      char === ':' ||
      char === ' ' ||
      char === '['
    ) {
      break;
    }
    if (/\w/.test(char)) {
      suggestionEndIndex = i + 1;
    } else {
      break;
    }
  }

  return {
    inExpression: true,
    inQuotedString: false,
    currentPath,
    currentPartial,
    suggestionStartIndex,
    suggestionEndIndex,
    afterOperator: false,
    expression: {
      fullText: template.slice(
        lastOpenBrace,
        isClosed ? closingBrace + 1 : template.length
      ),
      content: template.slice(
        lastOpenBrace + 1,
        isClosed ? closingBrace : template.length
      ),
      startIndex: lastOpenBrace,
      endIndex: isClosed ? closingBrace : template.length,
      isClosed,
    },
  };
}

export function shouldTriggerAutocomplete(
  template: string,
  cursorPosition: number,
  triggerCharacter?: string
): boolean {
  // Always trigger on {
  if (triggerCharacter === '{') {
    return true;
  }

  // Trigger on . if we're inside an expression
  if (triggerCharacter === '.') {
    return isInExpression(template, cursorPosition);
  }

  return isInExpression(template, cursorPosition);
}
