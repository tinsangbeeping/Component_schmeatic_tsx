import React, { useEffect, useMemo, useState } from 'react'
import { CatalogPanel } from './components/CatalogPanel'
import { Canvas } from './components/Canvas'
import { Header } from './components/Header'
import { StatusBar } from './components/StatusBar'
import { FileTree } from './components/FileTree'
import { EditorTabs } from './components/EditorTabs'
import { EnhancedPropertiesPanel } from './components/EnhancedPropertiesPanel'
import { SymbolCanvas } from './components/SymbolCanvas'
import { SymbolPropertiesPanel } from './components/SymbolPropertiesPanel'
import { CodeView } from './components/CodeView'
import { BlockDiagramEditorPage } from './components/BlockDiagramEditorPage'
import { useEditorStore } from './store/editorStore'
import {
  createSymbolDocument,
  generateSymbolTsx,
  getGeneratedSymbolTsxPath,
  getSymbolEditorPathFromName,
  importSymbolTsxToDocument,
  isSymbolEditorPath,
  parseSymbolDocument
} from './utils/symbolDocument'
import {
  buildComponentUsage,
  buildImportedProjectState,
  buildProjectFileTree,
  extractAllSubcircuits,
  extractAllSymbols
} from './utils/projectManager'
import { classifyFilePath, isCanvasEditableFileType } from './utils/fileClassification'
import { CatalogItem } from './types/catalog'
import { SymbolDocument, SymbolSelection, SymbolToolMode } from './types/symbolDocument'
import { getApplicablePatches } from './lib/patches'
import './App.css'

const MAIN_SCHEMATIC_PATH = 'schematics/main.tsx'

type LeftTab = 'workspaces' | 'files' | 'schematics' | 'components' | 'symbols' | 'subcircuits' | 'patches'

const TAB_LABELS: { id: LeftTab; label: string }[] = [
  { id: 'workspaces', label: 'WS' },
  { id: 'files',      label: 'Files' },
  { id: 'schematics', label: 'Sch' },
  { id: 'components', label: 'Parts' },
  { id: 'symbols',    label: 'Sym' },
  { id: 'subcircuits',label: 'Sub' },
  { id: 'patches',    label: 'Patch' },
]

