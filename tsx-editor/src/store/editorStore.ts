import { create } from 'zustand'
import { parse } from '@babel/parser'
import { getCatalogItem } from '../catalog'
import { loadEditorMeta, saveEditorMeta, getNetAnchor, setNetAnchor } from './metaHelpers'
import { WorkspaceData, StoredWorkspaceState } from '../types/workspace'
import { PatchDefinition } from '../types/project'
import {
  classifyFilePath,
  detectFileKind,
  getFolderForDetectedFileKind,
  inferDetectedFileKind,
  isCanvasEditableFileType
} from '../utils/fileClassification'
import {
  buildDependencyGraph,
  buildImportedProjectState,
  buildSubcircuitRegistry,
  buildSymbolComponentRegistry,
  extractAllSymbols,
  extractPortsFromSubcircuitContent,
  resolveProjectPath,
  validateImports
} from '../utils/projectManager'
import {
  createDefaultWorkspaceFsMap,
  ensureWorkspaceFsMapDefaults,
  exportWorkspaceJson,
  importWorkspaceJson
} from './workspaceFs'

// Round 0 DEBUG — set to true in browser console: window.__NETPORT_DEBUG = true
const NETPORT_DEBUG = () => typeof window !== 'undefined' && !!(window as any).__NETPORT_DEBUG
import { ExposedPortSelection, FSMap, PlacedComponent, EditorState, SelectedPinRef, WireConnection } from '../types/catalog'
import { getPinConfig } from '../types/schematic'
import { SCHEMATIC_COORD_SCALE, pixelToSchematic, schematicToPixel } from '../utils/coordinateScale'
import { inferNetRole, NetRegistry, NetRole } from '../net/NetRegistry'
import { inferPowerDistributionStrategy } from '../net/NetRegistry'
import type { ExportGraph } from '../types/exportGraph'
import { compileExportGraphToTSXNodes } from '../utils/exportCompiler'

interface EditorStore extends EditorState {
  codeViewTab: 'source' | 'export'
  exportPreview: {
    fileName: string
    content: string
  } | null
  copiedSelection: {
    components: PlacedComponent[]
    wires: WireConnection[]
  } | null
  pasteCount: number
  undoStack: { components: PlacedComponent[]; wires: WireConnection[] }[]
  redoStack: { components: PlacedComponent[]; wires: WireConnection[] }[]
  // Actions
  setFSMap: (fsMap: FSMap) => void
  setActiveFilePath: (filePath: string) => void
  openSubcircuitEditor: (name: string) => void
  insertSubcircuitInstance: (name: string, options?: { schX?: number; schY?: number; filePath?: string }) => void
  goBackFile: () => void
  updateFile: (filePath: string, content: string) => void
  addPlacedComponent: (component: PlacedComponent) => void
  updatePlacedComponent: (id: string, updates: Partial<PlacedComponent>) => void
  rotateSelectedComponents: () => void
  removePlacedComponent: (id: string) => void
  removeSelectedComponents: () => void
  setSelectedComponents: (ids: string[]) => void
  toggleComponentSelection: (id: string) => void
  copySelectedComponents: () => void
  pasteCopiedComponents: () => void
  setViewport: (viewport: Partial<EditorState['viewport']>) => void
  startWiring: (componentId: string, pinName: string) => void
  completeWiring: (componentId: string, pinName: string) => void
  cancelWiring: () => void
  removeWire: (wireId: string) => void
  disconnectPin: (componentId: string, pinName: string) => void
  beginSubcircuitPinSelection: (componentIds: string[]) => void
  toggleSubcircuitPinSelection: (componentId: string, pinName: string) => void
  cancelSubcircuitPinSelection: () => void
  exposeSubcircuitPort: (componentId: string, pinName: string, portName: string) => void
  setCursorNearPin: (info: { componentId: string; pinName: string } | null) => void
  createSubcircuit: (name: string, componentIds: string[], exposedPorts: ExposedPortSelection[]) => void
  applyLayout: () => Promise<void>
  autoWireCommonNets: () => void
  regenerateTSX: () => void
  generateFlatCircuitTSX: () => string
  generateProjectStructure: () => { parent: string; children: Record<string, string> }
  generateParentChildrenStructure: () => { parent: string; children: Record<string, string> }
  importTSXIntoActiveFile: (content: string) => void
  importFilesBatch: (files: Array<{ fileName: string; content: string }>) => void
  applyPatch: (patch: PatchDefinition) => void
  setCodeViewTab: (tab: 'source' | 'export') => void
  setExportPreview: (preview: { fileName: string; content: string } | null) => void
  // Workspace actions
  createWorkspace: (name?: string) => void
  switchWorkspace: (id: string) => void
  deleteWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void
  importWorkspaceJSON: (json: string) => void
  exportWorkspaceJSON: () => string
  importWorkspace: (payload: string, nameOverride?: string) => void
  exportActiveWorkspace: () => string
  // File tab actions
  openFileTab: (filePath: string) => void
  closeFileTab: (filePath: string) => void
  deleteFile: (filePath: string) => void
  moveFile: (oldPath: string, newPath: string) => void
  // Undo/redo
  undo: () => void
  redo: () => void
  pushUndoSnapshot: () => void
}

const SCHEMATIC_MAIN_PATH = 'schematics/main.tsx'
const LEGACY_MAIN_PATH = 'main.tsx'
const DEFAULT_SUBCIRCUITS_INDEX = ''

const isMainSchematicPath = (filePath: string): boolean => filePath === SCHEMATIC_MAIN_PATH || filePath === LEGACY_MAIN_PATH
const isSchematicFilePath = (filePath: string): boolean => {
  return isMainSchematicPath(filePath) || filePath.startsWith('schematics/')
}

const doesPathMatchDetectedKind = (filePath: string, kind: ReturnType<typeof detectFileKind>): boolean => {
  if (kind === 'board') return isSchematicFilePath(filePath)
  if (kind === 'subcircuit') return filePath.startsWith('subcircuits/')
  if (kind === 'symbol-component') return filePath.startsWith('symbols/')
  if (kind === 'raw') return filePath.startsWith('raw/')
  return true
}

const isCanvasEditableFilePath = (filePath: string): boolean => {
  return isCanvasEditableFileType(classifyFilePath(filePath))
}

const CANVAS_GRAPH_STATE_VERSION = 1

type PersistedCanvasGraphState = {
  version: number
  filePath: string
  tsxDigest: string
  components: PlacedComponent[]
  wires: WireConnection[]
}

const getCanvasGraphStatePath = (filePath: string): string => {
  const encoded = encodeURIComponent(filePath)
  return `editor/state/${encoded}.json`
}

const computeStringDigest = (input: string): string => {
  // Lightweight deterministic hash for stale-state detection.
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return (hash >>> 0).toString(16)
}

const readPersistedCanvasGraphState = (filePath: string, fsMap: FSMap): PersistedCanvasGraphState | null => {
  const statePath = getCanvasGraphStatePath(filePath)
  const raw = fsMap[statePath]
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as PersistedCanvasGraphState
    if (parsed.version !== CANVAS_GRAPH_STATE_VERSION) return null
    if (parsed.filePath !== filePath) return null
    if (!Array.isArray(parsed.components) || !Array.isArray(parsed.wires)) return null

    const content = fsMap[filePath] || ''
    const digest = computeStringDigest(content)
    if (parsed.tsxDigest !== digest) return null

    return parsed
  } catch {
    return null
  }
}

const writePersistedCanvasGraphState = (
  fsMap: FSMap,
  filePath: string,
  components: PlacedComponent[],
  wires: WireConnection[]
): FSMap => {
  const statePath = getCanvasGraphStatePath(filePath)
  const content = fsMap[filePath] || ''
  const snapshot: PersistedCanvasGraphState = {
    version: CANVAS_GRAPH_STATE_VERSION,
    filePath,
    tsxDigest: computeStringDigest(content),
    components: components.map(component => ({
      ...component,
      props: { ...component.props }
    })),
    wires: wires.map(wire => ({
      ...wire,
      from: { ...wire.from },
      to: { ...wire.to },
      routePoints: wire.routePoints ? wire.routePoints.map(point => ({ ...point })) : undefined
    }))
  }

  return {
    ...fsMap,
    [statePath]: JSON.stringify(snapshot)
  }
}

const validateFilePlacement = (filePath: string, content: string): void => {
  const kind = inferDetectedFileKind(filePath, content)
  if (kind === 'raw') return

  if (kind === 'board' && !isSchematicFilePath(filePath)) {
    throw new Error('Board schematic files must live under schematics/.')
  }

  if (kind === 'subcircuit' && !filePath.startsWith('subcircuits/')) {
    throw new Error('Subcircuit files must live under subcircuits/.')
  }

  if (kind === 'symbol-component' && !filePath.startsWith('symbols/')) {
    throw new Error('Symbol files must live under symbols/.')
  }
}

const getCanonicalFilePathForContent = (
  requestedPath: string,
  content: string,
  fsMap: FSMap,
  options?: { preserveRequestedPath?: boolean }
): string => {
  const normalizedRequestedPath = requestedPath === LEGACY_MAIN_PATH ? SCHEMATIC_MAIN_PATH : requestedPath
  const kind = inferDetectedFileKind(normalizedRequestedPath, content)

  if (kind === 'raw') {
    const fallbackBaseName = getFileBaseName(normalizedRequestedPath)
    return normalizedRequestedPath.startsWith('raw/') ? normalizedRequestedPath : `raw/${fallbackBaseName}.tsx`
  }

  if (options?.preserveRequestedPath && doesPathMatchDetectedKind(normalizedRequestedPath, kind)) {
    return normalizedRequestedPath
  }

  if (kind === 'board' && isMainSchematicPath(normalizedRequestedPath)) {
    return SCHEMATIC_MAIN_PATH
  }

  const folder = getFolderForDetectedFileKind(kind)
  const fallbackBaseName = getFileBaseName(normalizedRequestedPath)
  const rawBaseName = extractExportedIdentifier(content)
    || (fallbackBaseName.toLowerCase() === 'main' ? 'ImportedThing' : fallbackBaseName)
    || 'ImportedThing'
  const safeBaseName = toSafeIdentifier(rawBaseName)
  const candidate = `${folder}/${safeBaseName}.tsx`

  if (candidate === normalizedRequestedPath || !fsMap[candidate]) {
    return candidate
  }

  const usedNames = Object.keys(fsMap)
    .filter(path => path.startsWith(`${folder}/`) && path.endsWith('.tsx'))
    .map(path => path.replace(`${folder}/`, '').replace('.tsx', ''))

  return `${folder}/${toUniqueName(safeBaseName, usedNames)}.tsx`
}

const reconcileFsMapStructure = (rawMap: FSMap): FSMap => {
  let nextMap: FSMap = { ...rawMap }

  Object.entries(rawMap).forEach(([filePath, content]) => {
    if (!(filePath.endsWith('.tsx') || filePath === LEGACY_MAIN_PATH)) return

    const kind = inferDetectedFileKind(filePath, content)
    if (kind === 'raw') {
      if (filePath === LEGACY_MAIN_PATH && !nextMap[SCHEMATIC_MAIN_PATH]) {
        nextMap[SCHEMATIC_MAIN_PATH] = content
        delete nextMap[LEGACY_MAIN_PATH]
      }
      return
    }

    const desiredPath = getCanonicalFilePathForContent(filePath, content, nextMap, {
      preserveRequestedPath: true
    })

    if (desiredPath !== filePath) {
      delete nextMap[filePath]
      nextMap[desiredPath] = content
    }
  })

  return nextMap
}

const getDefaultImportPosition = (index: number): { schX: number; schY: number } => ({
  schX: 80 + (index % 4) * 140,
  schY: 80 + Math.floor(index / 4) * 100
})

const indentBlock = (content: string, spaces: number): string => {
  const prefix = ' '.repeat(spaces)
  return content.split('\n').map(line => `${prefix}${line}`).join('\n')
}

const getFileBaseName = (filePath: string): string => {
  const fileName = filePath.split('/').pop() || 'ImportedThing.tsx'
  return fileName.replace(/\.tsx$/, '')
}

