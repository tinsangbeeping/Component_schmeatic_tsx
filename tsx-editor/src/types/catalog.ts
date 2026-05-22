// Core types for the catalog system

export type PropType = 'string' | 'number' | 'select' | 'boolean'

export interface PropSchema {
  type: PropType
  label: string
  default?: any
  options?: string[] // for select type
  unit?: string // for display (e.g., "Ω", "F")
}

export interface EditablePropsSchema {
  [propName: string]: PropSchema
}

export interface CatalogItemMetadata {
  id: string
  label: string
  kind: 'part' | 'subcircuit'
  category?: string
  description?: string
  editablePropsSchema: EditablePropsSchema
  defaultProps: Record<string, any>
}

export interface CatalogItem {
  metadata: CatalogItemMetadata
  emitTSX: (props: Record<string, any>) => string
  // Optional: Component preview for catalog
  preview?: () => React.ReactNode
}

// FSMap type for project files
export interface FSMap {
  [filePath: string]: string
}

// Placed component instance (tracks what's on canvas)
export interface PlacedComponent {
  id: string // unique instance ID
  catalogId: string // reference to catalog item
  name: string // component name (e.g., "R1")
  props: Record<string, any> // current prop values including schX, schY
  tsxSnippet?: string // cached TSX representation
}

// Wire/Trace connection
export interface WireConnection {
  id: string
  from: {
    componentId: string
    pinName: string
  }
  to: {
    componentId: string
    pinName: string
  }
  routePoints?: Array<{
    x: number
    y: number
  }>
  // Editor-only metadata; not emitted as tscircuit JSX attribute.
  routingIntent?: 'manual' | 'semantic-auto' | 'orthogonal-auto' | 'bus'
  // Electrical graph edges may be logical-only. Hidden/label-only wires remain
  // part of the netlist/export truth but are not rendered as blue schematic wires.
  visualMode?: 'wire' | 'label-only' | 'hidden'
  tsxSnippet?: string
}

export interface ExposedPortSelection {
  componentId: string
  pinName: string
  portName: string
}

export interface SelectedPinRef {
  componentId: string
  pinName: string
}

export interface SubcircuitCreationState {
  active: boolean
  componentIds: string[]
  candidatePins: SelectedPinRef[]
  selectedPins: SelectedPinRef[]
}

// Editor state
export interface EditorState {
  fsMap: FSMap
  activeFilePath: string
  breadcrumbStack: string[]
  selectedComponentIds: string[] // Changed to array for multi-select
  placedComponents: PlacedComponent[]
  wires: WireConnection[]
  wiringStart: { componentId: string; pinName: string } | null
  cursorNearPin: { componentId: string; pinName: string } | null
  subcircuitCreation: SubcircuitCreationState
  viewport: {
    x: number
    y: number
    zoom: number
  }
  // Workspace model
  workspaces: Record<string, import('./workspace').WorkspaceData>
  activeWorkspaceId: string
  openFilePaths: string[]
}