function App() {
  const [draggedItem, setDraggedItem] = useState<CatalogItem | null>(null)
  const [leftPanelTab, setLeftPanelTab] = useState<LeftTab>('files')
  const [editingWsId, setEditingWsId] = useState<string | null>(null)
  const [editingWsName, setEditingWsName] = useState('')
  const [symbolToolMode, setSymbolToolMode] = useState<SymbolToolMode>('select')
  const [symbolSelection, setSymbolSelection] = useState<SymbolSelection>(null)
  const [symbolEditorView, setSymbolEditorView] = useState<'canvas' | 'json'>('canvas')
  const [canvasViewMode, setCanvasViewMode] = useState<'schematic' | 'block'>('schematic')

  const regenerateTSX        = useEditorStore(s => s.regenerateTSX)
  const fsMap                = useEditorStore(s => s.fsMap)
  const activeFilePath       = useEditorStore(s => s.activeFilePath)
  const setActiveFilePath    = useEditorStore(s => s.setActiveFilePath)
  const selectedComponentIds = useEditorStore(s => s.selectedComponentIds)
  const placedComponents     = useEditorStore(s => s.placedComponents)
  const wires                = useEditorStore(s => s.wires)
  const updatePlacedComponent= useEditorStore(s => s.updatePlacedComponent)
  const setFSMap             = useEditorStore(s => s.setFSMap)
  const workspaces           = useEditorStore(s => s.workspaces)
  const activeWorkspaceId    = useEditorStore(s => s.activeWorkspaceId)
  const switchWorkspace      = useEditorStore(s => s.switchWorkspace)
  const createWorkspace      = useEditorStore(s => s.createWorkspace)
  const deleteWorkspace      = useEditorStore(s => s.deleteWorkspace)
  const renameWorkspace      = useEditorStore(s => s.renameWorkspace)
  const deleteFile           = useEditorStore(s => s.deleteFile)
  const moveFile             = useEditorStore(s => s.moveFile)
  const insertSubcircuitInstance = useEditorStore(s => s.insertSubcircuitInstance)
  const applyPatch           = useEditorStore(s => s.applyPatch)

  const projectFileTree = buildProjectFileTree(fsMap)

  const selectedComponent = selectedComponentIds.length > 0
    ? placedComponents.find(c => c.id === selectedComponentIds[0]) || null
    : null

  const relevantConnections = selectedComponent
    ? wires.filter(w => w.from.componentId === selectedComponent.id || w.to.componentId === selectedComponent.id)
    : []

  const activeFileContent = fsMap[activeFilePath || MAIN_SCHEMATIC_PATH] || ''
  const activeFileType = classifyFilePath(activeFilePath || MAIN_SCHEMATIC_PATH)
  const canRenderCanvas = isCanvasEditableFileType(activeFileType)
  const isSymbolEditorFile = isSymbolEditorPath(activeFilePath)
  const symbolDocument = useMemo<SymbolDocument | null>(() => {
    if (!isSymbolEditorFile) return null
    return parseSymbolDocument(activeFileContent, activeFilePath.split('/').pop()?.replace('.symbol.json', '') || 'MySymbol')
  }, [activeFileContent, activeFilePath, isSymbolEditorFile])
  const canRenderSymbolEditor = isSymbolEditorFile && !!symbolDocument

  const symbolEditorDocuments = useMemo(
    () => Object.keys(fsMap)
      .filter(path => /^symbols\/\.editor\/.+\.symbol\.json$/.test(path))
      .sort((a, b) => a.localeCompare(b)),
    [fsMap]
  )

  const importedProject = buildImportedProjectState(fsMap)
  const symbolRegistry = extractAllSymbols(fsMap)
  const subcircuitRegistry = extractAllSubcircuits(fsMap)
  const componentUsage = buildComponentUsage(fsMap)
  const schematicEntries = importedProject.entryFiles.map(path => ({
    path,
    name: path.split('/').pop()?.replace(/\.tsx$/, '') || path
  }))
  const childSheetPaths = new Set(Object.values(importedProject.hierarchy).flat())
  const applicablePatches = getApplicablePatches(
    Object.fromEntries(subcircuitRegistry.map(subckt => [subckt.name, { filePath: subckt.filePath, ports: subckt.ports }]))
  )
  const savedSubcircuitsFromOtherWorkspaces = Object.values(workspaces)
    .filter(ws => ws.id !== activeWorkspaceId)
    .flatMap(ws =>
      Object.entries(ws.fsMap)
        .filter(([path]) => path.startsWith('subcircuits/') && path.endsWith('.tsx') && path !== 'subcircuits/index.ts')
        .map(([path, content]) => ({
          workspaceId: ws.id,
          workspaceName: ws.name,
          name: path.replace('subcircuits/', '').replace('.tsx', ''),
          filePath: path,
          content
        }))
    )
    .filter(saved => !subcircuitRegistry.some(local => local.name === saved.name))

  useEffect(() => { regenerateTSX() }, [regenerateTSX])

  useEffect(() => {
    setSymbolSelection(null)
    setSymbolToolMode('select')
    setSymbolEditorView('canvas')
    setCanvasViewMode('schematic')
  }, [activeFilePath])

  useEffect(() => {
    if (!canRenderCanvas && canvasViewMode !== 'schematic') {
      setCanvasViewMode('schematic')
    }
  }, [canRenderCanvas, canvasViewMode])

  const startRenameWorkspace = (id: string, name: string) => {
    setEditingWsId(id)
    setEditingWsName(name)
  }

  const finishRenameWorkspace = () => {
    if (editingWsId && editingWsName.trim()) {
      renameWorkspace(editingWsId, editingWsName.trim())
    }
    setEditingWsId(null)
    setEditingWsName('')
  }

  const createNewSchematicFile = () => {
    const baseName = prompt('New schematic page name (.tsx):', 'NewSheet')?.trim()
    if (!baseName) return
    const safeName = baseName.replace(/[^a-zA-Z0-9_]/g, '_')
    if (!safeName) return

    const filePath = `schematics/${safeName}.tsx`
    if (fsMap[filePath]) {
      setActiveFilePath(filePath)
      return
    }

    setFSMap({
      ...fsMap,
      [filePath]: `export default () => (\n  <board width="50mm" height="50mm">\n    {/* Add components here */}\n  </board>\n)\n`
    })
    setActiveFilePath(filePath)
  }

  const createNewSubcircuitFile = () => {
    const baseName = prompt('New subcircuit name (.tsx):', 'MySubcircuit')?.trim()
    if (!baseName) return
    const safeName = baseName.replace(/[^a-zA-Z0-9_]/g, '_')
    if (!safeName) return

    const filePath = `subcircuits/${safeName}.tsx`
    if (fsMap[filePath]) {
      setActiveFilePath(filePath)
      return
    }

    setFSMap({
      ...fsMap,
      [filePath]: `export const ports = [] as const\n\nexport function ${safeName}(props: { name: string; schX?: number; schY?: number }) {\n  const x = props.schX ?? 0\n  const y = props.schY ?? 0\n\n  return (\n    <subcircuit name={props.name}>\n      {/* Add components here */}\n    </subcircuit>\n  )\n}\n`
    })
    setActiveFilePath(filePath)
  }

  const importSavedSubcircuitToCurrentWorkspace = (name: string, content: string) => {
    const filePath = `subcircuits/${name}.tsx`
    const nextMap = {
      ...fsMap,
      [filePath]: content
    }
    setFSMap(nextMap)
    setActiveFilePath(filePath)
  }

  const getSheetPortsFromFile = (filePath: string): string[] => {
    const content = fsMap[filePath] || ''
    const explicitPorts = [...content.matchAll(/<port\b[^>]*name="([^"]+)"[^>]*\/>/g)]
      .map(match => match[1].trim())
      .filter(Boolean)

    if (explicitPorts.length > 0) return Array.from(new Set(explicitPorts))

    const namedNets = [...content.matchAll(/<net\b[^>]*name="([^"]+)"[^>]*\/>/g)]
      .map(match => match[1].trim())
      .filter(Boolean)

    return Array.from(new Set(namedNets))
  }

  const renderSchematicNode = (filePath: string, depth = 0, seen = new Set<string>()): React.ReactNode => {
    if (seen.has(filePath)) return null
    const nextSeen = new Set(seen)
    nextSeen.add(filePath)

    const displayName = filePath.split('/').pop()?.replace(/\.tsx$/, '') || filePath
    const children = importedProject.hierarchy[filePath] || []
    const isRoot = importedProject.rootFile === filePath

    return (
      <div key={filePath}>
        <div
          draggable
          style={{
            padding: '6px 8px',
            marginBottom: 4,
            marginLeft: depth * 12,
            borderRadius: 4,
            cursor: 'pointer',
            background: filePath === activeFilePath ? '#094771' : '#2a2a2a',
            color: filePath === activeFilePath ? '#fff' : '#ccc',
            fontSize: 12,
            border: isRoot ? '1px solid #4caf50' : '1px solid transparent'
          }}
          onClick={() => setActiveFilePath(filePath)}
          onDragStart={(e) => {
            e.dataTransfer.setData('sheetName', displayName)
            e.dataTransfer.setData('sheetPath', filePath)
            e.dataTransfer.setData('sheetPorts', JSON.stringify(getSheetPortsFromFile(filePath)))
          }}
          title={isRoot ? 'Root schematic — click to open or drag into a parent board as a sheet block' : 'Click to open or drag onto the canvas as a sheet block'}
        >
          {isRoot ? '🏠 ' : depth > 0 ? '↳ ' : '📄 '}
          {displayName}
        </div>
        {children.map(child => renderSchematicNode(child, depth + 1, nextSeen))}
      </div>
    )
  }

  const createNewSymbolFile = () => {
    const baseName = prompt('New symbol name (.tsx):', 'MySymbol')?.trim()
    if (!baseName) return
    const safeName = baseName.replace(/[^a-zA-Z0-9_]/g, '_')
    if (!safeName) return

    const filePath = `symbols/${safeName}.tsx`
    if (fsMap[filePath]) {
      setActiveFilePath(filePath)
      return
    }

    setFSMap({
      ...fsMap,
      [filePath]: `export default function ${safeName}(props: { name: string; schX?: number; schY?: number }) {\n  return (\n    <chip\n      name={props.name}\n      schX={props.schX}\n      schY={props.schY}\n      symbol={\n        <symbol>\n          <schematicline x1={0} y1={20} x2={40} y2={20} />\n          <port name="P1" direction="left" side="left" schX={0} schY={20} />\n          <port name="P2" direction="right" side="right" schX={40} schY={20} />\n        </symbol>\n      }\n    />\n  )\n}\n`
    })
    setActiveFilePath(filePath)
  }

  const createNewSymbolEditorFile = () => {
    const baseName = prompt('New symbol maker document name:', 'MySymbol')?.trim()
    if (!baseName) return

    const doc = createSymbolDocument(baseName)
    const editorPath = getSymbolEditorPathFromName(doc.name)

    if (fsMap[editorPath]) {
      setActiveFilePath(editorPath)
      return
    }

    setFSMap({
      ...fsMap,
      [editorPath]: JSON.stringify(doc, null, 2)
    })
    setActiveFilePath(editorPath)
  }

  const saveSymbolDocument = (nextDocument: SymbolDocument) => {
    if (!isSymbolEditorFile) return
    setFSMap({
      ...fsMap,
      [activeFilePath]: JSON.stringify(nextDocument, null, 2)
    })
  }

  const exportActiveSymbolDocument = () => {
    if (!symbolDocument) return
    const tsxPath = getGeneratedSymbolTsxPath(symbolDocument.name)
    const safeName = symbolDocument.name.replace(/[^a-zA-Z0-9_]/g, '_')
    const existingIndex = fsMap['symbols/index.ts'] || ''
    const exportLine = `export { default as ${safeName} } from "./${safeName}"`
    const indexLines = existingIndex
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !line.startsWith(`export { default as ${safeName} } from`))
      .filter(line => line !== '// Symbol definitions exported here')
    const nextIndex = [...indexLines, exportLine]
      .sort((a, b) => a.localeCompare(b))
      .join('\n')
    const nextMap = {
      ...fsMap,
      [tsxPath]: generateSymbolTsx(symbolDocument),
      'symbols/index.ts': nextIndex ? `${nextIndex}\n` : ''
    }
    setFSMap(nextMap)
    setActiveFilePath(tsxPath)
    alert(`Exported symbol TSX and registered component: ${tsxPath}`)
  }

  const importSymbolComponentToEditor = (symbolPath: string) => {
    const symbolContent = fsMap[symbolPath]
    if (!symbolContent) return
    const symbolName = symbolPath.split('/').pop()?.replace('.tsx', '') || 'ImportedSymbol'
    const editorPath = getSymbolEditorPathFromName(symbolName)

    if (fsMap[editorPath] && !window.confirm(`Overwrite existing symbol document at ${editorPath}?`)) {
      return
    }

    const doc = importSymbolTsxToDocument(symbolContent, symbolName)
    setFSMap({
      ...fsMap,
      [editorPath]: JSON.stringify(doc, null, 2)
    })
    setActiveFilePath(editorPath)

    if (doc.needsManualReview) {
      alert('Imported with best-effort parsing. Some dynamic TSX could not be represented exactly and needs manual review.')
    }
  }

  return (
    <div className="editor-container">
      <Header />

      <div style={{ display: 'flex', flex: 1, marginTop: 74, overflow: 'hidden' }}>
        {/* ── Left Panel ── */}
        <div style={{ width: 250, background: '#252526', borderRight: '1px solid #3e3e3e', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', background: '#2d2d2d', borderBottom: '1px solid #3e3e3e', flexShrink: 0 }}>
            {TAB_LABELS.map(t => (
              <button
                key={t.id}
                className={`catalog-tab ${leftPanelTab === t.id ? 'active' : ''}`}
                onClick={() => setLeftPanelTab(t.id)}
                style={{ flex: 1, fontSize: 11 }}
                title={t.id.charAt(0).toUpperCase() + t.id.slice(1)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>

            {/* WORKSPACES */}
            {leftPanelTab === 'workspaces' && (
              <div style={{ padding: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ color: '#ccc', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Workspaces</span>
                  <button
                    style={{ background: '#007acc', border: 'none', color: '#fff', borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
                    onClick={() => {
                      const name = prompt('New workspace name:')
                      if (name?.trim()) createWorkspace(name.trim())
                    }}
                  >+ New</button>
                </div>
                {Object.values(workspaces).map(ws => (
                  <div
                    key={ws.id}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '6px 8px', marginBottom: 2, borderRadius: 4, cursor: 'pointer',
                      background: ws.id === activeWorkspaceId ? '#094771' : '#2a2a2a',
                      color: ws.id === activeWorkspaceId ? '#fff' : '#ccc',
                      fontSize: 13
                    }}
                    onClick={() => switchWorkspace(ws.id)}
                  >
                    {editingWsId === ws.id ? (
                      <input
                        autoFocus
                        value={editingWsName}
                        onChange={e => setEditingWsName(e.target.value)}
                        onBlur={finishRenameWorkspace}
                        onKeyDown={e => { if (e.key === 'Enter') finishRenameWorkspace(); if (e.key === 'Escape') { setEditingWsId(null) } }}
                        style={{ flex: 1, background: '#333', border: '1px solid #007acc', color: '#fff', borderRadius: 3, padding: '2px 4px', fontSize: 12 }}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.name}</span>
                    )}
                    <div style={{ display: 'flex', gap: 4, marginLeft: 4 }} onClick={e => e.stopPropagation()}>
                      <button
                        style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 11, padding: '0 2px' }}
                        title="Rename"
                        onClick={() => startRenameWorkspace(ws.id, ws.name)}
                      >✏</button>
                      <button
                        style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 11, padding: '0 2px' }}
                        title="Delete"
                        onClick={() => {
                          if (window.confirm(`Delete workspace "${ws.name}"?`)) deleteWorkspace(ws.id)
                        }}
                      >🗑</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* FILES */}
            {leftPanelTab === 'files' && (
              <FileTree
                root={projectFileTree}
                onFileSelect={setActiveFilePath}
                onFileDelete={deleteFile}
                onFileMove={moveFile}
                activeFilePath={activeFilePath}
              />
            )}

            {/* SCHEMATICS */}
            {leftPanelTab === 'schematics' && (
              <div style={{ padding: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ color: '#ccc', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
                    Schematic Hierarchy
                  </div>
                  <button
                    style={{ background: '#007acc', border: 'none', color: '#fff', borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
                    onClick={createNewSchematicFile}
                  >+ New</button>
                </div>
                {schematicEntries.length === 0 ? (
                  <div style={{ color: '#666', fontSize: 12 }}>No schematic entry files found.</div>
                ) : (
                  <>
                    {(importedProject.rootFile
                      ? [importedProject.rootFile, ...schematicEntries.map(entry => entry.path).filter(path => path !== importedProject.rootFile && !childSheetPaths.has(path))]
                      : schematicEntries.map(entry => entry.path)
                    )
                      .filter((path, index, arr) => arr.indexOf(path) === index)
                      .map(path => renderSchematicNode(path))}
                  </>
                )}
              </div>
            )}

            {/* COMPONENTS */}
            {leftPanelTab === 'components' && (
              <CatalogPanel onDragStart={setDraggedItem} embedded />
            )}

            {/* SYMBOLS */}
            {leftPanelTab === 'symbols' && (
              <div style={{ padding: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ color: '#ccc', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Symbol Files</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      style={{ background: '#007acc', border: 'none', color: '#fff', borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
                      onClick={createNewSymbolEditorFile}
                    >+ Maker</button>
                    <button
                      style={{ background: '#3f3f46', border: 'none', color: '#fff', borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
                      onClick={createNewSymbolFile}
                    >+ TSX</button>
                  </div>
                </div>

                <div style={{ color: '#888', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                  Symbol Maker Documents
                </div>
                {symbolEditorDocuments.length === 0 && (
                  <div style={{ color: '#666', fontSize: 12, marginBottom: 10 }}>No symbol JSON documents yet.</div>
                )}
                {symbolEditorDocuments.map(path => {
                  const name = path.split('/').pop()?.replace('.symbol.json', '') || path
                  return (
                    <div
                      key={path}
                      style={{
                        padding: '5px 8px', marginBottom: 2, borderRadius: 4, cursor: 'pointer',
                        background: path === activeFilePath ? '#094771' : '#2a2a2a',
                        color: path === activeFilePath ? '#fff' : '#ccc',
                        fontSize: 12
                      }}
                      onClick={() => setActiveFilePath(path)}
                      title="Editable SymbolDocument JSON source"
                    >
                      ✍ {name}.symbol.json
                    </div>
                  )
                })}

                <div style={{ color: '#888', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginTop: 10, marginBottom: 6 }}>
                  Generated Symbol Components
                </div>
                {symbolRegistry.length === 0 && (
                  <div style={{ color: '#666', fontSize: 12 }}>No symbol files found.<br />Add .tsx files to the <code>symbols/</code> folder.</div>
                )}
                {symbolRegistry.map(symbol => (
                  <div
                    key={symbol.filePath}
                    draggable
                    style={{
                      padding: '5px 8px', marginBottom: 2, borderRadius: 4, cursor: 'pointer',
                      background: symbol.filePath === activeFilePath ? '#094771' : '#2a2a2a',
                      color: symbol.filePath === activeFilePath ? '#fff' : '#ccc',
                      fontSize: 12
                    }}
                    onClick={() => setActiveFilePath(symbol.filePath)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('symbolComponentName', symbol.name)
                      e.dataTransfer.setData('symbolComponentPath', symbol.filePath)
                      e.dataTransfer.setData('symbolComponentPorts', JSON.stringify(symbol.ports.map(port => port.name)))
                    }}
                    title="Drag onto canvas to place custom chip instance"
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        🧩 {symbol.name}{symbol.ports.length > 0 ? ` (${symbol.ports.map(port => port.name).join(', ')})` : ''}
                      </span>
                      <button
                        style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 11 }}
                        title="Import TSX into symbol maker JSON"
                        onClick={(e) => {
                          e.stopPropagation()
                          importSymbolComponentToEditor(symbol.filePath)
                        }}
                      >
                        ⇢ Maker
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* SUBCIRCUITS */}
            {leftPanelTab === 'subcircuits' && (
              <div style={{ padding: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ color: '#ccc', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Subcircuits</div>
                  <button
                    style={{ background: '#007acc', border: 'none', color: '#fff', borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
                    onClick={createNewSubcircuitFile}
                  >+ New</button>
                </div>
                {subcircuitRegistry.length === 0 && (
                  <div style={{ color: '#666', fontSize: 12 }}>No subcircuit files yet.</div>
                )}
                {subcircuitRegistry.map(subckt => (
                  <div
                    key={subckt.filePath}
                    draggable
                    style={{
                      padding: '5px 8px', marginBottom: 2, borderRadius: 4, cursor: 'pointer',
                      background: subckt.filePath === activeFilePath ? '#094771' : '#2a2a2a',
                      color: subckt.filePath === activeFilePath ? '#fff' : '#ccc',
                      fontSize: 12,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8
                    }}
                    onClick={() => {
                      setActiveFilePath(subckt.filePath)
                    }}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('subcircuitName', subckt.name)
                      e.dataTransfer.setData('subcircuitPath', subckt.filePath)
                    }}
                    title="Open subcircuit source or drag onto the canvas to place an instance"
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      🔧 {subckt.name}{subckt.ports.length > 0 ? ` (${subckt.ports.join(', ')})` : ''}
                      <span style={{ display: 'block', fontSize: 10, color: '#8fb6d8' }}>
                        used in {componentUsage[subckt.name]?.length || 0} file(s)
                      </span>
                    </span>
                    {activeFileType === 'board-tsx' && (
                      <button
                        style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 12 }}
                        onClick={(e) => {
                          e.stopPropagation()
                          insertSubcircuitInstance(subckt.name, { filePath: subckt.filePath })
                        }}
                        title="Insert instance into active board"
                      >
                        ➕
                      </button>
                    )}
                  </div>
                ))}

                {savedSubcircuitsFromOtherWorkspaces.length > 0 && (
                  <>
                    <div style={{ color: '#888', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginTop: 10, marginBottom: 6 }}>
                      Saved In Other WS
                    </div>
                    {savedSubcircuitsFromOtherWorkspaces.map(saved => (
                      <div
                        key={`${saved.workspaceId}:${saved.name}`}
                        style={{
                          padding: '6px 8px',
                          marginBottom: 4,
                          borderRadius: 4,
                          background: '#2a2a2a',
                          border: '1px solid #3a3a3a'
                        }}
                      >
                        <div style={{ color: '#ddd', fontSize: 12, marginBottom: 4 }}>🔁 {saved.name}</div>
                        <div style={{ color: '#888', fontSize: 11, marginBottom: 6 }}>from {saved.workspaceName}</div>
                        <button
                          style={{ background: '#007acc', border: 'none', color: '#fff', borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
                          onClick={() => importSavedSubcircuitToCurrentWorkspace(saved.name, saved.content)}
                        >
                          Use In This WS
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {/* PATCHES */}
            {leftPanelTab === 'patches' && (
              <div style={{ padding: 8 }}>
                <div style={{ color: '#ccc', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                  Patches
                </div>
                {applicablePatches.length === 0 ? (
                  <div style={{ color: '#666', fontSize: 12 }}>
                    No patches available yet. Import the required subcircuits first.
                  </div>
                ) : (
                  applicablePatches.map(patch => (
                    <div
                      key={patch.id}
                      style={{
                        padding: '8px 10px',
                        marginBottom: 6,
                        borderRadius: 4,
                        background: '#2a2a2a',
                        border: '1px solid #3a3a3a'
                      }}
                    >
                      <div style={{ color: '#ddd', fontSize: 12, marginBottom: 4 }}>🧩 {patch.name}</div>
                      <div style={{ color: '#888', fontSize: 11, marginBottom: 6 }}>{patch.description || 'Reusable macro patch'}</div>
                      <button
                        style={{ background: '#007acc', border: 'none', color: '#fff', borderRadius: 3, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}
                        onClick={() => applyPatch(patch)}
                        disabled={activeFileType !== 'board-tsx'}
                        title={activeFileType === 'board-tsx' ? 'Apply patch to active board' : 'Open a schematic file to apply patches'}
                      >
                        Insert Patch
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

          </div>
        </div>

        {/* ── Center: editor tabs + canvas ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <EditorTabs />
          {canRenderCanvas && (
            <div style={{ display: 'flex', gap: 6, padding: '6px 10px', borderBottom: '1px solid #2f2f2f', background: '#202020' }}>
              <button
                className={canvasViewMode === 'schematic' ? 'btn btn-primary' : 'btn btn-secondary'}
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setCanvasViewMode('schematic')}
              >
                Schematic
              </button>
              <button
                className={canvasViewMode === 'block' ? 'btn btn-primary' : 'btn btn-secondary'}
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setCanvasViewMode('block')}
              >
                Block
              </button>
            </div>
          )}
          {canRenderSymbolEditor && (
            <div style={{ display: 'flex', gap: 6, padding: '6px 10px', borderBottom: '1px solid #2f2f2f', background: '#202020' }}>
              <button
                className={symbolEditorView === 'canvas' ? 'btn btn-primary' : 'btn btn-secondary'}
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setSymbolEditorView('canvas')}
              >
                Symbol Canvas
              </button>
              <button
                className={symbolEditorView === 'json' ? 'btn btn-primary' : 'btn btn-secondary'}
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setSymbolEditorView('json')}
              >
                Symbol JSON
              </button>
            </div>
          )}
          {canRenderSymbolEditor && symbolDocument ? (
            symbolEditorView === 'json' ? (
              <CodeView />
            ) : (
              <SymbolCanvas
                document={symbolDocument}
                toolMode={symbolToolMode}
                selected={symbolSelection}
                onToolModeChange={setSymbolToolMode}
                onSelectionChange={setSymbolSelection}
                onDocumentChange={saveSymbolDocument}
              />
            )
          ) : canRenderCanvas ? (
            canvasViewMode === 'block' ? <BlockDiagramEditorPage /> : <Canvas />
          ) : (
            <CodeView />
          )}
        </div>

        {/* ── Right Panel ── */}
        <div style={{ width: 300, background: '#252526', borderLeft: '1px solid #3e3e3e', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {canRenderCanvas && canvasViewMode === 'block' ? (
            <div className="enhanced-properties-panel" style={{ padding: 12, color: '#bbb', fontSize: 12 }}>
              Block Diagram view active. Switch back to Schematic tab to inspect and edit component properties.
            </div>
          ) : canRenderSymbolEditor && symbolDocument && symbolEditorView === 'canvas' ? (
            <SymbolPropertiesPanel
              document={symbolDocument}
              selected={symbolSelection}
              onSelectionChange={setSymbolSelection}
              onDocumentChange={saveSymbolDocument}
              onExportTsx={exportActiveSymbolDocument}
            />
          ) : canRenderSymbolEditor && symbolEditorView === 'json' ? (
            <div className="enhanced-properties-panel" style={{ padding: 12, color: '#bbb', fontSize: 12 }}>
              JSON view active. Edit the SymbolDocument source directly in the center panel.
            </div>
          ) : (
            <EnhancedPropertiesPanel
              selectedComponent={selectedComponent}
              connections={relevantConnections}
              activeFileContent={activeFileContent}
              activeFilePath={activeFilePath || MAIN_SCHEMATIC_PATH}
              activeFileType={activeFileType}
              placedComponents={placedComponents}
              onPropertyChange={(componentId, propName, value) => {
                const component = placedComponents.find(c => c.id === componentId)
                if (component) {
                  if (propName === 'name') {
                    const nextName = String(value || component.name)

                    const netNameProps =
                      component.catalogId === 'net'
                        ? { name: nextName, netName: nextName }
                        : component.catalogId === 'netport'
                        ? { name: nextName, netName: nextName }
                        : component.catalogId === 'netlabel'
                        ? { net: nextName }
                        : null

                    updatePlacedComponent(componentId, {
                      name: nextName,
                      ...(netNameProps ? { props: netNameProps } : {})
                    })
                    return
                  }

                  updatePlacedComponent(componentId, {
                    props: { [propName]: value }
                  })
                }
              }}
            />
          )}
        </div>
      </div>

      <StatusBar />
    </div>
  )
}

export default App
