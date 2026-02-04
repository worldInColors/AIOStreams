export type OperatorCategory =
  | 'string'
  | 'number'
  | 'array'
  | 'boolean'
  | 'comparison'
  | 'comparator'
  | 'function';

export interface SELOperator {
  name: string;
  label: string;
  insertText: string;
  category: OperatorCategory;
  hasConditionalBlock?: boolean;
  isFunction?: boolean;
  cursorOffset?: number;
}
