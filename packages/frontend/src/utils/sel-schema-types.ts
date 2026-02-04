export type SELPropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'enum'
  | 'unknown';

export interface SELPropertyTree {
  name: string;
  type: SELPropertyType;
  path: string;
  description?: string;
  children?: SELPropertyTree[];
  enumValues?: string[];
}

export interface MatchHighlight {
  start: number;
  end: number;
}
