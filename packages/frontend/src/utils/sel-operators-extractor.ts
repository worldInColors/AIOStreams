import operatorsData from './sel-operators.json';
import type { SELOperator } from './sel-operators-types';

export const SEL_OPERATORS: SELOperator[] = operatorsData as SELOperator[];

export function getOperatorsByCategory(category: string): SELOperator[] {
  return SEL_OPERATORS.filter((op) => op.category === category);
}

export function getAllOperators(): SELOperator[] {
  return SEL_OPERATORS;
}
