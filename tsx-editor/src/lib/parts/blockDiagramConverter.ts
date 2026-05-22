import { getCatalogItem } from '../../catalog'
import type { PlacedComponent, WireConnection } from '../../types/catalog'
import type {
  RawBlock,
  RawBlockGraph,
  RawEdge,
  RawNet,
  BlockKind,
} from '../../types/blockDiagram'

const GLOBAL_NET_NAMES = new Set([
  'GND',
  'GROUND',
  'AGND',
  'DGND',
  'VCC',
  'VDD',
  'VSS',
  'VIN',
  'VBUS',
  '5V',
  '3V3',
  '3.3V',
  '12V',
  '24V',
])

const PASSIVE_TYPES = new Set([
  'resistor',
  'capacitor',
  'inductor',
  'diode',
  'jumper',
  'solderjumper',
  'testpoint',
  'voltageprobe',
  'netlabel',
])

const ACTIVE_TYPES = new Set([
  'chip',
  'customchip',
  'transistor',
  'mosfet_n',
  'mosfet_p',
  'switch',
  'pushbutton',
  'pinheader',
  'subcircuit-instance',
  'led',
])

const CARRIER_TYPES = new Set([
  'net',
  'netport',
  'netlabel',
])

const DECORATION_TYPES = new Set([
  'schematicline',
  'schematicrect',
  'schematiccircle',
  'schematicarc',
  'schematicpath',
  'schematictext',
  'trace',
])

class DSU {
  private parent = new Map<string, string>()

  find(x: string): string {
    const p = this.parent.get(x)

    if (!p) {
      this.parent.set(x, x)
      return x
    }

    if (p === x) return x

    const root = this.find(p)
    this.parent.set(x, root)

    return root
  }

  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)

    if (ra === rb) return

    if (ra < rb) this.parent.set(rb, ra)
    else this.parent.set(ra, rb)
  }
}

function endpointKey(endpoint: {
  componentId: string
  pinName: string
}) {
  return `${endpoint.componentId}:${endpoint.pinName}`
}

function isDecoration(component?: PlacedComponent) {
  return !!component && DECORATION_TYPES.has(component.catalogId)
}

function isCarrier(component?: PlacedComponent) {
  return !!component && CARRIER_TYPES.has(component.catalogId)
}

function isPassive(component?: PlacedComponent) {
  return !!component && PASSIVE_TYPES.has(component.catalogId)
}

function isActive(component?: PlacedComponent) {
  return !!component && ACTIVE_TYPES.has(component.catalogId)
}

function normalizedNetishName(component?: PlacedComponent) {
  if (!component) return ''

  return String(
    component.props?.netName ??
      component.props?.net ??
      component.props?.name ??
      component.name ??
      '',
  )
    .trim()
    .toUpperCase()
}

function isSupplyLike(component?: PlacedComponent) {
  if (!component) return false

  const name = normalizedNetishName(component)

  return (
    component.catalogId === 'voltagesource' ||
    component.catalogId === 'dcsource' ||
    component.catalogId === 'acsource' ||
    GLOBAL_NET_NAMES.has(name)
  )
}

function classifyKind(component?: PlacedComponent): BlockKind {
  if (!component) return 'isolated'
  if (isSupplyLike(component)) return 'supply'
  if (component.catalogId === 'subcircuit-instance') return 'active'
  if (isCarrier(component)) return 'connector'
  if (isActive(component)) return 'active'
  if (isPassive(component)) return 'passive'
  return 'isolated'
}

function getComponentLabel(component: PlacedComponent) {
  if (component.catalogId === 'subcircuit-instance') {
    const subName = String(component.props?.subcircuitName || '').trim()
    return subName ? `${component.name} (${subName})` : component.name
  }

  return String(component.name || component.props?.name || component.id)
}

function getComponentTypeLabel(component: PlacedComponent) {
  if (component.catalogId === 'subcircuit-instance') return 'Subcircuit'

  return getCatalogItem(component.catalogId)?.metadata?.label || component.catalogId
}

function getComponentCategory(component: PlacedComponent) {
  if (component.catalogId === 'subcircuit-instance') return 'Subcircuit'

  return getCatalogItem(component.catalogId)?.metadata?.category || 'Other'
}

