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
  cx: number
  cy: number
  width: number
  height: number
}

export interface SchematicCircleShape extends SymbolShapeBase {
  kind: 'schematiccircle'
  cx: number
  cy: number
  radius: number
}

export interface SchematicArcShape extends SymbolShapeBase {
  kind: 'schematicarc'
  cx: number
  cy: number
  radius: number
  startAngle: number
  endAngle: number
  direction?: 'clockwise' | 'counterclockwise'
}

export interface SchematicTextShape extends SymbolShapeBase {
  kind: 'schematictext'
  x: number
  y: number
  text: string
}

export type SymbolShape =
  | SchematicLineShape
  | SchematicRectShape
  | SchematicCircleShape
  | SchematicArcShape
  | SchematicTextShape

export type ElectricalDirection = 'input' | 'output' | 'inout' | 'passive'
export type SymbolPortSide = 'left' | 'right' | 'top' | 'bottom'
export type TscircuitPortDirection = 'left' | 'right' | 'up' | 'down'

export interface SymbolPort {
  id: string
  name: string
  electricalDirection?: ElectricalDirection
  side: SymbolPortSide
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
