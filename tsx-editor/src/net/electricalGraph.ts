import { PlacedComponent, WireConnection } from '../types/catalog'
import { getPinConfig } from '../types/schematic'
import { ElectricalGraphModel, Junction, Net, PinRef, Point, Port, WireSegment } from '../types/electricalGraph'

const EPSILON = 0.25

const approxEqual = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON

const pointsEqual = (a: Point, b: Point): boolean => approxEqual(a.x, b.x) && approxEqual(a.y, b.y)

const canonicalPointKey = (p: Point): string => `${Math.round(p.x * 100) / 100},${Math.round(p.y * 100) / 100}`

class UnionFind {
  private parent = new Map<string, string>()

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id)
  }

  find(id: string): string {
    const current = this.parent.get(id)
    if (!current) {
      this.parent.set(id, id)
      return id
    }
    if (current === id) return id
    const root = this.find(current)
    this.parent.set(id, root)
    return root
  }

  union(a: string, b: string): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return
    if (rootA < rootB) this.parent.set(rootB, rootA)
    else this.parent.set(rootA, rootB)
  }

  keys(): string[] {
    return [...this.parent.keys()]
  }
}

type EndpointKind = 'pin' | 'port' | 'net-anchor' | 'label'

type EndpointMeta = {
  componentId: string
  pinName: string
  kind: EndpointKind
  point: Point
  boundNetId?: string
  boundNetName?: string
  netAlias?: string
}

const normalizeSignalKind = (value: string | undefined): Net['kind'] => {
  const token = String(value || '').trim().toLowerCase()
  if (token === 'analog') return 'analog'
  if (token === 'digital') return 'digital'
  if (token === 'power') return 'power'
  if (token === 'ground') return 'ground'
  if (token === 'reference') return 'reference'
  return undefined
}

const parsePortDirection = (value: unknown): Port['direction'] => {
  const token = String(value || '').trim().toLowerCase()
  if (token === 'input') return 'input'
  if (token === 'output') return 'output'
  if (token === 'bidirectional' || token === 'inout') return 'bidirectional'
  if (token === 'passive') return 'passive'
  return undefined
}

const getComponentBaseSize = (component: PlacedComponent): { width: number; height: number } => {
  if (component.catalogId === 'netport') return { width: 72, height: 22 }
  if (component.catalogId === 'public-port') return { width: 18, height: 18 }
  if (component.catalogId === 'subcircuit-instance') {
    const portCount = ((component.props.ports as string[] | undefined) || []).length
    const rows = Math.max(1, Math.ceil(portCount / 2))
    return { width: 130, height: Math.max(46, 28 + rows * 18) }
  }
  if (component.catalogId === 'sheet-instance') {
    const portCount = ((component.props.ports as string[] | undefined) || []).length
    const rows = Math.max(1, Math.ceil(portCount / 2))
    return { width: 150, height: Math.max(52, 34 + rows * 18) }
  }
  if (component.catalogId === 'symbol-instance') {
    return {
      width: Math.max(20, Number(component.props.symbolWidth || 120)),
      height: Math.max(20, Number(component.props.symbolHeight || 56))
    }
  }

  const schematic = getPinConfig(component.catalogId)
  return {
    width: schematic?.width || 60,
    height: schematic?.height || 40
  }
}

const normalizeRotation = (rotation: any): number => {
  const raw = String(rotation || '0deg').trim()
  const parsed = Number(raw.replace(/deg$/, ''))
  const base = Number.isFinite(parsed) ? parsed : 0
  return ((base % 360) + 360) % 360
}

const rotatePoint = (x: number, y: number, width: number, height: number, rotation: number): Point => {
  if (rotation === 90) return { x: height - y, y: x }
  if (rotation === 180) return { x: width - x, y: height - y }
  if (rotation === 270) return { x: y, y: width - x }
  return { x, y }
}

