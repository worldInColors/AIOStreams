import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SELPropertyTree {
  name: string;
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'array'
    | 'object'
    | 'enum'
    | 'unknown';
  path: string;
  description?: string;
  children?: SELPropertyTree[];
}

type OperatorCategory =
  | 'string'
  | 'number'
  | 'array'
  | 'boolean'
  | 'comparison'
  | 'comparator'
  | 'function';

interface SELOperator {
  name: string;
  label: string;
  insertText: string;
  category: OperatorCategory;
  hasConditionalBlock?: boolean;
  isFunction?: boolean;
  cursorOffset?: number;
}

function getTypeFromNode(
  typeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker
): SELPropertyTree['type'] {
  if (!typeNode) return 'unknown';

  if (ts.isUnionTypeNode(typeNode)) {
    const nonNullTypes = typeNode.types
      .filter(
        (t) =>
          !ts.isLiteralTypeNode(t) ||
          t.literal.kind !== ts.SyntaxKind.NullKeyword
      )
      .filter(
        (t) =>
          t.kind !== ts.SyntaxKind.NullKeyword &&
          t.kind !== ts.SyntaxKind.UndefinedKeyword
      );

    if (nonNullTypes.length === 1) {
      return getTypeFromNode(nonNullTypes[0], checker);
    }

    // Check if it's a string literal union
    const allStringLiterals = nonNullTypes.every(
      (t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)
    );
    if (allStringLiterals) return 'enum';

    return 'unknown';
  }

  if (ts.isArrayTypeNode(typeNode)) return 'array';

  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText();
    if (typeName === 'Array') return 'array';
    return 'unknown';
  }

  switch (typeNode.kind) {
    case ts.SyntaxKind.StringKeyword:
      return 'string';
    case ts.SyntaxKind.NumberKeyword:
      return 'number';
    case ts.SyntaxKind.BooleanKeyword:
      return 'boolean';
    case ts.SyntaxKind.ObjectKeyword:
      return 'object';
  }

  if (ts.isTypeLiteralNode(typeNode)) return 'object';

  return 'unknown';
}

function extractPropertiesFromTypeLiteral(
  typeLiteral: ts.TypeLiteralNode,
  parentPath: string,
  checker: ts.TypeChecker
): SELPropertyTree[] {
  const properties: SELPropertyTree[] = [];

  for (const member of typeLiteral.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;

    const propName = member.name.getText();
    const propPath = parentPath ? `${parentPath}.${propName}` : propName;
    const propType = getTypeFromNode(member.type, checker);

    const prop: SELPropertyTree = {
      name: propName,
      type: propType,
      path: propPath,
    };

    if (member.type && ts.isTypeLiteralNode(member.type)) {
      prop.children = extractPropertiesFromTypeLiteral(
        member.type,
        propPath,
        checker
      );
    }

    if (member.type && ts.isUnionTypeNode(member.type)) {
      const objectType = member.type.types.find((t) => ts.isTypeLiteralNode(t));
      if (objectType && ts.isTypeLiteralNode(objectType)) {
        prop.type = 'object';
        prop.children = extractPropertiesFromTypeLiteral(
          objectType,
          propPath,
          checker
        );
      }
    }

    properties.push(prop);
  }

  return properties;
}

function extractParseValueInterface(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
): SELPropertyTree[] {
  const result: SELPropertyTree[] = [];

  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'ParseValue') {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.name) continue;

        const namespaceName = member.name.getText();

        const namespace: SELPropertyTree = {
          name: namespaceName,
          type: 'object',
          path: namespaceName,
          children: [],
        };

        if (member.type) {
          if (ts.isTypeLiteralNode(member.type)) {
            namespace.children = extractPropertiesFromTypeLiteral(
              member.type,
              namespaceName,
              checker
            );
          } else if (ts.isIntersectionTypeNode(member.type)) {
            for (const t of member.type.types) {
              if (ts.isTypeLiteralNode(t)) {
                namespace.children = extractPropertiesFromTypeLiteral(
                  t,
                  namespaceName,
                  checker
                );
                break;
              }
            }
          }
        }

        result.push(namespace);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