const extractContainerBody = (content: string, tagName: 'board' | 'subcircuit' | 'symbol'): string | null => {
  const match = content.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`))
  return match?.[1]?.trim() || null
}

const extractExportedIdentifier = (content: string): string | null => {
  const functionMatch = content.match(/export\s+(?:default\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/)
  if (functionMatch?.[1]) {
    return functionMatch[1]
  }

  const constMatches = [...content.matchAll(/export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)]
  const preferredConst = constMatches.find(match => match[1] !== 'ports')
  return preferredConst?.[1] || null
}

const extractPortsDeclaration = (content: string): string => {
  const match = content.match(/export\s+const\s+ports\s*=\s*\[[\s\S]*?\]\s*as\s+const/)
  return match?.[0] || 'export const ports = [] as const'
}

const buildBoardModule = (body: string): string => {
  const content = body.trim() ? indentBlock(body.trim(), 4) : '    {/* Add components here */}'
  return `export default () => (\n  <board width="50mm" height="50mm">\n${content}\n  </board>\n)\n`
}

const buildSubcircuitModule = (name: string, body: string, portsDeclaration?: string): string => {
  const content = body.trim() ? indentBlock(body.trim(), 6) : '      {/* Add components here */}'
  return `${portsDeclaration || 'export const ports = [] as const'}\n\nexport function ${name}(props: { name: string; schX?: number; schY?: number }) {\n  const x = props.schX ?? 0\n  const y = props.schY ?? 0\n\n  return (\n    <subcircuit name={props.name}>\n${content}\n    </subcircuit>\n  )\n}\n`
}

const buildSymbolModule = (name: string, body: string): string => {
  const content = body.trim() ? indentBlock(body.trim(), 4) : '    <line x1="-8" y1="0" x2="8" y2="0" stroke="black" />'
  return `export function ${name}(props: { name: string; schX?: number; schY?: number }) {\n  return (\n    <symbol>\n${content}\n    </symbol>\n  )\n}\n`
}

const detectStandaloneImport = (content: string): { kind: 'board' | 'subcircuit' | 'symbol-component' | 'raw'; suggestedName: string } | null => {
  const trimmed = content.trim()
  const kind = inferDetectedFileKind('ImportedThing.tsx', trimmed)

  const exportedName = toSafeIdentifier(extractExportedIdentifier(trimmed) || 'ImportedThing')
  return { kind, suggestedName: exportedName }
}

const normalizeImportedTSXContent = (content: string, activeFilePath: string): string => {
  const trimmed = content.trim()
  const targetName = toSafeIdentifier(getFileBaseName(activeFilePath))
  const detectedKind = detectFileKind(trimmed)

  if (!trimmed) {
    if (isSchematicFilePath(activeFilePath)) {
      return createDefaultWorkspaceFsMap()[SCHEMATIC_MAIN_PATH]
    }

    if (activeFilePath.startsWith('symbols/')) {
      return buildSymbolModule(targetName, '')
    }

    return buildSubcircuitModule(targetName, '')
  }

  if (detectedKind === 'board' || isSchematicFilePath(activeFilePath)) {
    if (/<board[\s>]/.test(trimmed)) {
      return trimmed
    }

    const boardBody = extractContainerBody(trimmed, 'board')
    if (boardBody) {
      return buildBoardModule(boardBody)
    }

    const subcircuitBody = extractContainerBody(trimmed, 'subcircuit')
    if (subcircuitBody) {
      return buildBoardModule(subcircuitBody)
    }

    const symbolBody = extractContainerBody(trimmed, 'symbol')
    if (symbolBody) {
      return buildBoardModule(symbolBody)
    }

    return buildBoardModule(trimmed)
  }

  if (detectedKind === 'symbol-component' || activeFilePath.startsWith('symbols/')) {
    return trimmed
  }

  if (detectedKind === 'raw' || activeFilePath.startsWith('raw/')) {
    return trimmed
  }

  const subcircuitBody = extractContainerBody(trimmed, 'subcircuit')
  if (subcircuitBody) {
    return buildSubcircuitModule(targetName, subcircuitBody, extractPortsDeclaration(trimmed))
  }

  return buildSubcircuitModule(targetName, trimmed, extractPortsDeclaration(trimmed))
}

const toSafeIdentifier = (raw: string): string => {
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, '')
  if (!cleaned) return 'MySubcircuit'
  if (/^[0-9]/.test(cleaned)) return `S${cleaned}`
  return cleaned[0].toUpperCase() + cleaned.slice(1)
}

const toUniqueName = (prefix: string, used: string[]): string => {
  let i = 1
  let candidate = `${prefix}${i}`
  while (used.includes(candidate)) {
    i += 1
    candidate = `${prefix}${i}`
  }
  return candidate
}

const makeWorkspaceId = (name: string): string => {
  const base = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'workspace'
  return `${base}-${Date.now()}`
}

const ensureFsMapDefaults = (rawMap: FSMap): FSMap => {
  const fsMap = regenerateSubcircuitIndex(reconcileFsMapStructure(ensureWorkspaceFsMapDefaults(rawMap)))
  if (!fsMap['subcircuits/index.ts']) {
    fsMap['subcircuits/index.ts'] = DEFAULT_SUBCIRCUITS_INDEX
  }
  return fsMap
}

const getWorkspaceDefaultFilePath = (fsMap: FSMap): string => {
  if (fsMap[SCHEMATIC_MAIN_PATH]) return SCHEMATIC_MAIN_PATH
  if (fsMap[LEGACY_MAIN_PATH]) return LEGACY_MAIN_PATH

  const firstSchematicPath = Object.keys(fsMap).sort().find(path => isSchematicFilePath(path))
  if (firstSchematicPath) return firstSchematicPath

  const firstPath = Object.keys(fsMap).sort()[0]
  return firstPath || SCHEMATIC_MAIN_PATH
}

const normalizeWorkspaceFileSelection = (
  fsMap: FSMap,
  activeFilePath?: string,
  openFilePaths?: string[]
): { activeFilePath: string; openFilePaths: string[] } => {
  const resolvedMap = ensureFsMapDefaults(fsMap)
  const fallbackPath = getWorkspaceDefaultFilePath(resolvedMap)
  const normalizePath = (path: string): string => {
    if (path === LEGACY_MAIN_PATH && resolvedMap[SCHEMATIC_MAIN_PATH]) {
      return SCHEMATIC_MAIN_PATH
    }

    if (!resolvedMap[path]) {
      const fileName = path.split('/').pop()
      const relocatedPath = Object.keys(resolvedMap).find(candidate => candidate.endsWith(`/${fileName}`))
      if (relocatedPath) return relocatedPath
    }

    return path
  }

  const dedupedOpen = Array.from(new Set((openFilePaths || []).map(normalizePath)))
    .filter(path => !!resolvedMap[path])

  let resolvedActive = normalizePath(activeFilePath || fallbackPath)
  if (!resolvedMap[resolvedActive]) {
    resolvedActive = fallbackPath
  }

  const resolvedOpen = dedupedOpen.length > 0 ? dedupedOpen : [resolvedActive]
  if (!resolvedOpen.includes(resolvedActive)) {
    resolvedOpen.push(resolvedActive)
  }

  return {
    activeFilePath: resolvedActive,
    openFilePaths: resolvedOpen
  }
}

const normalizeWorkspaceData = (workspace: WorkspaceData): WorkspaceData => {
  const fsMap = ensureFsMapDefaults(workspace.fsMap || {})
  const files = normalizeWorkspaceFileSelection(fsMap, workspace.activeFilePath, workspace.openFilePaths)
  return {
    ...workspace,
    fsMap,
    activeFilePath: files.activeFilePath,
    openFilePaths: files.openFilePaths
  }
}

const WORKSPACE_STORAGE_KEY = 'editor_workspaces'

const createDefaultWorkspace = (fsMap?: FSMap): WorkspaceData => {
  const map = fsMap || ensureFsMapDefaults(createDefaultWorkspaceFsMap('My Project'))
  return normalizeWorkspaceData({
    id: 'project-current',
    name: 'My Project',
    fsMap: map,
    openFilePaths: [SCHEMATIC_MAIN_PATH],
    activeFilePath: SCHEMATIC_MAIN_PATH
  })
}

const saveWorkspacesToStorage = (workspaces: Record<string, WorkspaceData>, activeWorkspaceId: string) => {
  if (typeof localStorage === 'undefined') return
  try {
    const stored: StoredWorkspaceState = { workspaces, activeWorkspaceId }
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(stored))
  } catch (e) {
    console.warn('Failed to save workspaces to localStorage:', e)
  }
}

// Keep the old key name for backwards compat in regenerateTSX callers that still call this
const saveFSMapToStorage = (fsMap: FSMap) => {
  // no-op: actual persistence goes through saveWorkspacesToStorage
  // kept to avoid breaking internal callers before they are migrated
}

const loadWorkspacesFromStorage = (): StoredWorkspaceState => {
  if (typeof localStorage === 'undefined') {
    const ws = createDefaultWorkspace()
    return { workspaces: { [ws.id]: ws }, activeWorkspaceId: ws.id }
  }

  try {
    const newStored = localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (newStored) {
      const parsed: StoredWorkspaceState = JSON.parse(newStored)
      // Ensure each workspace has required defaults and valid file selections.
      for (const id of Object.keys(parsed.workspaces)) {
        parsed.workspaces[id] = normalizeWorkspaceData(parsed.workspaces[id])
      }
      return parsed
    }
  } catch (e) {
    console.warn('Failed to load workspaces from localStorage:', e)
  }

  // Try migrating from legacy 'editor_fsMap' key
  try {
    const legacyStored = localStorage.getItem('editor_fsMap')
    if (legacyStored) {
      const legacyFsMap = ensureFsMapDefaults(JSON.parse(legacyStored))
      const ws = createDefaultWorkspace(legacyFsMap)
      return { workspaces: { [ws.id]: ws }, activeWorkspaceId: ws.id }
    }
  } catch (e) {
    console.warn('Failed to migrate legacy fsMap:', e)
  }

  const ws = createDefaultWorkspace()
  return { workspaces: { [ws.id]: ws }, activeWorkspaceId: ws.id }
}

const loadFSMapFromStorage = (): FSMap => {
  const { workspaces, activeWorkspaceId } = loadWorkspacesFromStorage()
  return workspaces[activeWorkspaceId]?.fsMap || ensureFsMapDefaults(createDefaultWorkspaceFsMap('My Project'))
}

const extractExplicitSubcircuitPorts = (content: string): string[] | null => {
  const ports = extractPortsFromSubcircuitContent(content)
  return ports.length > 0 ? ports : null
}

const getSubcircuitPorts = (fsMap: FSMap, name: string): string[] => {
  const subcircuitRegistry = buildSubcircuitRegistry(fsMap)
  const symbolComponentRegistry = buildSymbolComponentRegistry(fsMap)
  const filePath = subcircuitRegistry[name]?.filePath || symbolComponentRegistry[name]?.filePath || `subcircuits/${name}.tsx`
  const content = fsMap[filePath] || ''

  return extractExplicitSubcircuitPorts(content) || symbolComponentRegistry[name]?.ports || []
}

const getSheetPorts = (fsMap: FSMap, sheetPath: string): string[] => {
  const content = fsMap[sheetPath] || ''
  if (!content) return []

  const explicit = [...content.matchAll(/<port\b[^>]*name="([^"]+)"[^>]*\/>/g)]
    .map(match => match[1].trim())
    .filter(Boolean)

  if (explicit.length > 0) {
    return Array.from(new Set(explicit))
  }

  const fromExport = content.match(/export const ports\s*=\s*\[(.*?)\]\s*as const/s)
  if (fromExport?.[1]) {
    return fromExport[1]
      .split(',')
      .map(value => value.trim().replace(/['"]/g, ''))
      .filter(Boolean)
  }

  const nets = [...content.matchAll(/<net\b[^>]*name="([^"]+)"[^>]*\/>/g)]
    .map(match => match[1].trim())
    .filter(Boolean)

  return Array.from(new Set(nets))
}

const regenerateSubcircuitIndex = (fsMap: FSMap): FSMap => {
  const registry = buildSubcircuitRegistry(fsMap)
  const indexContent = Object.entries(registry)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, info]) => {
      const stem = info.filePath.replace(/^subcircuits\//, '').replace(/\.tsx$/, '')
      return `export { ${name} } from "./${stem}"`
    })
    .join('\n')

  return {
    ...fsMap,
    'subcircuits/index.ts': indexContent ? `${indexContent}\n` : ''
  }
}

const getWorkspaceSymbolNames = (fsMap: FSMap): Set<string> => {
  return new Set(
    Object.keys(fsMap)
      .filter(path => path.startsWith('symbols/') && path.endsWith('.tsx'))
      .map(path => path.replace('symbols/', '').replace('.tsx', ''))
  )
}

const getRelativeImportPath = (fromFilePath: string, toFilePath: string): string => {
  const fromParts = fromFilePath.split('/').slice(0, -1)
  const toParts = toFilePath.replace(/\.(tsx|ts)$/, '').split('/')

  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift()
    toParts.shift()
  }

  const up = fromParts.map(() => '..')
  const relative = [...up, ...toParts].join('/')
  return relative.startsWith('.') ? relative : `./${relative}`
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

const getImportResolutionCandidates = (fromFilePath: string, importPath: string): string[] => {
  if (!importPath.startsWith('.')) return []

  const baseSegments = fromFilePath.split('/').slice(0, -1)
  const importSegments = importPath.split('/')
  const normalizedSegments = normalizePathSegments([...baseSegments, ...importSegments])
  const stem = normalizedSegments.join('/')
  const stemWithoutExtension = stem.replace(/\.(tsx|ts)$/i, '')

  return Array.from(new Set([
    stem,
    stemWithoutExtension,
    `${stemWithoutExtension}.tsx`,
    `${stemWithoutExtension}.ts`,
    `${stemWithoutExtension}/index.tsx`,
    `${stemWithoutExtension}/index.ts`
  ]))
}

const rewriteImportedWorkspacePaths = (
  content: string,
  fromOriginalPath: string,
  fromTargetPath: string,
  relocationMap: Map<string, string>
): string => {
  const rewritePath = (rawPath: string): string => {
    if (!rawPath.startsWith('.')) return rawPath

    const relocatedTarget = getImportResolutionCandidates(fromOriginalPath, rawPath)
      .map(candidate => relocationMap.get(candidate))
      .find(Boolean)

    if (!relocatedTarget) return rawPath
    return getRelativeImportPath(fromTargetPath, relocatedTarget)
  }

  const rewrittenImports = content.replace(
    /(import\s+(?:type\s+)?(?:[^"']+?from\s+)?["'])([^"']+)(["'])/g,
    (_, prefix: string, rawPath: string, suffix: string) => `${prefix}${rewritePath(rawPath)}${suffix}`
  )

  return rewrittenImports.replace(
    /(<sheet\b[^>]*\bsrc=["'])([^"']+)(["'])/g,
    (_, prefix: string, rawPath: string, suffix: string) => `${prefix}${rewritePath(rawPath)}${suffix}`
  )
}

const removeUnsafeImportedNetShorts = (content: string): string => {
  return content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed !== '<trace from="net.DVDD" to="net.SWDIO" />'
        && trimmed !== '<trace from="net.DVDD" to="net.SWCLK" />'
    })
    .join('\n')
}

const parseComponentRef = (ref: string): { componentName: string; pinName: string } | null => {
  const arrowForm = ref.match(/^\.([A-Za-z_][A-Za-z0-9_]*)\s*>\s*\.([A-Za-z_][A-Za-z0-9_]*)$/)
  if (arrowForm) {
    return { componentName: arrowForm[1], pinName: arrowForm[2] }
  }

  const dotForm = ref.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/)
  if (!dotForm) return null
  if (dotForm[1].toLowerCase() === 'net') return null

  return { componentName: dotForm[1], pinName: dotForm[2] }
}

const parseTraceRoutePoints = (raw: string | undefined): Array<{ x: number; y: number }> | undefined => {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  // Prefer compact schema: "x1,y1;x2,y2;..." but keep JSON fallback for compatibility.
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (!Array.isArray(parsed)) return undefined
      const points = parsed
        .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      return points.length >= 2 ? points : undefined
    } catch {
      return undefined
    }
  }

  const points = trimmed
    .split(';')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [xRaw, yRaw] = chunk.split(',')
      return { x: Number(xRaw), y: Number(yRaw) }
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))

  return points.length >= 2 ? points : undefined
}

const serializeTraceRoutePoints = (routePoints: WireConnection['routePoints']): string | null => {
  if (!Array.isArray(routePoints) || routePoints.length < 2) return null
  const normalized = routePoints
    .map(point => ({ x: Number(point.x), y: Number(point.y) }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (normalized.length < 2) return null
  return normalized.map(point => `${point.x},${point.y}`).join(';')
}

const normalizePatchComponentSpec = (
  component: PatchDefinition['components'][number],
  index: number
): { subcircuit: string; instanceName?: string; props?: Record<string, any>; schX?: number; schY?: number } => {
  if (typeof component === 'string') {
    return {
      subcircuit: component,
      instanceName: `${component}${index + 1}`
    }
  }

  return {
    subcircuit: component.type || component.subcircuit || '',
    instanceName: component.instanceName,
    props: component.props,
    schX: component.schX,
    schY: component.schY
  }
}

const parsePatchWireSpec = (
  spec: PatchDefinition['wiring'][number]
): { from: string; to: string } | null => {
  if (typeof spec !== 'string') {
    return spec
  }

  const fromMatch = spec.match(/from="([^"]+)"/)
  const toMatch = spec.match(/to="([^"]+)"/)
  if (fromMatch && toMatch) {
    return { from: fromMatch[1], to: toMatch[1] }
  }

  const arrowMatch = spec.split(/\s*->\s*/)
  if (arrowMatch.length === 2) {
    const normalizeEndpoint = (value: string) => {
      const trimmed = value.trim()
      const dotForm = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/)
      return dotForm ? `.${dotForm[1]} > .${dotForm[2]}` : trimmed
    }

    return {
      from: normalizeEndpoint(arrowMatch[0]),
      to: normalizeEndpoint(arrowMatch[1])
    }
  }

  return null
}

class NetUnionFind {
  private parent = new Map<string, string>()

  add(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id)
    }
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
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    if (ra < rb) {
      this.parent.set(rb, ra)
      return
    }
    this.parent.set(ra, rb)
  }
}

const isNetLikeComponent = (component: PlacedComponent | undefined): boolean => {
  if (!component) return false
  return component.catalogId === 'net' || component.catalogId === 'netport'
}

const isPublicPortComponent = (component: PlacedComponent | undefined): boolean => {
  return !!component && component.catalogId === 'public-port'
}

const getComponentNetName = (component: PlacedComponent): string => {
  return String(component.props.netName || component.props.name || component.name || '').trim().toUpperCase()
}

const getRoleRank = (role: NetRole): number => {
  if (role === 'ground' || role === 'power') return 3
  if (role === 'analog') return 2
  if (role === 'signal') return 1
  return 0
}

const mergeNetRoles = (a: NetRole, b: NetRole): NetRole => {
  if (a === 'unknown') return b
  if (b === 'unknown') return a
  return getRoleRank(b) >= getRoleRank(a) ? b : a
}

const roleFromNetComponent = (component: PlacedComponent): NetRole => {
  const explicit = component.props.netRole as NetRole | undefined
  if (explicit && explicit !== 'unknown') return explicit

  if (component.catalogId === 'net') {
    if (component.props.isGround) return 'ground'
    if (component.props.isForPower) return 'power'
  }

  return inferNetRole(getComponentNetName(component))
}

const hasPowerSignalConflict = (a: NetRole, b: NetRole): boolean => {
  return (a === 'power' && b === 'signal') || (a === 'signal' && b === 'power')
}

const getOrphanedNetportsAfterRemovingWires = (
  components: PlacedComponent[],
  currentWires: WireConnection[],
  removedWireIds: Set<string>
): string[] => {
  const remainingWires = currentWires.filter(wire => !removedWireIds.has(wire.id))
  const connectedComponentIds = new Set<string>()

  remainingWires.forEach((wire) => {
    connectedComponentIds.add(wire.from.componentId)
    connectedComponentIds.add(wire.to.componentId)
  })

  return components
    .filter(component => component.catalogId === 'netport' && !connectedComponentIds.has(component.id))
    .map(component => String(component.props.netName || component.name || '').trim())
    .filter(Boolean)
}

const clearWireRoutes = (wires: WireConnection[], componentIds?: Set<string>): WireConnection[] => {
  return wires.map((wire) => {
    if (!wire.routePoints || wire.routePoints.length === 0) return wire
    if (
      componentIds
      && !componentIds.has(wire.from.componentId)
      && !componentIds.has(wire.to.componentId)
    ) {
      return wire
    }

    const { routePoints, ...rest } = wire
    return rest
  })
}

const mergeElectricalNets = (
  components: PlacedComponent[],
  wires: WireConnection[]
): { components: PlacedComponent[]; wires: WireConnection[] } => {
  const byId = new Map(components.map(component => [component.id, component]))
  const netLikeIds = components
    .filter(component => isNetLikeComponent(component))
    .map(component => component.id)

  if (netLikeIds.length === 0) {
    return { components, wires }
  }

  const uf = new NetUnionFind()
  netLikeIds.forEach(id => uf.add(id))

  wires.forEach((wire) => {
    const fromComp = byId.get(wire.from.componentId)
    const toComp = byId.get(wire.to.componentId)
    if (!isNetLikeComponent(fromComp) || !isNetLikeComponent(toComp)) return
    uf.union(wire.from.componentId, wire.to.componentId)
  })

  const groups = new Map<string, PlacedComponent[]>()
  netLikeIds.forEach((id) => {
    const component = byId.get(id)
    if (!component) return
    const root = uf.find(id)
    const bucket = groups.get(root) || []
    bucket.push(component)
    groups.set(root, bucket)
  })

  const aliasToCanonicalName = new Map<string, string>()
  const componentToRepresentative = new Map<string, string>()
  const representativeToCanonicalName = new Map<string, string>()
  const representativeToRole = new Map<string, NetRole>()

  groups.forEach((members) => {
    const names = members
      .map(getComponentNetName)
      .filter(Boolean)
      .sort()

    const canonicalName = names[0] || 'NET'
    const canonicalRole = members.reduce<NetRole>((acc, member) => mergeNetRoles(acc, roleFromNetComponent(member)), 'unknown')

    members.forEach((member) => {
      const alias = getComponentNetName(member)
      if (alias) aliasToCanonicalName.set(alias, canonicalName)
    })

    const representative = [...members].sort((a, b) => {
      const aNetPriority = a.catalogId === 'net' ? 0 : 1
      const bNetPriority = b.catalogId === 'net' ? 0 : 1
      if (aNetPriority !== bNetPriority) return aNetPriority - bNetPriority

      const aNamePriority = getComponentNetName(a) === canonicalName ? 0 : 1
      const bNamePriority = getComponentNetName(b) === canonicalName ? 0 : 1
      if (aNamePriority !== bNamePriority) return aNamePriority - bNamePriority

      return a.id.localeCompare(b.id)
    })[0]

    members.forEach((member) => {
      componentToRepresentative.set(member.id, representative.id)
    })
    representativeToCanonicalName.set(representative.id, canonicalName)
    representativeToRole.set(representative.id, canonicalRole)
  })

  const canonicalRegistry = new NetRegistry()
  representativeToCanonicalName.forEach((name, representativeId) => {
    canonicalRegistry.registerNet(name, {
      role: representativeToRole.get(representativeId) || inferNetRole(name),
      source: 'merge'
    })
  })

  const mergedComponents = components.map((component) => {
    if (isNetLikeComponent(component)) {
      const repId = componentToRepresentative.get(component.id) || component.id
      const canonicalName = representativeToCanonicalName.get(repId) || getComponentNetName(component)
      const netId = canonicalRegistry.getNetId(canonicalName)
      const netRole = canonicalRegistry.getNetRole(netId) || inferNetRole(canonicalName)

      if (component.catalogId === 'net') {
        return {
          ...component,
          name: canonicalName,
          props: {
            ...component.props,
            netId,
            netRole,
            name: canonicalName
          }
        }
      }

      return {
        ...component,
        name: canonicalName,
        props: {
          ...component.props,
          netId,
          netRole,
          netName: canonicalName
        }
      }
    }

    if (component.catalogId === 'netlabel') {
      const rawNet = String(component.props.net || component.props.netName || '').trim().toUpperCase()
      if (!rawNet) return component
      const canonicalName = aliasToCanonicalName.get(rawNet) || rawNet
      const netId = canonicalRegistry.getNetId(canonicalName)

      return {
        ...component,
        props: {
          ...component.props,
          net: canonicalName,
          netId,
          netRole: canonicalRegistry.getNetRole(netId) || inferNetRole(canonicalName)
        }
      }
    }

    return component
  })

  const mergedWires = wires.map((wire) => {
    const remapEndpoint = (endpoint: { componentId: string; pinName: string }) => {
      const comp = byId.get(endpoint.componentId)
      if (!isNetLikeComponent(comp)) return endpoint
      const repId = componentToRepresentative.get(endpoint.componentId) || endpoint.componentId
      return { componentId: repId, pinName: 'port' }
    }

    return {
      ...wire,
      from: remapEndpoint(wire.from),
      to: remapEndpoint(wire.to)
    }
  })

  return {
    components: mergedComponents,
    wires: mergedWires
  }
}

const parseSchExpr = (expr: string, isSubcircuitFile: boolean): number => {
  const compact = expr.replace(/\s+/g, '')
  if (isSubcircuitFile) {
    const withOffset = compact.match(/^[xy]\+(-?\d+(?:\.\d+)?)$/)
    if (withOffset) return schematicToPixel(Number(withOffset[1]))
  }

  const num = Number(compact)
  return Number.isFinite(num) ? schematicToPixel(num) : 0
}

const parseEditorCoordExpr = (expr: string): number => {
  const num = Number(expr.replace(/\s+/g, ''))
  return Number.isFinite(num) ? num : 0
}

const parseStaticExpression = (expr: string): any => {
  try {
    const ast = parse(`(${expr})`, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript']
    })
    const expressionStatement = ast.program.body[0]
    if (!expressionStatement || expressionStatement.type !== 'ExpressionStatement') {
      return expr.trim()
    }

    const evaluate = (node: any): any => {
      if (!node) return undefined

      if (node.type === 'ParenthesizedExpression') return evaluate(node.expression)
      if (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion' || node.type === 'TSNonNullExpression') {
        return evaluate(node.expression)
      }
      if (node.type === 'StringLiteral') return node.value
      if (node.type === 'NumericLiteral') return node.value
      if (node.type === 'BooleanLiteral') return node.value
      if (node.type === 'NullLiteral') return null
      if (node.type === 'Identifier') {
        if (node.name === 'undefined') return undefined
        return node.name
      }
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis.map((q: any) => q.value.cooked || '').join('')
      }
      if (node.type === 'UnaryExpression') {
        const arg = evaluate(node.argument)
        if (node.operator === '+') return Number(arg)
        if (node.operator === '-') return -Number(arg)
        if (node.operator === '!') return !arg
      }
      if (node.type === 'ArrayExpression') {
        return node.elements.map((el: any) => evaluate(el))
      }
      if (node.type === 'ObjectExpression') {
        const out: Record<string, any> = {}
        node.properties.forEach((prop: any) => {
          if (prop.type !== 'ObjectProperty') return
          const keyNode = prop.key
          const key = keyNode.type === 'Identifier'
            ? keyNode.name
            : keyNode.type === 'StringLiteral' || keyNode.type === 'NumericLiteral'
            ? String(keyNode.value)
            : ''
          if (!key) return
          out[key] = evaluate(prop.value)
        })
        return out
      }

      return expr.trim()
    }

    return evaluate(expressionStatement.expression)
  } catch {
    return expr.trim()
  }
}

const parseJsxAttributes = (propsStr: string): Array<{ key: string; kind: 'string' | 'expr' | 'boolean'; rawValue: string; parsedValue: any }> => {
  const attrs: Array<{ key: string; kind: 'string' | 'expr' | 'boolean'; rawValue: string; parsedValue: any }> = []
  let i = 0

  const skipWhitespace = () => {
    while (i < propsStr.length && /\s/.test(propsStr[i])) i += 1
  }

  const readIdentifier = (): string => {
    const start = i
    while (i < propsStr.length && /[A-Za-z0-9_]/.test(propsStr[i])) i += 1
    return propsStr.slice(start, i)
  }

  while (i < propsStr.length) {
    skipWhitespace()
    if (i >= propsStr.length) break

    if (!/[A-Za-z_]/.test(propsStr[i])) {
      i += 1
      continue
    }

    const key = readIdentifier()
    if (!key) continue

    skipWhitespace()
    if (propsStr[i] !== '=') {
      attrs.push({ key, kind: 'boolean', rawValue: 'true', parsedValue: true })
      continue
    }

    i += 1
    skipWhitespace()

    if (i >= propsStr.length) {
      attrs.push({ key, kind: 'boolean', rawValue: 'true', parsedValue: true })
      break
    }

    const ch = propsStr[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      const start = i
      while (i < propsStr.length && propsStr[i] !== quote) {
        if (propsStr[i] === '\\') i += 1
        i += 1
      }
      const raw = propsStr.slice(start, i)
      if (i < propsStr.length && propsStr[i] === quote) i += 1
      attrs.push({ key, kind: 'string', rawValue: raw, parsedValue: raw })
      continue
    }

    if (ch === '{') {
      const start = i
      let depth = 0
      let quote: '"' | "'" | '`' | null = null
      i += 1
      depth = 1
      while (i < propsStr.length && depth > 0) {
        const current = propsStr[i]
        if (quote) {
          if (current === '\\') {
            i += 2
            continue
          }
          if (current === quote) quote = null
          i += 1
          continue
        }

        if (current === '"' || current === "'" || current === '`') {
          quote = current as '"' | "'" | '`'
          i += 1
          continue
        }

        if (current === '{') depth += 1
        if (current === '}') depth -= 1
        i += 1
      }

      const end = i
      const raw = propsStr.slice(start + 1, Math.max(start + 1, end - 1))
      attrs.push({ key, kind: 'expr', rawValue: raw, parsedValue: parseStaticExpression(raw) })
      continue
    }

    const start = i
    while (i < propsStr.length && !/\s/.test(propsStr[i])) i += 1
    const raw = propsStr.slice(start, i)
    attrs.push({ key, kind: 'string', rawValue: raw, parsedValue: raw })
  }

  return attrs
}

