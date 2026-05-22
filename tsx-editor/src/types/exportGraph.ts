export type ExportTrace = {
  kind: 'trace'
  from: string
  to: string
  routePoints?: Array<{ x: number; y: number }>
  routingIntent?: 'manual' | 'semantic-auto' | 'orthogonal-auto' | 'bus'
  visualMode?: 'wire' | 'label-only' | 'hidden'
}

export type ExportNetDeclaration = {
  kind: 'net'
  name: string
  role?: string
  scope?: string
}

export type ExportNetLabel = {
  kind: 'netlabel'
  net: string
  schX?: number
  schY?: number
  netRole?: string
}

export type ExportGraphNode = ExportNetDeclaration | ExportTrace | ExportNetLabel

/**
 * ExportGraph is an intermediate compile target.
 * ViewGraph must not be serialized directly into TSX.
 */
export type ExportGraph = {
  nodes: ExportGraphNode[]
}