function countProperties(tree: SELPropertyTree[]): number {
  let count = 0;
  for (const node of tree) {
    count++;
    if (node.children) {
      count += countProperties(node.children);
    }
  }
  return count;
}

/**
 * Extract operators from ModifierConstants and ComparatorConstants classes
 */
function extractOperators(sourceFile: ts.SourceFile): SELOperator[] {
  const operators: SELOperator[] = [];
  const foundOperators = new Set<string>();

  const conditionalOperators = new Set<string>();
  const functionOperators = new Set<string>();

  function addOperator(
    name: string,
    category: OperatorCategory,
    options: Partial<SELOperator> = {}
  ) {
    if (foundOperators.has(name)) return;
    foundOperators.add(name);

    const isFunction = functionOperators.has(name);
    const hasConditionalBlock = conditionalOperators.has(name);

    let insertText = name;
    let cursorOffset: number | undefined;

    if (isFunction) {
      if (name === 'replace') {
        insertText = "replace('', '')";
        cursorOffset = 6;
      } else if (name === 'join') {
        insertText = "join('')";
        cursorOffset = 2;
      } else if (name === 'truncate') {
        insertText = 'truncate()';
        cursorOffset = 1;
      } else if (name === 'slice') {
        insertText = 'slice()';
        cursorOffset = 1;
      }
    } else if (hasConditionalBlock) {
      insertText = name + '[""||\"\"]';
      cursorOffset = 6;
    }

    operators.push({
      name,
      label: name,
      insertText,
      category,
      hasConditionalBlock,
      isFunction,
      cursorOffset,
      ...options,
    });
  }

  function visit(node: ts.Node) {
    // Look for class declarations
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;

      if (className === 'ModifierConstants') {
        // detect function operators and conditional operators
        for (const member of node.members) {
          if (
            ts.isPropertyDeclaration(member) &&
            member.name &&
            ts.isIdentifier(member.name)
          ) {
            const propName = member.name.text;

            // Detect function operators from hardcodedModifiersForRegexMatching
            if (propName === 'hardcodedModifiersForRegexMatching') {
              if (
                member.initializer &&
                ts.isObjectLiteralExpression(member.initializer)
              ) {
                for (const prop of member.initializer.properties) {
                  if (ts.isPropertyAssignment(prop) && prop.name) {
                    let keyName: string | undefined;
                    if (ts.isStringLiteral(prop.name)) {
                      keyName = prop.name.text;
                    }
                    if (keyName) {
                      // Extract function name
                      const funcMatch = keyName.match(/^([a-z]+)\(/i);
                      if (funcMatch) {
                        functionOperators.add(funcMatch[1]);
                      }
                    }
                  }
                }
              }
            }

            // Detect conditional operators from conditionalModifiers
            if (propName === 'conditionalModifiers') {
              if (
                member.initializer &&
                ts.isObjectLiteralExpression(member.initializer)
              ) {
                for (const prop of member.initializer.properties) {
                  if (
                    ts.isPropertyAssignment(prop) &&
                    ts.isObjectLiteralExpression(prop.initializer)
                  ) {
                    for (const nestedProp of prop.initializer.properties) {
                      if (
                        ts.isPropertyAssignment(nestedProp) &&
                        nestedProp.name
                      ) {
                        let nestedKeyName: string | undefined;
                        if (ts.isIdentifier(nestedProp.name)) {
                          nestedKeyName = nestedProp.name.text;
                        } else if (ts.isStringLiteral(nestedProp.name)) {
                          nestedKeyName = nestedProp.name.text;
                        }
                        if (nestedKeyName) {
                          conditionalOperators.add(nestedKeyName);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // extract all operators
        for (const member of node.members) {
          if (
            ts.isPropertyDeclaration(member) &&
            member.name &&
            ts.isIdentifier(member.name)
          ) {
            const propName = member.name.text;

            let category: OperatorCategory = 'string';
            if (propName === 'stringModifiers') category = 'string';
            else if (propName === 'numberModifiers') category = 'number';
            else if (propName === 'arrayModifiers') category = 'array';
            else if (propName === 'conditionalModifiers') category = 'boolean';
            else continue;

            // Extract keys from the object literal
            if (
              member.initializer &&
              ts.isObjectLiteralExpression(member.initializer)
            ) {
              for (const prop of member.initializer.properties) {
                if (ts.isPropertyAssignment(prop) && prop.name) {
                  let keyName: string | undefined;
                  if (ts.isIdentifier(prop.name)) {
                    keyName = prop.name.text;
                  } else if (ts.isStringLiteral(prop.name)) {
                    keyName = prop.name.text;
                  }

                  if (keyName) {
                    // Handle nested objects
                    if (ts.isObjectLiteralExpression(prop.initializer)) {
                      const nestedCategory =
                        keyName === 'prefix' ? 'comparison' : 'boolean';
                      for (const nestedProp of prop.initializer.properties) {
                        if (
                          ts.isPropertyAssignment(nestedProp) &&
                          nestedProp.name
                        ) {
                          let nestedKeyName: string | undefined;
                          if (ts.isIdentifier(nestedProp.name)) {
                            nestedKeyName = nestedProp.name.text;
                          } else if (ts.isStringLiteral(nestedProp.name)) {
                            nestedKeyName = nestedProp.name.text;
                          }
                          if (nestedKeyName) {
                            addOperator(nestedKeyName, nestedCategory);
                          }
                        }
                      }
                    } else {
                      addOperator(keyName, category);
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (className === 'ComparatorConstants') {
        for (const member of node.members) {
          if (
            ts.isPropertyDeclaration(member) &&
            member.name &&
            ts.isIdentifier(member.name) &&
            member.name.text === 'comparatorKeyToFuncs'
          ) {
            if (
              member.initializer &&
              ts.isObjectLiteralExpression(member.initializer)
            ) {
              for (const prop of member.initializer.properties) {
                if (ts.isPropertyAssignment(prop) && prop.name) {
                  let keyName: string | undefined;
                  if (ts.isIdentifier(prop.name)) {
                    keyName = prop.name.text;
                  } else if (ts.isStringLiteral(prop.name)) {
                    keyName = prop.name.text;
                  }
                  if (keyName) {
                    addOperator(keyName, 'comparator');
                  }
                }
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Add function operators
  for (const funcName of functionOperators) {
    addOperator(funcName, 'function');
  }

  // Sort operators by category and name
  operators.sort((a, b) => {
    const categoryOrder: OperatorCategory[] = [
      'string',
      'number',
      'array',
      'boolean',
      'comparison',
      'comparator',
      'function',
    ];
    const catDiff =
      categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
    if (catDiff !== 0) return catDiff;
    return a.name.localeCompare(b.name);
  });

  return operators;
}

async function main() {
  console.log('Extracting schema ...\n');

  const baseTsPath = resolve(
    __dirname,
    '../packages/core/src/formatters/base.ts'
  );

  const sourceText = readFileSync(baseTsPath, 'utf-8');

  // Create a TypeScript program to get type information
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
  };

  const sourceFile = ts.createSourceFile(
    baseTsPath,
    sourceText,
    ts.ScriptTarget.ESNext,
    true
  );

  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile
  ) => {
    if (fileName === baseTsPath) return sourceFile;
    return originalGetSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile
    );
  };

  const program = ts.createProgram([baseTsPath], compilerOptions, host);
  const checker = program.getTypeChecker();

  const tree = extractParseValueInterface(sourceFile, checker);

  if (tree.length === 0) {
    console.error('ERROR: Could not find ParseValue interface in base.ts');
    process.exit(1);
  }

  const operators = extractOperators(sourceFile);

  const utilsDir = resolve(__dirname, '../packages/frontend/src/utils');

  const jsonPath = resolve(utilsDir, 'sel-schema.json');
  writeFileSync(jsonPath, JSON.stringify(tree, null, 2), 'utf-8');

  const operatorsJsonPath = resolve(utilsDir, 'sel-operators.json');
  writeFileSync(operatorsJsonPath, JSON.stringify(operators, null, 2), 'utf-8');

  console.log('\nSEL schema and operators extraction complete!');
}

main().catch(console.error);
