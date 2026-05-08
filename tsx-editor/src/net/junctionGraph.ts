import type { PlacedComponent, WireConnection } from '../types/catalog'
import { getPinConfig } from '../types/schematic'

export type JunctionPoint = { x: number; y: number }

type Segment = {
  wireId: string
  from: JunctionPoint
  to: JunctionPoint
}

type EndpointRef = {
  key: string
  wireId: string
  point: JunctionPoint
}

type UnionPair = [string, string]

const EPS = 0.25

const approxEq = (a: number, b: number): boolean => Math.abs(a - b) <= EPS
const pointEq = (a: JunctionPoint, b: JunctionPoint): boolean => approxEq(a.x, b.x) && approxEq(a.y, b.y)

const endpointKey = (componentId: string, pinName: string): string => `${componentId}::${pinName}`

const isPointOnSegment = (p: JunctionPoint, a: JunctionPoint, b: JunctionPoint): boolean => {
  const cross = (p.y - a.y) * (b.x - a.x) - (p.x - a.x) * (b.y - a.y)
  if (Math.abs(cross) > EPS) return false
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)
  if (dot < -EPS) return false
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
  return dot - len2 <= EPS
}

const isSegmentEndpoint = (p: JunctionPoint, segment: Segment): boolean => {
  return pointEq(p, segment.from) || pointEq(p, segment.to)
}

const normalizeRotation = (rotation: any): number => {
  const raw = String(rotation || '0deg').trim()
  const parsed = Number(raw.replace(/deg$/, ''))
  const base = Number.isFinite(parsed) ? parsed : 0
  return ((base % 360) + 360) % 360
}

const rotatePoint = (x: number, y: number, width: number, height: number, rotation: number): JunctionPoint => {
  if (rotation === 90) return { x: height - y, y: x }
  if (rotation === 180) return { x: width - x, y: height - y }
  if (rotation === 270) return { x: y, y: width - x }
  return { x, y }
}

const getPinOffset = (component: PlacedComponent, pinName: string): JunctionPoint => {
  if (component.catalogId === 'netport') return { x: 0, y: 11 }
  if (component.catalogId === 'public-port') return { x: 9, y: 9 }

  if (component.catalogId === 'subcircuit-instance' || component.catalogId === 'sheet-instance') {
    const ports = (component.props.ports as string[] | undefined) || []
    const width = component.catalogId === 'sheet-instance' ? 150 : 130
    const index = Math.max(0, ports.indexOf(pinName))
    const row = Math.floor(index / 2)
    const isLeft = index % 2 === 0
    return { x: isLeft ? 0 : width, y: 18 + row * 18 }
  }

  if (component.catalogId === 'symbol-instance') {
    const ports = ((component.props.ports as string[] | undefined) || []).map(String)
    const index = Math.max(0, ports.indexOf(pinName))
    const row = Math.floor(index / 2)
    const isLeft = index % 2 === 0
    return { x: isLeft ? 0 : 120, y: 18 + row * 18 }
  }

  const pinCfg = getPinConfig(component.catalogId)
  const pin = pinCfg?.pins.find(p => p.name === pinName)
  if (!pin) return { x: 0, y: 0 }
  return { x: pin.x, y: pin.y }
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
  if (component.catalogId === 'symbol-instance') return { width: 120, height: 56 }
  const pinCfg = getPinConfig(component.catalogId)
  return { width: pinCfg?.width || 60, height: pinCfg?.height || 40 }
}

const getEndpointPoint = (component: PlacedComponent, pinName: string): JunctionPoint => {
  const base = getComponentBaseSize(component)
  const local = getPinOffset(component, pinName)
  const rotation = normalizeRotation(component.props.schRotation)
  const rotated = rotatePoint(local.x, local.y, base.width, base.height, rotation)
  return {
    x: Number(component.props.schX || 0) + rotated.x,
    y: Number(component.props.schY || 0) + rotated.y
  }
}