const getPinOffset = (component: PlacedComponent, pinName: string): Point => {
  if (component.catalogId === 'netport') return { x: 0, y: 11 }
  if (component.catalogId === 'public-port') return { x: 9, y: 9 }

  if (component.catalogId === 'subcircuit-instance' || component.catalogId === 'sheet-instance') {
    const ports = (component.props.ports as string[] | undefined) || []
    const width = component.catalogId === 'sheet-instance' ? 150 : 130
    const index = Math.max(0, ports.indexOf(pinName))
    const row = Math.floor(index / 2)
    const isLeft = index % 2 === 0
    return {
      x: isLeft ? 0 : width,
      y: 18 + row * 18
    }
  }

  if (component.catalogId === 'symbol-instance') {
    const explicitPorts = Array.isArray(component.props.symbolPorts)
      ? (component.props.symbolPorts as Array<{ name?: string; schX?: number; schY?: number; x?: number; y?: number }>)
      : []
    const match = explicitPorts.find(port => String(port.name || '') === pinName)
    if (match) {
      return {
        x: Number(match.schX ?? match.x ?? 0),
        y: Number(match.schY ?? match.y ?? 0)
      }
    }

    const ports = ((component.props.ports as string[] | undefined) || []).map(String)
    const width = Math.max(20, Number(component.props.symbolWidth || 120))
    const index = Math.max(0, ports.indexOf(pinName))
    const row = Math.floor(index / 2)
    const isLeft = index % 2 === 0
    return {
      x: isLeft ? 0 : width,
      y: 18 + row * 18
    }
  }

  const schematic = getPinConfig(component.catalogId)
  const pin = schematic?.pins.find(p => p.name === pinName)
  if (!pin) return { x: 0, y: 0 }
  return { x: pin.x, y: pin.y }
}

const getEndpointPoint = (component: PlacedComponent, pinName: string): Point => {
  const base = getComponentBaseSize(component)
  const offset = getPinOffset(component, pinName)
  const rotation = normalizeRotation(component.props.schRotation)
  const rotated = rotatePoint(offset.x, offset.y, base.width, base.height, rotation)

  return {
    x: Number(component.props.schX || 0) + rotated.x,
    y: Number(component.props.schY || 0) + rotated.y
  }
}

const isPointOnSegment = (point: Point, segment: { from: Point; to: Point }): boolean => {
  const { from, to } = segment
  const cross = (point.y - from.y) * (to.x - from.x) - (point.x - from.x) * (to.y - from.y)
  if (Math.abs(cross) > EPSILON) return false

  const dot = (point.x - from.x) * (to.x - from.x) + (point.y - from.y) * (to.y - from.y)
  if (dot < -EPSILON) return false

  const squaredLen = Math.pow(to.x - from.x, 2) + Math.pow(to.y - from.y, 2)
  if (dot - squaredLen > EPSILON) return false
  return true
}

const isSegmentEndpoint = (point: Point, segment: { from: Point; to: Point }): boolean => {
  return pointsEqual(point, segment.from) || pointsEqual(point, segment.to)
}

const classifyEndpoint = (component: PlacedComponent, pinName: string): EndpointMeta => {
  const point = getEndpointPoint(component, pinName)

  if (component.catalogId === 'public-port') {
    return {
      componentId: component.id,
      pinName,
      kind: 'port',
      point,
      boundNetId: String(component.props.netId || '').trim() || undefined,
      boundNetName: String(component.props.publicPortName || component.name || '').trim() || undefined
    }
  }

  if (component.catalogId === 'net' || component.catalogId === 'netport') {
    const boundNetName = String(component.props.netName || component.props.name || component.name || '').trim() || undefined
    return {
      componentId: component.id,
      pinName,
      kind: 'net-anchor',
      point,
      boundNetId: String(component.props.netId || '').trim() || undefined,
      boundNetName
    }
  }

  if (component.catalogId === 'netlabel') {
    return {
      componentId: component.id,
      pinName,
      kind: 'label',
      point,
      boundNetId: component.props.bindToNet ? String(component.props.netId || '').trim() || undefined : undefined,
      boundNetName: component.props.bindToNet ? String(component.props.net || component.props.netName || '').trim() || undefined : undefined,
      netAlias: String(component.props.net || component.props.netName || '').trim() || undefined
    }
  }

  return {
    componentId: component.id,
    pinName,
    kind: 'pin',
    point
  }
}

const segmentIdFor = (wireId: string, index: number): string => `${wireId}:seg:${index}`

const toStableNetId = (raw: string): string => {
  const safe = String(raw || '').trim().replace(/[^a-zA-Z0-9_:-]/g, '_')
  return safe || 'net_auto'
}

