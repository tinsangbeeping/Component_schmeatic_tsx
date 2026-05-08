export type ExportTrace = {
  kind: 'trace'
  from: string
  to: string
  routePoints?: Array<{ x: number; y: number }>
  routingIntent?: 'manual' | 'semantic-auto' | 'orthogonal-auto' | 'bus'
}

export type ExportNetLabel = {
  kind: 'netlabel'
  net: string
}

export type ExportGraphNode = ExportTrace | ExportNetLabel

/**
 * ExportGraph is an intermediate compile target.
 * ViewGraph must not be serialized directly into TSX.
 */
export type ExportGraph = {
  nodes: ExportGraphNode[]
}
