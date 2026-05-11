/**
 * semanticLayout.ts
 * ─────────────────
 * Semantic-aware layout engine. Sits BETWEEN the ElectricalTruthGraph and
 * the raw ELK layout engine. Applies domain knowledge before ELK runs so
 * that the resulting schematic is readable without manual adjustment.
 *
 * Responsibilities:
 *   1. Classify components into semantic clusters (IC, decoupling, power, signal)
 *   2. Decide which nets are drawn as wires vs. repeated labels
 *   3. Pre-position clusters so ELK refines within each group
 *   4. Exclude netlabels / power symbols from ELK routing graph
 *   5. Never expose ELK-internal helper nodes to the canvas
 *
 * Key rules enforced here:
 *   - Power/ground nets → label strategy (no giant bus)
 *   - Decoupling caps   → placed near their IC power pin before ELK
 *   - SPI/I2C/UART signals → flagged as bus group, kept together by ELK groups
 *   - Analog components → placed in an isolated zone (separate ELK partition)
 *   - ELK nodes for netlabels/power symbols → NEVER created
 */

import type { PlacedComponent, WireConnection } from '../types/catalog'
import type { ElectricalTruthGraph, NetRole } from '../types/electricalTruth'
import { inferNetRole, inferPowerDistributionStrategy } from '../net/NetRegistry'
import type {
  SchematicViewGraph,
  SemanticCluster,
  SemanticClusterKind,
  NetLayoutDirective,
  NetLayoutStyle,
} from '../types/schematicView'
import { defaultNetLayoutDirective } from '../types/schematicView'

// ─── Component classification ─────────────────────────────────────────────────

type ComponentKind =
  | 'ic'           // integrated circuit, microcontroller, FPGA, ADC, …
  | 'passive'      // R, C, L, diode — no directional logic
  | 'decoupling'   // capacitor explicitly near a power pin
  | 'power-rail'   // voltage regulator, power management
  | 'connector'    // header, jack, USB connector
  | 'analog'       // op-amp, comparator, ADC, DAC
  | 'net-marker'   // internal editor net/netport placeholder — EXCLUDED from ELK
  | 'other'

const IC_CATALOG_IDS = new Set(['chip', 'customchip', 'subcircuit-instance', 'sheet-instance', 'symbol-instance'])
const PASSIVE_CATALOG_IDS = new Set(['resistor', 'capacitor', 'inductor', 'diode', 'led', 'transistor'])
const CONNECTOR_CATALOG_IDS = new Set(['connector', 'header'])
const ANALOG_CATALOG_IDS = new Set(['opamp'])
/** Internal editor helpers that must NEVER become ELK nodes */
const NET_MARKER_CATALOG_IDS = new Set(['net', 'netport', 'netlabel', 'public-port'])

export function classifyComponent(catalogId: string): ComponentKind {
  if (NET_MARKER_CATALOG_IDS.has(catalogId)) return 'net-marker'
  if (IC_CATALOG_IDS.has(catalogId))         return 'ic'
  if (PASSIVE_CATALOG_IDS.has(catalogId))    return 'passive'
  if (CONNECTOR_CATALOG_IDS.has(catalogId))  return 'connector'
  if (ANALOG_CATALOG_IDS.has(catalogId))     return 'analog'
  return 'other'
}

/**
 * Filter out all net-marker components before passing to ELK.
 * netlabels and power symbols provide electrical merging in the truth graph
 * but must NOT appear as routing nodes in the ELK graph.
 */
export function filterLayoutCandidates(components: PlacedComponent[]): PlacedComponent[] {
  return components.filter(c => classifyComponent(c.catalogId) !== 'net-marker')
}

// ─── Decoupling cap detection ─────────────────────────────────────────────────

const POWER_PIN_PATTERNS = /^(VDD|VCC|DVDD|AVDD|PVDD|3V3|5V|V_|VIN|PWR)/i
const GROUND_PIN_PATTERNS = /^(GND|AGND|DGND|PGND|VSS|NEG)/i
const DECOUPLING_CAP_PATTERNS = /^(BYPASS|DECOUPL|BULK|FILTER)/i

/**
 * Determine whether a capacitor is a decoupling cap by checking:
 * 1. Its name matches common bypass cap patterns
 * 2. One of its connected pins is a power pin and the other is ground
 */