function buildElectricalNets(
  components: PlacedComponent[],
  wires: WireConnection[],
): RawNet[] {
  const byId = new Map(components.map((c) => [c.id, c]))
  const uf = new DSU()
  const endpointComponent = new Map<string, string>()

  for (const wire of wires) {
    const fromComp = byId.get(wire.from.componentId)
    const toComp = byId.get(wire.to.componentId)

    if (!fromComp || !toComp) continue

    const a = endpointKey(wire.from)
    const b = endpointKey(wire.to)

    endpointComponent.set(a, wire.from.componentId)
    endpointComponent.set(b, wire.to.componentId)

    uf.union(a, b)
  }

  const rootToComponents = new Map<string, Set<string>>()
  const rootToNetNames = new Map<string, Set<string>>()

  endpointComponent.forEach((componentId, epKey) => {
    const root = uf.find(epKey)
    const comp = byId.get(componentId)

    if (!rootToComponents.has(root)) {
      rootToComponents.set(root, new Set())
    }

    rootToComponents.get(root)!.add(componentId)

    const netName = normalizedNetishName(comp)

    if (
      netName &&
      (GLOBAL_NET_NAMES.has(netName) ||
        comp?.catalogId === 'net' ||
        comp?.catalogId === 'netport' ||
        comp?.catalogId === 'netlabel')
    ) {
      if (!rootToNetNames.has(root)) {
        rootToNetNames.set(root, new Set())
      }

      rootToNetNames.get(root)!.add(netName)
    }
  })

  const nets: RawNet[] = []
  let i = 1

  for (const [root, componentSet] of rootToComponents.entries()) {
    const componentIds = [...componentSet]
    const explicitNames = [...(rootToNetNames.get(root) ?? new Set<string>())]
    const name = explicitNames[0] || `NET_${i++}`

    nets.push({
      id: root,
      name,
      componentIds,
      endpointCount: componentIds.length,
    })
  }

  return nets
}

/**
 * Decide where a passive component belongs.
 *
 * Priority:
 * 1. MCU / IC / custom chip / subcircuit owns nearby passives.
 * 2. Transistor / MOSFET can own passives.
 * 3. Switch owns debounce/filter weakly.
 * 4. LED owns series resistor weakly.
 */
function pickAnchorForPassive(
  component: PlacedComponent,
  byId: Map<string, PlacedComponent>,
  nets: RawNet[],
): string | null {
  let best: {
    score: number
    componentId: string
  } | null = null

  const componentType = component.catalogId.toLowerCase()

  for (const net of nets) {
    if (!net.componentIds.includes(component.id)) continue

    for (const otherId of net.componentIds) {
      if (otherId === component.id) continue

      const other = byId.get(otherId)
      if (!other) continue
      if (isCarrier(other) || isSupplyLike(other)) continue

      const otherType = other.catalogId.toLowerCase()
      const otherText = `${other.name} ${other.props?.name || ''} ${
        other.props?.subcircuitName || ''
      } ${getComponentTypeLabel(other)} ${getComponentCategory(other)}`.toLowerCase()

      let score = 0

      // Strongest: controller / IC / subcircuit should own nearby passives
      if (otherType === 'chip') score += 220
      if (otherType === 'customchip') score += 220
      if (otherType === 'subcircuit-instance') score += 200
      if (otherText.includes('mcu')) score += 240
      if (otherText.includes('microcontroller')) score += 240
      if (otherText.includes('controller')) score += 200
      if (otherText.includes('ic')) score += 170
      if (otherText.includes('integrated circuit')) score += 170

      // Medium: active power/signal stage
      if (otherType === 'transistor') score += 100
      if (otherType.includes('mosfet')) score += 100

      // Input-side controls can own simple passives, but not dominate the whole graph
      if (otherType === 'switch' || otherType === 'pushbutton') {
        score += 45
      }

      // LED owns series resistor weakly, but should not absorb too much
      if (otherType === 'led') {
        if (componentType === 'resistor') score += 40
        else score += 5
      }

      // Avoid passive-passive clustering becoming the main block
      if (isPassive(other)) score -= 25

      // Signal nets are more meaningful than global rails
      if (!GLOBAL_NET_NAMES.has(net.name)) score += 20
      else score -= 20

      if (!best || score > best.score) {
        best = {
          score,
          componentId: otherId,
        }
      }
    }
  }

  if (!best || best.score < 40) return null

  return best.componentId
}