const normalizeConnectionPinName = (componentProps: Record<string, any>, pinName: string): string => {
  const raw = String(pinName || '').trim()
  if (!raw) return raw

  if (/^pin\d+$/i.test(raw)) return raw
  if (/^\d+$/.test(raw)) return `pin${raw}`

  const pinLabels = componentProps.pinLabels
  if (pinLabels && typeof pinLabels === 'object' && !Array.isArray(pinLabels)) {
    const entries = Object.entries(pinLabels as Record<string, unknown>)
    const byKey = entries.find(([key]) => String(key).trim().toLowerCase() === raw.toLowerCase())
    if (byKey) {
      const slot = String(byKey[0]).trim()
      return /^\d+$/.test(slot) ? `pin${slot}` : slot
    }

    const byLabel = entries.find(([, value]) => String(value || '').trim().toLowerCase() === raw.toLowerCase())
    if (byLabel) {
      const slot = String(byLabel[0]).trim()
      return /^\d+$/.test(slot) ? `pin${slot}` : slot
    }
  }

  return raw
}

const normalizeChipPinSlotName = (value: unknown): string => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^pin\d+$/i.test(raw)) return `pin${Number(raw.slice(3))}`
  if (/^\d+$/.test(raw)) return `pin${Number(raw)}`
  return raw
}

const deriveCustomChipPropsFromDeclaration = (props: Record<string, any>): Partial<Record<string, any>> => {
  const pinLabels = props.pinLabels
  const schPinArrangement = props.schPinArrangement

  const hasPinLabels = !!pinLabels && typeof pinLabels === 'object' && !Array.isArray(pinLabels)
  const hasPinArrangement = !!schPinArrangement && typeof schPinArrangement === 'object' && !Array.isArray(schPinArrangement)
  if (!hasPinLabels && !hasPinArrangement) return {}

  const normalizedLabels = new Map<string, string>()
  if (hasPinLabels) {
    Object.entries(pinLabels as Record<string, unknown>).forEach(([rawKey, rawLabel]) => {
      const pinKey = normalizeChipPinSlotName(rawKey)
      if (!pinKey) return
      const pinLabel = String(rawLabel || '').trim()
      normalizedLabels.set(pinKey, pinLabel || pinKey)
    })
  }

  const arrangement = hasPinArrangement ? (schPinArrangement as Record<string, unknown>) : {}
  const getSidePins = (sideKey: string): string[] => {
    const side = arrangement[sideKey]
    if (!side || typeof side !== 'object' || Array.isArray(side)) return []
    const pins = (side as Record<string, unknown>).pins
    if (!Array.isArray(pins)) return []
    return pins
      .map(pin => normalizeChipPinSlotName(pin))
      .filter(Boolean)
  }

  const leftPins = getSidePins('leftSide')
  const rightPins = getSidePins('rightSide')
  const topPins = getSidePins('topSide')
  const bottomPins = getSidePins('bottomSide')

  const arrangedPinCount = leftPins.length + rightPins.length + topPins.length + bottomPins.length
  const labelPins = Array.from(normalizedLabels.keys())
  const labelPinCount = labelPins.length
  const fallbackLegacyPinCount = Math.max(0, Number(props.pinCount || 0))
  const effectivePinCount = Math.max(arrangedPinCount, labelPinCount, fallbackLegacyPinCount)

  if (effectivePinCount <= 0) return {}

  const hasExplicitArrangement = arrangedPinCount > 0
  const effectiveLeft = hasExplicitArrangement ? leftPins.length : Math.ceil(effectivePinCount / 2)
  const effectiveRight = hasExplicitArrangement ? rightPins.length : Math.floor(effectivePinCount / 2)
  const effectiveTop = hasExplicitArrangement ? topPins.length : 0
  const effectiveBottom = hasExplicitArrangement ? bottomPins.length : 0

  const slotMappings: string[] = []
  const addSideMappings = (pins: string[], sidePrefix: 'L' | 'R' | 'U' | 'D') => {
    pins.forEach((pinName, index) => {
      const slot = `${sidePrefix}${index + 1}`
      slotMappings.push(`${slot}=${pinName}`)
    })
  }

  if (hasExplicitArrangement) {
    addSideMappings(leftPins, 'L')
    addSideMappings(rightPins, 'R')
    addSideMappings(topPins, 'U')
    addSideMappings(bottomPins, 'D')
  }

  return {
    pinCount: Math.max(2, effectivePinCount),
    leftPins: effectiveLeft,
    rightPins: effectiveRight,
    topPins: effectiveTop,
    bottomPins: effectiveBottom,
    ...(slotMappings.length > 0 ? { pinNames: slotMappings.join(',') } : {})
  }
}

const getUniqueImportedComponentName = (requestedName: string, usedNames: Set<string>): string => {
  const base = requestedName.trim()
  if (!base) return requestedName

  if (!usedNames.has(base)) {
    usedNames.add(base)
    return base
  }

  const match = base.match(/^(.*?)(\d+)$/)
  const prefix = match?.[1] && match[1].length > 0 ? match[1] : base
  let index = match ? Number(match[2]) + 1 : 2
  let candidate = `${prefix}${index}`

  while (usedNames.has(candidate)) {
    index += 1
    candidate = `${prefix}${index}`
  }

  usedNames.add(candidate)
  return candidate
}

const getBoardEntrypointPath = (fsMap: FSMap, preferredPath?: string): string => {
  const boardPaths = Object.keys(fsMap).filter(path => isSchematicFilePath(path))

  if (preferredPath && boardPaths.includes(preferredPath)) return preferredPath
  if (boardPaths.includes(SCHEMATIC_MAIN_PATH)) return SCHEMATIC_MAIN_PATH
  if (boardPaths.includes(LEGACY_MAIN_PATH)) return LEGACY_MAIN_PATH
  return boardPaths.sort()[0] || SCHEMATIC_MAIN_PATH
}

const normalizeImportedProjectPath = (fileName: string, content: string): string => {
  const normalized = fileName
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')

  if (normalized === LEGACY_MAIN_PATH) {
    return SCHEMATIC_MAIN_PATH
  }

  if (!normalized.includes('/')) {
    const kind = inferDetectedFileKind(normalized, content)
    if (kind === 'board') return `schematics/${normalized}`
    if (kind === 'subcircuit') return `subcircuits/${normalized}`
    if (kind === 'symbol-component') return `symbols/${normalized}`
    if (kind === 'raw') return `raw/${normalized}`
  }

  return normalized
}

