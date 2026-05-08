import ELK from 'elkjs'
import { PlacedComponent } from '../types/catalog'
import { getPinConfig } from '../types/schematic'
import { filterLayoutCandidates, filterElkEdges } from './semanticLayout'

const elk = new ELK()
const GRID_SIZE = 20

type ElkPortSide = 'WEST' | 'EAST' | 'NORTH' | 'SOUTH'

export interface LayoutPort {
  id: string
  width: number
  height: number
  properties?: Record<string, string>
  layoutOptions?: Record<string, string>
}

export interface LayoutNode {
  id: string
  width: number
  height: number
  ports: LayoutPort[]
  layoutOptions?: Record<string, string>
}

export interface LayoutEdge {
  id: string
  sources: string[]
  targets: string[]
}

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>
  routes: Map<string, Array<{ x: number; y: number }>>
}

const snapToGrid = (value: number): number => Math.round((value || 0) / GRID_SIZE) * GRID_SIZE

const toElkPortSide = (side?: string): ElkPortSide => {
  if (side === 'right') return 'EAST'
  if (side === 'top') return 'NORTH'
  if (side === 'bottom') return 'SOUTH'
  return 'WEST'
}

const getCustomChipLayoutPins = (component: PlacedComponent): Array<{ name: string; side: ElkPortSide }> => {
  const pinCount = Math.max(2, Number(component.props.pinCount || 8))
  const leftCount = Math.max(0, Number(component.props.leftPins ?? Math.ceil(pinCount / 2)))
  const rightCount = Math.max(0, Number(component.props.rightPins ?? Math.floor(pinCount / 2)))
  const topCount = Math.max(0, Number(component.props.topPins ?? 0))
  const bottomCount = Math.max(0, Number(component.props.bottomPins ?? 0))

  const namedMap = new Map<string, string>()
  const rawNames = String(component.props.pinNames || '').trim()
  if (rawNames.includes('=')) {
    rawNames
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        const [slot, ...rest] = entry.split('=')
        const slotKey = slot.trim().toUpperCase()
        const pinLabel = rest.join('=').trim()
        if (slotKey && pinLabel) {
          namedMap.set(slotKey, pinLabel)
        }
      })
  }

  const legacyNames = !rawNames.includes('=')
    ? rawNames.split(',').map(value => value.trim()).filter(Boolean)
    : []
  let legacyCursor = 0

  const resolveName = (slotKey: string, fallback: string) => {
    if (namedMap.has(slotKey)) return namedMap.get(slotKey) as string
    if (legacyCursor < legacyNames.length) {
      const next = legacyNames[legacyCursor]
      legacyCursor += 1
      return next
    }
    return fallback
  }

  const pins: Array<{ name: string; side: ElkPortSide }> = []
  for (let i = 0; i < leftCount; i += 1) pins.push({ name: resolveName(`L${i + 1}`, `pin${i + 1}`), side: 'WEST' })
  for (let i = 0; i < rightCount; i += 1) pins.push({ name: resolveName(`R${i + 1}`, `pin${leftCount + i + 1}`), side: 'EAST' })
  for (let i = 0; i < topCount; i += 1) pins.push({ name: resolveName(`U${i + 1}`, `U${i + 1}`), side: 'NORTH' })
  for (let i = 0; i < bottomCount; i += 1) pins.push({ name: resolveName(`D${i + 1}`, `D${i + 1}`), side: 'SOUTH' })
  return pins
}

