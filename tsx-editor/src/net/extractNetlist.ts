import type { PlacedComponent, WireConnection } from '../types/catalog'
import { solveJunctionGraph } from './junctionGraph'

export interface NetlistEndpoint {
  componentId: string
  componentName: string
  pinName: string
}

export interface ExtractedNet {
  id: string
  name: string
  endpoints: NetlistEndpoint[]
  netComponentIds: string[]
}

export interface ExtractedNetlist {
  nets: ExtractedNet[]
  endpointToNetName: Map<string, string>
}

class UnionFind {
  private parent = new Map<string, string>()

  add(id: string) {
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

  union(a: string, b: string) {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return
    if (rootA < rootB) this.parent.set(rootB, rootA)
    else this.parent.set(rootA, rootB)
  }

  ids(): string[] {
    return [...this.parent.keys()]
  }
}

const endpointKey = (componentId: string, pinName: string) => `${componentId}::${pinName}`

const isNetLike = (component: PlacedComponent | undefined) =>
  !!component && (component.catalogId === 'net' || component.catalogId === 'netport' || component.catalogId === 'netlabel')

const explicitNetName = (component: PlacedComponent | undefined): string => {
  if (!component) return ''
  if (component.catalogId === 'netlabel') {
    return String(component.props.net || component.props.netName || '').trim().toUpperCase()
  }
  if (component.catalogId === 'net' || component.catalogId === 'netport') {
    return String(component.props.netName || component.props.name || component.name || '').trim().toUpperCase()
  }
  return ''
}

const nextUnnamedNetName = (index: number) => `N${index}`

/**
 * Converts visual wires into electrical connected components.
 * This is the foundation KiCad-style junction behavior needs:
 * endpoints connected by traces, net labels, or explicit net ports become one logical net.
 */
export function extractNetlistFromGraph(
  components: PlacedComponent[],
  wires: WireConnection[]
): ExtractedNetlist {
  const byId = new Map(components.map(component => [component.id, component]))
  const uf = new UnionFind()

  const solved = solveJunctionGraph(components, wires)
  solved.endpointKeys.forEach((key) => uf.add(key))
  solved.unions.forEach(([a, b]) => uf.union(a, b))

  // A net/netport/netlabel represents a named electrical node; all pins on the same named node are one net.
  const firstEndpointForNetName = new Map<string, string>()
  components.forEach((component) => {
    const name = explicitNetName(component)
    if (!name) return
    // netlabel, netport, and net all use the same virtual 'port' pin as their anchor endpoint.
    const key = endpointKey(component.id, 'port')
    uf.add(key)
    const existing = firstEndpointForNetName.get(name)
    if (existing) uf.union(existing, key)
    else firstEndpointForNetName.set(name, key)
  })

  const groups = new Map<string, string[]>()
  uf.ids().forEach((id) => {
    const root = uf.find(id)
    const bucket = groups.get(root) || []
    bucket.push(id)
    groups.set(root, bucket)
  })

  const endpointToNetName = new Map<string, string>()
  let unnamedIndex = 1

  const nets: ExtractedNet[] = [...groups.values()].map((keys, index) => {
    const namedCandidates = keys
      .map((key) => {
        const [componentId] = key.split('::')
        return explicitNetName(byId.get(componentId))
      })
      .filter(Boolean)
      .sort()

    const name = namedCandidates[0] || nextUnnamedNetName(unnamedIndex++)
    const endpoints: NetlistEndpoint[] = []
    const netComponentIds: string[] = []

    keys.forEach((key) => {
      endpointToNetName.set(key, name)
      const [componentId, pinName] = key.split('::')
      const component = byId.get(componentId)
      if (!component) return

      if (isNetLike(component)) {
        netComponentIds.push(componentId)
        return
      }

      endpoints.push({
        componentId,
        componentName: component.name,
        pinName
      })
    })

    return {
      id: `net-${index + 1}`,
      name,
      endpoints: endpoints.sort((a, b) => `${a.componentName}.${a.pinName}`.localeCompare(`${b.componentName}.${b.pinName}`)),
      netComponentIds: [...new Set(netComponentIds)].sort()
    }
  })

  return {
    nets: nets.sort((a, b) => a.name.localeCompare(b.name)),
    endpointToNetName
  }
}

export function endpointKeyFor(componentId: string, pinName: string): string {
  return endpointKey(componentId, pinName)
}