export function buildRawBlockGraph(
  placedComponents: PlacedComponent[],
  wires: WireConnection[],
): RawBlockGraph {
  const visibleComponents = placedComponents.filter((c) => !isDecoration(c))
  const byId = new Map(visibleComponents.map((c) => [c.id, c]))
  const nets = buildElectricalNets(visibleComponents, wires)

  const carrierIds = new Set(
    visibleComponents.filter((c) => isCarrier(c)).map((c) => c.id),
  )

  const anchorByComponentId = new Map<string, string>()

  for (const component of visibleComponents) {
    if (carrierIds.has(component.id)) continue

    if (component.catalogId === 'subcircuit-instance') {
      anchorByComponentId.set(component.id, component.id)
      continue
    }

    if (isActive(component) || isSupplyLike(component)) {
      anchorByComponentId.set(component.id, component.id)
      continue
    }

    if (isPassive(component)) {
      const anchor = pickAnchorForPassive(component, byId, nets)

      if (anchor) {
        anchorByComponentId.set(component.id, anchor)
        continue
      }
    }

    anchorByComponentId.set(component.id, component.id)
  }

  const blockMembers = new Map<string, PlacedComponent[]>()

  for (const component of visibleComponents) {
    if (carrierIds.has(component.id)) continue

    const anchor = anchorByComponentId.get(component.id) || component.id
    const bucket = blockMembers.get(anchor) || []

    bucket.push(component)
    blockMembers.set(anchor, bucket)
  }

  const rawBlocks: RawBlock[] = []

  for (const [anchorId, members] of blockMembers.entries()) {
    const anchor = byId.get(anchorId) || members[0]

    const categories = [...new Set(members.map(getComponentCategory))]
    const typeLabels = [...new Set(members.map(getComponentTypeLabel))]
    const memberNames = members.map(getComponentLabel)
    const kinds = members.map(classifyKind)

    const kind: BlockKind =
      kinds.includes('supply')
        ? 'supply'
        : kinds.includes('active')
          ? 'active'
          : kinds.includes('connector')
            ? 'connector'
            : kinds.includes('passive')
              ? 'passive'
              : 'isolated'

    const title =
      anchor.catalogId === 'subcircuit-instance'
        ? getComponentLabel(anchor)
        : members.length === 1
          ? getComponentLabel(anchor)
          : `${getComponentLabel(
              members.find((m) => isActive(m) || isSupplyLike(m)) || anchor,
            )} block`

    const portCount =
      anchor.catalogId === 'subcircuit-instance'
        ? ((anchor.props.ports as string[] | undefined) || []).length
        : 0

    rawBlocks.push({
      id: anchorId,
      title,
      subtitle:
        anchor.catalogId === 'subcircuit-instance'
          ? `Subcircuit • ${portCount} ports`
          : `${categories.join(' · ')} • ${members.length} part${
              members.length > 1 ? 's' : ''
            }`,
      kind,
      layer: 'block',
      memberComponentIds: members.map((m) => m.id),
      memberNames,
      memberTypes: typeLabels,
      netIds: [],
    })
  }

  const netIdsByBlockId = new Map<string, Set<string>>()
  const edgeAccumulator = new Map<string, RawEdge>()
  const hubBlockIds = new Set<string>()

  const addEdge = (
    sourceBlockId: string,
    targetBlockId: string,
    netName: string,
    netId: string,
  ) => {
    if (sourceBlockId === targetBlockId) return

    const [source, target] =
      sourceBlockId < targetBlockId
        ? [sourceBlockId, targetBlockId]
        : [targetBlockId, sourceBlockId]

    const key = `${source}__${target}__${netId}`

    const autoGenerated =
      /^NET[_-]?\d*$/i.test(netName) ||
      /^N\d+$/i.test(netName)

    const strongName =
      GLOBAL_NET_NAMES.has(netName) || autoGenerated
        ? ''
        : netName
    const existing = edgeAccumulator.get(key)

    if (!existing) {
      edgeAccumulator.set(key, {
        id: key,
        sourceBlockId: source,
        targetBlockId: target,
        labels: strongName ? [strongName] : [],
        strength: GLOBAL_NET_NAMES.has(netName) ? 1 : 3,
        relation: 'electrical',
      })
    } else if (strongName && !existing.labels.includes(strongName)) {
      existing.labels.push(strongName)
    }
  }

  for (const net of nets) {
    const touchedBlocks = [
      ...new Set(
        net.componentIds
          .filter((id) => !carrierIds.has(id))
          .map((id) => anchorByComponentId.get(id) || id)
          .filter((blockId) => rawBlocks.some((b) => b.id === blockId)),
      ),
    ]

    for (const blockId of touchedBlocks) {
      const set = netIdsByBlockId.get(blockId) || new Set<string>()
      set.add(net.id)
      netIdsByBlockId.set(blockId, set)
    }

    if (touchedBlocks.length === 2) {
      addEdge(touchedBlocks[0], touchedBlocks[1], net.name, net.id)
      continue
    }

    if (touchedBlocks.length > 2) {
      // Prefer star topology around strongest active/controller block
      const scored = touchedBlocks
        .map((blockId) => {
          const block = rawBlocks.find((b) => b.id === blockId)

          let score = 0
          const text = `${block?.title || ''} ${block?.subtitle || ''}`.toLowerCase()

          if (text.includes('mcu')) score += 300
          if (text.includes('microcontroller')) score += 300
          if (text.includes('controller')) score += 250
          if (text.includes('ic')) score += 220
          if (text.includes('chip')) score += 220
          if (text.includes('subcircuit')) score += 180

          if (text.includes('led')) score -= 50
          if (text.includes('switch')) score -= 50

          return {
            blockId,
            score,
          }
        })
        .sort((a, b) => b.score - a.score)

      const center = scored[0]

      // If strong center exists, use star instead of hub mesh
      if (center && center.score >= 100) {
        for (const other of scored.slice(1)) {
          addEdge(center.blockId, other.blockId, net.name, net.id)
        }

        continue
      }

      // fallback to hub
      const hubId = `net-hub-${net.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`

      if (!hubBlockIds.has(hubId)) {
        hubBlockIds.add(hubId)

        rawBlocks.push({
          id: hubId,
          title: GLOBAL_NET_NAMES.has(net.name) ? net.name : net.name || 'NET',
          subtitle: `${touchedBlocks.length} connected blocks`,
          kind: 'connector',
          layer: 'block',
          memberComponentIds: [],
          memberNames: [],
          memberTypes: ['Net Hub'],
          netIds: [net.id],
        })
      }

      for (const blockId of touchedBlocks) {
        addEdge(hubId, blockId, net.name, net.id)
      }
    }
  }

  const connectedBlockIds = new Set<string>()

  edgeAccumulator.forEach((edge) => {
    connectedBlockIds.add(edge.sourceBlockId)
    connectedBlockIds.add(edge.targetBlockId)
  })

  const finalizedRawBlocks = rawBlocks.map((block) => ({
    ...block,
    netIds: block.netIds.length
      ? block.netIds
      : [...(netIdsByBlockId.get(block.id) || new Set<string>())],
  }))

  const hierarchyRawBlocks: RawBlock[] = []
  const hierarchyEdges: RawEdge[] = []

  for (const parent of finalizedRawBlocks) {
    if (parent.layer !== 'block' || parent.memberComponentIds.length === 0) continue

    const members = parent.memberComponentIds
      .map((componentId) => byId.get(componentId))
      .filter((component): component is PlacedComponent => !!component)

    for (const member of members) {
      const isSubcircuit = member.catalogId === 'subcircuit-instance'
      const childLayer = isSubcircuit ? 'subcircuit' : 'component'
      const childId = `${childLayer}:${parent.id}:${member.id}`
      const childTitle = getComponentLabel(member)
      const childType = getComponentTypeLabel(member)
      const ports = ((member.props?.ports as string[] | undefined) || []).length

      hierarchyRawBlocks.push({
        id: childId,
        title: childTitle,
        subtitle: isSubcircuit
          ? `Subcircuit instance${ports ? ` • ${ports} ports` : ''}`
          : `Component • ${childType}`,
        kind: classifyKind(member),
        layer: childLayer,
        parentBlockId: parent.id,
        memberComponentIds: [member.id],
        memberNames: [childTitle],
        memberTypes: [childType],
        netIds: parent.netIds,
      })

      hierarchyEdges.push({
        id: `hier:${parent.id}__${childId}`,
        sourceBlockId: parent.id,
        targetBlockId: childId,
        labels: [],
        strength: 1,
        relation: 'hierarchy',
      })
    }
  }

  return {
    rawBlocks: [...finalizedRawBlocks, ...hierarchyRawBlocks],
    rawEdges: [...edgeAccumulator.values(), ...hierarchyEdges],
    rawNets: nets,
    debug: {
      visibleComponents: visibleComponents.length,
      carrierComponents: carrierIds.size,
      isolatedBlocks: finalizedRawBlocks.filter((block) => !connectedBlockIds.has(block.id)).length,
    },
  }
}