function isDecouplingCap(
  component: PlacedComponent,
  wires: WireConnection[],
  byId: Map<string, PlacedComponent>
): boolean {
  if (component.catalogId !== 'capacitor') return false
  const name = String(component.name || component.props.name || '').toUpperCase()
  if (DECOUPLING_CAP_PATTERNS.test(name)) return true

  // Check if one side connects to a power net and the other to ground
  const myWires = wires.filter(
    w => w.from.componentId === component.id || w.to.componentId === component.id
  )
  let hasPowerSide = false
  let hasGroundSide = false
  for (const wire of myWires) {
    const otherId = wire.from.componentId === component.id
      ? wire.to.componentId
      : wire.from.componentId
    const otherPinName = wire.from.componentId === component.id
      ? wire.to.pinName
      : wire.from.pinName
    const other = byId.get(otherId)
    if (!other) continue
    const otherName = String(other.props.netName || other.props.net || other.props.name || other.name || '').toUpperCase()
    if (POWER_PIN_PATTERNS.test(otherName) || POWER_PIN_PATTERNS.test(otherPinName)) hasPowerSide = true
    if (GROUND_PIN_PATTERNS.test(otherName) || GROUND_PIN_PATTERNS.test(otherPinName)) hasGroundSide = true
  }
  return hasPowerSide && hasGroundSide
}

// ─── Signal bus detection ─────────────────────────────────────────────────────

const SPI_PATTERNS  = /^(MOSI|MISO|SCK|SCLK|SS|CS|NSS|SPI)/i
const I2C_PATTERNS  = /^(SDA|SCL|I2C)/i
const UART_PATTERNS = /^(TX|RX|CTS|RTS|UART|USART)/i

type BusKind = 'spi-group' | 'i2c-group' | 'uart-group' | null

function detectBusPin(pinName: string): BusKind {
  if (SPI_PATTERNS.test(pinName))  return 'spi-group'
  if (I2C_PATTERNS.test(pinName))  return 'i2c-group'
  if (UART_PATTERNS.test(pinName)) return 'uart-group'
  return null
}

// ─── Semantic cluster builder ──────────────────────────────────────────────────

let _clusterIdSeq = 0
function newClusterId(): string {
  _clusterIdSeq += 1
  return `sc-${_clusterIdSeq}`
}

/**
 * Analyse the placed components and wires to build a list of SemanticClusters.
 *
 * Clusters are:
 *   - Decoupling caps → each cap gets a cluster anchored to its IC power pin
 *   - SPI/I2C/UART   → all components sharing same-bus pins → one cluster per bus
 *   - Analog          → all analog components (opamps, …) → one isolated cluster
 */
export function buildSemanticClusters(
  components: PlacedComponent[],
  wires: WireConnection[]
): SemanticCluster[] {
  _clusterIdSeq = 0
  const clusters: SemanticCluster[] = []
  const byId = new Map(components.map(c => [c.id, c]))

  // ── 1. Decoupling caps ────────────────────────────────────────────────────
  for (const component of components) {
    if (!isDecouplingCap(component, wires, byId)) continue
    // Find the IC power pin this cap is closest to
    const myWires = wires.filter(
      w => w.from.componentId === component.id || w.to.componentId === component.id
    )
    let anchorComponentId: string | undefined
    let anchorPinName: string | undefined
    for (const wire of myWires) {
      const otherId = wire.from.componentId === component.id
        ? wire.to.componentId
        : wire.from.componentId
      const otherPin = wire.from.componentId === component.id
        ? wire.to.pinName
        : wire.from.pinName
      const other = byId.get(otherId)
      if (!other) continue
      if (classifyComponent(other.catalogId) === 'ic') {
        anchorComponentId = otherId
        anchorPinName = otherPin
        break
      }
    }
    clusters.push({
      id: newClusterId(),
      kind: 'decoupling',
      componentIds: [component.id],
      anchorComponentId,
      anchorPinName,
      preferredDirection: 'vertical',
    })
  }

  // ── 2. SPI / I2C / UART bus groups ───────────────────────────────────────
  const busMembers: Record<BusKind & string, Set<string>> = {
    'spi-group':  new Set(),
    'i2c-group':  new Set(),
    'uart-group': new Set(),
  }
  for (const wire of wires) {
    const busKind = detectBusPin(wire.from.pinName) || detectBusPin(wire.to.pinName)
    if (!busKind) continue
    busMembers[busKind].add(wire.from.componentId)
    busMembers[busKind].add(wire.to.componentId)
  }
  for (const [busKind, ids] of Object.entries(busMembers) as [SemanticClusterKind, Set<string>][]) {
    if (ids.size < 2) continue
    const validIds = [...ids].filter(id => {
      const c = byId.get(id)
      return c && classifyComponent(c.catalogId) !== 'net-marker'
    })
    if (validIds.length < 2) continue
    clusters.push({
      id: newClusterId(),
      kind: busKind,
      componentIds: validIds,
      preferredDirection: 'horizontal',
    })
  }

  // ── 3. Analog isolation cluster ───────────────────────────────────────────
  const analogIds = components
    .filter(c => classifyComponent(c.catalogId) === 'analog')
    .map(c => c.id)
  if (analogIds.length > 0) {
    clusters.push({
      id: newClusterId(),
      kind: 'analog-block',
      componentIds: analogIds,
      preferredDirection: 'vertical',
    })
  }

  return clusters
}

