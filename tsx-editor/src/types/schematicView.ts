/**
 * schematicView.ts
 * ────────────────
 * The SCHEMATIC VIEW GRAPH — how the circuit is drawn on screen.
 * This layer answers "where is it drawn and how does it look."
 *
 * Key invariants:
 *   1. SAME NET ≠ SAME VISIBLE WIRE
 *      A visible wire must be declared explicitly here to be drawn.
 *      Netlabels and power symbols do NOT generate wires.
 *
 *   2. ELK ANCHORS ≠ SCHEMATIC POSITIONS
 *      ELK-generated coordinates are layout hints stored here temporarily
 *      during auto-layout. They are NEVER exported to tscircuit JSX.
 *
 *   3. netlabels / power symbols → NEVER become ELK routing nodes
 *      They provide only electrical merging (in ElectricalTruthGraph)
 *      and a placed symbol (in this file). The ELK layout engine must
 *      exclude them from its routing graph.
 *
 * Export mapping (this file → tscircuit JSX):
 *   ViewWire              → <trace from="A" to="B" />
 *   ViewNetLabel          → <netlabel net="NAME" />
 *   ViewPowerSymbol       → <trace from="." to="net.GND" /> (+ rendered symbol)
 *   ViewSheetPort         → referenced in trace selectors, never standalone tag
 *   ELK positions/anchors → NEVER exported
 */

import type { NetId, PinKey, NetRole } from './electricalTruth'

// ─── Visual modes ─────────────────────────────────────────────────────────────

/**
 * How a connection is rendered between two pins.
 * Stored per-wire to allow mixed rendering in one schematic.
 */
export type VisualConnectionMode =
  | 'wire'        // render as a blue orthogonal line
  | 'label-only'  // no line; net identity conveyed only by netlabel symbols at each endpoint
  | 'hidden'      // logical connection, no visual at all (useful for subcircuit boundaries)

export type RoutingIntent = 'manual' | 'semantic-auto' | 'orthogonal-auto' | 'bus'
export type PowerDistributionStrategy = 'global-label' | 'local-island' | 'continuous-rail'

// ─── Placed visual elements ───────────────────────────────────────────────────

/**
 * A visible wire drawn between exactly two component pins.
 *
 * Rule: a ViewWire ALWAYS requires both endpoints to be real component pins.
 * Net markers, netlabels, and ELK helper nodes MUST NOT be wire endpoints.
 *
 * Export: <trace from="fromSelector" to="toSelector" />
 */
export type ViewWire = {
  id: string
  fromComponentId: string
  fromPinName: string
  toComponentId: string
  toPinName: string
  /** Intermediate bend-points for orthogonal routing (editor display only) */
  routePoints?: Array<{ x: number; y: number }>
  mode: VisualConnectionMode
  routingIntent?: RoutingIntent
  /** Electrical net this wire belongs to (assigned by ElectricalTruthGraph) */
  netId?: NetId
}

/**
 * A net label symbol placed on the schematic.
 *
 * Provides:
 *   a) Electrical merging: all same-name labels share one net (in truth graph)
 *   b) Visual representation: a labelled flag symbol drawn near its anchor pin
 *
 * Does NOT generate any wire — not even locally.
 * The ELK layout engine MUST NOT include this as a routing node.
 *
 * Export: <netlabel net="NAME" />
 */
export type ViewNetLabel = {
  id: string
  netName: string      // canonical net name, e.g. "DVDD", "GND"
  netId?: NetId        // resolved net identity
  /** Canvas position where the label symbol is drawn */
  x: number
  y: number
  rotation?: 0 | 90 | 180 | 270
  /**
   * Optional anchor: which component pin this label is visually attached to.
   * Determines the small "stub" line from the label to the pin end.
   * If absent, the label floats freely.
   */
  anchorComponentId?: string
  anchorPinName?: string
}

/**
 * A power or ground symbol placed on the schematic.
 *
 * Provides:
 *   a) Electrical: declares its anchor pin is on a global power/ground net
 *   b) Visual: renders the standard power/ground symbol (VCC arrow, GND bar, …)
 *
 * Does NOT generate a separate JSX tag.
 * Export: <trace from=".C1 > .pin1" to="net.GND" />
 * (The symbol is editor-only rendering.)
 *
 * The ELK layout engine MUST NOT include this as a routing node.
 */
export type ViewPowerSymbol = {
  id: string
  netName: string      // e.g. "GND", "VCC", "DVDD"
  netId?: NetId
  role: Extract<NetRole, 'power' | 'ground'>
  /** Canvas position of the symbol's tip/base */
  x: number
  y: number
  rotation?: 0 | 90 | 180 | 270
  /** Which component pin this symbol is electrically attached to */
  anchorComponentId: string
  anchorPinName: string
}

/**
 * A hierarchical sheet port: the in/out boundary of a subcircuit.
 * Drawn as a directional port symbol on the schematic border.
 *
 * Export: referenced as trace selector ".portName > .port" (never standalone tag).
 *
 * elkAnchor: ELK-assigned position during auto-layout.
 * NEVER export elkAnchor to tscircuit JSX.
 */
