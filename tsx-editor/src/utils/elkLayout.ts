import ELK from 'elkjs'
import { PlacedComponent } from '../types/catalog'
import { getPinConfig } from '../types/schematic'
import { filterLayoutCandidates, filterElkEdges } from './semanticLayout'
import { buildCustomChipLayout } from './customChipLayout'

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
  const layout = buildCustomChipLayout(component.props, component.name)
  return layout.pins.map((pin) => ({
    name: pin.name,
    side: pin.side === 'left'
      ? 'WEST'
      : pin.side === 'right'
      ? 'EAST'
      : pin.side === 'top'
      ? 'NORTH'
      : 'SOUTH'
  }))
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
  if (component.catalogId === 'symbol-instance') {
    const rawBounds = component.props.symbolBounds as { minX?: unknown; minY?: unknown; maxX?: unknown; maxY?: unknown } | undefined
    const boundsWidth = Number(rawBounds?.maxX) - Number(rawBounds?.minX)
    const boundsHeight = Number(rawBounds?.maxY) - Number(rawBounds?.minY)
    const width = Number.isFinite(boundsWidth) && boundsWidth > 0
      ? boundsWidth
      : Number(component.props.symbolWidth || 120)
    const height = Number.isFinite(boundsHeight) && boundsHeight > 0
      ? boundsHeight
      : Number(component.props.symbolHeight || 80)
    return {
      width: Math.max(20, Number.isFinite(width) ? width : 120),
      height: Math.max(20, Number.isFinite(height) ? height : 80)
    }
  }

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
    const layout = buildCustomChipLayout(component.props, component.name)
    return {
      width: layout.width,
      height: layout.height
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
    const symbolicPorts = Array.isArray(component.props.symbolPorts)
      ? (component.props.symbolPorts as Array<{ name?: string; side?: string; order?: number }>)
      : []

    if (component.catalogId === 'symbol-instance' && symbolicPorts.length > 0) {
      return symbolicPorts
        .filter((port) => String(port.name || '').trim().length > 0)
        .sort((a, b) => {
          const sideRank = (side?: string) => {
            if (side === 'left') return 0
            if (side === 'right') return 1
            if (side === 'top') return 2
            if (side === 'bottom') return 3
            return 4
          }
          const sd = sideRank(a.side) - sideRank(b.side)
          if (sd !== 0) return sd
          const ao = Number(a.order)
          const bo = Number(b.order)
          if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo
          return String(a.name || '').localeCompare(String(b.name || ''))
        })
        .map((port) => ({ name: String(port.name), side: toElkPortSide(port.side) }))
    }

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
