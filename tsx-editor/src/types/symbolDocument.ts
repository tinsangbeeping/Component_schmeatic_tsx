export type SymbolShapeKind = 'schematicline' | 'schematicrect' | 'schematiccircle' | 'schematicarc' | 'schematictext'

export type SymbolToolMode = 'select' | SymbolShapeKind | 'port'

export interface SymbolShapeBase {
  id: string
  kind: SymbolShapeKind
}

export interface SchematicLineShape extends SymbolShapeBase {
  kind: 'schematicline'
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface SchematicRectShape extends SymbolShapeBase {
  kind: 'schematicrect'
  schX: number
  schY: number
  width: number
  height: number
}

export interface SchematicCircleShape extends SymbolShapeBase {
  kind: 'schematiccircle'
  center: { x: number; y: number }
  radius: number
}

export interface SchematicArcShape extends SymbolShapeBase {
  kind: 'schematicarc'
  center: { x: number; y: number }
  radius: number
  startAngleDegrees: number
  endAngleDegrees: number
}

export interface SchematicTextShape extends SymbolShapeBase {
  kind: 'schematictext'
  schX: number
  schY: number
  text: string
}

export type SymbolShape =
  | SchematicLineShape
  | SchematicRectShape
  | SchematicCircleShape
  | SchematicArcShape
  | SchematicTextShape

export type SymbolPortDirection = 'input' | 'output' | 'inout' | 'passive'
export type SymbolPortSide = 'left' | 'right' | 'top' | 'bottom'

export interface SymbolPort {
  id: string
  name: string
  direction: SymbolPortDirection
  side?: SymbolPortSide
  order?: number
  schX: number
  schY: number
}

export interface SymbolDocument {
  kind: 'symbol'
  name: string
  description: string
  width: number
  height: number
  needsManualReview?: boolean
  shapes: SymbolShape[]
  ports: SymbolPort[]
}

export type SymbolSelection =
  | { kind: 'shape'; id: string }
  | { kind: 'port'; id: string }
  | { kind: 'multi'; shapeIds: string[]; portIds: string[] }
  | null