const parseFileToCanvas = (filePath: string, fsMap: FSMap): { components: PlacedComponent[]; wires: WireConnection[] } => {
  const content = fsMap[filePath] || ''
  const isSchematicFile = isSchematicFilePath(filePath)
  const isSubcircuitFile = filePath.startsWith('subcircuits/')
  const symbolNames = getWorkspaceSymbolNames(fsMap)
  const symbolDefinitions = extractAllSymbols(fsMap)
  const symbolDefinitionsByName = new Map(symbolDefinitions.map(symbol => [symbol.name, symbol]))
  const symbolDefinitionsByPath = new Map(symbolDefinitions.map(symbol => [symbol.filePath, symbol]))
  const subcircuitRegistry = buildSubcircuitRegistry(fsMap)
  const symbolComponentRegistry = buildSymbolComponentRegistry(fsMap)
  const subcircuitRegistryByPath = new Map(Object.values(subcircuitRegistry).map(info => [info.filePath, info]))
  const symbolComponentRegistryByPath = new Map(Object.values(symbolComponentRegistry).map(info => [info.filePath, info]))
  const importedComponentPaths = new Map<string, string>()
  ;[...content.matchAll(/import\s+(?:type\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+from\s+["']([^"']+)["']/g)].forEach((match) => {
    const localName = match[1]
    const importPath = match[2]
    const resolvedPath = resolveProjectPath(filePath, importPath, fsMap)
    if (localName && resolvedPath) {
      importedComponentPaths.set(localName, resolvedPath)
    }
  })
  const bodyMatch = isSchematicFile
    ? content.match(/<board[^>]*>([\s\S]*?)<\/board>/)
    : content.match(/<subcircuit[^>]*>([\s\S]*?)<\/subcircuit>/)

  if (!bodyMatch) {
    return { components: [], wires: [] }
  }

  const body = bodyMatch[1]
  const components: PlacedComponent[] = []
  const wires: WireConnection[] = []
  const nameToId = new Map<string, string>()
  const importedNameMap = new Map<string, string>()
  const netRegistry = new NetRegistry()

  const componentRegex = /<([A-Za-z_][A-Za-z0-9_]*)\s+([^>]*?)\/>/g
  const usedComponentNames = new Set<string>()
  let componentMatch
  let parseCursor = 0
  let defaultImportIndex = 0
  let hasAnyExplicitCoordinates = false

  while ((componentMatch = componentRegex.exec(body)) !== null) {
    const tagName = componentMatch[1]
    const propsStr = componentMatch[2]
    const leadingSegment = body.slice(parseCursor, componentMatch.index)
    const schXCommentMatches = [...leadingSegment.matchAll(/\{\/\*\s*\/\/\s*schX=\{([^}]+)\}\s*\*\/\}/g)]
    const schYCommentMatches = [...leadingSegment.matchAll(/\{\/\*\s*\/\/\s*schY=\{([^}]+)\}\s*\*\/\}/g)]
    const editorSchXCommentMatches = [...leadingSegment.matchAll(/\{\/\*\s*\/\/\s*editorSchX=\{([^}]+)\}\s*\*\/\}/g)]
    const editorSchYCommentMatches = [...leadingSegment.matchAll(/\{\/\*\s*\/\/\s*editorSchY=\{([^}]+)\}\s*\*\/\}/g)]
    const schXCommentExpr = schXCommentMatches.length > 0 ? schXCommentMatches[schXCommentMatches.length - 1][1] : null
    const schYCommentExpr = schYCommentMatches.length > 0 ? schYCommentMatches[schYCommentMatches.length - 1][1] : null
    const editorSchXCommentExpr = editorSchXCommentMatches.length > 0 ? editorSchXCommentMatches[editorSchXCommentMatches.length - 1][1] : null
    const editorSchYCommentExpr = editorSchYCommentMatches.length > 0 ? editorSchYCommentMatches[editorSchYCommentMatches.length - 1][1] : null

    parseCursor = componentRegex.lastIndex

    if (tagName === 'trace' || tagName === 'board' || tagName === 'subcircuit') continue

    const props: Record<string, any> = {}
    let hasExplicitPosition = false
    let name = ''
    const attributes = parseJsxAttributes(propsStr)

    attributes.forEach(({ key, kind, rawValue, parsedValue }) => {
      if (key === 'name' && kind === 'string' && parsedValue) {
        name = String(parsedValue)
        return
      }

      if (key === 'schX' && kind === 'expr') {
        const parsedNumber = typeof parsedValue === 'number' ? parsedValue : Number(parsedValue)
        props.schX = Number.isFinite(parsedNumber)
          ? schematicToPixel(parsedNumber)
          : parseSchExpr(rawValue, isSubcircuitFile)
        hasExplicitPosition = true
        hasAnyExplicitCoordinates = true
        return
      }

      if (key === 'schY' && kind === 'expr') {
        const parsedNumber = typeof parsedValue === 'number' ? parsedValue : Number(parsedValue)
        props.schY = Number.isFinite(parsedNumber)
          ? schematicToPixel(parsedNumber)
          : parseSchExpr(rawValue, isSubcircuitFile)
        hasExplicitPosition = true
        hasAnyExplicitCoordinates = true
        return
      }

      if (kind === 'string') {
        props[key] = parsedValue
        return
      }

      if (kind === 'boolean') {
        props[key] = true
        return
      }

      if (kind === 'expr') {
        const numeric = typeof parsedValue === 'number' ? parsedValue : Number(parsedValue)
        props[key] = Number.isFinite(numeric) && String(parsedValue).trim() === String(numeric)
          ? numeric
          : parsedValue
      }
    })

    if (tagName === 'switch') {
      if (props.type === undefined && props.variant !== undefined) {
        props.type = props.variant
      }
      delete props.variant
      if (props.footprint === undefined || props.footprint === '') {
        props.footprint = 'pushbutton'
      }
    }

    if (tagName === 'chip') {
      Object.assign(props, deriveCustomChipPropsFromDeclaration(props))
    }

    if (props.schX === undefined && editorSchXCommentExpr !== null) {
      props.schX = parseEditorCoordExpr(editorSchXCommentExpr)
      hasExplicitPosition = true
      hasAnyExplicitCoordinates = true
    } else if (props.schX === undefined && schXCommentExpr !== null) {
      props.schX = parseSchExpr(schXCommentExpr, isSubcircuitFile)
      hasExplicitPosition = true
      hasAnyExplicitCoordinates = true
    }

    if (props.schY === undefined && editorSchYCommentExpr !== null) {
      props.schY = parseEditorCoordExpr(editorSchYCommentExpr)
      hasExplicitPosition = true
      hasAnyExplicitCoordinates = true
    } else if (props.schY === undefined && schYCommentExpr !== null) {
      props.schY = parseSchExpr(schYCommentExpr, isSubcircuitFile)
      hasExplicitPosition = true
      hasAnyExplicitCoordinates = true
    }

    if (props.schX === undefined && props.schY === undefined) {
      const fallback = getDefaultImportPosition(defaultImportIndex++)
      props.schX = fallback.schX
      props.schY = fallback.schY
    }

    if (tagName === 'netlabel') {
      const rawNet = String(props.net || '').trim()
      if (rawNet) {
        const netId = netRegistry.registerNet(rawNet, {
          role: inferNetRole(rawNet),
          source: 'netlabel'
        })
        props.netId = netId
        props.net = netRegistry.getNetName(netId) || rawNet
        props.netRole = netRegistry.getNetRole(netId) || inferNetRole(rawNet)
      }
    }

    if (!name) {
      if (tagName === 'netlabel') {
        name = `netlabel-${components.length + 1}`
      } else if (tagName === 'sheet') {
        const fallbackSheetName = String(props.src || `Sheet${components.length + 1}`)
          .split('/')
          .pop()
          ?.replace(/\.(tsx|ts)$/, '') || `Sheet${components.length + 1}`
        name = fallbackSheetName
      } else if (tagName === 'port') {
        name = `PORT${components.length + 1}`
      } else {
        continue
      }
    }

    const preservePublicName = tagName === 'port' || tagName === 'net'
    const originalName = name
    if (!preservePublicName) {
      name = getUniqueImportedComponentName(name, usedComponentNames)
    }
    importedNameMap.set(originalName, name)

    const isCustomChip = tagName === 'chip' && (
      props.pinCount !== undefined ||
      props.pinNames !== undefined ||
      props.symbolPreset !== undefined
    )
    const isSheetReference = tagName === 'sheet'
    const isPublicPort = tagName === 'port'
    const effectiveCatalogId = isCustomChip ? 'customchip' : tagName
    const isKnownPart = !isSheetReference && !isPublicPort && !!getCatalogItem(effectiveCatalogId)
    const id = `comp-${filePath}-${name}-${components.length}`

    const importedComponentPath = importedComponentPaths.get(tagName)
    const isSymbolReference = symbolNames.has(tagName)
      || (!!importedComponentPath && symbolDefinitionsByPath.has(importedComponentPath))
    const subcircuitDefinition = subcircuitRegistry[tagName]
    const symbolComponentDefinition = symbolComponentRegistry[tagName]
    const importedSubcircuitDefinition = importedComponentPath ? subcircuitRegistryByPath.get(importedComponentPath) : undefined
    const importedSymbolComponentDefinition = importedComponentPath ? symbolComponentRegistryByPath.get(importedComponentPath) : undefined
    const resolvedSymbolDefinition =
      symbolDefinitionsByName.get(tagName)
      || (importedComponentPath ? symbolDefinitionsByPath.get(importedComponentPath) : undefined)

    if (isSheetReference) {
      const rawSheetSrc = String(props.src || '')
      const resolvedSheetPath = resolveProjectPath(filePath, rawSheetSrc, fsMap)
        || resolveProjectPath(filePath, rawSheetSrc)
        || rawSheetSrc
      props.sheetPath = resolvedSheetPath
      props.sheetName = name
      props.ports = resolvedSheetPath ? getSheetPorts(fsMap, resolvedSheetPath) : []
    } else if (isPublicPort) {
      props.publicPortName = name
    } else if (isSymbolReference) {
      props.symbolName = tagName
      props.ports = resolvedSymbolDefinition?.ports.map(port => port.name)
        || symbolComponentDefinition?.ports
        || importedSymbolComponentDefinition?.ports
        || []
      props.symbolPorts = resolvedSymbolDefinition?.ports.map(port => ({
        name: port.name,
        schX: Number(port.x || 0),
        schY: Number(port.y || 0)
      }))
        || symbolComponentDefinition?.portGeometry.map(port => ({
          name: String(port.name || ''),
          schX: Number(port.schX || 0),
          schY: Number(port.schY || 0)
        }))
        || importedSymbolComponentDefinition?.portGeometry.map(port => ({
          name: String(port.name || ''),
          schX: Number(port.schX || 0),
          schY: Number(port.schY || 0)
        }))
        || []
      props.symbolShapes = resolvedSymbolDefinition?.geometry?.shapes?.map(shape => ({ ...shape }))
        || symbolComponentDefinition?.geometry?.shapes?.map(shape => ({ ...shape }))
        || importedSymbolComponentDefinition?.geometry?.shapes?.map(shape => ({ ...shape }))
        || []
      props.symbolWidth = Number(
        resolvedSymbolDefinition?.geometry?.width
        || symbolComponentDefinition?.geometry?.width
        || importedSymbolComponentDefinition?.geometry?.width
        || props.symbolWidth
        || 120
      )
      props.symbolHeight = Number(
        resolvedSymbolDefinition?.geometry?.height
        || symbolComponentDefinition?.geometry?.height
        || importedSymbolComponentDefinition?.geometry?.height
        || props.symbolHeight
        || 80
      )
      props.symbolOriginX = Number(
        resolvedSymbolDefinition?.geometry?.origin?.x
        || symbolComponentDefinition?.geometry?.origin?.x
        || importedSymbolComponentDefinition?.geometry?.origin?.x
        || 0
      )
      props.symbolOriginY = Number(
        resolvedSymbolDefinition?.geometry?.origin?.y
        || symbolComponentDefinition?.geometry?.origin?.y
        || importedSymbolComponentDefinition?.geometry?.origin?.y
        || 0
      )
      props.subcircuitPath = importedComponentPath || resolvedSymbolDefinition?.filePath || symbolComponentDefinition?.filePath || `symbols/${tagName}.tsx`
    } else if (!isKnownPart) {
      const ports = subcircuitDefinition?.ports
        || symbolComponentDefinition?.ports
        || importedSubcircuitDefinition?.ports
        || importedSymbolComponentDefinition?.ports
        || getSubcircuitPorts(fsMap, tagName)
      props.subcircuitName = tagName
      props.subcircuitPath = importedComponentPath
        || subcircuitDefinition?.filePath
        || symbolComponentDefinition?.filePath
        || `subcircuits/${tagName}.tsx`
      props.ports = ports
    }

    const component: PlacedComponent = {
      id,
      catalogId: isPublicPort
        ? 'public-port'
        : isSheetReference
        ? 'sheet-instance'
        : isKnownPart
        ? effectiveCatalogId
        : isSymbolReference
        ? 'symbol-instance'
        : 'subcircuit-instance',
      name,
      props: {
        ...props,
        layoutLocked: hasExplicitPosition,
        schX: props.schX ?? 0,
        schY: props.schY ?? 0
      },
      tsxSnippet: ''
    }

    components.push(component)
    if (tagName !== 'net' && tagName !== 'netlabel') {
      nameToId.set(name, id)
    }
  }

  const netEndpointByName = new Map<string, string>()

  components.forEach((component) => {
    if (component.catalogId === 'netport') {
      const netName = String(component.props.netName || component.props.name || component.name || '').trim()
      if (!netName) return
      const netId = netRegistry.registerNet(netName, {
        role: roleFromNetComponent(component),
        source: 'trace'
      })
      component.props = {
        ...component.props,
        netId,
        netRole: netRegistry.getNetRole(netId) || inferNetRole(netName),
        netName: netRegistry.getNetName(netId) || netName
      }
      const canonicalName = canonicalizeNetName(netRegistry.getNetName(netId) || netName)
      if (!netEndpointByName.has(canonicalName)) {
        netEndpointByName.set(canonicalName, component.id)
      }
      return
    }

    if (component.catalogId !== 'net') return
    const netName = String(component.props.name || component.name || '').trim()
    if (!netName) return
    const explicitRole: NetRole = component.props.isGround
      ? 'ground'
      : component.props.isForPower
      ? 'power'
      : inferNetRole(netName)
    const netId = netRegistry.registerNet(netName, {
      role: explicitRole,
      source: 'explicit-net'
    })
    component.props = {
      ...component.props,
      netId,
      netRole: netRegistry.getNetRole(netId) || explicitRole
    }
    const canonicalName = canonicalizeNetName(netRegistry.getNetName(netId) || netName)
    if (!netEndpointByName.has(canonicalName)) {
      netEndpointByName.set(canonicalName, component.id)
    }
  })

  const resolveExistingNetComponent = (portName: string): string | null => {
    const canonicalName = canonicalizeNetName(portName)
    const endpointId = netEndpointByName.get(canonicalName)
    if (endpointId) return endpointId
    return null
  }

  const ensureNetComponent = (portName: string): string => {
    const existing = resolveExistingNetComponent(portName)
    if (existing) return existing

    const canonicalName = canonicalizeNetName(portName)
    const netId = netRegistry.registerNet(canonicalName, {
      role: inferNetRole(canonicalName),
      source: 'inferred'
    })

    const componentId = `comp-${filePath}-net-${canonicalName}-${components.length}`
    const inferredNet: PlacedComponent = {
      id: componentId,
      catalogId: 'net',
      name: canonicalName,
      props: {
        name: canonicalName,
        netId,
        netRole: netRegistry.getNetRole(netId) || inferNetRole(canonicalName),
        schX: 0,
        schY: 0,
        layoutLocked: true
      },
      tsxSnippet: ''
    }

    components.push(inferredNet)
    netEndpointByName.set(canonicalName, componentId)
    return componentId
  }

  const traceRegex = /<trace\b((?:[^"'>]|"[^"]*"|'[^']*')*)\/>/g
  let traceMatch
  let traceIndex = 0

  while ((traceMatch = traceRegex.exec(body)) !== null) {
    const attrs = traceMatch[1] || ''
    const fromRaw = attrs.match(/\bfrom\s*=\s*(["'])(.*?)\1/)?.[2]
    const toRaw = attrs.match(/\bto\s*=\s*(["'])(.*?)\1/)?.[2]
    const routePointsRaw = attrs.match(/\broutePoints\s*=\s*(["'])(.*?)\1/)?.[2]
    if (!fromRaw || !toRaw) continue
    const routePoints = parseTraceRoutePoints(routePointsRaw)

    const fromRef = parseComponentRef(fromRaw)
    const toRef = parseComponentRef(toRaw)
    const fromNet = fromRaw.match(/^net\.([A-Za-z_][A-Za-z0-9_]*)$/)
    const toNet = toRaw.match(/^net\.([A-Za-z_][A-Za-z0-9_]*)$/)

    if (fromRef && toRef) {
      const fromComponentName = importedNameMap.get(fromRef.componentName) || fromRef.componentName
      const toComponentName = importedNameMap.get(toRef.componentName) || toRef.componentName
      const fromId = nameToId.get(fromComponentName)
      const toId = nameToId.get(toComponentName)
      if (!fromId || !toId) continue

      wires.push({
        id: `wire-${filePath}-${traceIndex++}`,
        from: { componentId: fromId, pinName: fromRef.pinName },
        to: { componentId: toId, pinName: toRef.pinName },
        ...(routePoints ? { routePoints } : {}),
        routingIntent: 'manual',
        tsxSnippet: ''
      })
      continue
    }

    if (fromRef && toNet) {
      const fromComponentName = importedNameMap.get(fromRef.componentName) || fromRef.componentName
      const fromId = nameToId.get(fromComponentName)
      if (!fromId) continue
      const netId = ensureNetComponent(toNet[1])
      wires.push({
        id: `wire-${filePath}-${traceIndex++}`,
        from: { componentId: fromId, pinName: fromRef.pinName },
        to: { componentId: netId, pinName: 'port' },
        ...(routePoints ? { routePoints } : {}),
        routingIntent: 'manual',
        tsxSnippet: ''
      })
      continue
    }

    if (fromNet && toRef) {
      const toComponentName = importedNameMap.get(toRef.componentName) || toRef.componentName
      const toId = nameToId.get(toComponentName)
      if (!toId) continue
      const netId = ensureNetComponent(fromNet[1])
      wires.push({
        id: `wire-${filePath}-${traceIndex++}`,
        from: { componentId: netId, pinName: 'port' },
        to: { componentId: toId, pinName: toRef.pinName },
        ...(routePoints ? { routePoints } : {}),
        routingIntent: 'manual',
        tsxSnippet: ''
      })
      continue
    }

    if (fromNet && toNet) {
      const fromRole = netRegistry.getNetRole(fromNet[1]) || inferNetRole(fromNet[1])
      const toRole = netRegistry.getNetRole(toNet[1]) || inferNetRole(toNet[1])
      if (hasPowerSignalConflict(fromRole, toRole)) {
        console.warn(`[net-semantics] Rejected direct power-signal short: net.${fromNet[1]} -> net.${toNet[1]}`)
        continue
      }

      const fromId = ensureNetComponent(fromNet[1])
      const toId = ensureNetComponent(toNet[1])
      wires.push({
        id: `wire-${filePath}-${traceIndex++}`,
        from: { componentId: fromId, pinName: 'port' },
        to: { componentId: toId, pinName: 'port' },
        ...(routePoints ? { routePoints } : {}),
        routingIntent: 'manual',
        tsxSnippet: ''
      })
    }
  }

  components.forEach((component) => {
    if (component.catalogId === 'net' || component.catalogId === 'netport' || component.catalogId === 'netlabel' || component.catalogId === 'public-port') return
    const connections = component.props.connections
    if (!connections || typeof connections !== 'object' || Array.isArray(connections)) return

    Object.entries(connections as Record<string, unknown>).forEach(([rawPinName, rawNetName]) => {
      const netNameValue = String(rawNetName || '').trim()
      if (!netNameValue) return

      const netName = netNameValue.replace(/^net\./i, '').trim()
      if (!netName) return

      const pinName = normalizeConnectionPinName(component.props, rawPinName)
      const netComponentId = ensureNetComponent(netName)

      const duplicate = wires.some((wire) => (
        (wire.from.componentId === component.id && wire.from.pinName === pinName && wire.to.componentId === netComponentId)
        || (wire.to.componentId === component.id && wire.to.pinName === pinName && wire.from.componentId === netComponentId)
      ))
      if (duplicate) return

      wires.push({
        id: `wire-${filePath}-${traceIndex++}`,
        from: { componentId: component.id, pinName },
        to: { componentId: netComponentId, pinName: 'port' },
        routingIntent: 'manual',
        tsxSnippet: ''
      })
    })
  })

  const normalizeComponentsToViewport = (items: PlacedComponent[]): PlacedComponent[] => {
    if (items.length === 0) return items

    // Respect explicit TSX coordinates from import so authored geometry is preserved.
    if (hasAnyExplicitCoordinates) return items

    const points = items
      .map((component) => ({
        id: component.id,
        x: Number(component.props.schX || 0),
        y: Number(component.props.schY || 0)
      }))

    const minX = Math.min(...points.map(p => p.x))
    const maxX = Math.max(...points.map(p => p.x))
    const minY = Math.min(...points.map(p => p.y))
    const maxY = Math.max(...points.map(p => p.y))

    const width = Math.max(1, maxX - minX)
    const height = Math.max(1, maxY - minY)

    // Keep imported circuits in view so connected wires/components stay visible.
    const targetWidth = 1200
    const targetHeight = 700
    const margin = 80

    const scaleX = (targetWidth - margin * 2) / width
    const scaleY = (targetHeight - margin * 2) / height
    const scaleToFit = Math.min(scaleX, scaleY, 1)

    const shouldScale = width > (targetWidth - margin * 2) || height > (targetHeight - margin * 2)
    const scale = shouldScale ? Math.max(0.1, scaleToFit) : 1

    return items.map((component) => {
      const sourceX = Number(component.props.schX || 0)
      const sourceY = Number(component.props.schY || 0)

      const normalizedX = Math.round((sourceX - minX) * scale + margin)
      const normalizedY = Math.round((sourceY - minY) * scale + margin)

      return {
        ...component,
        props: {
          ...component.props,
          schX: normalizedX,
          schY: normalizedY
        }
      }
    })
  }

  const merged = mergeElectricalNets(components, wires)
  return { components: normalizeComponentsToViewport(merged.components), wires: merged.wires }
}

const getCanvasStateForFile = (filePath: string, fsMap: FSMap): { components: PlacedComponent[]; wires: WireConnection[] } => {
  if (!isCanvasEditableFilePath(filePath)) {
    return { components: [], wires: [] }
  }

  const persisted = readPersistedCanvasGraphState(filePath, fsMap)
  if (persisted) {
    return {
      components: persisted.components.map(component => ({
        ...component,
        props: { ...component.props }
      })),
      wires: persisted.wires.map(wire => ({
        ...wire,
        from: { ...wire.from },
        to: { ...wire.to },
        routePoints: wire.routePoints ? wire.routePoints.map(point => ({ ...point })) : undefined
      }))
    }
  }

  return parseFileToCanvas(filePath, fsMap)
}

const syncActiveCanvasFile = (state: Pick<EditorState, 'activeFilePath' | 'fsMap' | 'placedComponents' | 'wires'>): FSMap => {
  if (!isCanvasEditableFilePath(state.activeFilePath)) {
    return regenerateSubcircuitIndex({ ...state.fsMap })
  }

  const currentContent = generateFileTSX(state.activeFilePath, state.placedComponents, state.wires)
  const withSource = regenerateSubcircuitIndex({
    ...state.fsMap,
    [state.activeFilePath]: currentContent
  })

  return writePersistedCanvasGraphState(withSource, state.activeFilePath, state.placedComponents, state.wires)
}

const buildPersistedCanvasState = (
  state: Pick<EditorState, 'activeFilePath' | 'fsMap' | 'placedComponents' | 'wires' | 'workspaces' | 'activeWorkspaceId' | 'openFilePaths'>,
  overrides: Partial<Pick<EditorState, 'activeFilePath' | 'fsMap' | 'placedComponents' | 'wires' | 'openFilePaths'>>
) => {
  const activeFilePath = overrides.activeFilePath ?? state.activeFilePath
  const placedComponents = overrides.placedComponents ?? state.placedComponents
  const wires = overrides.wires ?? state.wires
  const openFilePaths = overrides.openFilePaths ?? state.openFilePaths
  const fsMapBase = overrides.fsMap ?? state.fsMap

  const fsMap = isCanvasEditableFilePath(activeFilePath)
    ? syncActiveCanvasFile({ activeFilePath, fsMap: fsMapBase, placedComponents, wires })
    : regenerateSubcircuitIndex({ ...fsMapBase })

  const workspaces = {
    ...state.workspaces,
    [state.activeWorkspaceId]: {
      ...state.workspaces[state.activeWorkspaceId],
      fsMap,
      activeFilePath,
      openFilePaths
    }
  }

  return {
    activeFilePath,
    placedComponents,
    wires,
    openFilePaths,
    fsMap,
    workspaces
  }
}

const getComponentTagName = (component: PlacedComponent): string => {
  if (component.catalogId === 'subcircuit-instance') {
    return component.props.subcircuitName || component.name
  }
  if (component.catalogId === 'sheet-instance') {
    return 'sheet'
  }
  if (component.catalogId === 'symbol-instance') {
    return component.props.symbolName || component.name
  }
  if (component.catalogId === 'public-port') {
    return 'port'
  }
  if (component.catalogId === 'customchip') {
    return 'chip'
  }
  return component.catalogId
}

const sanitizeComponentName = (name: string): string => name.trim().replace(/^\.+/, '')

const canonicalizeNetName = (value: string): string => value.trim().toUpperCase()

const inferCommonNetForPin = (label: string): string | null => {
  const normalized = label.trim().toLowerCase()
  if (!normalized) return null

  if (/^(gnd|ground|vss|0v|agnd|dgnd)$/i.test(normalized)) return 'GND'
  if (/^(vcc|vdd|vin|vbatt|vbat|3v3|5v|power)$/i.test(normalized)) return 'VCC'
  return null
}

const getAutoWireTargets = (component: PlacedComponent): Array<{ pinName: string; netName: string }> => {
  if (component.catalogId === 'net' || component.catalogId === 'netport' || component.catalogId === 'netlabel' || component.catalogId === 'public-port') {
    return []
  }

  const inferred = new Map<string, string>()
  const pinLabels = component.props?.pinLabels

  if (pinLabels && typeof pinLabels === 'object') {
    Object.entries(pinLabels as Record<string, unknown>).forEach(([pinName, value]) => {
      const netName = inferCommonNetForPin(String(value || pinName))
      if (netName) inferred.set(pinName, netName)
    })
  }

  if ((component.catalogId === 'subcircuit-instance' || component.catalogId === 'sheet-instance') && Array.isArray(component.props?.ports)) {
    ;(component.props.ports as unknown[]).forEach((port) => {
      const pinName = String(port)
      const netName = inferCommonNetForPin(pinName)
      if (netName) inferred.set(pinName, netName)
    })
  }

  const fallbackPins = getPinConfig(component.catalogId)?.pins || []
  fallbackPins.forEach((pin) => {
    const netName = inferCommonNetForPin(pin.name)
    if (netName && !inferred.has(pin.name)) {
      inferred.set(pin.name, netName)
    }
  })

  return Array.from(inferred.entries()).map(([pinName, netName]) => ({ pinName, netName }))
}

const getSelectablePinsForComponent = (component: PlacedComponent): string[] => {
  if (component.catalogId === 'net' || component.catalogId === 'netport') {
    return ['port']
  }

  if (component.catalogId === 'public-port') {
    return ['port']
  }

  if (component.catalogId === 'symbol-instance') {
    const fromGeometry = Array.isArray(component.props.symbolPorts)
      ? (component.props.symbolPorts as Array<{ name?: string }>).map(port => String(port.name || '').trim()).filter(Boolean)
      : []
    if (fromGeometry.length > 0) return fromGeometry

    const ports = ((component.props.ports as string[] | undefined) || []).map(String).filter(Boolean)
    return ports
  }

  if (component.catalogId === 'subcircuit-instance' || component.catalogId === 'sheet-instance') {
    const ports = (component.props.ports as string[] | undefined) || []
    return ports.length > 0 ? ports : ['IO']
  }

  if (component.catalogId === 'customchip') {
    const legacyCount = Math.max(2, Number(component.props.pinCount || 8))
    const leftCount = Math.max(0, Number(component.props.leftPins ?? Math.ceil(legacyCount / 2)))
    const rightCount = Math.max(0, Number(component.props.rightPins ?? Math.floor(legacyCount / 2)))
    const topCount = Math.max(0, Number(component.props.topPins ?? 0))
    const bottomCount = Math.max(0, Number(component.props.bottomPins ?? 0))

    const namedMap = new Map<string, string>()
    const rawNames = String(component.props.pinNames || '').trim()
    const hasExplicitSideConfig =
      component.props.leftPins !== undefined ||
      component.props.rightPins !== undefined ||
      component.props.topPins !== undefined ||
      component.props.bottomPins !== undefined ||
      rawNames.includes('=')

    if (!hasExplicitSideConfig) {
      return Array.from({ length: legacyCount }, (_, index) => `pin${index + 1}`)
    }

    if (rawNames.includes('=')) {
      rawNames
        .split(',')
        .map((entry: string) => entry.trim())
        .filter(Boolean)
        .forEach((entry: string) => {
          const [slot, ...rest] = entry.split('=')
          const slotKey = slot.trim().toUpperCase()
          const pinLabel = rest.join('=').trim()
          if (slotKey && pinLabel) {
            namedMap.set(slotKey, pinLabel)
          }
        })
    }

    const legacyNames = !rawNames.includes('=')
      ? rawNames.split(',').map((value: string) => value.trim()).filter(Boolean)
      : []
    let legacyCursor = 0

    const getName = (slotKey: string, fallback: string) => {
      if (namedMap.has(slotKey)) return namedMap.get(slotKey) as string
      if (legacyCursor < legacyNames.length) {
        const fromLegacy = legacyNames[legacyCursor]
        legacyCursor += 1
        return fromLegacy
      }
      return fallback
    }

    const pins: string[] = []
    for (let i = 0; i < leftCount; i += 1) pins.push(getName(`L${i + 1}`, `L${i + 1}`))
    for (let i = 0; i < rightCount; i += 1) pins.push(getName(`R${i + 1}`, `R${i + 1}`))
    for (let i = 0; i < topCount; i += 1) pins.push(getName(`U${i + 1}`, `U${i + 1}`))
    for (let i = 0; i < bottomCount; i += 1) pins.push(getName(`D${i + 1}`, `D${i + 1}`))
    return pins
  }

  return (getPinConfig(component.catalogId)?.pins || []).map(pin => pin.name)
}

const validateWireSelectorsForExport = (
  filePath: string,
  components: PlacedComponent[],
  wires: WireConnection[]
): string[] => {
  const byId = new Map(components.map(component => [component.id, component]))
  const errors: string[] = []

  const validateEndpoint = (endpoint: { componentId: string; pinName: string }) => {
    const component = byId.get(endpoint.componentId)
    if (!component) {
      errors.push(`${filePath}: missing component id ${endpoint.componentId}`)
      return
    }

    if (component.catalogId === 'net' || component.catalogId === 'netport' || component.catalogId === 'netlabel' || component.catalogId === 'public-port') {
      if (endpoint.pinName !== 'port') {
        errors.push(`${filePath}: invalid net selector .${component.name} > .${endpoint.pinName}`)
      }
      return
    }

    const validPins = new Set(getSelectablePinsForComponent(component))
    if (validPins.size > 0 && !validPins.has(endpoint.pinName)) {
      errors.push(`${filePath}: invalid selector .${component.name} > .${endpoint.pinName}`)
    }
  }

  wires.forEach((wire) => {
    validateEndpoint(wire.from)
    validateEndpoint(wire.to)
  })

  return errors
}

const buildNetRegistryFromComponents = (components: PlacedComponent[]): NetRegistry => {
  const registry = new NetRegistry()

  components.forEach((component) => {
    if (component.catalogId !== 'net' && component.catalogId !== 'netport') return
    const rawName = String(component.props.netName || component.props.name || component.name || '').trim()
    if (!rawName) return
    registry.registerNet(rawName, {
      role: roleFromNetComponent(component),
      source: component.catalogId === 'net' ? 'explicit-net' : 'trace'
    })
  })

  return registry
}

const toAttrList = (props: Record<string, any>): string[] => {
  const attrs: string[] = []

  Object.entries(props)
    .filter(([key]) => ![
      'name',
      'schX',
      'schY',
      'schRotation',
      'subcircuitName',
      'subcircuitPath',
      'sheetName',
      'sheetPath',
      'src',
      'ports',
      'symbolPorts',
      'symbolShapes',
      'symbolWidth',
      'symbolHeight',
      'symbolOriginX',
      'symbolOriginY',
      'netName',
      'netId',
      'netAnchorKind',
      'isImplicitImportedNetAnchor',
      'layoutLocked'
    ].includes(key))
    .forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return
      if (typeof value === 'number') {
        attrs.push(`${key}={${value}}`)
        return
      }
      if (typeof value === 'boolean') {
        if (value) attrs.push(key)
        return
      }
      attrs.push(`${key}="${String(value).replace(/"/g, '&quot;')}"`)
    })

  return attrs
}

const createComponentSnippet = (component: PlacedComponent, inSubcircuitFile: boolean, activeFilePath?: string): string => {
  if (component.catalogId === 'netport') return ''

  const tagName = getComponentTagName(component)
  const normalizedProps = { ...component.props }
  if (component.catalogId === 'switch') {
    if (normalizedProps.type === undefined && normalizedProps.variant !== undefined) {
      normalizedProps.type = normalizedProps.variant
    }
    delete normalizedProps.variant
    if (normalizedProps.footprint === undefined || normalizedProps.footprint === '') {
      normalizedProps.footprint = 'pushbutton'
    }
  }

  if (component.catalogId === 'customchip') {
    const pinCount = Math.max(2, Number(normalizedProps.pinCount || 8))
    if (normalizedProps.footprint === undefined || normalizedProps.footprint === '') {
      normalizedProps.footprint = pinCount === 8 ? 'soic8' : 'soic8'
    }
  }

  if (component.catalogId === 'net') {
    const rawNetName = String(normalizedProps.name || component.name || '').trim()
    if (rawNetName) {
      const canonical = canonicalizeNetName(rawNetName)
      normalizedProps.name = canonical
    }
  }

  if (component.catalogId === 'netlabel') {
    const rawNetName = String(normalizedProps.net || normalizedProps.netName || '').trim()
    if (rawNetName) {
      normalizedProps.net = canonicalizeNetName(rawNetName)
    }
  }

  const attrs = toAttrList(normalizedProps)
  const name = sanitizeComponentName(String(normalizedProps.name || component.name || ''))
  const x = pixelToSchematic(Number(normalizedProps.schX || 0))
  const y = pixelToSchematic(Number(normalizedProps.schY || 0))
  const editorX = Number(normalizedProps.schX || 0)
  const editorY = Number(normalizedProps.schY || 0)
  const coordX = Number.isInteger(x) ? String(x) : String(Number(x.toFixed(3)))
  const coordY = Number.isInteger(y) ? String(y) : String(Number(y.toFixed(3)))
  const schXExpr = inSubcircuitFile ? `{x + ${coordX}}` : `{${coordX}}`
  const schYExpr = inSubcircuitFile ? `{y + ${coordY}}` : `{${coordY}}`
  const propLines: string[] = []

  if (name && component.catalogId !== 'netlabel') propLines.push(`name="${name}"`)
  if (attrs.length > 0) propLines.push(...attrs)
  propLines.push(`schX=${schXExpr}`)
  propLines.push(`schY=${schYExpr}`)
  const rotation = String(normalizedProps.schRotation || '0deg')
  propLines.push(`schRotation="${rotation}"`)
  const commentX = Number.isInteger(editorX) ? String(editorX) : String(Number(editorX.toFixed(3)))
  const commentY = Number.isInteger(editorY) ? String(editorY) : String(Number(editorY.toFixed(3)))

  if (component.catalogId === 'public-port') {
    return [
      `<port`,
      `  name="${name}"`,
      `  schX=${schXExpr}`,
      `  schY=${schYExpr}`,
      '/>'
    ].join('\n')
  }

  if (component.catalogId === 'sheet-instance') {
    const resolvedSheetPath = String(normalizedProps.sheetPath || normalizedProps.src || '').trim()
    const sheetSrc = activeFilePath && resolvedSheetPath
      ? `${getRelativeImportPath(activeFilePath, resolvedSheetPath)}.tsx`
      : String(normalizedProps.src || resolvedSheetPath || '')

    const sheetLines = [
      `{/* // editorSchX={${commentX}} */}`,
      `{/* // editorSchY={${commentY}} */}`,
      `<sheet`,
      `  name="${name}"`,
      `  src="${sheetSrc}"`,
      `  schX=${schXExpr}`,
      `  schY=${schYExpr}`
    ]
    if (rotation !== '0deg') {
      sheetLines.push(`  schRotation="${rotation}"`)
    }
    sheetLines.push('/>')
    return sheetLines.join('\n')
  }

  const multiline = [
    `{/* // editorSchX={${commentX}} */}`,
    `{/* // editorSchY={${commentY}} */}`,
    `<${tagName}`,
    ...propLines.map(line => `  ${line}`),
    '/>'
  ]
  return multiline.join('\n')
}

const traceEndpointRef = (component: PlacedComponent | undefined, pinName: string): string | null => {
  if (!component) return null
  if (component.catalogId === 'public-port') {
    const cleanName = sanitizeComponentName(String(component.name || component.props.publicPortName || ''))
    if (!cleanName) return null
    return `.${cleanName} > .port`
  }
  const publicInstanceName = String(component.props.publicInstanceName || '').trim()
  const publicPortName = String(component.props.publicPortName || '').trim()
  if (publicInstanceName && publicPortName) {
    const cleanInstanceName = sanitizeComponentName(publicInstanceName)
    const cleanPortName = sanitizeComponentName(publicPortName)
    if (cleanInstanceName && cleanPortName) {
      return `.${cleanInstanceName} > .${cleanPortName}`
    }
  }
  // netlabel, netport, and net all resolve to net.NETNAME selector (named-net reference)
  if (
    component.catalogId === 'netport' ||
    component.catalogId === 'net' ||
    component.catalogId === 'netlabel'
  ) {
    const rawNetName = String(
      component.props.netName ||
      component.props.net ||
      component.props.name ||
      component.name ||
      ''
    ).trim()
    if (!rawNetName) return null
    const netName = canonicalizeNetName(rawNetName)
    return `net.${netName}`
  }
  const cleanName = sanitizeComponentName(String(component.name || component.props.name || ''))
  if (!cleanName) return null
  if (component.catalogId === 'sheet-instance') {
    return `${cleanName}.${pinName}`
  }
  return `.${cleanName} > .${pinName}`
}

const SCHEMATIC_PRIMITIVE_CATALOG_IDS = new Set([
  'schematicline',
  'schematicrect',
  'schematiccircle',
  'schematicarc',
  'schematicpath',
  'schematictext'
])

const isSymbolEditorPrimitiveComponent = (component: PlacedComponent): boolean => {
  return SCHEMATIC_PRIMITIVE_CATALOG_IDS.has(component.catalogId)
}

const createGraphExportArtifacts = (
  components: PlacedComponent[],
  wires: WireConnection[]
): {
  netDeclarations: string[]
  traceSnippets: string[]
  netComments: string[]
} => {
  const byId = new Map(components.map(component => [component.id, component]))

  // Internal 'net' canvas markers provide named-net identity for the editor;
  // they must NOT be emitted as JSX – tscircuit nets are implicit via trace selectors.
  // We still collect net names for potential comment annotation only.
  const _internalNetNames = components
    .filter(component => component.catalogId === 'net')
    .map(component => canonicalizeNetName(String(component.props.name || component.name || '')))
    .filter(Boolean)
    .filter((name, index, arr) => arr.indexOf(name) === index)
    .sort((a, b) => a.localeCompare(b))
  const netDeclarations: string[] = [] // never emit <net name="..." /> – not valid tscircuit JSX

  const traceSet = new Set<string>()
  const exportGraph: ExportGraph = { nodes: [] }

  wires.forEach((wire) => {
    const fromComponent = byId.get(wire.from.componentId)
    const toComponent = byId.get(wire.to.componentId)
    const fromRef = traceEndpointRef(fromComponent, wire.from.pinName)
    const toRef = traceEndpointRef(toComponent, wire.to.pinName)
    if (!fromRef || !toRef) return
    if (fromRef === toRef) return

    // Avoid exporting abstract net-to-net edges that explode into unreadable netlist-style wiring.
    if (fromRef.startsWith('net.') && toRef.startsWith('net.')) return

    exportGraph.nodes.push({
      kind: 'trace',
      from: fromRef,
      to: toRef,
      routePoints: wire.routePoints,
      routingIntent: wire.routingIntent
    })
  })

  const labelsByNet = new Map<string, Array<{ x: number; y: number; explicit: boolean }>>()
  components
    .filter(component => component.catalogId === 'netlabel')
    .filter(component => component.props.internalHelper !== true)
    .forEach((component) => {
      const rawNet = String(component.props.net || component.props.netName || component.name || '').trim()
      if (!rawNet) return
      const net = canonicalizeNetName(rawNet)
      const x = Number(component.props.schX || 0)
      const y = Number(component.props.schY || 0)
      const explicit = component.props.layoutLocked === true
      const bucket = labelsByNet.get(net) || []
      bucket.push({ x, y, explicit })
      labelsByNet.set(net, bucket)
    })

  labelsByNet.forEach((labels, net) => {
    const explicitLabels = labels.filter(label => label.explicit)
    if (explicitLabels.length > 0) {
      exportGraph.nodes.push({ kind: 'netlabel', net })
      return
    }

    // If there are only default/unpositioned labels, emit at most one explicit netlabel.
    if (labels.length > 0) {
      exportGraph.nodes.push({ kind: 'netlabel', net })
    }
  })

  compileExportGraphToTSXNodes(exportGraph).forEach(snippet => traceSet.add(snippet))

  return {
    netDeclarations,
    traceSnippets: [...traceSet].sort((a, b) => a.localeCompare(b)),
    netComments: []
  }
}

const generateFileTSX = (filePath: string, components: PlacedComponent[], wires: WireConnection[]): string => {
  const isSchematicFile = isSchematicFilePath(filePath)
  const inSubcircuit = !isSchematicFile
  const lines: string[] = []

  const renderedComponents = components
    .filter(component => component.catalogId !== 'net' && component.catalogId !== 'netport' && component.catalogId !== 'netlabel')
    .filter(component => !isSymbolEditorPrimitiveComponent(component))
    .map(component => createComponentSnippet(component, inSubcircuit, filePath))
    .filter(Boolean)
    .map(line => line.split('\n').map(inner => `    ${inner}`).join('\n'))

  const graphArtifacts = createGraphExportArtifacts(components, wires)
  const renderedNets = graphArtifacts.netDeclarations.map(line => `    ${line}`)
  const renderedWires = graphArtifacts.traceSnippets.map(line => `    ${line}`)

  lines.push(
    ...graphArtifacts.netComments,
    ...renderedNets,
    ...renderedComponents,
    ...renderedWires
  )
  const body = lines.length > 0 ? lines.join('\n') : '    {/* Add components here */}'

  if (isSchematicFile) {
    const subImportMap = new Map<string, string>()
    components
      .filter(c => c.catalogId === 'subcircuit-instance')
      .forEach((component) => {
        const name = String(component.props.subcircuitName || '').trim()
        const importPath = String(component.props.subcircuitPath || `subcircuits/${name}.tsx`).trim()
        if (name && importPath) {
          subImportMap.set(name, importPath)
        }
      })

    const symbolImportMap = new Map<string, string>()
    components
      .filter(c => c.catalogId === 'symbol-instance')
      .forEach((component) => {
        const symbolName = String(component.props.symbolName || component.name || '').trim()
        const symbolPath = String(component.props.subcircuitPath || `symbols/${symbolName}.tsx`).trim()
        if (symbolName && symbolPath) {
          symbolImportMap.set(symbolName, symbolPath)
        }
      })

    const subImports = [...subImportMap.entries()]
      .filter(([, importFilePath]) => !importFilePath.startsWith('symbols/'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, importFilePath]) => `import { ${name} } from "${getRelativeImportPath(filePath, importFilePath)}"`)
    const symbolComponentImports = [...subImportMap.entries()]
      .filter(([, importFilePath]) => importFilePath.startsWith('symbols/'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, importFilePath]) => `import ${name} from "${getRelativeImportPath(filePath, importFilePath)}"`)
    const symbolImports = [...symbolImportMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([symbolName, symbolPath]) => `import ${symbolName} from "${getRelativeImportPath(filePath, symbolPath)}"`)

    const imports = [...subImports, ...symbolComponentImports, ...symbolImports].join('\n')

    return `${imports ? `${imports}\n\n` : ''}export default () => (\n  <board width="50mm" height="50mm">\n${body}\n  </board>\n)\n`
  }

  const subcircuitName = filePath.replace('subcircuits/', '').replace('.tsx', '')
  const publicPorts = Array.from(new Set(
    components
      .filter(component => component.catalogId === 'public-port')
      .map(component => String(component.props.publicPortName || component.name || '').trim())
      .filter(Boolean)
  ))
  const portsConst = `export const ports = [${publicPorts.map(port => `"${port}"`).join(', ')}] as const\n\n`

  return `${portsConst}export function ${subcircuitName}(props: { name: string; schX?: number; schY?: number }) {\n  const x = props.schX ?? 0\n  const y = props.schY ?? 0\n\n  return (\n    <subcircuit name={props.name}>\n${body}\n    </subcircuit>\n  )\n}\n`
}

const generateFlatMainTSX = (fsMap: FSMap, rootPath = SCHEMATIC_MAIN_PATH): string => {
  const flatComponents: PlacedComponent[] = []
  const flatWires: WireConnection[] = []
  const netEndpointByName = new Map<string, string>()
  const componentById = new Map<string, PlacedComponent>()
  const parsedCache = new Map<string, { components: PlacedComponent[]; wires: WireConnection[] }>()
  let idCounter = 0

  const generateId = (prefix: string): string => `${prefix}-${idCounter++}`

  const ensureNetEndpoint = (
    netName: string,
    options?: { publicRef?: { instanceName: string; portName: string } }
  ): string => {
    const existing = netEndpointByName.get(netName)
    if (existing) {
      if (options?.publicRef) {
        const existingComponent = componentById.get(existing)
        if (existingComponent) {
          existingComponent.props = {
            ...existingComponent.props,
            publicInstanceName: options.publicRef.instanceName,
            publicPortName: options.publicRef.portName
          }
        }
      }
      return existing
    }

    const id = generateId('net')
    const endpoint: PlacedComponent = {
      id,
      catalogId: 'netport',
      name: netName,
      props: {
        netName,
        ...(options?.publicRef
          ? {
              publicInstanceName: options.publicRef.instanceName,
              publicPortName: options.publicRef.portName
            }
          : {}),
        schX: 0,
        schY: 0
      },
      tsxSnippet: ''
    }

    netEndpointByName.set(netName, id)
    componentById.set(id, endpoint)
    return id
  }

  const parseCached = (filePath: string): { components: PlacedComponent[]; wires: WireConnection[] } => {
    const existing = parsedCache.get(filePath)
    if (existing) return existing
    const parsed = getCanvasStateForFile(filePath, fsMap)
    parsedCache.set(filePath, parsed)
    return parsed
  }

  const expandFile = (
    filePath: string,
    offsetX: number,
    offsetY: number,
    instancePrefix: string,
    pinNetMap?: Map<string, string>
  ) => {
    const parsed = parseCached(filePath)
    const localIdMap = new Map<string, string>()
    const localById = new Map(parsed.components.map(component => [component.id, component]))

    parsed.components.forEach((component) => {
      if (component.catalogId === 'subcircuit-instance' || component.catalogId === 'sheet-instance') {
        return
      }

      if (component.catalogId === 'netport') {
        const localNet = String(component.props.netName || component.name || '').trim()
        if (!localNet) return
        const mappedNet = pinNetMap?.get(localNet) || `${instancePrefix}${localNet}`
        localIdMap.set(component.id, ensureNetEndpoint(mappedNet))
        return
      }

      if (component.catalogId === 'public-port') {
        const portName = String(component.props.publicPortName || component.name || '').trim()
        if (!portName) return
        const mappedNet = pinNetMap?.get(portName) || `${instancePrefix}${portName}`
        localIdMap.set(component.id, ensureNetEndpoint(mappedNet))
        return
      }

      const componentId = generateId('flat-comp')
      const originalName = String(component.props.name || component.name || '')
      const nextName = instancePrefix ? `${instancePrefix}${originalName}` : originalName
      const nextComponent: PlacedComponent = {
        ...component,
        id: componentId,
        name: nextName,
        props: {
          ...component.props,
          name: nextName,
          schX: Number(component.props.schX || 0) + offsetX,
          schY: Number(component.props.schY || 0) + offsetY
        }
      }

      localIdMap.set(component.id, componentId)
      componentById.set(componentId, nextComponent)
      flatComponents.push(nextComponent)
    })

    parsed.components
      .filter(component => component.catalogId === 'subcircuit-instance' || component.catalogId === 'sheet-instance')
      .forEach((component) => {
        const targetPath = component.catalogId === 'sheet-instance'
          ? String(component.props.sheetPath || '').trim()
          : String(component.props.subcircuitPath || `subcircuits/${String(component.props.subcircuitName || component.name || '').trim()}.tsx`).trim()
        if (!targetPath) return

        const nestedPrefixBase = instancePrefix ? `${instancePrefix}${component.name}` : String(component.name || 'sheet')
        const nestedPrefix = `${nestedPrefixBase}__`
        const nestedPortMap = new Map<string, string>()
        const ports = ((component.props.ports as string[] | undefined) || []).map(port => String(port))

        ports.forEach((portName) => {
          nestedPortMap.set(portName, `${nestedPrefix}${portName}`)
        })

        expandFile(
          targetPath,
          offsetX + Number(component.props.schX || 0),
          offsetY + Number(component.props.schY || 0),
          nestedPrefix,
          nestedPortMap
        )
      })

    const resolveEndpoint = (endpoint: { componentId: string; pinName: string }): { componentId: string; pinName: string } | null => {
      const component = localById.get(endpoint.componentId)
      if (!component) return null

      if (component.catalogId === 'subcircuit-instance' || component.catalogId === 'sheet-instance') {
        const nestedPrefixBase = instancePrefix ? `${instancePrefix}${component.name}` : String(component.name || component.props.subcircuitName || component.props.sheetName || 'sheet')
        const netName = `${nestedPrefixBase}__${endpoint.pinName}`
        return {
          componentId: ensureNetEndpoint(netName, {
            publicRef: {
              instanceName: String(component.name || '').trim(),
              portName: endpoint.pinName
            }
          }),
          pinName: 'port'
        }
      }

      const mapped = localIdMap.get(endpoint.componentId)
      if (!mapped) return null

      const mappedComponent = componentById.get(mapped)
      if (mappedComponent?.catalogId === 'netport') {
        return { componentId: mapped, pinName: 'port' }
      }

      return { componentId: mapped, pinName: endpoint.pinName }
    }

    parsed.wires.forEach((wire) => {
      const from = resolveEndpoint(wire.from)
      const to = resolveEndpoint(wire.to)
      if (!from || !to) return

      flatWires.push({
        id: generateId('flat-wire'),
        from,
        to,
        tsxSnippet: ''
      })
    })
  }

  const fallbackRootPath = Object.keys(fsMap).sort().find(path => isSchematicFilePath(path)) || SCHEMATIC_MAIN_PATH
  const effectiveRootPath = fsMap[rootPath] ? rootPath : fallbackRootPath

  expandFile(effectiveRootPath, 0, 0, '')

  const renderedComponents = flatComponents
    .filter(component => component.catalogId !== 'net' && component.catalogId !== 'netport')
    .filter(component => !isSymbolEditorPrimitiveComponent(component))
    .map(component => createComponentSnippet(component, false, effectiveRootPath))
    .filter(Boolean)
    .map(line => `    ${line}`)

  const allComponentsForWires = [...componentById.values()]
  const graphArtifacts = createGraphExportArtifacts(allComponentsForWires, flatWires)

  const renderedNets = graphArtifacts.netDeclarations.map(line => `    ${line}`)

  const renderedWires = graphArtifacts.traceSnippets
    .map(line => `    ${line}`)

  const body = [...graphArtifacts.netComments, ...renderedNets, ...renderedComponents, ...renderedWires]
  const content = body.length > 0 ? body.join('\n') : '    {/* Add components here */}'

  return `export default () => (\n  <board width="50mm" height="50mm">\n${content}\n  </board>\n)\n`
}

const initialWorkspaceState = loadWorkspacesFromStorage()
const initialActiveWsId = initialWorkspaceState.activeWorkspaceId
const initialWorkspace = initialWorkspaceState.workspaces[initialActiveWsId] || createDefaultWorkspace()
const initialFsMap = initialWorkspace.fsMap
const initialCanvas = getCanvasStateForFile(initialWorkspace.activeFilePath || SCHEMATIC_MAIN_PATH, initialFsMap)

export const useEditorStore = create<EditorStore>((set, get) => ({
  // Initial state - load from localStorage
  fsMap: initialFsMap,
  activeFilePath: initialWorkspace.activeFilePath || SCHEMATIC_MAIN_PATH,
  breadcrumbStack: [],
  selectedComponentIds: [],
  codeViewTab: 'source',
  exportPreview: null,
  placedComponents: initialCanvas.components,
  wires: initialCanvas.wires,
  wiringStart: null,
  cursorNearPin: null,
  subcircuitCreation: {
    active: false,
    componentIds: [],
    candidatePins: [],
    selectedPins: []
  },
  copiedSelection: null,
  pasteCount: 0,
  viewport: {
    x: 0,
    y: 0,
    zoom: 1
  },
  // Workspace model
  workspaces: initialWorkspaceState.workspaces,
  activeWorkspaceId: initialActiveWsId,
  openFilePaths: initialWorkspace.openFilePaths || [SCHEMATIC_MAIN_PATH],
  // Undo/redo stacks
  undoStack: [],
  redoStack: [],

  // Actions
  setFSMap: (fsMap) => {
    const next = regenerateSubcircuitIndex(ensureFsMapDefaults(fsMap))
    const state = get()
    const normalizedFiles = normalizeWorkspaceFileSelection(next, state.activeFilePath, state.openFilePaths)
    const parsed = getCanvasStateForFile(normalizedFiles.activeFilePath, next)
    const withSnapshot = isCanvasEditableFilePath(normalizedFiles.activeFilePath)
      ? writePersistedCanvasGraphState(next, normalizedFiles.activeFilePath, parsed.components, parsed.wires)
      : next
    const nextWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        fsMap: withSnapshot,
        activeFilePath: normalizedFiles.activeFilePath,
        openFilePaths: normalizedFiles.openFilePaths
      }
    }
    saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)
    set({
      fsMap: withSnapshot,
      workspaces: nextWorkspaces,
      activeFilePath: normalizedFiles.activeFilePath,
      openFilePaths: normalizedFiles.openFilePaths,
      placedComponents: parsed.components,
      wires: parsed.wires,
      selectedComponentIds: []
    })
  },

  setActiveFilePath: (filePath) => {
    const state = get()
    if (filePath === state.activeFilePath) return

    get().regenerateTSX()

    let fsMap = { ...state.fsMap }
    if (!fsMap[filePath]) {
      if (filePath.startsWith('subcircuits/')) {
        const name = filePath.replace('subcircuits/', '').replace('.tsx', '')
        fsMap[filePath] = buildSubcircuitModule(name, '')
      } else if (filePath.startsWith('symbols/')) {
        const name = filePath.replace('symbols/', '').replace('.tsx', '')
        fsMap[filePath] = buildSymbolModule(name, '')
      } else if (isSchematicFilePath(filePath)) {
        fsMap[filePath] = buildBoardModule('')
      }

      fsMap = regenerateSubcircuitIndex(fsMap)
      saveFSMapToStorage(fsMap)
    }

    if (!fsMap[filePath]) {
      return
    }

    const nextOpenFilePaths = state.openFilePaths.includes(filePath)
      ? state.openFilePaths
      : [...state.openFilePaths, filePath]
    const normalizedFiles = normalizeWorkspaceFileSelection(fsMap, filePath, nextOpenFilePaths)
    const parsed = getCanvasStateForFile(normalizedFiles.activeFilePath, fsMap)
    const nextFsMap = isCanvasEditableFilePath(normalizedFiles.activeFilePath)
      ? writePersistedCanvasGraphState(fsMap, normalizedFiles.activeFilePath, parsed.components, parsed.wires)
      : fsMap
    const renormalizedFiles = normalizeWorkspaceFileSelection(nextFsMap, normalizedFiles.activeFilePath, normalizedFiles.openFilePaths)
    const nextWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        fsMap: nextFsMap,
        activeFilePath: renormalizedFiles.activeFilePath,
        openFilePaths: renormalizedFiles.openFilePaths
      }
    }
    saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)
    set({
      fsMap: nextFsMap,
      activeFilePath: renormalizedFiles.activeFilePath,
      openFilePaths: renormalizedFiles.openFilePaths,
      workspaces: nextWorkspaces,
      placedComponents: parsed.components,
      wires: parsed.wires,
      selectedComponentIds: [],
      wiringStart: null,
      cursorNearPin: null
    })
  },

  openSubcircuitEditor: (name) => {
    const state = get()
    const safe = toSafeIdentifier(name)
    const registry = buildSubcircuitRegistry(state.fsMap)
    const filePath = registry[name]?.filePath || `subcircuits/${safe}.tsx`

    if (state.activeFilePath === filePath) return

    get().regenerateTSX()

    let fsMap = { ...state.fsMap }
    if (!fsMap[filePath]) {
      fsMap[filePath] = buildSubcircuitModule(safe, '', 'export const ports = [] as const')
      fsMap = regenerateSubcircuitIndex(fsMap)
      saveFSMapToStorage(fsMap)
    }

    const parsed = getCanvasStateForFile(filePath, fsMap)
    const fsMapWithSnapshot = writePersistedCanvasGraphState(fsMap, filePath, parsed.components, parsed.wires)
    set({
      fsMap: fsMapWithSnapshot,
      activeFilePath: filePath,
      breadcrumbStack: [...state.breadcrumbStack, state.activeFilePath],
      placedComponents: parsed.components,
      wires: parsed.wires,
      selectedComponentIds: [],
      wiringStart: null,
      cursorNearPin: null
    })
  },

  insertSubcircuitInstance: (name, options) => {
    const state = get()
    const registry = buildSubcircuitRegistry(state.fsMap)
    const subcircuit = registry[name]

    if (!subcircuit) {
      const message = `Subcircuit "${name}" is not a valid reusable block yet.`
      if (typeof window !== 'undefined') {
        window.alert(message)
      } else {
        console.warn(message)
      }
      return
    }

    if (!isSchematicFilePath(state.activeFilePath)) {
      get().setActiveFilePath(subcircuit.filePath)
      return
    }

    const existingNames = new Set(state.placedComponents.map(component => component.name))
    let suffix = 1
    let uniqueName = `${name}${suffix}`
    while (existingNames.has(uniqueName)) {
      suffix += 1
      uniqueName = `${name}${suffix}`
    }

    const fallbackPosition = getDefaultImportPosition(state.placedComponents.length)
    const schX = options?.schX ?? fallbackPosition.schX
    const schY = options?.schY ?? fallbackPosition.schY

    get().addPlacedComponent({
      id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      catalogId: 'subcircuit-instance',
      name: uniqueName,
      props: {
        subcircuitName: name,
        subcircuitPath: options?.filePath || subcircuit.filePath,
        ports: subcircuit.ports,
        schX,
        schY
      },
      tsxSnippet: `<${name} name="${uniqueName}" schX={${schX}} schY={${schY}} />`
    })

    set({ selectedComponentIds: [] })
  },

  applyPatch: (patch) => {
    const state = get()
    if (!isSchematicFilePath(state.activeFilePath)) {
      throw new Error('Patches can only be applied to a schematic board file.')
    }

    const registry = buildSubcircuitRegistry(state.fsMap)
    const existingNames = new Set(state.placedComponents.map(component => component.name))
    const aliasToInstance = new Map<string, string>()
    const addedComponents: PlacedComponent[] = []
    const offsetX = Number(patch.layout?.offsetX || 0)
    const offsetY = Number(patch.layout?.offsetY || 0)

    patch.components.forEach((component, index) => {
      const spec = normalizePatchComponentSpec(component, index)
      if (!spec.subcircuit) {
        throw new Error(`Invalid patch component at index ${index}`)
      }

      const subcircuit = registry[spec.subcircuit]
      if (!subcircuit) {
        throw new Error(`Missing subcircuit: ${spec.subcircuit}`)
      }

      let instanceName = spec.instanceName?.trim() || `${spec.subcircuit}${index + 1}`
      while (existingNames.has(instanceName)) {
        instanceName = `${instanceName}_${existingNames.size}`
      }
      existingNames.add(instanceName)
      aliasToInstance.set(spec.subcircuit, instanceName)
      aliasToInstance.set(instanceName, instanceName)

      const fallbackPosition = getDefaultImportPosition(state.placedComponents.length + index)
      const schX = (spec.schX ?? fallbackPosition.schX) + offsetX
      const schY = (spec.schY ?? fallbackPosition.schY) + offsetY

      addedComponents.push({
        id: `patch-${patch.id}-${Date.now()}-${index}`,
        catalogId: 'subcircuit-instance',
        name: instanceName,
        props: {
          ...(spec.props || {}),
          name: instanceName,
          subcircuitName: spec.subcircuit,
          subcircuitPath: subcircuit.filePath,
          ports: subcircuit.ports,
          schX,
          schY
        },
        tsxSnippet: `<${spec.subcircuit} name="${instanceName}" schX={${schX}} schY={${schY}} />`
      })
    })

    const allComponents = [...state.placedComponents, ...addedComponents]
    const nameToId = new Map(allComponents.map(component => [component.name, component.id]))
    const componentPorts = new Map(allComponents.map(component => [component.name, new Set(((component.props.ports as string[] | undefined) || []).map(String))]))

    const addedWires: WireConnection[] = patch.wiring.flatMap((wireSpec, index) => {
      const parsedSpec = parsePatchWireSpec(wireSpec)
      if (!parsedSpec) {
        throw new Error(`Invalid patch wire at index ${index}`)
      }

      const fromRef = parseComponentRef(parsedSpec.from)
      const toRef = parseComponentRef(parsedSpec.to)
      if (!fromRef || !toRef) {
        throw new Error(`Patch wire endpoints must use component.pin format: ${parsedSpec.from} -> ${parsedSpec.to}`)
      }

      const fromComponentName = aliasToInstance.get(fromRef.componentName) || fromRef.componentName
      const toComponentName = aliasToInstance.get(toRef.componentName) || toRef.componentName
      const fromId = nameToId.get(fromComponentName)
      const toId = nameToId.get(toComponentName)
      if (!fromId || !toId) {
        throw new Error(`Patch wiring references missing instance: ${parsedSpec.from} -> ${parsedSpec.to}`)
      }

      const fromPorts = componentPorts.get(fromComponentName)
      const toPorts = componentPorts.get(toComponentName)
      if (fromPorts && fromPorts.size > 0 && !fromPorts.has(fromRef.pinName)) {
        throw new Error(`Invalid patch wiring pin: ${fromComponentName}.${fromRef.pinName}`)
      }
      if (toPorts && toPorts.size > 0 && !toPorts.has(toRef.pinName)) {
        throw new Error(`Invalid patch wiring pin: ${toComponentName}.${toRef.pinName}`)
      }

      return [{
        id: `patch-wire-${patch.id}-${Date.now()}-${index}`,
        from: { componentId: fromId, pinName: fromRef.pinName },
        to: { componentId: toId, pinName: toRef.pinName },
        tsxSnippet: ''
      }]
    })

    const wires = [...state.wires, ...addedWires]
    const persisted = buildPersistedCanvasState(state, {
      placedComponents: allComponents,
      wires
    })
    saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)

    set({
      placedComponents: allComponents,
      wires,
      selectedComponentIds: addedComponents.map(component => component.id),
      wiringStart: null,
      cursorNearPin: null,
      exportPreview: null,
      fsMap: persisted.fsMap,
      workspaces: persisted.workspaces
    })
  },

  goBackFile: () => {
    const state = get()
    if (state.breadcrumbStack.length === 0) return

    get().regenerateTSX()

    const previous = state.breadcrumbStack[state.breadcrumbStack.length - 1]
    const nextStack = state.breadcrumbStack.slice(0, -1)
    const parsed = getCanvasStateForFile(previous, state.fsMap)

    set({
      activeFilePath: previous,
      breadcrumbStack: nextStack,
      placedComponents: parsed.components,
      wires: parsed.wires,
      selectedComponentIds: [],
      wiringStart: null,
      cursorNearPin: null
    })
  },

  updateFile: (filePath, content) => set((state) => {
    const nextFsMapBase = { ...state.fsMap }
    const targetFilePath = getCanonicalFilePathForContent(filePath, content, nextFsMapBase, {
      preserveRequestedPath: true
    })

    delete nextFsMapBase[filePath]
    nextFsMapBase[targetFilePath] = content

    const newFsMap = regenerateSubcircuitIndex(ensureFsMapDefaults(nextFsMapBase))
    const normalizedFiles = normalizeWorkspaceFileSelection(
      newFsMap,
      state.activeFilePath === filePath ? targetFilePath : state.activeFilePath,
      state.openFilePaths.map(path => path === filePath ? targetFilePath : path)
    )
    const parsed = getCanvasStateForFile(normalizedFiles.activeFilePath, newFsMap)

    const nextWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        fsMap: newFsMap,
        activeFilePath: normalizedFiles.activeFilePath,
        openFilePaths: normalizedFiles.openFilePaths
      }
    }

    saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)
    return {
      fsMap: newFsMap,
      workspaces: nextWorkspaces,
      activeFilePath: normalizedFiles.activeFilePath,
      openFilePaths: normalizedFiles.openFilePaths,
      placedComponents: parsed.components,
      wires: parsed.wires
    }
  }),

  addPlacedComponent: (component) => set((state) => {
    const placedComponents = [...state.placedComponents, component]
    const persisted = buildPersistedCanvasState(state, { placedComponents })
    saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)
    return {
      placedComponents,
      fsMap: persisted.fsMap,
      workspaces: persisted.workspaces
    }
  }),

  updatePlacedComponent: (id, updates) => set((state) => {
    const placedComponents = state.placedComponents.map((component) => {
      if (component.id !== id) return component

      const mergedProps = updates.props
        ? { ...component.props, ...updates.props }
        : component.props

      return {
        ...component,
        ...updates,
        props: mergedProps
      }
    })
    const wires = clearWireRoutes(state.wires, new Set([id]))

    const updatedComp = placedComponents.find(c => c.id === id)
    let fsMap = state.fsMap
    if (
      updatedComp?.catalogId === 'netport' &&
      updates.props?.schX !== undefined &&
      updates.props?.schY !== undefined
    ) {
      const netName = String(updatedComp.props.netName || updatedComp.name || '').trim()
      if (netName) {
        const meta = loadEditorMeta(state.fsMap)
        const nextMeta = setNetAnchor(meta, state.activeFilePath, netName, {
          schX: updates.props.schX,
          schY: updates.props.schY
        })
        if (NETPORT_DEBUG()) console.log('[netport:saved-to-meta]', { netName, schX: updates.props.schX, schY: updates.props.schY })
        fsMap = saveEditorMeta(state.fsMap, nextMeta)
      }
    }

    const persisted = buildPersistedCanvasState(state, { placedComponents, wires, fsMap })
    saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)
    return {
      placedComponents,
      wires,
      fsMap: persisted.fsMap,
      workspaces: persisted.workspaces
    }
  }),

  rotateSelectedComponents: () => {
    const state = get()
    if (state.selectedComponentIds.length === 0) return

    const selectedSet = new Set(state.selectedComponentIds)
    const nextComponents = state.placedComponents.map((component) => {
      if (!selectedSet.has(component.id)) return component

      const rawRotation = String(component.props.schRotation || '0deg').trim()
      const parsed = Number(rawRotation.replace(/deg$/, ''))
      const current = Number.isFinite(parsed) ? parsed : 0
      const normalized = ((current % 360) + 360) % 360
      const nextRotation = (normalized + 90) % 360

      return {
        ...component,
        props: {
          ...component.props,
          schRotation: `${nextRotation}deg`
        }
      }
    })

    const wires = clearWireRoutes(state.wires, selectedSet)
    const persisted = buildPersistedCanvasState(state, { placedComponents: nextComponents, wires })
    saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)
    set({
      placedComponents: nextComponents,
      wires,
      fsMap: persisted.fsMap,
      workspaces: persisted.workspaces
    })
  },

  removePlacedComponent: (id) => set((state) => {
    const placedComponents = state.placedComponents.filter((comp) => comp.id !== id)
    const wires = state.wires.filter((wire) => wire.from.componentId !== id && wire.to.componentId !== id)
    const selectedComponentIds = state.selectedComponentIds.filter(selectedId => selectedId !== id)
    const persisted = buildPersistedCanvasState(state, { placedComponents, wires })
    saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)
    return {
      placedComponents,
      wires,
      selectedComponentIds,
      fsMap: persisted.fsMap,
      workspaces: persisted.workspaces
    }
  }),

  removeSelectedComponents: () => {
    const state = get()
    let newComponents = state.placedComponents
    let newWires = state.wires

    // Remove all selected components
    for (const id of state.selectedComponentIds) {
      newComponents = newComponents.filter(comp => comp.id !== id)
      newWires = newWires.filter(w => 
        w.from.componentId !== id && w.to.componentId !== id
      )
    }

    const persisted = buildPersistedCanvasState(state, {
      placedComponents: newComponents,
      wires: newWires
    })
    saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)

    set({ 
      placedComponents: newComponents,
      wires: newWires,
      selectedComponentIds: [],
      fsMap: persisted.fsMap,
      workspaces: persisted.workspaces
    })
  },

  setSelectedComponents: (ids) => set({ selectedComponentIds: ids }),

  toggleComponentSelection: (id) => set((state) => {
    const isSelected = state.selectedComponentIds.includes(id)
    if (isSelected) {
      return { selectedComponentIds: state.selectedComponentIds.filter(selectedId => selectedId !== id) }
    } else {
      return { selectedComponentIds: [...state.selectedComponentIds, id] }
    }
  }),

  copySelectedComponents: () => {
    const state = get()
    if (state.selectedComponentIds.length === 0) return

    const selectedSet = new Set(state.selectedComponentIds)
    const components = state.placedComponents
      .filter(component => selectedSet.has(component.id))
      .map(component => ({
        ...component,
        props: { ...component.props }
      }))

    const wires = state.wires
      .filter(wire => selectedSet.has(wire.from.componentId) && selectedSet.has(wire.to.componentId))
      .map(wire => ({
        ...wire,
        from: { ...wire.from },
        to: { ...wire.to }
      }))

    set({ copiedSelection: { components, wires } })
  },

  pasteCopiedComponents: () => {
    const state = get()
    if (!state.copiedSelection || state.copiedSelection.components.length === 0) return

    const nextPasteCount = state.pasteCount + 1
    const offset = nextPasteCount * 8
    const usedNames = new Set(state.placedComponents.map(component => component.name))
    const idMap = new Map<string, string>()
    const now = Date.now()

    const pastedComponents: PlacedComponent[] = state.copiedSelection.components.map((component, index) => {
      const newId = `comp-paste-${now}-${index}-${Math.random().toString(36).slice(2, 7)}`
      idMap.set(component.id, newId)

      let nextName = component.name
      if (component.catalogId !== 'net' && usedNames.has(nextName)) {
        let i = 1
        while (usedNames.has(`${component.name}_${i}`)) {
          i += 1
        }
        nextName = `${component.name}_${i}`
      }
      usedNames.add(nextName)

      return {
        ...component,
        id: newId,
        name: nextName,
        props: {
          ...component.props,
          schX: Number(component.props.schX || 0) + offset,
          schY: Number(component.props.schY || 0) + offset
        }
      }
    })

    const pastedWires: WireConnection[] = state.copiedSelection.wires
      .map((wire, index) => {
        const nextFromId = idMap.get(wire.from.componentId)
        const nextToId = idMap.get(wire.to.componentId)
        if (!nextFromId || !nextToId) return null

        return {
          ...wire,
          id: `wire-paste-${now}-${index}-${Math.random().toString(36).slice(2, 7)}`,
          from: {
            componentId: nextFromId,
            pinName: wire.from.pinName
          },
          to: {
            componentId: nextToId,
            pinName: wire.to.pinName
          }
        }
      })
      .filter((wire): wire is WireConnection => wire !== null)

    const placedComponents = [...state.placedComponents, ...pastedComponents]
    const wires = [...state.wires, ...pastedWires]
    const persisted = buildPersistedCanvasState(state, { placedComponents, wires })
    saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)

    set({
      placedComponents,
      wires,
      selectedComponentIds: pastedComponents.map(component => component.id),
      pasteCount: nextPasteCount,
      fsMap: persisted.fsMap,
      workspaces: persisted.workspaces
    })
  },

  setViewport: (viewport) => set((state) => ({
    viewport: { ...state.viewport, ...viewport }
  })),

  setCursorNearPin: (info) => set({ cursorNearPin: info }),

  startWiring: (componentId, pinName) => set({
    wiringStart: { componentId, pinName }
  }),

  completeWiring: (componentId, pinName) => {
    const state = get()
    if (!state.wiringStart) return

    const fromComp = state.placedComponents.find(c => c.id === state.wiringStart!.componentId)
    const toComp = state.placedComponents.find(c => c.id === componentId)

    if (!fromComp || !toComp) return

    const newWire: WireConnection = {
      id: `wire-${Date.now()}`,
      from: {
        componentId: state.wiringStart.componentId,
        pinName: state.wiringStart.pinName
      },
      to: {
        componentId,
        pinName
      },
      tsxSnippet: `<trace from=".${fromComp.name} > .${state.wiringStart.pinName}" to=".${toComp.name} > .${pinName}" />`
    }

    set((state) => {
      const wires = clearWireRoutes([...state.wires, newWire])
      const persisted = buildPersistedCanvasState(state, { wires })
      saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)
      return {
        wires,
        wiringStart: null,
        fsMap: persisted.fsMap,
        workspaces: persisted.workspaces
      }
    })
  },

  cancelWiring: () => set({ wiringStart: null }),

  removeWire: (wireId) => set((state) => {
    const orphanedNetports = getOrphanedNetportsAfterRemovingWires(
      state.placedComponents,
      state.wires,
      new Set([wireId])
    )

    if (orphanedNetports.length > 0) {
      const label = orphanedNetports.join(', ')
      const shouldContinue = window.confirm(
        `Removing this wire disconnects net anchor(s): ${label}. Continue?`
      )
      if (!shouldContinue) {
        return state
      }
    }

    const wires = state.wires.filter(w => w.id !== wireId)
    const persisted = buildPersistedCanvasState(state, { wires })
    saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)
    return {
      wires,
      fsMap: persisted.fsMap,
      workspaces: persisted.workspaces
    }
  }),

  disconnectPin: (componentId, pinName) => set((state) => {
    const removedWireIds = new Set(
      state.wires
        .filter(w =>
          (w.from.componentId === componentId && w.from.pinName === pinName) ||
          (w.to.componentId === componentId && w.to.pinName === pinName)
        )
        .map(w => w.id)
    )

    const orphanedNetports = getOrphanedNetportsAfterRemovingWires(
      state.placedComponents,
      state.wires,
      removedWireIds
    )

    if (orphanedNetports.length > 0) {
      const label = orphanedNetports.join(', ')
      const shouldContinue = window.confirm(
        `Disconnecting this pin removes the last wire for net anchor(s): ${label}. Continue?`
      )
      if (!shouldContinue) {
        return state
      }
    }

    const wires = state.wires.filter(w => !removedWireIds.has(w.id))
    const persisted = buildPersistedCanvasState(state, { wires })
    saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)
    return {
      wires,
      fsMap: persisted.fsMap,
      workspaces: persisted.workspaces
    }
  }),

  beginSubcircuitPinSelection: (componentIds) => {
    const state = get()
    const selectedSet = new Set(componentIds)
    const candidatePins: SelectedPinRef[] = []
    const seen = new Set<string>()
    const boundaryPins = new Set<string>()

    state.wires.forEach((wire) => {
      const fromInside = selectedSet.has(wire.from.componentId)
      const toInside = selectedSet.has(wire.to.componentId)
      if (fromInside === toInside) return

      const endpoint = fromInside ? wire.from : wire.to
      const key = `${endpoint.componentId}:${endpoint.pinName}`
      boundaryPins.add(key)
      if (seen.has(key)) return
      seen.add(key)

      candidatePins.push({
        componentId: endpoint.componentId,
        pinName: endpoint.pinName
      })
    })

    state.placedComponents
      .filter(component => selectedSet.has(component.id))
      .forEach((component) => {
        getSelectablePinsForComponent(component).forEach((pinName) => {
          const key = `${component.id}:${pinName}`
          if (seen.has(key)) return
          seen.add(key)

          candidatePins.push({
            componentId: component.id,
            pinName
          })
        })
      })

    candidatePins.sort((a, b) => {
      const aKey = `${a.componentId}:${a.pinName}`
      const bKey = `${b.componentId}:${b.pinName}`
      const aBoundary = boundaryPins.has(aKey) ? 0 : 1
      const bBoundary = boundaryPins.has(bKey) ? 0 : 1
      if (aBoundary !== bBoundary) return aBoundary - bBoundary
      return aKey.localeCompare(bKey)
    })

    set({
      subcircuitCreation: {
        active: true,
        componentIds,
        candidatePins,
        selectedPins: []
      }
    })
  },

  toggleSubcircuitPinSelection: (componentId, pinName) => {
    const state = get()
    if (!state.subcircuitCreation.active) return

    const key = `${componentId}:${pinName}`
    const isCandidate = state.subcircuitCreation.candidatePins.some(
      pin => `${pin.componentId}:${pin.pinName}` === key
    )
    if (!isCandidate) return

    const alreadySelected = state.subcircuitCreation.selectedPins.some(
      pin => `${pin.componentId}:${pin.pinName}` === key
    )

    const selectedPins = alreadySelected
      ? state.subcircuitCreation.selectedPins.filter(pin => `${pin.componentId}:${pin.pinName}` !== key)
      : [...state.subcircuitCreation.selectedPins, { componentId, pinName }]

    set({
      subcircuitCreation: {
        ...state.subcircuitCreation,
        selectedPins
      }
    })
  },

  cancelSubcircuitPinSelection: () => set({
    subcircuitCreation: {
      active: false,
      componentIds: [],
      candidatePins: [],
      selectedPins: []
    }
  }),

  exposeSubcircuitPort: (componentId, pinName, portName) => {
    const state = get()
    if (!state.activeFilePath.startsWith('subcircuits/')) return

    const sanitizedPort = portName.trim().replace(/[^A-Za-z0-9_]/g, '_')
    if (!sanitizedPort) return

    const sourceComponent = state.placedComponents.find(component => component.id === componentId)
    if (!sourceComponent || sourceComponent.catalogId === 'netport' || sourceComponent.catalogId === 'public-port' || sourceComponent.catalogId === 'subcircuit-instance') {
      return
    }

    const nextComponents = [...state.placedComponents]
    const netRegistry = buildNetRegistryFromComponents(nextComponents)
    const netId = netRegistry.getNetId(sanitizedPort)
    const canonicalName = netRegistry.getNetName(netId) || sanitizedPort

    let publicPortComponent = nextComponents.find(
      component => component.catalogId === 'public-port' && (
        component.props.publicPortName === canonicalName ||
        component.name === canonicalName
      )
    )

    if (!publicPortComponent) {
      publicPortComponent = {
        id: `net-${Date.now()}-${netId}`,
        catalogId: 'public-port',
        name: canonicalName,
        props: {
          publicPortName: canonicalName,
          schX: (sourceComponent.props.schX || 0) + 24,
          schY: sourceComponent.props.schY || 0
        },
        tsxSnippet: ''
      }
      nextComponents.push(publicPortComponent)
    } else {
      publicPortComponent = {
        ...publicPortComponent,
        props: {
          ...publicPortComponent.props,
          publicPortName: canonicalName
        }
      }
      const existingIndex = nextComponents.findIndex(component => component.id === publicPortComponent!.id)
      if (existingIndex >= 0) {
        nextComponents[existingIndex] = publicPortComponent
      }
    }

    const alreadyConnected = state.wires.some(wire => (
      wire.from.componentId === componentId &&
      wire.from.pinName === pinName &&
      wire.to.componentId === publicPortComponent!.id
    ) || (
      wire.to.componentId === componentId &&
      wire.to.pinName === pinName &&
      wire.from.componentId === publicPortComponent!.id
    ))

    if (alreadyConnected) return

    const nextWires = [
      ...state.wires,
      {
        id: `wire-port-${Date.now()}`,
        from: { componentId, pinName },
        to: { componentId: publicPortComponent.id, pinName: 'port' },
        tsxSnippet: ''
      }
    ]

    const persisted = buildPersistedCanvasState(state, {
      placedComponents: nextComponents,
      wires: nextWires
    })
    saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)

    set({
      placedComponents: nextComponents,
      wires: nextWires,
      selectedComponentIds: [componentId],
      fsMap: persisted.fsMap,
      workspaces: persisted.workspaces
    })
  },

  createSubcircuit: (name, componentIds, exposedPorts) => {
    const state = get()
    const safeName = toSafeIdentifier(name)
    if (!safeName || componentIds.length === 0) return

    const selectedSet = new Set(componentIds)
    const selectedComponents = state.placedComponents.filter(c => selectedSet.has(c.id) && c.catalogId !== 'netport')
    if (selectedComponents.length === 0) return

    const minX = Math.min(...selectedComponents.map(c => c.props.schX || 0))
    const minY = Math.min(...selectedComponents.map(c => c.props.schY || 0))

    const validBoundary = new Set<string>()
    state.wires.forEach(wire => {
      const fromInside = selectedSet.has(wire.from.componentId)
      const toInside = selectedSet.has(wire.to.componentId)
      if (fromInside !== toInside) {
        if (fromInside) validBoundary.add(`${wire.from.componentId}:${wire.from.pinName}`)
        if (toInside) validBoundary.add(`${wire.to.componentId}:${wire.to.pinName}`)
      }
    })

    const chosenPorts = exposedPorts
      .map(port => ({
        ...port,
        portName: port.portName.trim().replace(/[^A-Za-z0-9_]/g, '_')
      }))
      .filter(port => port.portName.length > 0)

    const boundaryToPort = new Map<string, string>()
    chosenPorts.forEach(port => {
      boundaryToPort.set(`${port.componentId}:${port.pinName}`, port.portName)
    })

    const subComponents: PlacedComponent[] = selectedComponents.map(component => ({
      ...component,
      props: {
        ...component.props,
        schX: (component.props.schX || 0) - minX,
        schY: (component.props.schY || 0) - minY
      }
    }))

    const internalWires = state.wires
      .filter(wire => selectedSet.has(wire.from.componentId) && selectedSet.has(wire.to.componentId))
      .map(wire => ({ ...wire }))

    const subNetRegistry = buildNetRegistryFromComponents(subComponents)
    const netIdToComponentId = new Map<string, string>()
    const portNameToNetId = new Map<string, string>()
    chosenPorts.forEach((port, index) => {
      const netId = subNetRegistry.getNetId(port.portName)
      const canonicalName = subNetRegistry.getNetName(netId) || port.portName
      portNameToNetId.set(port.portName, netId)

      if (netIdToComponentId.has(netId)) return

      const source = subComponents.find(c => c.id === port.componentId)
      const componentId = `net-${safeName}-${netId}`
      netIdToComponentId.set(netId, componentId)
      subComponents.push({
        id: componentId,
        catalogId: 'public-port',
        name: canonicalName,
        props: {
          publicPortName: canonicalName,
          schX: (source?.props.schX || 0) + 24,
          schY: (source?.props.schY || 0) + index * 12
        },
        tsxSnippet: ''
      })
    })

    chosenPorts.forEach((port, index) => {
      const netId = portNameToNetId.get(port.portName)
      const netComponentId = netId ? netIdToComponentId.get(netId) : undefined
      if (!netComponentId) return
      internalWires.push({
        id: `wire-port-${Date.now()}-${index}`,
        from: { componentId: port.componentId, pinName: port.pinName },
        to: { componentId: netComponentId, pinName: 'port' },
        tsxSnippet: ''
      })
    })

    const portList = [...new Set(chosenPorts.map(port => port.portName))]
    const subPath = `subcircuits/${safeName}.tsx`
    const subContent = generateFileTSX(subPath, subComponents, internalWires)
    const portsConst = `export const ports = [${portList.map(port => `"${port}"`).join(', ')}] as const\n\n`
    const subContentWithPorts = subContent.includes('export const ports =')
      ? subContent
      : `${portsConst}${subContent}`

    let nextFsMap = regenerateSubcircuitIndex({
      ...state.fsMap,
      [subPath]: subContentWithPorts
    })

    const boundaryWires = state.wires.filter(wire => {
      const fromInside = selectedSet.has(wire.from.componentId)
      const toInside = selectedSet.has(wire.to.componentId)
      return fromInside !== toInside
    })

    const instanceName = toUniqueName(safeName, state.placedComponents.map(c => c.name))
    const instanceId = `sub-${Date.now()}`

    const instance: PlacedComponent = {
      id: instanceId,
      catalogId: 'subcircuit-instance',
      name: instanceName,
      props: {
        subcircuitName: safeName,
        ports: portList,
        schX: minX,
        schY: minY
      },
      tsxSnippet: ''
    }

    const remainingComponents = state.placedComponents.filter(component => !selectedSet.has(component.id))
    const remainingWires = state.wires.filter(wire => !selectedSet.has(wire.from.componentId) && !selectedSet.has(wire.to.componentId))

    const rewiredBoundary: WireConnection[] = []
    boundaryWires.forEach((wire, index) => {
      const fromInside = selectedSet.has(wire.from.componentId)
      const insideEndpoint = fromInside ? wire.from : wire.to
      const outsideEndpoint = fromInside ? wire.to : wire.from
      const key = `${insideEndpoint.componentId}:${insideEndpoint.pinName}`
      const portName = boundaryToPort.get(key)
      if (!portName) return

      rewiredBoundary.push({
        id: `wire-rewire-${Date.now()}-${index}`,
        from: {
          componentId: outsideEndpoint.componentId,
          pinName: outsideEndpoint.pinName
        },
        to: {
          componentId: instanceId,
          pinName: portName
        },
        tsxSnippet: ''
      })
    })

    const nextComponents = [...remainingComponents, instance]
    const nextWires = [...remainingWires, ...rewiredBoundary]

    const newActiveContent = generateFileTSX(state.activeFilePath, nextComponents, nextWires)
    nextFsMap = regenerateSubcircuitIndex({
      ...nextFsMap,
      [state.activeFilePath]: newActiveContent
    })

    const normalizedFiles = normalizeWorkspaceFileSelection(
      nextFsMap,
      state.activeFilePath,
      state.openFilePaths.includes(subPath)
        ? state.openFilePaths
        : [...state.openFilePaths, subPath]
    )
    const nextWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        fsMap: nextFsMap,
        activeFilePath: normalizedFiles.activeFilePath,
        openFilePaths: normalizedFiles.openFilePaths
      }
    }
    saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)

    set({
      fsMap: nextFsMap,
      workspaces: nextWorkspaces,
      openFilePaths: normalizedFiles.openFilePaths,
      placedComponents: nextComponents,
      wires: nextWires,
      selectedComponentIds: [],
      subcircuitCreation: {
        active: false,
        componentIds: [],
        candidatePins: [],
        selectedPins: []
      }
    })
  },

  generateFlatCircuitTSX: () => {
    const state = get()
    const syncedFiles: FSMap = { ...state.fsMap }
    const rootPath = getBoardEntrypointPath(
      syncedFiles,
      isSchematicFilePath(state.activeFilePath) ? state.activeFilePath : undefined
    )

    if (isCanvasEditableFilePath(state.activeFilePath)) {
      syncedFiles[state.activeFilePath] = generateFileTSX(state.activeFilePath, state.placedComponents, state.wires)
    }

    Object.keys(syncedFiles)
      .filter(path => isSchematicFilePath(path) || (path.startsWith('subcircuits/') && path.endsWith('.tsx')))
      .forEach((path) => {
        const parsed = getCanvasStateForFile(path, syncedFiles)
        const selectorErrors = validateWireSelectorsForExport(path, parsed.components, parsed.wires)
        if (selectorErrors.length > 0) {
          throw new Error(`Invalid trace selector(s) found before export:\n${selectorErrors.join('\n')}`)
        }
        const generated = generateFileTSX(path, parsed.components, parsed.wires)
        syncedFiles[path] = generated
        const withSnapshot = writePersistedCanvasGraphState(syncedFiles, path, parsed.components, parsed.wires)
        Object.assign(syncedFiles, withSnapshot)
      })

    const files = regenerateSubcircuitIndex(syncedFiles)
    return generateFlatMainTSX(files, rootPath)
  },

  generateProjectStructure: () => {
    const state = get()
    const syncedFiles: FSMap = { ...state.fsMap }

    if (isCanvasEditableFilePath(state.activeFilePath)) {
      syncedFiles[state.activeFilePath] = generateFileTSX(state.activeFilePath, state.placedComponents, state.wires)
    }

    Object.keys(syncedFiles)
      .filter(path => isSchematicFilePath(path) || (path.startsWith('subcircuits/') && path.endsWith('.tsx')))
      .forEach((path) => {
        const parsed = getCanvasStateForFile(path, syncedFiles)
        const generated = generateFileTSX(path, parsed.components, parsed.wires)
        syncedFiles[path] = generated
        const withSnapshot = writePersistedCanvasGraphState(syncedFiles, path, parsed.components, parsed.wires)
        Object.assign(syncedFiles, withSnapshot)
      })

    const files = regenerateSubcircuitIndex(syncedFiles)
    const parentPath = (isSchematicFilePath(state.activeFilePath) && files[state.activeFilePath])
      ? state.activeFilePath
      : getBoardEntrypointPath(files)

    const parent = files[parentPath] || ''
    const children = Object.fromEntries(
      Object.entries(files).filter(([path]) => path !== parentPath)
    )

    return {
      parent,
      children
    }
  },

  generateParentChildrenStructure: () => {
    const structure = get().generateProjectStructure()

    return {
      parent: structure.parent,
      children: structure.children
    }
  },

  importTSXIntoActiveFile: (content) => {
    const state = get()
    const standaloneImport = detectStandaloneImport(content)

    const preserveRequestedPath =
      !standaloneImport ||
      (standaloneImport.kind === 'board' && isSchematicFilePath(state.activeFilePath)) ||
      (standaloneImport.kind === 'subcircuit' && state.activeFilePath.startsWith('subcircuits/')) ||
      (standaloneImport.kind === 'symbol-component' && state.activeFilePath.startsWith('symbols/')) ||
      (standaloneImport.kind === 'raw' && state.activeFilePath.startsWith('raw/'))

    const targetFilePath = getCanonicalFilePathForContent(
      state.activeFilePath,
      content,
      state.fsMap,
      { preserveRequestedPath }
    )

    const normalized = isCanvasEditableFilePath(targetFilePath)
      ? normalizeImportedTSXContent(content, targetFilePath)
      : content

    const nextFsMapSeed = { ...state.fsMap }
    const isSameNamedRelocation =
      targetFilePath !== state.activeFilePath &&
      getFileBaseName(targetFilePath) === getFileBaseName(state.activeFilePath)

    if (isSameNamedRelocation && nextFsMapSeed[state.activeFilePath]) {
      delete nextFsMapSeed[state.activeFilePath]
    }

    const nextFsMap = regenerateSubcircuitIndex({
      ...nextFsMapSeed,
      [targetFilePath]: normalized
    })

    const nextOpenFilePaths = state.openFilePaths.includes(targetFilePath)
      ? state.openFilePaths.map(path => (isSameNamedRelocation && path === state.activeFilePath ? targetFilePath : path))
      : [
          ...state.openFilePaths.filter(path => !(isSameNamedRelocation && path === state.activeFilePath)),
          targetFilePath
        ]

    const normalizedFiles = normalizeWorkspaceFileSelection(nextFsMap, targetFilePath, nextOpenFilePaths)
    const parsed = getCanvasStateForFile(normalizedFiles.activeFilePath, nextFsMap)
    // Keep imported TSX as-is to preserve original schematic flow.
    // Internal graph becomes source-of-truth via sidecar snapshot.
    const syncedFsMap = isCanvasEditableFilePath(normalizedFiles.activeFilePath)
      ? writePersistedCanvasGraphState(nextFsMap, normalizedFiles.activeFilePath, parsed.components, parsed.wires)
      : nextFsMap
    const nextWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        fsMap: syncedFsMap,
        activeFilePath: normalizedFiles.activeFilePath,
        openFilePaths: normalizedFiles.openFilePaths
      }
    }

    saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)

    set({
      fsMap: syncedFsMap,
      activeFilePath: normalizedFiles.activeFilePath,
      openFilePaths: normalizedFiles.openFilePaths,
      workspaces: nextWorkspaces,
      placedComponents: parsed.components,
      wires: parsed.wires,
      selectedComponentIds: [],
      wiringStart: null,
      cursorNearPin: null,
      exportPreview: null,
      codeViewTab: 'source'
    })
  },

  importFilesBatch: (files) => {
    const state = get()
    if (!Array.isArray(files) || files.length === 0) return

    let nextFsMapSeed = { ...state.fsMap }
    const nextOpenFilePaths = [...state.openFilePaths]
    const importedSchematicPaths: string[] = []
    const importedEntries: Array<{ originalPath: string; targetFilePath: string; content: string }> = []

    files.forEach(({ fileName, content }) => {
      const originalPath = fileName
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
      const requestedPath = normalizeImportedProjectPath(originalPath, content)
      const targetFilePath = getCanonicalFilePathForContent(requestedPath, content, nextFsMapSeed, {
        preserveRequestedPath: true
      })
      nextFsMapSeed[targetFilePath] = content
      importedEntries.push({ originalPath, targetFilePath, content })
    })

    const relocationMap = importedEntries.reduce<Map<string, string>>((map, entry) => {
      const normalizedOriginal = entry.originalPath.replace(/^\/+/, '')
      const stem = normalizedOriginal.replace(/\.(tsx|ts)$/i, '')
      map.set(normalizedOriginal, entry.targetFilePath)
      map.set(stem, entry.targetFilePath)
      map.set(`${stem}.tsx`, entry.targetFilePath)
      map.set(`${stem}.ts`, entry.targetFilePath)
      return map
    }, new Map<string, string>())

    importedEntries.forEach(({ originalPath, targetFilePath, content }) => {
      const rewritten = rewriteImportedWorkspacePaths(content, originalPath, targetFilePath, relocationMap)
      const sanitized = inferDetectedFileKind(targetFilePath, rewritten) === 'board'
        ? removeUnsafeImportedNetShorts(rewritten)
        : rewritten
      const normalized = isCanvasEditableFilePath(targetFilePath)
        ? normalizeImportedTSXContent(sanitized, targetFilePath)
        : sanitized

      nextFsMapSeed[targetFilePath] = normalized
      if (!nextOpenFilePaths.includes(targetFilePath)) {
        nextOpenFilePaths.push(targetFilePath)
      }
      if (inferDetectedFileKind(targetFilePath, normalized) === 'board') {
        importedSchematicPaths.push(targetFilePath)
      }
    })

    const nextFsMap = regenerateSubcircuitIndex(ensureFsMapDefaults(nextFsMapSeed))
    const brokenImports = validateImports(nextFsMap)
    if (brokenImports.length > 0) {
      console.warn('[batch-import] Missing dependencies (import as-is):', brokenImports)
    }
    const importedProject = buildImportedProjectState(nextFsMap)
    console.log('[batch-import]', {
      totalFiles: Object.keys(nextFsMap).length,
      rootFile: importedProject.rootFile,
      schematics: importedProject.entryFiles,
      subcircuits: Object.keys(importedProject.registry)
    })
    const preferredActivePath =
      (importedProject.rootFile && importedSchematicPaths.includes(importedProject.rootFile)
        ? importedProject.rootFile
        : [...importedSchematicPaths].reverse().find(path => importedProject.entryFiles.includes(path)))
      || importedProject.entryFiles.find(path => path !== SCHEMATIC_MAIN_PATH && path !== importedProject.rootFile)
      || importedProject.rootFile
      || importedProject.entryFiles[0]
      || state.activeFilePath
    const normalizedFiles = normalizeWorkspaceFileSelection(nextFsMap, preferredActivePath, nextOpenFilePaths)
    let syncedFsMapSeed = { ...nextFsMap }
    Object.keys(syncedFsMapSeed)
      .filter(path => isCanvasEditableFilePath(path))
      .forEach((path) => {
        const parsedFile = getCanvasStateForFile(path, syncedFsMapSeed)
        syncedFsMapSeed = writePersistedCanvasGraphState(syncedFsMapSeed, path, parsedFile.components, parsedFile.wires)
      })
    const syncedFsMap = regenerateSubcircuitIndex(syncedFsMapSeed)
    const parsed = getCanvasStateForFile(normalizedFiles.activeFilePath, syncedFsMap)
    const nextWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        fsMap: syncedFsMap,
        activeFilePath: normalizedFiles.activeFilePath,
        openFilePaths: normalizedFiles.openFilePaths
      }
    }

    saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)
    set({
      fsMap: syncedFsMap,
      workspaces: nextWorkspaces,
      activeFilePath: normalizedFiles.activeFilePath,
      openFilePaths: normalizedFiles.openFilePaths,
      placedComponents: parsed.components,
      wires: parsed.wires,
      selectedComponentIds: [],
      exportPreview: null,
      codeViewTab: 'source'
    })
  },

  applyLayout: async () => {
    const state = get()
    const layoutTargets = state.placedComponents.filter(c => (
      c.catalogId !== 'netport'
      && c.catalogId !== 'public-port'
      && c.catalogId !== 'net'
      && !c.props.layoutLocked
    ))
    if (layoutTargets.length === 0) return

    try {
      const { layoutCircuit } = await import('../utils/elkLayout')

      const layoutTargetIds = new Set(layoutTargets.map(component => component.id))
      const edges = state.wires
        .filter(wire => layoutTargetIds.has(wire.from.componentId) && layoutTargetIds.has(wire.to.componentId))
        .map(wire => ({
          from: { componentId: wire.from.componentId, pinName: wire.from.pinName },
          to: { componentId: wire.to.componentId, pinName: wire.to.pinName }
        }))

      const layoutResult = await layoutCircuit(layoutTargets, edges)

      const newComponents = state.placedComponents.map(comp => {
        const newPos = layoutResult.positions.get(comp.id)
        if (newPos) {
          return {
            ...comp,
            props: {
              ...comp.props,
              schX: newPos.x,
              schY: newPos.y
            }
          }
        }
        return comp
      })

      const newWires = state.wires.map((wire) => {
        if (wire.routingIntent === 'manual' || wire.routingIntent === 'bus') {
          return wire
        }
        const routePoints = layoutResult.routes.get(wire.id)
        if (!routePoints || routePoints.length < 2) {
          const { routePoints: _routePoints, ...rest } = wire
          return rest
        }

        return {
          ...wire,
          routePoints,
          routingIntent: wire.routingIntent || 'orthogonal-auto'
        }
      })

      const persisted = buildPersistedCanvasState(state, { placedComponents: newComponents, wires: newWires })
      saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)
      set({
        ...persisted,
        selectedComponentIds: state.selectedComponentIds,
        exportPreview: null,
        codeViewTab: 'source'
      })
    } catch (error) {
      console.error('Layout failed:', error)
    }
  },

  autoWireCommonNets: () => {
    const state = get()
    let nextComponents = [...state.placedComponents]
    let nextWires = clearWireRoutes(state.wires)
    let created = 0

    const ensureNetPort = (netName: string, x: number, y: number) => {
      const canonical = canonicalizeNetName(netName)
      const existing = nextComponents.find(component =>
        (component.catalogId === 'netport' || component.catalogId === 'net') &&
        canonicalizeNetName(String(component.props.netName || component.props.name || component.name || '')) === canonical
      )

      if (existing) return existing

      const netport: PlacedComponent = {
        id: `netport-auto-${canonical}-${Date.now()}-${nextComponents.length}`,
        catalogId: 'netport',
        name: canonical,
        props: {
          name: canonical,
          netName: canonical,
          schX: x,
          schY: y,
          schRotation: '0deg'
        },
        tsxSnippet: ''
      }

      nextComponents.push(netport)
      return netport
    }

    state.placedComponents.forEach((component) => {
      getAutoWireTargets(component).forEach(({ pinName, netName }) => {
        const netRole = inferNetRole(netName)
        const powerStrategy = inferPowerDistributionStrategy(netName, netRole)
        // Default policy: GND/VCC/DVDD use global labels, not giant auto buses.
        if (powerStrategy === 'global-label') {
          return
        }

        const pinAlreadyConnected = nextWires.some(wire =>
          (wire.from.componentId === component.id && wire.from.pinName === pinName) ||
          (wire.to.componentId === component.id && wire.to.pinName === pinName)
        )

        if (pinAlreadyConnected) return

        const offsetX = netName === 'GND' ? -140 : 140
        const netPort = ensureNetPort(
          netName,
          Number(component.props.schX || 0) + offsetX,
          Number(component.props.schY || 0)
        )

        nextWires.push({
          id: `wire-auto-${Date.now()}-${created}`,
          from: { componentId: component.id, pinName },
          to: { componentId: netPort.id, pinName: 'port' },
          routingIntent: 'semantic-auto'
        })
        created += 1
      })
    })

    if (created === 0) return

    const persisted = buildPersistedCanvasState(state, {
      placedComponents: nextComponents,
      wires: nextWires
    })
    saveWorkspacesToStorage(persisted.workspaces, state.activeWorkspaceId)
    set({
      ...persisted,
      exportPreview: null,
      codeViewTab: 'source'
    })
  },

  regenerateTSX: () => {
    const state = get()
    if (NETPORT_DEBUG()) {
      const netports = state.placedComponents.filter(c => c.catalogId === 'netport')
      console.log('[netport:regenerate]', state.activeFilePath, netports.map(c => ({ name: c.name, schX: c.props.schX, schY: c.props.schY })))
    }
    const nextFsMap = syncActiveCanvasFile(state)

    // Sync to active workspace and persist
    const nextWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        fsMap: nextFsMap,
        activeFilePath: state.activeFilePath,
        openFilePaths: state.openFilePaths
      }
    }
    saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)
    set({ fsMap: nextFsMap, workspaces: nextWorkspaces })
  },

  setCodeViewTab: (tab) => set({ codeViewTab: tab }),

  setExportPreview: (preview) => set({ exportPreview: preview }),
  
  // ── Undo / Redo ──────────────────────────────────────────────────────────
  pushUndoSnapshot: () => {
    const state = get()
    const snapshot = {
      components: state.placedComponents.map(c => ({ ...c, props: { ...c.props } })),
      wires: state.wires.map(w => ({ ...w, from: { ...w.from }, to: { ...w.to } }))
    }
    const undoStack = [...state.undoStack, snapshot].slice(-50)
    set({ undoStack, redoStack: [] })
  },
  
  undo: () => {
    const state = get()
    if (state.undoStack.length === 0) return
    const snapshot = state.undoStack[state.undoStack.length - 1]
    const redoSnapshot = {
      components: state.placedComponents.map(c => ({ ...c, props: { ...c.props } })),
      wires: state.wires.map(w => ({ ...w, from: { ...w.from }, to: { ...w.to } }))
    }
    set({
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, redoSnapshot],
      placedComponents: snapshot.components,
      wires: snapshot.wires,
      selectedComponentIds: []
    })
    setTimeout(() => get().regenerateTSX(), 0)
  },
  
  redo: () => {
    const state = get()
    if (state.redoStack.length === 0) return
    const snapshot = state.redoStack[state.redoStack.length - 1]
    const undoSnapshot = {
      components: state.placedComponents.map(c => ({ ...c, props: { ...c.props } })),
      wires: state.wires.map(w => ({ ...w, from: { ...w.from }, to: { ...w.to } }))
    }
    set({
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, undoSnapshot],
      placedComponents: snapshot.components,
      wires: snapshot.wires,
      selectedComponentIds: []
    })
    setTimeout(() => get().regenerateTSX(), 0)
  },
  
  // ── File Tabs ─────────────────────────────────────────────────────────────
  openFileTab: (filePath) => {
    const state = get()
    if (state.openFilePaths.includes(filePath)) return
    const openFilePaths = [...state.openFilePaths, filePath]
    const nextWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        openFilePaths
      }
    }
    saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)
    set({ openFilePaths, workspaces: nextWorkspaces })
  },
  
  closeFileTab: (filePath) => {
    const state = get()
    const next = state.openFilePaths.filter(p => p !== filePath)
    if (next.length === 0) return // keep at least one tab
    const newActive = state.activeFilePath === filePath
      ? next[Math.max(0, state.openFilePaths.indexOf(filePath) - 1)]
      : state.activeFilePath
    if (newActive !== state.activeFilePath) {
      get().setActiveFilePath(newActive)
    }
    const nextWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        activeFilePath: newActive,
        openFilePaths: next
      }
    }
    saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)
    set({ openFilePaths: next, workspaces: nextWorkspaces })
  },

  deleteFile: (filePath) => {
    const state = get()
    if (!state.fsMap[filePath]) return

    const dependencyGraph = buildDependencyGraph(state.fsMap)
    const usedBy = dependencyGraph[filePath]?.usedBy || []
    if (usedBy.length > 0) {
      const message = `Cannot delete ${filePath} because it is still used by: ${usedBy.join(', ')}`
      if (typeof window !== 'undefined') {
        window.alert(message)
      } else {
        console.warn(message)
      }
      return
    }

    const nextFsMap = { ...state.fsMap }
    delete nextFsMap[filePath]

    const ensuredFsMap = regenerateSubcircuitIndex(ensureFsMapDefaults(nextFsMap))
    const normalizedFiles = normalizeWorkspaceFileSelection(
      ensuredFsMap,
      state.activeFilePath === filePath ? undefined : state.activeFilePath,
      state.openFilePaths.filter(path => path !== filePath)
    )

    const parsed = getCanvasStateForFile(normalizedFiles.activeFilePath, ensuredFsMap)
    const nextWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        fsMap: ensuredFsMap,
        activeFilePath: normalizedFiles.activeFilePath,
        openFilePaths: normalizedFiles.openFilePaths
      }
    }

    saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)
    set({
      fsMap: ensuredFsMap,
      workspaces: nextWorkspaces,
      activeFilePath: normalizedFiles.activeFilePath,
      openFilePaths: normalizedFiles.openFilePaths,
      placedComponents: parsed.components,
      wires: parsed.wires,
      selectedComponentIds: [],
      exportPreview: null
    })
  },

  moveFile: (oldPath, newPath) => {
    const state = get()
    const content = state.fsMap[oldPath]
    if (!content || oldPath === newPath) return

    try {
      const dependencyGraph = buildDependencyGraph(state.fsMap)
      const usedBy = dependencyGraph[oldPath]?.usedBy || []
      if (usedBy.length > 0) {
        throw new Error(`Cannot move ${oldPath} because it is still imported by: ${usedBy.join(', ')}`)
      }
      const targetPath = getCanonicalFilePathForContent(newPath, content, state.fsMap, {
        preserveRequestedPath: true
      })
      validateFilePlacement(targetPath, content)

      const nextFsMapBase = { ...state.fsMap }
      delete nextFsMapBase[oldPath]
      nextFsMapBase[targetPath] = content

      const nextFsMap = regenerateSubcircuitIndex(ensureFsMapDefaults(nextFsMapBase))
      const normalizedFiles = normalizeWorkspaceFileSelection(
        nextFsMap,
        state.activeFilePath === oldPath ? targetPath : state.activeFilePath,
        state.openFilePaths.map(path => path === oldPath ? targetPath : path)
      )

      const parsed = getCanvasStateForFile(normalizedFiles.activeFilePath, nextFsMap)
      const nextWorkspaces = {
        ...state.workspaces,
        [state.activeWorkspaceId]: {
          ...state.workspaces[state.activeWorkspaceId],
          fsMap: nextFsMap,
          activeFilePath: normalizedFiles.activeFilePath,
          openFilePaths: normalizedFiles.openFilePaths
        }
      }

      saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)
      set({
        fsMap: nextFsMap,
        workspaces: nextWorkspaces,
        activeFilePath: normalizedFiles.activeFilePath,
        openFilePaths: normalizedFiles.openFilePaths,
        placedComponents: parsed.components,
        wires: parsed.wires,
        selectedComponentIds: []
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to move file.'
      window.alert(message)
    }
  },
  
  // ── Workspaces ────────────────────────────────────────────────────────────
  createWorkspace: (name = 'New Workspace') => {
    const state = get()
    // Save current workspace state first
    get().regenerateTSX()
    const id = makeWorkspaceId(name)
    const newWs: WorkspaceData = {
      id,
      name,
      fsMap: ensureFsMapDefaults(createDefaultWorkspaceFsMap(name)),
      openFilePaths: [SCHEMATIC_MAIN_PATH],
      activeFilePath: SCHEMATIC_MAIN_PATH
    }
    const nextWorkspaces = { ...state.workspaces, [id]: newWs }
    // Switch to the new workspace
    const parsed = getCanvasStateForFile(SCHEMATIC_MAIN_PATH, newWs.fsMap)
    const fsMapWithSnapshot = writePersistedCanvasGraphState(newWs.fsMap, SCHEMATIC_MAIN_PATH, parsed.components, parsed.wires)
    const workspaceWithSnapshot: WorkspaceData = {
      ...newWs,
      fsMap: fsMapWithSnapshot
    }
    const nextWorkspacesWithSnapshot = { ...state.workspaces, [id]: workspaceWithSnapshot }
    saveWorkspacesToStorage(nextWorkspacesWithSnapshot, id)
    set({
      workspaces: nextWorkspacesWithSnapshot,
      activeWorkspaceId: id,
      fsMap: fsMapWithSnapshot,
      activeFilePath: SCHEMATIC_MAIN_PATH,
      openFilePaths: [SCHEMATIC_MAIN_PATH],
      placedComponents: parsed.components,
      wires: parsed.wires,
      selectedComponentIds: [],
      breadcrumbStack: [],
      undoStack: [],
      redoStack: []
    })
  },
  
  switchWorkspace: (id) => {
    const state = get()
    if (id === state.activeWorkspaceId) return
    const target = state.workspaces[id]
    if (!target) return
  
    // Persist current workspace state before switching
    const currentFsMap = syncActiveCanvasFile(state)
    const updatedWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        fsMap: currentFsMap,
        activeFilePath: state.activeFilePath,
        openFilePaths: state.openFilePaths
      },
    }
  
    const normalizedCurrent = normalizeWorkspaceData({
      ...updatedWorkspaces[state.activeWorkspaceId],
      fsMap: currentFsMap,
      activeFilePath: state.activeFilePath,
      openFilePaths: state.openFilePaths
    })
    const normalizedTarget = normalizeWorkspaceData(target)

    const parsed = getCanvasStateForFile(normalizedTarget.activeFilePath, normalizedTarget.fsMap)
    const targetFsMapWithSnapshot = isCanvasEditableFilePath(normalizedTarget.activeFilePath)
      ? writePersistedCanvasGraphState(normalizedTarget.fsMap, normalizedTarget.activeFilePath, parsed.components, parsed.wires)
      : normalizedTarget.fsMap
    const nextWorkspaces = {
      ...updatedWorkspaces,
      [state.activeWorkspaceId]: normalizedCurrent,
      [id]: {
        ...normalizedTarget,
        fsMap: targetFsMapWithSnapshot
      }
    }
    saveWorkspacesToStorage(nextWorkspaces, id)
    set({
      workspaces: nextWorkspaces,
      activeWorkspaceId: id,
      fsMap: targetFsMapWithSnapshot,
      activeFilePath: normalizedTarget.activeFilePath,
      openFilePaths: normalizedTarget.openFilePaths,
      placedComponents: parsed.components,
      wires: parsed.wires,
      selectedComponentIds: [],
      breadcrumbStack: [],
      undoStack: [],
      redoStack: []
    })
  },
  
  deleteWorkspace: (id) => {
    const state = get()
    if (Object.keys(state.workspaces).length <= 1) return // keep at least one
    const next = { ...state.workspaces }
    delete next[id]
    const newActiveId = id === state.activeWorkspaceId
      ? Object.keys(next)[0]
      : state.activeWorkspaceId
  
    if (id === state.activeWorkspaceId) {
      get().switchWorkspace(newActiveId)
    } else {
      saveWorkspacesToStorage(next, state.activeWorkspaceId)
      set({ workspaces: next })
    }
  },
  
  renameWorkspace: (id, name) => {
    const state = get()
    if (!state.workspaces[id]) return
    const next = {
      ...state.workspaces,
      [id]: { ...state.workspaces[id], name }
    }
    saveWorkspacesToStorage(next, state.activeWorkspaceId)
    set({ workspaces: next })
  },
  
  importWorkspaceJSON: (json) => {
    try {
      const imported = importWorkspaceJson(json)
      const id = makeWorkspaceId(imported.name)
      const name = imported.name || `Imported ${new Date().toLocaleDateString()}`
      const fsMap = ensureFsMapDefaults(imported.files || {})
      const newWs: WorkspaceData = normalizeWorkspaceData({
        id,
        name,
        fsMap,
        openFilePaths: [SCHEMATIC_MAIN_PATH],
        activeFilePath: SCHEMATIC_MAIN_PATH
      })
      const state = get()
      const nextWorkspaces = { ...state.workspaces, [id]: newWs }
      const parsed = getCanvasStateForFile(newWs.activeFilePath, newWs.fsMap)
      const fsMapWithSnapshot = isCanvasEditableFilePath(newWs.activeFilePath)
        ? writePersistedCanvasGraphState(newWs.fsMap, newWs.activeFilePath, parsed.components, parsed.wires)
        : newWs.fsMap
      const nextWorkspacesWithSnapshot = {
        ...state.workspaces,
        [id]: {
          ...newWs,
          fsMap: fsMapWithSnapshot
        }
      }
      saveWorkspacesToStorage(nextWorkspacesWithSnapshot, id)
      set({
        workspaces: nextWorkspacesWithSnapshot,
        activeWorkspaceId: id,
        fsMap: fsMapWithSnapshot,
        activeFilePath: newWs.activeFilePath,
        openFilePaths: newWs.openFilePaths,
        placedComponents: parsed.components,
        wires: parsed.wires,
        selectedComponentIds: [],
        breadcrumbStack: [],
        undoStack: [],
        redoStack: []
      })
    } catch (e) {
      console.error('Failed to import workspace JSON:', e)
    }
  },
  
  exportWorkspaceJSON: () => {
    const state = get()
    // First sync fsMap
    const currentFsMap = syncActiveCanvasFile(state)
    const normalizedFiles = normalizeWorkspaceFileSelection(currentFsMap, state.activeFilePath, state.openFilePaths)
    const nextWorkspaces = {
      ...state.workspaces,
      [state.activeWorkspaceId]: {
        ...state.workspaces[state.activeWorkspaceId],
        fsMap: currentFsMap,
        activeFilePath: normalizedFiles.activeFilePath,
        openFilePaths: normalizedFiles.openFilePaths
      }
    }
    saveWorkspacesToStorage(nextWorkspaces, state.activeWorkspaceId)
    set({
      fsMap: currentFsMap,
      workspaces: nextWorkspaces,
      activeFilePath: normalizedFiles.activeFilePath,
      openFilePaths: normalizedFiles.openFilePaths
    })
    const wsName = state.workspaces[state.activeWorkspaceId]?.name || 'Workspace'
    return JSON.stringify(exportWorkspaceJson(wsName, currentFsMap), null, 2)
  },

  importWorkspace: (payload, nameOverride) => {
    try {
      const imported = importWorkspaceJson(payload)
      const finalName = nameOverride || imported.name
      const id = makeWorkspaceId(finalName)
      const state = get()
      const newWs: WorkspaceData = normalizeWorkspaceData({
        id,
        name: finalName,
        fsMap: ensureFsMapDefaults(imported.files),
        activeFilePath: SCHEMATIC_MAIN_PATH,
        openFilePaths: [SCHEMATIC_MAIN_PATH]
      })
      const parsed = getCanvasStateForFile(newWs.activeFilePath, newWs.fsMap)
      const fsMapWithSnapshot = isCanvasEditableFilePath(newWs.activeFilePath)
        ? writePersistedCanvasGraphState(newWs.fsMap, newWs.activeFilePath, parsed.components, parsed.wires)
        : newWs.fsMap
      const nextWorkspaces = {
        ...state.workspaces,
        [id]: {
          ...newWs,
          fsMap: fsMapWithSnapshot
        }
      }
      saveWorkspacesToStorage(nextWorkspaces, id)
      set({
        workspaces: nextWorkspaces,
        activeWorkspaceId: id,
        fsMap: fsMapWithSnapshot,
        activeFilePath: newWs.activeFilePath,
        openFilePaths: newWs.openFilePaths,
        placedComponents: parsed.components,
        wires: parsed.wires,
        selectedComponentIds: [],
        breadcrumbStack: [],
        undoStack: [],
        redoStack: []
      })
    } catch (e) {
      console.error('Failed to import workspace payload:', e)
    }
  },

  exportActiveWorkspace: () => {
    return get().exportWorkspaceJSON()
  }
}))

export const minimalImportExportTestUtils = {
  parseImportedTSXToCanvas: (content: string, filePath = SCHEMATIC_MAIN_PATH) => {
    const normalized = normalizeImportedTSXContent(content, filePath)
    const fsMap = ensureFsMapDefaults({ [filePath]: normalized })
    const resolvedPath = getCanonicalFilePathForContent(filePath, normalized, fsMap, {
      preserveRequestedPath: true
    })
    return parseFileToCanvas(resolvedPath, fsMap)
  },
  exportCanvasToTSX: (
    filePath: string,
    components: PlacedComponent[],
    wires: WireConnection[]
  ) => generateFileTSX(filePath, components, wires),
  normalizeImportedTSXContent,
  detectFileKind
}

export const getActiveWorkspace = (state: EditorState) => {
  return state.workspaces[state.activeWorkspaceId] || null
}

export const getActiveFsMap = (state: EditorState): FSMap => {
  return getActiveWorkspace(state)?.fsMap ?? {}
}