export type ViewSheetPort = {
  id: string
  name: string
  direction: 'input' | 'output' | 'bidirectional'
  x: number
  y: number
  /**
   * ELK-generated anchor position during auto-layout.
   * Editor display only — NEVER exported to tscircuit JSX.
   */
  elkAnchor?: { x: number; y: number }
}

// ─── Semantic layout hints ────────────────────────────────────────────────────

/**
 * A semantic cluster groups components that should be placed near each other.
 * Used by the semantic-aware layout engine (NOT raw ELK).
 *
 * The layout engine reads these hints and applies pre-clustering before
 * passing the remaining topology to ELK. This prevents:
 *   - decoupling caps ending up far from their power pins
 *   - SPI/I2C signals being scattered across the sheet
 *   - analog front-end mixed into digital block
 *   - giant VCC/GND buses connecting everything
 */
export type SemanticClusterKind =
  | 'decoupling'     // bypass cap(s) near a power pin
  | 'spi-group'      // SPI bus signals (MOSI, MISO, SCK, CS) together
  | 'i2c-group'      // I2C bus signals (SDA, SCL) together
  | 'uart-group'     // UART signals (TX, RX, CTS, RTS) together
  | 'analog-block'   // analog front-end, isolated from digital
  | 'power-domain'   // components sharing a supply rail
  | 'functional'     // any user-defined functional grouping

export type SemanticCluster = {
  id: string
  kind: SemanticClusterKind
  /** Component IDs that belong to this cluster */
  componentIds: string[]
  /**
   * Preferred placement relative to an anchor component.
   * E.g. decoupling caps should be placed 'near' their IC power pin.
   */
  anchorComponentId?: string
  anchorPinName?: string
  /** Suggested layout direction within the cluster */
  preferredDirection?: 'horizontal' | 'vertical'
}

/**
 * A layout directive for a named net.
 * Controls whether the net is drawn as explicit wires or as repeated labels.
 *
 * 'wire'       → draw explicit trace lines (good for short local connections)
 * 'label'      → use repeated net labels (good for power rails, long-distance)
 * 'bus'        → group into a bus structure (good for parallel data lines)
 */
export type NetLayoutStyle = 'wire' | 'label' | 'bus'

export type NetLayoutDirective = {
  netName: string
  style: NetLayoutStyle
  powerStrategy?: PowerDistributionStrategy
  /**
   * Priority for label-style nets: higher priority labels are placed
   * closer to their anchor component.
   */
  priority?: number
}

// ─── The view graph ───────────────────────────────────────────────────────────

/**
 * The complete schematic view for one schematic/subcircuit file.
 *
 * This graph is DERIVED FROM ElectricalTruthGraph + user placement decisions.
 * It is the ONLY source of truth for what is rendered on screen.
 *
 * NEVER mix into ElectricalTruthGraph.
 * NEVER use here for connectivity queries — always use ElectricalTruthGraph.
 *
 * Export mapping to tscircuit JSX:
 *   wires         → <trace from="…" to="…" />
 *   netLabels     → <netlabel net="…" />
 *   powerSymbols  → <trace from="…" to="net.NAME" />  (symbol is editor-only)
 *   sheetPorts    → selector fragments, never standalone
 *   clusters      → NEVER exported (layout-engine internal)
 *   elk positions → NEVER exported
 */
export type SchematicViewGraph = {
  /** Explicitly drawn wires (the only source of blue lines on screen) */
  wires: ViewWire[]
  /** Placed net label symbols */
  netLabels: ViewNetLabel[]
  /** Placed power/ground symbols */
  powerSymbols: ViewPowerSymbol[]
  /** Hierarchical sheet ports */
  sheetPorts: ViewSheetPort[]
  /**
   * Semantic clusters for smart layout.
   * Read by semanticLayout.ts; ignored by the export layer.
   */
  clusters: SemanticCluster[]
  /**
   * Per-net layout style directives.
   * Determines whether a net is drawn as wire, label, or bus.
   * Power/ground nets default to 'label'.
   * Short local signal nets default to 'wire'.
   */
  netLayoutDirectives: NetLayoutDirective[]
}

// ─── Default layout directives for well-known nets ───────────────────────────

/**
 * Returns a default NetLayoutDirective for a net based on its name/role.
 * Power rails and common ground names default to label-style to avoid
 * giant bus connections across the sheet.
 */
export function defaultNetLayoutDirective(netName: string): NetLayoutDirective {
  const upper = netName.toUpperCase()
  const isPower =
    upper === 'VCC' ||
    upper === 'VDD' ||
    upper === 'DVDD' ||
    upper === 'AVDD' ||
    upper === 'PVDD' ||
    upper.startsWith('3V') ||
    upper.startsWith('5V') ||
    upper.startsWith('V_') ||
    upper.startsWith('VCC_') ||
    upper.startsWith('VDD_')
  const isGround =
    upper === 'GND' ||
    upper === 'AGND' ||
    upper === 'DGND' ||
    upper === 'PGND' ||
    upper.startsWith('GND_')

  if (isPower || isGround) {
    return { netName, style: 'label', priority: 10 }
  }
  // SPI / I2C / UART signals: draw as wires (local grouping handles distance)
  return { netName, style: 'wire', priority: 1 }
}