export const buildElectricalGraphModel = (
  components: PlacedComponent[],
  wires: WireConnection[]
): ElectricalGraphModel => {
  const componentById = new Map(components.map(component => [component.id, component]))
  const endpointByKey = new Map<string, EndpointMeta>()
  const uf = new UnionFind()
  const rawSegments: Array<{ id: string; from: Point; to: Point; wireId: string }> = []

  const endpointKey = (componentId: string, pinName: string): string => `${componentId}::${pinName}`

  wires.forEach((wire) => {
    const fromComp = componentById.get(wire.from.componentId)
    const toComp = componentById.get(wire.to.componentId)
    if (!fromComp || !toComp) return

    const fromMeta = classifyEndpoint(fromComp, wire.from.pinName)
    const toMeta = classifyEndpoint(toComp, wire.to.pinName)
    const fromKey = endpointKey(wire.from.componentId, wire.from.pinName)
    const toKey = endpointKey(wire.to.componentId, wire.to.pinName)

    endpointByKey.set(fromKey, fromMeta)
    endpointByKey.set(toKey, toMeta)

    uf.add(fromKey)
    uf.add(toKey)
    uf.union(fromKey, toKey)

    const routePoints = Array.isArray(wire.routePoints) && wire.routePoints.length >= 2
      ? wire.routePoints.map(point => ({ x: Number(point.x), y: Number(point.y) }))
      : []

    const polyline = routePoints.length >= 2
      ? routePoints
      : [fromMeta.point, toMeta.point]

    for (let i = 0; i < polyline.length - 1; i += 1) {
      rawSegments.push({
        id: segmentIdFor(wire.id, i),
        from: polyline[i],
        to: polyline[i + 1],
        wireId: wire.id
      })
    }
  })

  const endpoints = [...endpointByKey.entries()]
  endpoints.forEach(([key, endpoint]) => {
    rawSegments.forEach((segment) => {
      if (isSegmentEndpoint(endpoint.point, segment)) return
      if (isPointOnSegment(endpoint.point, segment)) {
        // Endpoint touching a segment is an electrical join.
        const segmentRootCandidate = wires.find(wire => segment.id.startsWith(`${wire.id}:`))
        if (!segmentRootCandidate) return
        const segmentEndpointKey = endpointKey(segmentRootCandidate.from.componentId, segmentRootCandidate.from.pinName)
        if (endpointByKey.has(segmentEndpointKey)) {
          uf.union(key, segmentEndpointKey)
        }
      }
    })
  })

  const groupByRoot = new Map<string, string[]>()
  uf.keys().forEach((id) => {
    const root = uf.find(id)
    const bucket = groupByRoot.get(root) || []
    bucket.push(id)
    groupByRoot.set(root, bucket)
  })

  const roots = [...groupByRoot.keys()].sort((a, b) => a.localeCompare(b))
  const rootToNetId = new Map<string, string>()
  const nets: Net[] = []
  const mergeHistory: ElectricalGraphModel['mergeHistory'] = []

  roots.forEach((root, index) => {
    const members = groupByRoot.get(root) || []
    const boundNetIds = members
      .map(member => endpointByKey.get(member)?.boundNetId)
      .filter((id): id is string => !!id)
      .map(toStableNetId)
      .sort((a, b) => a.localeCompare(b))

    const netNames = members
      .map(member => endpointByKey.get(member)?.boundNetName)
      .filter((name): name is string => !!name && name.trim().length > 0)

    const aliases = members
      .map(member => endpointByKey.get(member)?.netAlias)
      .filter((alias): alias is string => !!alias && alias.trim().length > 0)

    const canonicalNetId = boundNetIds[0] || `net_auto_${index + 1}`
    const canonicalName = netNames[0] || undefined
    const aliasSet = new Set<string>([...netNames.slice(1), ...aliases].map(alias => alias.trim()).filter(Boolean))
    if (canonicalName) aliasSet.delete(canonicalName)

    const signalKinds = members
      .map(member => endpointByKey.get(member))
      .map((meta) => {
        if (!meta) return undefined
        const component = componentById.get(meta.componentId)
        if (!component) return undefined
        if (meta.kind === 'port') {
          return normalizeSignalKind(String(component.props.signalKind || component.props.kind || ''))
        }
        return normalizeSignalKind(String(component.props.netRole || component.props.kind || ''))
      })
      .filter((kind): kind is NonNullable<Net['kind']> => !!kind)

    const net: Net = {
      id: canonicalNetId,
      name: canonicalName,
      kind: signalKinds[0],
      aliases: [...aliasSet]
    }

    nets.push(net)
    rootToNetId.set(root, canonicalNetId)

    if (boundNetIds.length > 1 || aliasSet.size > 0) {
      mergeHistory.push({
        canonicalNetId,
        mergedNetIds: boundNetIds.slice(1),
        aliases: [...aliasSet]
      })
    }
  })

  const ports: Port[] = []
  const pinRefs: PinRef[] = []
  const connections: ElectricalGraphModel['connections'] = []
  const connectionKeys = new Set<string>()

  endpointByKey.forEach((meta, key) => {
    const netId = rootToNetId.get(uf.find(key))
    if (!netId) return

    if (meta.kind === 'port') {
      const component = componentById.get(meta.componentId)
      const port: Port = {
        id: meta.componentId,
        name: String(component?.props.publicPortName || component?.name || 'PORT').trim() || 'PORT',
        direction: parsePortDirection(component?.props.direction),
        signalKind: normalizeSignalKind(String(component?.props.signalKind || component?.props.kind || '')),
        netId
      }

      if (!ports.some(existing => existing.id === port.id)) {
        ports.push(port)
      }

      const connectionKey = `port:${port.id}:${netId}`
      if (!connectionKeys.has(connectionKey)) {
        connectionKeys.add(connectionKey)
        connections.push({ type: 'port-to-net', portId: port.id, netId })
      }
      return
    }

    if (meta.kind === 'pin') {
      const pin: PinRef = {
        componentId: meta.componentId,
        pinName: meta.pinName
      }

      if (!pinRefs.some(existing => existing.componentId === pin.componentId && existing.pinName === pin.pinName)) {
        pinRefs.push(pin)
      }

      const connectionKey = `pin:${pin.componentId}:${pin.pinName}:${netId}`
      if (!connectionKeys.has(connectionKey)) {
        connectionKeys.add(connectionKey)
        connections.push({ type: 'pin-to-net', pin, netId })
      }
    }
  })

  const wireSegments: WireSegment[] = rawSegments.map((segment) => {
    const relatedWire = wires.find(wire => segment.id.startsWith(`${wire.id}:`))
    if (!relatedWire) {
      return {
        id: segment.id,
        from: segment.from,
        to: segment.to,
        netId: nets[0]?.id || 'net_auto_1'
      }
    }

    const root = uf.find(endpointKey(relatedWire.from.componentId, relatedWire.from.pinName))
    return {
      id: segment.id,
      from: segment.from,
      to: segment.to,
      netId: rootToNetId.get(root) || (nets[0]?.id || 'net_auto_1')
    }
  })

  const segmentsByPoint = new Map<string, Set<string>>()
  const pointToNetIds = new Map<string, Set<string>>()

  wireSegments.forEach((segment) => {
    ;[segment.from, segment.to].forEach((point) => {
      const pointKey = canonicalPointKey(point)
      const segmentSet = segmentsByPoint.get(pointKey) || new Set<string>()
      segmentSet.add(segment.id)
      segmentsByPoint.set(pointKey, segmentSet)

      const netSet = pointToNetIds.get(pointKey) || new Set<string>()
      netSet.add(segment.netId)
      pointToNetIds.set(pointKey, netSet)
    })
  })

  const junctions: Junction[] = []
  let junctionIndex = 0
  segmentsByPoint.forEach((segmentIds, pointKey) => {
    if (segmentIds.size < 3) return

    const [x, y] = pointKey.split(',').map(Number)
    const netIds = [...(pointToNetIds.get(pointKey) || new Set<string>())]
    junctions.push({
      id: `junction_${junctionIndex++}`,
      point: { x, y },
      netIds
    })
  })

  return {
    ports: ports.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    nets: nets.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    pinRefs: pinRefs.sort((a, b) => `${a.componentId}:${a.pinName}`.localeCompare(`${b.componentId}:${b.pinName}`)),
    connections,
    wireSegments,
    junctions,
    mergeHistory
  }
}
