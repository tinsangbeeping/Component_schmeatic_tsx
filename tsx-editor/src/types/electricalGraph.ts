export type Point = {
  x: number
  y: number
}

export type Port = {
  id: string
  name: string
  direction?: 'input' | 'output' | 'bidirectional' | 'passive'
  signalKind?: 'analog' | 'digital' | 'power' | 'ground' | 'reference'
  netId?: string
}

export type Net = {
  id: string
  name?: string
  kind?: 'analog' | 'digital' | 'power' | 'ground' | 'reference'
  aliases?: string[]
}

export type PinRef = {
  componentId: string
  pinName: string
}

export type Connection =
  | { type: 'pin-to-net'; pin: PinRef; netId: string }
  | { type: 'port-to-net'; portId: string; netId: string }

export type WireSegment = {
  id: string
  from: Point
  to: Point
  netId: string
}

export type Junction = {
  id: string
  point: Point
  netIds: string[]
}

export type NetMergeHistory = {
  canonicalNetId: string
  mergedNetIds: string[]
  aliases: string[]
}

export type ElectricalGraphModel = {
  ports: Port[]
  nets: Net[]
  pinRefs: PinRef[]
  connections: Connection[]
  wireSegments: WireSegment[]
  junctions: Junction[]
  mergeHistory: NetMergeHistory[]
}

// ─── Internal editor schema (richer than tscircuit JSX) ───────────────────────

/**
 * How a connection is rendered visually in the editor.
 * - 'wire'       → drawn as a physical line between two pins
 * - 'label-only' → not drawn as a wire; net identity conveyed only via netlabel symbols
 * - 'hidden'     → logical connection only, no visual representation
 */
export type VisualConnectionMode = 'wire' | 'label-only' | 'hidden'

/**
 * The semantic role of a net.
 * Determines default visual treatment (power rails, signals, etc.)
 */
export type NetRole =
  | 'power'    // positive supply rail (VCC, DVDD, …)
  | 'ground'   // ground reference (GND, AGND, DGND, …)
  | 'signal'   // ordinary signal net
  | 'clock'    // clock signal
  | 'analog'   // analog signal
  | 'reference'// voltage reference

/**
 * A visible wire segment between two component pins stored in the editor.
 * Export target: <trace from="A" to="B" />
 */
export type SchematicWire = {
  id: string
  fromComponentId: string
  fromPinName: string
  toComponentId: string
  toPinName: string
  /** Intermediate bend-points for orthogonal routing */
  routePoints?: Point[]
  visualMode: VisualConnectionMode
  netId?: string
}

/**
 * A power/ground symbol placed on the schematic.
 * Export target: <trace from=".C1 > .pin1" to="net.GND" /> (no separate JSX tag)
 * The visual symbol is editor-only; tscircuit sees only a net.* reference.
 */
export type PowerSymbol = {
  id: string
  /** Canonical net name this symbol represents, e.g. 'GND', 'VCC', 'DVDD' */
  netName: string
  role: Extract<NetRole, 'power' | 'ground'>
  /** Canvas position (editor display only – never exported) */
  x: number
  y: number
  rotation?: number
}

/**
 * A net label placed on the schematic.
 * Export target: <netlabel net="NETNAME" />
 * Used to name nets and imply connections without drawing a physical wire.
 */
export type SchematicNetLabel = {
  id: string
  /** Canonical net name, e.g. 'DVDD', 'GND' */
  netName: string
  /** Canvas position */
  x: number
  y: number
  rotation?: number
  /** Which pin/component this label is electrically attached to (optional anchor) */
  anchorComponentId?: string
  anchorPinName?: string
}

/**
 * A hierarchical sheet port (input/output boundary of a subcircuit).
 * Export target: the port is referenced via selector in <trace from=".portName > .port" … />
 * Never exported as a standalone tscircuit tag.
 */
export type SheetPort = {
  id: string
  name: string
  direction: 'input' | 'output' | 'bidirectional'
  x: number
  y: number
  /** ELK-generated anchor position – editor display only, NEVER exported */
  elkAnchor?: Point
}
