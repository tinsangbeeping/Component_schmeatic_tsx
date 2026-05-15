import JSZip from 'jszip'
import { FSMap } from '../types/catalog'
import {
  ComponentUsageMap,
  DependencyGraph,
  FileTreeNode,
  ImportedProjectFile,
  ImportedProjectState,
  ProjectFile,
  SubcircuitDefinition,
  SubcircuitRegistry,
  SymbolDefinition,
  WorkspaceComponentRegistry,
  WorkspaceSymbolRegistry
} from '../types/project'
import { detectFileKind, getFolderForDetectedFileKind, inferDetectedFileKind } from './fileClassification'
import { importSymbolTsxToDocument } from './symbolDocument'

export const DEFAULT_SYMBOLS_FOLDER = `
export const ResistorSymbol = () => (
  <symbol>
    <rect x="-4" y="-2" width="8" height="4" fill="none" stroke="black" strokeWidth="1" />
  </symbol>
)

export const CapacitorSymbol = () => (
  <symbol>
    <line x1="-4" y1="0" x2="0" y2="0" stroke="black" strokeWidth="1" />
    <line x1="2" y1="-3" x2="2" y2="3" stroke="black" strokeWidth="1" />
    <line x1="4" y1="0" x2="8" y2="0" stroke="black" strokeWidth="1" />
  </symbol>
)
`

export const buildProjectFileTree = (fsMap: FSMap): FileTreeNode => {
  const root: FileTreeNode = {
    id: 'root',
    name: 'Project',
    type: 'folder',
    path: '/',
    children: []
  }

  const folders = new Map<string, FileTreeNode>()
  folders.set('', root)

  const ensureFolderNode = (folderPath: string): FileTreeNode => {
    const normalized = folderPath.replace(/^\/+|\/+$/g, '')
    if (!normalized) return root

    const existing = folders.get(normalized)
    if (existing) return existing

    const parts = normalized.split('/').filter(Boolean)
    const parentPath = parts.slice(0, -1).join('/')
    const parent = ensureFolderNode(parentPath)

    const node: FileTreeNode = {
      id: `folder:${normalized}`,
      name: parts[parts.length - 1],
      type: 'folder',
      path: normalized,
      children: []
    }

    parent.children = parent.children || []
    parent.children.push(node)
    folders.set(normalized, node)
    return node
  }

  // Keep the expected workspace roots visible even when empty.
  ;['schematics', 'subcircuits', 'symbols', 'symbols/.editor', 'raw', 'editor'].forEach(ensureFolderNode)

  Object.entries(fsMap).forEach(([path, content]) => {
    const normalizedPath = path.replace(/^\/+|\/+$/g, '')
    if (!normalizedPath) return

    const isSymbolEditorDocument = /^symbols\/\.editor\/.+\.symbol\.json$/.test(normalizedPath)
    const detectedKind = inferDetectedFileKind(normalizedPath, content)
    const parts = normalizedPath.split('/')
    const fileName = parts[parts.length - 1]
    const actualParentFolderPath = parts.slice(0, -1).join('/')
    const parentFolderPath =
      isSymbolEditorDocument
        ? actualParentFolderPath || 'symbols/.editor'
        :
      detectedKind === 'raw'
        ? actualParentFolderPath || 'raw'
        : getFolderForDetectedFileKind(detectedKind)
    const parent = ensureFolderNode(parentFolderPath)

    parent.children = parent.children || []
    parent.children.push({
      id: `file:${normalizedPath}`,
      name: fileName,
      type: 'file',
      path: normalizedPath,
      content
    })
  })

  const sortTree = (node: FileTreeNode) => {
    if (!node.children?.length) return
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    node.children.forEach(sortTree)
  }

  sortTree(root)

  return root
}