// ─── Net layout strategy ──────────────────────────────────────────────────────

/**
 * For each net in the truth graph, decide the layout style.
 * Power/ground → label (no giant bus).
 * Short local signal → wire.
 * Parallel data bus (D0–D7, A0–A15) → bus.
 */
export function buildNetLayoutDirectives(
  components: PlacedComponent[],
  wires: WireConnection[],
  truthGraph: ElectricalTruthGraph
): NetLayoutDirective[] {
  const directives: NetLayoutDirective[] = []
  const seen = new Set<string>()

  for (const net of truthGraph.nets) {
    if (seen.has(net.name)) continue
    seen.add(net.name)
    const role = inferNetRole(net.name)
    const strategy = inferPowerDistributionStrategy(net.name, role)
    const base = defaultNetLayoutDirective(net.name)

    if (strategy === 'global-label') {
      directives.push({ netName: net.name, style: 'label', priority: 10, powerStrategy: strategy })
      continue
    }
    if (strategy === 'local-island') {
      directives.push({ netName: net.name, style: 'label', priority: 8, powerStrategy: strategy })
      continue
    }
    if (role === 'spi' || role === 'i2c' || role === 'differential') {
      directives.push({ netName: net.name, style: 'bus', priority: 7, powerStrategy: strategy })
      continue
    }
    if (role === 'clock' || role === 'reset') {
      directives.push({ netName: net.name, style: 'wire', priority: 6, powerStrategy: strategy })
      continue
    }

    // Override: if a net has more than 4 connections, prefer label to avoid long tangly wire
    const connectionCount = truthGraph.connections.filter(c => c.netId === net.id).length
    if (connectionCount > 4 && base.style === 'wire') {
      directives.push({ netName: net.name, style: 'label', priority: 5, powerStrategy: strategy })
      continue
    }
    directives.push({ ...base, powerStrategy: strategy })
  }

  // Any net that remained (not in truthGraph) still applies defaults
  for (const component of components) {
    const name = String(component.props.netName || component.props.net || component.props.name || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    directives.push(defaultNetLayoutDirective(name))
  }

  return directives
}

// ─── ELK edge filter ─────────────────────────────────────────────────────────

/**
 * Filter wires to keep only those suitable for ELK routing.
 *
 * Excluded from ELK:
 *   - Any wire whose endpoint is a net-marker component (net, netport, netlabel)
 *   - Any wire connecting the same component to itself
 *
 * These wires still exist in the ViewGraph for rendering,
 * but ELK should not see them as routing edges.
 */
export function filterElkEdges(
  wires: WireConnection[],
  byId: Map<string, PlacedComponent>
): WireConnection[] {
  return wires.filter((wire) => {
    const from = byId.get(wire.from.componentId)
    const to   = byId.get(wire.to.componentId)
    if (!from || !to) return false
    if (from.id === to.id) return false
    // Exclude edges involving net-markers
    if (classifyComponent(from.catalogId) === 'net-marker') return false
    if (classifyComponent(to.catalogId)   === 'net-marker') return false
    return true
  })
}