const uniquePairs = (pairs: UnionPair[]): UnionPair[] => {
  const out: UnionPair[] = []
  const seen = new Set<string>()
  pairs.forEach(([a, b]) => {
    const left = a < b ? a : b
    const right = a < b ? b : a
    const key = `${left}@@${right}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push([left, right])
    }
  })
  return out
}

/**
 * JunctionGraph solver:
 * - endpoint touching wire = connected
 * - crossing wire != connected
 * - T-junction = connected
 * - explicit junction component required for cross-connect at crossings
 */
export const solveJunctionGraph = (
  components: PlacedComponent[],
  wires: WireConnection[]
): {
  endpointKeys: Set<string>
  unions: UnionPair[]
} => {
  const byId = new Map(components.map(c => [c.id, c]))
  const endpointKeys = new Set<string>()
  const unions: UnionPair[] = []
  const endpointsByWire = new Map<string, EndpointRef[]>()
  const segments: Segment[] = []

  wires.forEach((wire) => {
    const fromComp = byId.get(wire.from.componentId)
    const toComp = byId.get(wire.to.componentId)
    if (!fromComp || !toComp) return

    const fromKey = endpointKey(wire.from.componentId, wire.from.pinName)
    const toKey = endpointKey(wire.to.componentId, wire.to.pinName)
    endpointKeys.add(fromKey)
    endpointKeys.add(toKey)
    unions.push([fromKey, toKey])

    const fromPoint = getEndpointPoint(fromComp, wire.from.pinName)
    const toPoint = getEndpointPoint(toComp, wire.to.pinName)

    endpointsByWire.set(wire.id, [
      { key: fromKey, wireId: wire.id, point: fromPoint },
      { key: toKey, wireId: wire.id, point: toPoint }
    ])

    const routePoints = Array.isArray(wire.routePoints) && wire.routePoints.length >= 2
      ? wire.routePoints.map(point => ({ x: Number(point.x), y: Number(point.y) }))
      : []

    const polyline = routePoints.length >= 2 ? routePoints : [fromPoint, toPoint]
    for (let i = 0; i < polyline.length - 1; i += 1) {
      segments.push({
        wireId: wire.id,
        from: polyline[i],
        to: polyline[i + 1]
      })
    }
  })

  const wireAnchor = (wireId: string): string | null => {
    const refs = endpointsByWire.get(wireId)
    return refs && refs.length > 0 ? refs[0].key : null
  }

  // endpoint touching wire segment => connected
  endpointsByWire.forEach((refs) => {
    refs.forEach((ref) => {
      segments.forEach((segment) => {
        if (segment.wireId === ref.wireId) return
        if (!isPointOnSegment(ref.point, segment.from, segment.to)) return
        const anchor = wireAnchor(segment.wireId)
        if (!anchor) return
        unions.push([ref.key, anchor])
      })
    })
  })

  // T-junction: segment endpoint on another segment interior => connected
  segments.forEach((a) => {
    ;[a.from, a.to].forEach((endpoint) => {
      segments.forEach((b) => {
        if (a.wireId === b.wireId) return
        if (!isPointOnSegment(endpoint, b.from, b.to)) return
        if (isSegmentEndpoint(endpoint, b)) return
        const aAnchor = wireAnchor(a.wireId)
        const bAnchor = wireAnchor(b.wireId)
        if (aAnchor && bAnchor) unions.push([aAnchor, bAnchor])
      })
    })
  })

  // Explicit junction component can force cross-connect at a crossing.
  const explicitJunctions = components.filter(c => c.catalogId === 'junction')
  explicitJunctions.forEach((junction) => {
    const point = {
      x: Number(junction.props.schX || 0),
      y: Number(junction.props.schY || 0)
    }
    const touched = new Set<string>()
    segments.forEach((segment) => {
      if (isPointOnSegment(point, segment.from, segment.to)) {
        const anchor = wireAnchor(segment.wireId)
        if (anchor) touched.add(anchor)
      }
    })
    const anchors = [...touched]
    for (let i = 1; i < anchors.length; i += 1) {
      unions.push([anchors[0], anchors[i]])
    }
  })

  return {
    endpointKeys,
    unions: uniquePairs(unions)
  }
}
