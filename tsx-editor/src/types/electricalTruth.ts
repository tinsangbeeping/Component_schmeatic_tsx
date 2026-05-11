/**
 * electricalTruth.ts
 * ──────────────────
 * The ELECTRICAL TRUTH GRAPH — the canonical, topology-correct representation
 * of a circuit. This layer answers "what is connected to what" and knows nothing
 * about how the schematic is drawn.
 *
 * Key invariant:
 *   SAME NET NAME  ≠  SAME VISIBLE WIRE
 *
 * Two pins can be on the same net (same NetId) without any visible wire between
 * them. Net membership is merged by:
 *   1. A SchematicWire explicitly connecting two pins
 *   2. A NetLabel or PowerSymbol declaring that a pin belongs to a named net
 *   3. A global power net (GND, VCC, …) that is implicitly shared
 *
 * This file contains ONLY data types. No UI state. No ELK positions.
 * All ELK / visual data lives in schematicView.ts.
 */

// ─── Primitives ───────────────────────────────────────────────────────────────

export type NetId = string   // opaque canonical identifier, e.g. "net__GND" or "net__DVDD"
export type PinKey = string  // "{componentId}:{pinName}", e.g. "U1:VDD"

// ─── Net identity ─────────────────────────────────────────────────────────────

/** Semantic role of a net; drives visual defaults and layout hints. */
export type NetRole =
  | 'power'     // positive supply rail (VCC, DVDD, 3V3, …)
  | 'ground'    // ground reference  (GND, AGND, DGND, PGND, …)
  | 'signal'    // ordinary logic / mixed signal net
  | 'clock'     // periodic clock (SCK, CLK, XTAL, …)
  | 'analog'    // analog signal (sensitive to crosstalk)
  | 'reference' // voltage/current reference (VREF, IREF, …)

/**
 * A net is a named set of electrically equivalent nodes.
 * A net has NO spatial information. Spatial info lives in SchematicViewGraph.
 */
export type TruthNet = {
  id: NetId
  /** Human-readable canonical name, e.g. "GND", "DVDD", "SPI_CLK" */
  name: string
  role: NetRole
  /**
   * Alternative names that were merged into this net (e.g. via union-find).
   * All aliases are electrically equivalent.
   */
  aliases: string[]
  /**
   * Whether this is a global/implicit net (GND, VCC, …) that components
   * connect to by name without an explicit wire.
   */
  isGlobal: boolean
}

// ─── Pins and ports ──────────────────────────────────────────────────────────

export type PinDirection = 'input' | 'output' | 'bidirectional' | 'passive' | 'power' | 'open-collector'
export type SignalKind   = 'analog' | 'digital' | 'power' | 'ground' | 'reference' | 'clock'

/** A single pin on a placed component. */
export type TruthPin = {
  key: PinKey          // "{componentId}:{pinName}"
  componentId: string
  pinName: string
  direction?: PinDirection
  signalKind?: SignalKind
  /** Which net this pin belongs to (undefined = unconnected) */
  netId?: NetId
}

/** A hierarchical port — boundary pin of a subcircuit. */
export type TruthPort = {
  id: string
  name: string
  direction: 'input' | 'output' | 'bidirectional'
  componentId: string  // the subcircuit instance that owns this port
  netId?: NetId
}

// ─── Connections ─────────────────────────────────────────────────────────────

/**
 * A connection in the TRUTH graph is a logical statement:
 * "pin A and pin B are on the same net."
 *
 * It does NOT imply any visual wire between A and B.
 * Visual wires are declared separately in SchematicViewGraph.
 *
 * Sources of connections:
 *   'wire'       → an explicit visible wire segment in SchematicViewGraph
 *   'netlabel'   → a netlabel placed on a pin assigning it to a named net
 *   'power'      → a power-symbol declaring a pin is on a global power net
 *   'port'       → a hierarchical port linking parent and child circuits
 *   'implicit'   → VCC/GND footprint pads that need no explicit connection
 */
export type ConnectionSource = 'wire' | 'netlabel' | 'power' | 'port' | 'implicit'

export type TruthConnection = {
  id: string
  pinA: PinKey
  pinB: PinKey
  netId: NetId
  source: ConnectionSource
}

// ─── Power and netlabels ──────────────────────────────────────────────────────

/**
 * A global named net that merges all same-named pins without any wire.
 * E.g. every chip pin called "GND" is automatically part of this net.
 *
 * This is TRUTH-layer: no position, no visual.
 */
export type GlobalNet = {
  netId: NetId
  canonicalName: string    // e.g. "GND"
  role: Extract<NetRole, 'power' | 'ground'>
  /** All pin keys that belong to this global net */
  memberPins: PinKey[]
}

// ─── The truth graph ─────────────────────────────────────────────────────────

/**
 * The complete electrical truth for one schematic/subcircuit file.
 *
 * BUILD FROM:  extracted from PlacedComponent[] + WireConnection[]
 * EXPORT TO:   <trace from="…" to="net.NAME" /> + <netlabel net="NAME" />
 *
 * NEVER include:
 *   - Canvas coordinates (that's SchematicViewGraph)
 *   - ELK-generated positions or routes
 *   - Visual rendering decisions
 */
export type ElectricalTruthGraph = {
  /** All nets known in this file (signal + power + ground) */
  nets: TruthNet[]
  /** All pins across all placed components */
  pins: TruthPin[]
  /** All hierarchical ports */
  ports: TruthPort[]
  /**
   * Explicit logical connections.
   * Note: same-net membership is already implicit via pin.netId;
   * connections here record WHY two pins ended up on the same net.
   */
  connections: TruthConnection[]
  /** Global power/ground nets (GND, VCC, DVDD, …) */
  globalNets: GlobalNet[]
  /**
   * Union-find merge history: records which raw net names were merged
   * into a canonical NetId, for debugging and round-trip accuracy.
   */
  mergeHistory: Array<{
    canonicalNetId: NetId
    mergedNames: string[]
  }>
}
