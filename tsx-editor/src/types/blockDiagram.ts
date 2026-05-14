export type BlockKind = 'active' | 'passive' | 'supply' | 'connector' | 'isolated'

export interface RawBlock {
  id: string
  title: string
  subtitle?: string
  kind: BlockKind
  memberComponentIds: string[]
  memberNames: string[]
  memberTypes: string[]
  netIds: string[]
}

export interface RawEdge {
  id: string
  sourceBlockId: string
  targetBlockId: string
  labels: string[]
  strength: number
}

export interface RawNet {
  id: string
  name: string
  componentIds: string[]
  endpointCount: number
}

export interface RawBlockGraph {
  rawBlocks: RawBlock[]
  rawEdges: RawEdge[]
  rawNets: RawNet[]
  debug: {
    visibleComponents: number
    carrierComponents: number
    isolatedBlocks: number
  }
}

export interface DiagramBlock {
  id: string
  title: string
  subtitle?: string
  kind: BlockKind
  childBlockIds: string[]
  rawBlockIds: string[]
  memberComponentIds: string[]
  x: number
  y: number
  width: number
  height: number
  color: string
}

export interface DiagramEdge {
  id: string
  sourceBlockId: string
  targetBlockId: string
  labels: string[]
  strength: number
}

export interface BlockDiagramState {
  blocks: DiagramBlock[]
  edges: DiagramEdge[]
  selectedBlockIds: string[]
}