const dedupeRoutePoints = (points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => {
  const deduped: Array<{ x: number; y: number }> = []
  points.forEach((point) => {
    const next = { x: snapToGrid(point.x), y: snapToGrid(point.y) }
    const prev = deduped[deduped.length - 1]
    if (!prev || prev.x !== next.x || prev.y !== next.y) {
      deduped.push(next)
    }
  })
  return deduped
}

const extractRoutePoints = (edge: any): Array<{ x: number; y: number }> => {
  const sections = Array.isArray(edge?.sections) ? edge.sections : []
  const routes = sections
    .map((section: any) => {
      const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint]
        .filter((point: any) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
        .map((point: any) => ({ x: point.x, y: point.y }))
      return dedupeRoutePoints(points)
    })
    .filter((route: Array<{ x: number; y: number }>) => route.length >= 2)

  if (routes.length === 0) return []

  return routes.reduce((acc: Array<{ x: number; y: number }>, route) => {
    if (acc.length === 0) return [...route]
    const prev = acc[acc.length - 1]
    const next = route[0]
    if (prev.x === next.x && prev.y === next.y) {
      return [...acc, ...route.slice(1)]
    }
    return [...acc, ...route]
  }, [])
}

const getNodeSize = (component: PlacedComponent): { width: number; height: number } => {
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

  if (component.catalogId === 'customchip') {
    const pinCount = Math.max(2, Number(component.props.pinCount || 8))
    const leftPins = Math.max(0, Number(component.props.leftPins ?? Math.ceil(pinCount / 2)))
    const rightPins = Math.max(0, Number(component.props.rightPins ?? Math.floor(pinCount / 2)))
    const topPins = Math.max(0, Number(component.props.topPins ?? 0))
    const bottomPins = Math.max(0, Number(component.props.bottomPins ?? 0))
    const sideRows = Math.max(leftPins, rightPins)
    const topBottomCols = Math.max(topPins, bottomPins)
    return {
      width: Math.max(100, 28 + topBottomCols * 20),
      height: Math.max(80, 24 + sideRows * 20)
    }
  }

  const schematic = getPinConfig(component.catalogId)
  return {
    width: schematic?.width || 60,
    height: schematic?.height || 40
  }
}

const getLayoutPins = (component: PlacedComponent): Array<{ name: string; side: ElkPortSide }> => {
  if (component.catalogId === 'net' || component.catalogId === 'netport') {
    return [{ name: 'port', side: component.catalogId === 'net' ? 'EAST' : 'WEST' }]
  }

  if (component.catalogId === 'public-port') {
    return [{ name: 'port', side: 'WEST' }]
  }

  if (component.catalogId === 'subcircuit-instance' || component.catalogId === 'sheet-instance' || component.catalogId === 'symbol-instance') {
    const ports = ((component.props.ports as string[] | undefined) || []).map(String)
    if (ports.length === 0) return [{ name: 'IO', side: 'WEST' }]

    return ports.map((name, index) => ({
      name,
      side: index % 2 === 0 ? 'WEST' : 'EAST'
    }))
  }

  if (component.catalogId === 'customchip') {
    return getCustomChipLayoutPins(component)
  }

  const schematic = getPinConfig(component.catalogId)
  return (schematic?.pins || []).map(pin => ({
    name: pin.name,
    side: toElkPortSide(pin.side)
  }))
}

export async function layoutCircuit(
  components: PlacedComponent[],
  edges: Array<{ from: { componentId: string; pinName: string }; to: { componentId: string; pinName: string } }>
): Promise<LayoutResult> {
  try {
    // ── Semantic pre-filter ──────────────────────────────────────────────────
    // net-markers (net, netport, netlabel, public-port) must NEVER be ELK nodes.
    // They provide electrical merging only; they have no physical routing geometry.
    const layoutComponents = filterLayoutCandidates(components)
    const byId = new Map(components.map(c => [c.id, c]))

    // Wrap raw edges as WireConnection-like objects so filterElkEdges can inspect them
    const wireEdges = edges.map((e, i) => ({
      id: `edge-${i}`,
      from: e.from,
      to: e.to,
      routePoints: undefined as undefined,
    }))
    const filteredEdges = filterElkEdges(wireEdges as any, byId)
    const filteredEdgeSet = new Set(filteredEdges.map(e => e.id))
    const layoutEdges = edges.filter((_, i) => filteredEdgeSet.has(`edge-${i}`))

    const nodes: LayoutNode[] = layoutComponents.map((component) => {
      const size = getNodeSize(component)
      const declaredPins = getLayoutPins(component)

      return {
        id: component.id,
        width: size.width,
        height: size.height,
        ports: declaredPins.map((pin, index) => ({
          id: `${component.id}.${pin.name}`,
          width: 8,
          height: 8,
          properties: {
            'port.side': pin.side,
            'port.index': String(index)
          },
          layoutOptions: {
            'elk.port.side': pin.side,
            'elk.port.index': String(index)
          }
        })),
        layoutOptions: {
          'elk.portConstraints': 'FIXED_ORDER',
          'org.eclipse.elk.portConstraints': 'FIXED_ORDER'
        }
      }
    })

    const nodePortMap = new Map<string, Set<string>>()
    nodes.forEach(node => {
      nodePortMap.set(node.id, new Set(node.ports.map(port => port.id)))
    })

    const edgesList: LayoutEdge[] = layoutEdges
      .map((edge, idx) => {
        const sourcePort = `${edge.from.componentId}.${edge.from.pinName}`
        const targetPort = `${edge.to.componentId}.${edge.to.pinName}`
        const sourceExists = nodePortMap.get(edge.from.componentId)?.has(sourcePort)
        const targetExists = nodePortMap.get(edge.to.componentId)?.has(targetPort)
        if (!sourceExists || !targetExists) return null

        return {
          id: `edge-${idx}`,
          sources: [sourcePort],
          targets: [targetPort]
        }
      })
      .filter((edge): edge is LayoutEdge => !!edge)

    const graph = {
      id: 'circuit',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.portConstraints': 'FIXED_ORDER',
        'elk.spacing.nodeNode': '50',
        'elk.layered.spacing.nodeNodeBetweenLayers': '90',
        'elk.layered.spacing.edgeNodeBetweenLayers': '30',
        'elk.layered.considerModelOrder.strategy': 'PREFER_NODES',
        'elk.edgeRouting': 'ORTHOGONAL'
      },
      children: nodes,
      edges: edgesList
    }

    const result = await elk.layout(graph as any)
    const positionMap = new Map<string, { x: number; y: number }>()
    const routeMap = new Map<string, Array<{ x: number; y: number }>>()

    if (result.children) {
      result.children.forEach((child: any) => {
        positionMap.set(child.id, {
          x: snapToGrid(child.x || 0),
          y: snapToGrid(child.y || 0)
        })
      })
    }

    if (result.edges) {
      result.edges.forEach((edge: any) => {
        const route = extractRoutePoints(edge)
        if (route.length >= 2) {
          routeMap.set(edge.id, route)
        }
      })
    }

    return {
      positions: positionMap,
      routes: routeMap
    }
  } catch (error) {
    console.error('ELK layout error:', error)
    return {
      positions: createGridLayout(components),
      routes: new Map()
    }
  }
}

export function createGridLayout(components: PlacedComponent[]): Map<string, { x: number; y: number }> {
  const positionMap = new Map<string, { x: number; y: number }>()
  const cols = Math.ceil(Math.sqrt(components.length))

  components.forEach((comp, idx) => {
    const row = Math.floor(idx / cols)
    const col = idx % cols
    positionMap.set(comp.id, {
      x: col * 120,
      y: row * 120
    })
  })

  return positionMap
}

export function shouldApplyLayout(wireCount: number, componentCount: number): boolean {
  return wireCount > 3 || componentCount > 4
}