export const extractExportName = (code: string): string | null => {
  const match = code.match(/export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
  return match?.[1] || null
}

export const isValidSubcircuit = (code: string): boolean => {
  if (detectFileKind(code) !== 'subcircuit') return false
  if (/export\s+default/.test(code)) return false
  if (!/export\s+function\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(code)) return false
  if (!/<subcircuit\b/.test(code)) return false
  if (/<board\b[\s>]/.test(code)) return false
  return true
}

export const isValidSymbolComponent = (code: string): boolean => {
  const trimmed = code.trim()
  if (!trimmed) return false
  return /<chip\b[\s\S]*?\bsymbol\s*=\s*\{/.test(trimmed)
}

export const extractPortsFromSymbolComponentContent = (content: string): string[] => {
  const unique = (values: string[]) => Array.from(new Set(values.map(value => value.trim()).filter(Boolean)))
  const symbolBody = content.match(/<symbol\b[^>]*>([\s\S]*?)<\/symbol>/)?.[1] || content
  const taggedPorts = [...symbolBody.matchAll(/<port\b[^>]*name=["']([^"']+)["'][^>]*\/?>(?:<\/port>)?/g)]
    .map(match => match[1])
  return unique(taggedPorts)
}

const extractSymbolComponentName = (path: string, content: string): string => {
  const fromDefaultFunction = content.match(/export\s+default\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1]
  if (fromDefaultFunction) return fromDefaultFunction

  const fromFunction = content.match(/export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1]
  if (fromFunction) return fromFunction

  const fromConst = [...content.matchAll(/export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)]
    .map(match => match[1])
    .find(name => name !== 'ports')
  if (fromConst) return fromConst

  return path.split('/').pop()?.replace('.tsx', '') || 'SymbolComponent'
}

export const extractPortsFromSubcircuitContent = (content: string): string[] => {
  const unique = (values: string[]) => Array.from(new Set(values.map(value => value.trim()).filter(Boolean)))

  const exportedPortsMatch = content.match(/export\s+const\s+ports\s*=\s*\[([\s\S]*?)\]\s*as\s+const/)
  if (exportedPortsMatch?.[1]) {
    const explicitPorts = [...exportedPortsMatch[1].matchAll(/["']([^"']+)["']/g)]
      .map(match => match[1])
    if (explicitPorts.length > 0) {
      return unique(explicitPorts)
    }
  }

  const taggedPorts = [...content.matchAll(/<port\b[^>]*name=["']([^"']+)["'][^>]*\/?>(?:<\/port>)?/g)]
    .map(match => match[1])
  if (taggedPorts.length > 0) {
    return unique(taggedPorts)
  }

  const namedNets = [...content.matchAll(/<net\b[^>]*name=["']([^"']+)["'][^>]*\/?>(?:<\/net>)?/g)]
    .map(match => match[1])
  if (namedNets.length > 0) {
    return unique(namedNets)
  }

  const tracedNets = [...content.matchAll(/\bnet\.([A-Za-z_][A-Za-z0-9_]*)\b/g)]
    .map(match => match[1])
  return unique(tracedNets)
}

export const extractImportPaths = (code: string): string[] => {
  return [...code.matchAll(/import\s+(?:type\s+)?(?:[^"']+?from\s+)?["']([^"']+)["']/g)]
    .map(match => match[1])
    .filter(Boolean)
}

export const extractExportNames = (code: string): string[] => {
  const names = new Set<string>()

  ;[...code.matchAll(/export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].forEach(match => names.add(match[1]))
  ;[...code.matchAll(/export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].forEach(match => {
    if (match[1] !== 'ports') {
      names.add(match[1])
    }
  })

  if (/export\s+default/.test(code)) {
    names.add('default')
  }

  return [...names]
}

const normalizePathSegments = (segments: string[]): string[] => {
  const normalized: string[] = []

  segments.forEach((segment) => {
    if (!segment || segment === '.') return
    if (segment === '..') {
      normalized.pop()
      return
    }
    normalized.push(segment)
  })

  return normalized
}

const findFallbackProjectPath = (targetPath: string, fsMap?: FSMap): string | null => {
  if (!fsMap) return null

  const normalizedTarget = targetPath.replace(/^\/+/, '').replace(/\.(tsx|ts)$/i, '').replace(/\/index$/i, '')
  const basename = normalizedTarget.split('/').pop()
  if (!basename) return null

  const matches = Object.keys(fsMap).filter((candidate) => {
    const normalizedCandidate = candidate.replace(/^\/+/, '').replace(/\.(tsx|ts)$/i, '').replace(/\/index$/i, '')
    return normalizedCandidate === normalizedTarget || normalizedCandidate.endsWith(`/${basename}`)
  })

  return matches.length === 1 ? matches[0] : null
}

const isWorkspaceImportPath = (importPath: string): boolean => {
  if (!importPath) return false
  if (importPath.startsWith('.') || importPath.startsWith('/')) return true

  return ['schematics/', 'subcircuits/', 'symbols/', 'raw/', 'editor/'].some(prefix => importPath.startsWith(prefix))
}

export const resolveImportPath = (fromPath: string, importPath: string, fsMap?: FSMap): string | null => {
  if (!importPath.startsWith('.')) {
    return null
  }

  const baseSegments = fromPath.split('/').slice(0, -1)
  const importSegments = importPath.split('/')
  const normalizedSegments = normalizePathSegments([...baseSegments, ...importSegments])
  const stem = normalizedSegments.join('/')
  const stemWithoutExtension = stem.replace(/\.(tsx|ts)$/i, '')
  const candidates = Array.from(new Set([
    stem,
    `${stemWithoutExtension}.tsx`,
    `${stemWithoutExtension}.ts`,
    `${stemWithoutExtension}/index.ts`,
    `${stemWithoutExtension}/index.tsx`
  ]))

  if (!fsMap) {
    return candidates[0] || null
  }

  return candidates.find(candidate => !!fsMap[candidate]) || findFallbackProjectPath(stemWithoutExtension, fsMap)
}

export const resolveProjectPath = (fromPath: string, targetPath: string, fsMap?: FSMap): string | null => {
  if (!targetPath) return null

  if (targetPath.startsWith('.')) {
    return resolveImportPath(fromPath, targetPath, fsMap)
  }

  const normalized = targetPath.replace(/^\/+/, '')
  const candidates = [
    normalized,
    normalized.endsWith('.tsx') || normalized.endsWith('.ts') ? normalized : `${normalized}.tsx`,
    `schematics/${normalized.replace(/^schematics\//, '')}`,
    `schematics/${normalized.replace(/^schematics\//, '')}.tsx`
  ]

  if (!fsMap) {
    return candidates[0] || null
  }

  return candidates.find(candidate => !!fsMap[candidate]) || findFallbackProjectPath(normalized, fsMap)
}

export const extractSheetReferences = (code: string): Array<{ name: string; src: string }> => {
  return [...code.matchAll(/<sheet\b([^>]*)\/>/g)]
    .map(match => {
      const attrs = match[1] || ''
      const src = attrs.match(/\bsrc="([^"]+)"/)?.[1] || ''
      const name = attrs.match(/\bname="([^"]+)"/)?.[1] || ''
      return { name, src }
    })
    .filter(entry => !!entry.src)
}

export const detectRootSchematic = (entryFiles: string[]): string | null => {
  const preferred = [...entryFiles].find(path => /(^|\/)main\.tsx$/i.test(path))
  if (preferred) return preferred

  const preferredDerivedMain = [...entryFiles].find(path => /(^|\/)[^/]*_main\.tsx$/i.test(path))
  if (preferredDerivedMain) return preferredDerivedMain

  const sorted = [...entryFiles].sort((a, b) => a.localeCompare(b))
  return sorted[0] || null
}

const isPlaceholderBoardContent = (content: string): boolean => {
  return /<board[^>]*>\s*\{\/\*\s*Add components here\s*\*\/\}\s*<\/board>/s.test(content)
}

const filterPlaceholderEntryFiles = (entryFiles: string[], fsMap: FSMap): string[] => {
  if (entryFiles.length <= 1) return entryFiles

  const nonPlaceholder = entryFiles.filter((filePath) => !isPlaceholderBoardContent(fsMap[filePath] || ''))
  return nonPlaceholder.length > 0 ? nonPlaceholder : entryFiles
}

export const buildSchematicHierarchy = (fsMap: FSMap): { rootFile: string | null; hierarchy: Record<string, string[]> } => {
  const entryFiles = filterPlaceholderEntryFiles(Object.entries(fsMap)
    .filter(([path, code]) => inferDetectedFileKind(path, code) === 'board')
    .map(([path]) => path)
  , fsMap)

  const hierarchy = entryFiles.reduce<Record<string, string[]>>((acc, filePath) => {
    const content = fsMap[filePath] || ''
    const children = extractSheetReferences(content)
      .map(ref => resolveProjectPath(filePath, ref.src, fsMap))
      .filter((path): path is string => !!path)

    acc[filePath] = Array.from(new Set(children))
    return acc
  }, {})

  return {
    rootFile: detectRootSchematic(entryFiles),
    hierarchy
  }
}

export const buildSubcircuitRegistry = (fsMap: FSMap): SubcircuitRegistry => {
  return extractAllSubcircuits(fsMap).reduce<SubcircuitRegistry>((registry, subcircuit) => {
    registry[subcircuit.name] = {
      filePath: subcircuit.filePath,
      ports: subcircuit.ports
    }
    return registry
  }, {})
}

export const buildSymbolComponentRegistry = (fsMap: FSMap): SubcircuitRegistry => {
  return extractAllSymbols(fsMap).reduce<SubcircuitRegistry>((registry, symbolComponent) => {
    registry[symbolComponent.name] = {
      filePath: symbolComponent.filePath,
      ports: symbolComponent.ports.map(port => port.name)
    }
    return registry
  }, {})
}

const getPathBaseName = (path: string): string => path.split('/').pop()?.replace(/\.(tsx|ts)$/i, '') || path

export const buildWorkspaceSymbolRegistry = (fsMap: FSMap): WorkspaceSymbolRegistry => {
  const out: WorkspaceSymbolRegistry = {}

  extractAllSymbols(fsMap).forEach((symbol) => {
    const symbolId = getPathBaseName(symbol.filePath)
    out[symbolId] = {
      ...symbol,
      id: symbolId
    }
  })

  return out
}

const inferFootprintFromSymbolFile = (content: string): string | undefined => {
  const footprint = content.match(/\bfootprint\s*=\s*["']([^"']+)["']/)?.[1]
  return footprint?.trim() || undefined
}

const normalizeRef = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/^symbols\/(?:\.editor|editor)\//, '')
    .replace(/^symbols\//, '')
    .replace(/\.symbol\.json$/i, '')
    .replace(/\.(tsx|ts)$/i, '')
}

const inferSymbolRefForComponent = (
  componentType: string,
  filePath: string,
  explicitSymbolRef: string | undefined,
  pins: string[],
  symbolRegistry: WorkspaceSymbolRegistry
): string | null => {
  if (explicitSymbolRef) {
    const normalized = normalizeRef(explicitSymbolRef)
    if (symbolRegistry[normalized]) return normalized
  }

  const byFileBase = getPathBaseName(filePath)
  if (symbolRegistry[byFileBase]) return byFileBase

  const byType = normalizeRef(componentType)
  if (symbolRegistry[byType]) return byType

  const pinSet = new Set(pins.map(pin => pin.trim()).filter(Boolean))
  if (pinSet.size > 0) {
    const byPinMatch = Object.entries(symbolRegistry)
      .map(([symbolId, symbol]) => ({
        symbolId,
        score: symbol.ports.reduce((acc, port) => acc + (pinSet.has(port.name) ? 1 : 0), 0)
      }))
      .sort((a, b) => b.score - a.score)[0]

    if (byPinMatch && byPinMatch.score > 0) return byPinMatch.symbolId
  }

  return null
}

export const buildWorkspaceComponentRegistry = (fsMap: FSMap): WorkspaceComponentRegistry => {
  const symbolRegistry = buildWorkspaceSymbolRegistry(fsMap)
  const out: WorkspaceComponentRegistry = {}

  Object.values(symbolRegistry).forEach((symbol) => {
    const symbolId = symbol.id
    const pins = symbol.ports.map(port => port.name)
    const source = fsMap[symbol.filePath] || ''
    const footprint = inferFootprintFromSymbolFile(source)
    const componentType = symbol.name

    out[componentType] = {
      componentType,
      symbolRef: symbolId,
      pins,
      footprint,
      role: 'custom-chip',
      sourceFilePath: symbol.filePath
    }
  })

  Object.entries(fsMap).forEach(([filePath, content]) => {
    if (!filePath.endsWith('.tsx')) return

    const exportDefaultFn = content.match(/export\s+default\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1]
    const exportFns = [...content.matchAll(/export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(match => match[1])
    const exportConsts = [...content.matchAll(/export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)]
      .map(match => match[1])
      .filter(name => name !== 'ports')
    const componentTypes = Array.from(new Set([exportDefaultFn, ...exportFns, ...exportConsts].filter(Boolean) as string[]))
    if (componentTypes.length === 0) return

    const taggedPins = extractPortsFromSymbolComponentContent(content)
    const explicitSymbolRef =
      content.match(/\bsymbolRef\s*=\s*["']([^"']+)["']/)?.[1]
      || content.match(/\bsymbolRef\s*:\s*["']([^"']+)["']/)?.[1]

    componentTypes.forEach((componentType) => {
      if (out[componentType]?.symbolRef) return
      const inferredRef = inferSymbolRefForComponent(componentType, filePath, explicitSymbolRef, taggedPins, symbolRegistry)
      if (!inferredRef) return

      const symbol = symbolRegistry[inferredRef]
      out[componentType] = {
        componentType,
        symbolRef: inferredRef,
        pins: taggedPins.length > 0 ? taggedPins : symbol.ports.map(port => port.name),
        footprint: inferFootprintFromSymbolFile(content),
        role: 'custom-chip',
        sourceFilePath: filePath
      }
    })
  })

  return out
}

export const buildDependencyGraph = (fsMap: FSMap): DependencyGraph => {
  const graph: DependencyGraph = {}

  Object.keys(fsMap).forEach((path) => {
    graph[path] = {
      path,
      imports: [],
      usedBy: []
    }
  })

  Object.entries(fsMap).forEach(([path, content]) => {
    const dependencyRefs = [
      ...extractImportPaths(content),
      ...extractSheetReferences(content).map(ref => ref.src)
    ]

    dependencyRefs.forEach((refPath) => {
      const resolved = resolveProjectPath(path, refPath, fsMap)
      if (!resolved || !graph[resolved]) return

      if (!graph[path].imports.includes(resolved)) {
        graph[path].imports.push(resolved)
      }
      if (!graph[resolved].usedBy.includes(path)) {
        graph[resolved].usedBy.push(path)
      }
    })
  })

  return graph
}

export const getBrokenImports = (fsMap: FSMap): Array<{ filePath: string; importPath: string }> => {
  const broken: Array<{ filePath: string; importPath: string }> = []

  Object.entries(fsMap).forEach(([path, content]) => {
    const dependencyRefs = [
      ...extractImportPaths(content),
      ...extractSheetReferences(content).map(ref => ref.src)
    ]

    dependencyRefs.forEach((importPath) => {
      if (!isWorkspaceImportPath(importPath)) return

      const resolved = resolveProjectPath(path, importPath, fsMap)
      if (!resolved) {
        broken.push({ filePath: path, importPath })
      }
    })
  })

  return broken
}

export const validateImports = (fsMap: FSMap): string[] => {
  const broken = getBrokenImports(fsMap)
  return broken.map(entry => `${entry.filePath} -> ${entry.importPath}`)
}

export const extractBatchFilesFromZip = async (
  input: Blob | ArrayBuffer | Uint8Array
): Promise<Array<{ fileName: string; content: string }>> => {
  const zip = await JSZip.loadAsync(input)
  const candidateEntries = Object.values(zip.files)
    .filter(entry => !entry.dir)
    .filter(entry => /\.tsx$/i.test(entry.name))

  const normalizedNames = candidateEntries
    .map(entry => entry.name.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, ''))
    .filter(Boolean)

  const rootSegments = normalizedNames
    .map(name => name.split('/')[0])
    .filter(Boolean)
  const firstRoot = rootSegments[0] || ''
  const hasSingleTopLevelRoot = !!firstRoot && rootSegments.every(segment => segment === firstRoot)

  const files: Array<{ fileName: string; content: string }> = []

  for (const entry of candidateEntries) {
    const normalizedName = entry.name.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
    const fileName = hasSingleTopLevelRoot
      ? normalizedName.replace(new RegExp(`^${firstRoot}/`), '')
      : normalizedName

    if (!fileName) continue

    const content = await entry.async('string')
    if (!content.trim()) continue

    files.push({
      fileName,
      content
    })
  }

  if (files.length === 0) {
    throw new Error('No importable .tsx files were found in the zip archive.')
  }

  return files
}

export const buildComponentUsage = (fsMap: FSMap): ComponentUsageMap => {
  const usage: ComponentUsageMap = {}
  const trackedNames = [
    ...Object.keys(buildSubcircuitRegistry(fsMap)),
    ...extractAllSymbols(fsMap).map(symbolComponent => symbolComponent.name)
  ]

  trackedNames.forEach((name) => {
    const matcher = new RegExp(`<${name}\\b`)
    Object.entries(fsMap).forEach(([path, content]) => {
      if (matcher.test(content)) {
        if (!usage[name]) usage[name] = []
        usage[name].push(path)
      }
    })
  })

  return usage
}

export const buildImportedProjectState = (fsMap: FSMap): ImportedProjectState => {
  const files = Object.entries(fsMap).reduce<Record<string, ImportedProjectFile>>((acc, [path, code]) => {
    const kind = inferDetectedFileKind(path, code)
    acc[path] = {
      path,
      code,
      kind,
      exports: extractExportNames(code),
      imports: extractImportPaths(code),
      sheets: extractSheetReferences(code).map(ref => ref.src)
    }
    return acc
  }, {})

  const registry = Object.fromEntries(
    Object.entries(buildSubcircuitRegistry(fsMap)).map(([name, info]) => [name, info.filePath])
  )
  const entryFiles = filterPlaceholderEntryFiles(Object.values(files)
    .filter(file => file.kind === 'board')
    .map(file => file.path)
  , fsMap)
  const { rootFile, hierarchy } = buildSchematicHierarchy(fsMap)

  return {
    files,
    registry,
    entryFiles,
    rootFile,
    hierarchy,
    dependencyGraph: buildDependencyGraph(fsMap),
    componentUsage: buildComponentUsage(fsMap)
  }
}

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

const shapeBounds = (shape: Record<string, any>): { minX: number; minY: number; maxX: number; maxY: number } | null => {
  if (shape.kind === 'schematicline') {
    const x1 = toFiniteNumber(shape.x1)
    const y1 = toFiniteNumber(shape.y1)
    const x2 = toFiniteNumber(shape.x2)
    const y2 = toFiniteNumber(shape.y2)
    return {
      minX: Math.min(x1, x2),
      minY: Math.min(y1, y2),
      maxX: Math.max(x1, x2),
      maxY: Math.max(y1, y2)
    }
  }

  if (shape.kind === 'schematicrect') {
    const width = Math.abs(toFiniteNumber(shape.width))
    const height = Math.abs(toFiniteNumber(shape.height))
    const cx = Number.isFinite(Number(shape.x))
      ? toFiniteNumber(shape.x) + width / 2
      : toFiniteNumber(shape.cx ?? shape.schX ?? shape.center?.x)
    const cy = Number.isFinite(Number(shape.y))
      ? toFiniteNumber(shape.y) + height / 2
      : toFiniteNumber(shape.cy ?? shape.schY ?? shape.center?.y)
    return {
      minX: cx - width / 2,
      minY: cy - height / 2,
      maxX: cx + width / 2,
      maxY: cy + height / 2
    }
  }

  if (shape.kind === 'schematiccircle' || shape.kind === 'schematicarc') {
    const centerX = toFiniteNumber(shape.cx ?? shape.center?.x ?? shape.x)
    const centerY = toFiniteNumber(shape.cy ?? shape.center?.y ?? shape.y)
    const radius = Math.abs(toFiniteNumber(shape.radius))
    return {
      minX: centerX - radius,
      minY: centerY - radius,
      maxX: centerX + radius,
      maxY: centerY + radius
    }
  }

  if (shape.kind === 'schematictext') {
    const x = toFiniteNumber(shape.x ?? shape.schX)
    const y = toFiniteNumber(shape.y ?? shape.schY)
    const textWidth = Math.max(1, String(shape.text || '').length) * 6
    return {
      minX: x,
      minY: y - 8,
      maxX: x + textWidth,
      maxY: y + 2
    }
  }

  return null
}

const isNonDegenerateShape = (shape: Record<string, any>): boolean => {
  if (shape.kind === 'schematicline') {
    const x1 = toFiniteNumber(shape.x1)
    const y1 = toFiniteNumber(shape.y1)
    const x2 = toFiniteNumber(shape.x2)
    const y2 = toFiniteNumber(shape.y2)
    return x1 !== x2 || y1 !== y2
  }

  if (shape.kind === 'schematicrect') {
    return Math.abs(toFiniteNumber(shape.width)) > 0 && Math.abs(toFiniteNumber(shape.height)) > 0
  }

  if (shape.kind === 'schematiccircle') {
    return Math.abs(toFiniteNumber(shape.radius)) > 0
  }

  if (shape.kind === 'schematicarc') {
    const radius = Math.abs(toFiniteNumber(shape.radius))
    const start = toFiniteNumber(shape.startAngle ?? shape.startAngleDegrees)
    const end = toFiniteNumber(shape.endAngle ?? shape.endAngleDegrees)
    const delta = Math.abs(((end - start) % 360 + 360) % 360)
    return radius > 0 && delta > 0
  }

  if (shape.kind === 'schematictext') {
    return String(shape.text || '').trim().length > 0
  }

  return false
}

const normalizeSymbolGeometry = (
  rawShapes: Array<Record<string, any>>,
  rawPorts: Array<{ name: string; x: number; y: number; side?: 'left' | 'right' | 'top' | 'bottom'; order?: number }>
): {
  width: number
  height: number
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  origin: { x: number; y: number }
  shapes: Array<Record<string, any>>
  ports: Array<{ name: string; x: number; y: number; side?: 'left' | 'right' | 'top' | 'bottom'; order?: number }>
} => {
  const shapes = rawShapes.filter(isNonDegenerateShape)

  // Use ONLY shape bounds for normalization origin — stray port positions must not
  // distort the coordinate system and cause visual Y/X inversion.
  const shapeBoundsArr: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = []
  shapes.forEach((shape) => {
    const bound = shapeBounds(shape)
    if (bound) shapeBoundsArr.push(bound)
  })

  const minX = shapeBoundsArr.length > 0 ? Math.min(...shapeBoundsArr.map(b => b.minX)) : 0
  const minY = shapeBoundsArr.length > 0 ? Math.min(...shapeBoundsArr.map(b => b.minY)) : 0
  const maxX = shapeBoundsArr.length > 0 ? Math.max(...shapeBoundsArr.map(b => b.maxX)) : 120
  const maxY = shapeBoundsArr.length > 0 ? Math.max(...shapeBoundsArr.map(b => b.maxY)) : 80

  const normalizedShapes = shapes.map((shape) => {
    if (shape.kind === 'schematicline') {
      return {
        ...shape,
        x1: toFiniteNumber(shape.x1),
        y1: toFiniteNumber(shape.y1),
        x2: toFiniteNumber(shape.x2),
        y2: toFiniteNumber(shape.y2)
      }
    }

    if (shape.kind === 'schematicrect') {
      const width = Math.abs(toFiniteNumber(shape.width))
      const height = Math.abs(toFiniteNumber(shape.height))
      return {
        ...shape,
        cx: Number.isFinite(Number(shape.x))
          ? toFiniteNumber(shape.x) + width / 2
          : toFiniteNumber(shape.cx ?? shape.schX ?? shape.center?.x),
        cy: Number.isFinite(Number(shape.y))
          ? toFiniteNumber(shape.y) + height / 2
          : toFiniteNumber(shape.cy ?? shape.schY ?? shape.center?.y),
        width,
        height
      }
    }

    if (shape.kind === 'schematiccircle' || shape.kind === 'schematicarc') {
      return {
        ...shape,
        cx: toFiniteNumber(shape.cx ?? shape.center?.x ?? shape.x),
        cy: toFiniteNumber(shape.cy ?? shape.center?.y ?? shape.y),
        radius: Math.abs(toFiniteNumber(shape.radius))
      }
    }

    if (shape.kind === 'schematictext') {
      return {
        ...shape,
        x: toFiniteNumber(shape.x ?? shape.schX),
        y: toFiniteNumber(shape.y ?? shape.schY),
        text: String(shape.text || '')
      }
    }

    return { ...shape }
  })

  const normalizedPorts = rawPorts
    .filter(port => String(port.name || '').trim().length > 0)
    .map((port, index) => ({
      name: String(port.name || '').trim(),
      x: toFiniteNumber(port.x),
      y: toFiniteNumber(port.y),
      ...(port.side ? { side: port.side } : {}),
      order: port.order !== undefined ? port.order : index
    }))

  return {
    width: Math.max(20, maxX - minX),
    height: Math.max(20, maxY - minY),
    bounds: {
      minX,
      minY,
      maxX,
      maxY
    },
    origin: { x: minX, y: minY },
    shapes: normalizedShapes,
    ports: normalizedPorts
  }
}

export const extractAllSymbols = (fsMap: FSMap): SymbolDefinition[] => {
  const symbolComponents: SymbolDefinition[] = []

  Object.entries(fsMap).forEach(([path, content]) => {
    if (!path.endsWith('.tsx')) return
    const detectedKind = inferDetectedFileKind(path, content)
    if (detectedKind !== 'symbol-component') return

    const name = extractSymbolComponentName(path, content)
    const parsedDoc = importSymbolTsxToDocument(content, name)
    const rawPorts = parsedDoc.ports.length > 0
      ? parsedDoc.ports.map(port => ({
          name: port.name,
          x: toFiniteNumber(port.x),
          y: toFiniteNumber(port.y),
          electricalDirection: port.electricalDirection,
          side: port.side,
          order: port.order
        }))
      : extractPortsFromSymbolComponentContent(content).map(portName => ({ name: portName, x: 0, y: 0 }))

    const normalized = normalizeSymbolGeometry(
      parsedDoc.shapes.map(shape => ({ ...shape })) as Array<Record<string, any>>,
      rawPorts
    )

    symbolComponents.push({
      id: getPathBaseName(path),
      name,
      filePath: path,
      width: normalized.width,
      height: normalized.height,
      bounds: normalized.bounds,
      scalePolicy: 'fit-local-bounds',
      ports: normalized.ports,
      geometry: {
        width: normalized.width,
        height: normalized.height,
        bounds: normalized.bounds,
        origin: normalized.origin,
        shapes: normalized.shapes
      },
      drawing: { type: 'jsx', content }
    })
  })

  return symbolComponents
}

export const extractAllSubcircuits = (fsMap: FSMap): SubcircuitDefinition[] => {
  const subcircuits: SubcircuitDefinition[] = []

  Object.entries(fsMap).forEach(([path, content]) => {
    if (!path.endsWith('.tsx')) return
    if (path === 'subcircuits/index.ts') return
    if (!isValidSubcircuit(content)) return

    const exportName = extractExportName(content)
    if (!exportName) return

    subcircuits.push({
      id: exportName,
      name: exportName,
      filePath: path,
      ports: extractPortsFromSubcircuitContent(content),
      internalComponents: []
    })
  })

  return subcircuits
}

export const ensureProjectFolderDefaults = (fsMap: FSMap): FSMap => {
  const updated = { ...fsMap }

  // Ensure main schematic
  if (!updated['schematics/main.tsx']) {
    updated['schematics/main.tsx'] = `export default () => (
  <board width="50mm" height="50mm">
    {/* Add components here */}
  </board>
)`
  }

  // Ensure symbols folder index
  if (!updated['symbols/index.ts']) {
    updated['symbols/index.ts'] = `// Symbol definitions exported here`
  }

  // Ensure subcircuits folder
  if (!updated['subcircuits/index.ts']) {
    updated['subcircuits/index.ts'] = `// Subcircuits exported here`
  }

  return updated
}

export const getFilesByFolder = (fsMap: FSMap, folder: 'symbols' | 'subcircuits' | 'schematics'): ProjectFile[] => {
  const files: ProjectFile[] = []

  Object.entries(fsMap).forEach(([path, content]) => {
    if (!path.endsWith('.tsx')) return

    const detectedKind = inferDetectedFileKind(path, content)
    const matchesFolder =
      (folder === 'schematics' && detectedKind === 'board') ||
      (folder === 'subcircuits' && detectedKind === 'subcircuit') ||
      (folder === 'symbols' && detectedKind === 'symbol-component')

    if (matchesFolder) {
      files.push({
        path,
        content,
        type: (folder === 'schematics' ? 'board' : folder === 'symbols' ? 'symbol-component' : 'subcircuit') as ProjectFile['type']
      })
    }
  })

  return files
}
