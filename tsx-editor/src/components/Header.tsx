import React, { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { useEditorStore } from '../store/editorStore'
import { pixelToSchematic } from '../utils/coordinateScale'
import { buildImportedProjectState, buildSubcircuitRegistry, extractBatchFilesFromZip, getBrokenImports } from '../utils/projectManager'
import { getApplicablePatches } from '../lib/patches'

const MAIN_SCHEMATIC_PATH = 'schematics/main.tsx'

export const Header: React.FC = () => {
  const {
    fsMap,
    setFSMap,
    setActiveFilePath,
    placedComponents,
    applyLayout,
    autoWireCommonNets,
    selectedComponentIds,
    rotateSelectedComponents,
    removeSelectedComponents,
    copySelectedComponents,
    pasteCopiedComponents,
    generateFlatCircuitTSX,
    importTSXIntoActiveFile,
    importFilesBatch,
    applyPatch,
    setCodeViewTab,
    setExportPreview,
    activeFilePath,
    breadcrumbStack,
    goBackFile
  } = useEditorStore()

  const undo                = useEditorStore(s => s.undo)
  const redo                = useEditorStore(s => s.redo)
  const cancelWiring        = useEditorStore(s => s.cancelWiring)
  const wiringStart         = useEditorStore(s => s.wiringStart)
  const exportWorkspaceJSON = useEditorStore(s => s.exportWorkspaceJSON)
  const importWorkspaceJSON = useEditorStore(s => s.importWorkspaceJSON)

  const currentFileLabel = activeFilePath === MAIN_SCHEMATIC_PATH || activeFilePath === 'main.tsx'
    ? MAIN_SCHEMATIC_PATH
    : activeFilePath.replace('subcircuits/', '')

  const [showExportDialog, setShowExportDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showWsImportDialog, setShowWsImportDialog] = useState(false)
  const [showBatchImportDialog, setShowBatchImportDialog] = useState(false)
  const [showPatchDialog, setShowPatchDialog] = useState(false)
  const [importContent, setImportContent] = useState('')
  const [wsImportContent, setWsImportContent] = useState('')
  const [batchImportContent, setBatchImportContent] = useState('')
  const [exportName, setExportName] = useState('MyComponent')
  const [selectedPatchId, setSelectedPatchId] = useState('')
  const [isLayouting, setIsLayouting] = useState(false)
  const [isZipImporting, setIsZipImporting] = useState(false)
  const [isZipExporting, setIsZipExporting] = useState(false)
  const zipInputRef = useRef<HTMLInputElement | null>(null)
  const showAdvancedToolbar = typeof window !== 'undefined' && (window as any).__SHOW_ADVANCED_TOOLBAR === true

  const subcircuitRegistry = useMemo(() => buildSubcircuitRegistry(fsMap), [fsMap])
  const applicablePatches = useMemo(() => getApplicablePatches(subcircuitRegistry), [subcircuitRegistry])

  const downloadBlobFile = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    URL.revokeObjectURL(url)
  }

  const downloadTextFile = (content: string, fileName: string) => {
    const blob = new Blob([content], { type: 'text/plain' })
    downloadBlobFile(blob, fileName)
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTypingTarget = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )

      if (isTypingTarget) return

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedComponentIds.length > 0) {
        e.preventDefault()
        removeSelectedComponents()
        return
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        redo()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selectedComponentIds.length > 0) {
        e.preventDefault()
        copySelectedComponents()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        pasteCopiedComponents()
        return
      }

      if (e.key === 'Escape') {
        if (wiringStart) {
          e.preventDefault()
          cancelWiring()
        }
        return
      }

      if (e.key.toLowerCase() === 'r' && selectedComponentIds.length > 0) {
        e.preventDefault()
        rotateSelectedComponents()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedComponentIds, removeSelectedComponents, copySelectedComponents, pasteCopiedComponents,
      rotateSelectedComponents, undo, redo, cancelWiring, wiringStart])

  const handleExport = () => {
    const circuitTsx = generateFlatCircuitTSX() || fsMap[MAIN_SCHEMATIC_PATH] || fsMap['main.tsx'] || ''
    setExportPreview({ fileName: 'circuit.tsx', content: circuitTsx })
    setCodeViewTab('export')
    downloadTextFile(circuitTsx, 'circuit.tsx')
  }

  const handleCopy = () => {
    const currentTsx = fsMap[activeFilePath] || ''
    navigator.clipboard.writeText(currentTsx)
    alert(`Copied ${activeFilePath} to clipboard`)
  }

  const handleImport = () => {
    if (!importContent.trim()) return
    try {
      importTSXIntoActiveFile(importContent)
      setShowImportDialog(false)
      setImportContent('')
      alert('Imported TSX successfully and updated the target file.')
    } catch (error) {
      alert('Import failed: ' + (error as Error).message)
    }
  }

  const parseBatchPayload = (payload: string): Array<{ fileName: string; content: string }> => {
    const parsed = JSON.parse(payload) as unknown

    if (Array.isArray(parsed)) {
      return parsed.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
          throw new Error(`Batch entry ${index + 1} is invalid.`)
        }
        const fileName = String((entry as any).fileName || (entry as any).path || '').trim()
        const content = String((entry as any).content || '').trim()
        if (!fileName || !content) {
          throw new Error(`Batch entry ${index + 1} must include fileName and content.`)
        }
        return { fileName, content }
      })
    }

    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed as Record<string, string>).map(([fileName, content]) => ({
        fileName,
        content: String(content)
      }))
    }

    throw new Error('Batch import expects a JSON array or an object map of file paths to content.')
  }

  const importBatchFiles = (files: Array<{ fileName: string; content: string }>) => {
    importFilesBatch(files)
    setShowBatchImportDialog(false)
    setBatchImportContent('')

    const currentFsMap = useEditorStore.getState().fsMap
    const importedProject = buildImportedProjectState(currentFsMap)
    const broken = getBrokenImports(currentFsMap)
    const summary = `Imported ${files.length} files • root: ${importedProject.rootFile || 'none'} • ${importedProject.entryFiles.length} schematic page(s) • ${Object.keys(importedProject.registry).length} reusable block(s).`
    if (broken.length > 0) {
      const brokenList = broken.map(b => `  • ${b.filePath} -> ${b.importPath}`).join('\n')
      alert(`${summary}\n\n⚠️ Warning: ${broken.length} unresolved import(s) — these files may need to be imported separately:\n${brokenList}`)
    } else {
      alert(summary)
    }
  }

  const handleBatchImport = () => {
    if (!batchImportContent.trim()) return
    try {
      const files = parseBatchPayload(batchImportContent)
      importBatchFiles(files)
    } catch (error) {
      alert('Batch import failed: ' + (error as Error).message)
    }
  }

  const handleZipImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setIsZipImporting(true)
    try {
      const files = await extractBatchFilesFromZip(await file.arrayBuffer())
      importBatchFiles(files)
    } catch (error) {
      alert('Zip import failed: ' + (error as Error).message)
    } finally {
      setIsZipImporting(false)
      event.target.value = ''
    }
  }

  const handleApplyPatch = () => {
    const patch = applicablePatches.find(item => item.id === selectedPatchId) || applicablePatches[0]
    if (!patch) {
      alert('No applicable patches are available for the current imported subcircuits.')
      return
    }

    try {
      applyPatch(patch)
      setShowPatchDialog(false)
      alert(`Applied patch: ${patch.name}`)
    } catch (error) {
      alert('Patch failed: ' + (error as Error).message)
    }
  }

  const handleExportWorkspace = () => {
    try {
      const json = exportWorkspaceJSON()
      const ws = JSON.parse(json) as { name?: string }
      const safeName = ws.name?.replace(/[^a-z0-9]/gi, '_') || 'export'
      downloadTextFile(json, `workspace-${safeName}-${Date.now()}.json`)
    } catch (e) {
      alert('Workspace export failed: ' + (e as Error).message)
    }
  }

  const handleImportWorkspace = () => {
    if (!wsImportContent.trim()) return
    try {
      importWorkspaceJSON(wsImportContent)
      setShowWsImportDialog(false)
      setWsImportContent('')
      alert('Workspace imported and activated.')
    } catch (e) {
      alert('Workspace import failed: ' + (e as Error).message)
    }
  }

  const handleCreateSchematicPage = () => {
    const baseName = window.prompt('New schematic page name (.tsx):', 'NewSheet')?.trim()
    if (!baseName) return

    const safeName = baseName.replace(/[^a-zA-Z0-9_]/g, '_')
    if (!safeName) {
      alert('Please enter a valid alphanumeric page name.')
      return
    }

    const filePath = `schematics/${safeName}.tsx`
    if (fsMap[filePath]) {
      setActiveFilePath(filePath)
      alert(`Opened existing page: ${filePath}`)
      return
    }

    setFSMap({
      ...fsMap,
      [filePath]: `export default () => (\n  <board width="50mm" height="50mm">\n    {/* Add components here */}\n  </board>\n)\n`
    })
    setActiveFilePath(filePath)
    alert(`Created schematic page: ${filePath}`)
  }

  const handleExportAsComponent = () => {
    if (!exportName) return
    if (placedComponents.length === 0) { alert('No components to export'); return }

    const minX = Math.min(...placedComponents.map(c => c.props.schX || 0))
    const minY = Math.min(...placedComponents.map(c => c.props.schY || 0))

    const componentsTSX = placedComponents
      .filter(c => c.catalogId !== 'netport')
      .map(c => {
        const normalizedProps = { ...c.props }
        if (c.catalogId === 'switch') {
          if (normalizedProps.type === undefined && normalizedProps.variant !== undefined) {
            normalizedProps.type = normalizedProps.variant
          }
          delete normalizedProps.variant
          if (!normalizedProps.footprint) normalizedProps.footprint = 'pushbutton'
        }
        const localX = pixelToSchematic((c.props.schX || 0) - minX)
        const localY = pixelToSchematic((c.props.schY || 0) - minY)
        const coordX = Number.isInteger(localX) ? String(localX) : String(Number(localX.toFixed(3)))
        const coordY = Number.isInteger(localY) ? String(localY) : String(Number(localY.toFixed(3)))
        const propLines = Object.entries(normalizedProps)
          .filter(([k]) => !['name', 'schX', 'schY', 'schRotation', 'subcircuitName', 'ports', 'netName'].includes(k))
          .map(([k, v]) => {
            if (typeof v === 'number') return `${k}={${v}}`
            if (typeof v === 'boolean') return v ? k : ''
            return `${k}="${v}"`
          })
          .filter(Boolean)
        const tagName = c.catalogId === 'subcircuit-instance' ? c.props.subcircuitName : c.catalogId
        return [
          `      {/* // editorSchX={${c.props.schX || 0}} */}`,
          `      {/* // editorSchY={${c.props.schY || 0}} */}`,
          `      <${tagName}`,
          `        name="${c.name}"`,
          ...propLines.map(l => `        ${l}`),
          `        schX={x + ${coordX}}`,
          `        schY={y + ${coordY}}`,
          `        schRotation="${normalizedProps.schRotation || '0deg'}"`,
          `      />`
        ].join('\n')
      })
      .join('\n')

    const exportedTSX = `import React from "react"\n\nexport const ports = [] as const\n\nexport function ${exportName}(props: {\n  name: string\n  schX?: number\n  schY?: number\n}) {\n  const x = props.schX ?? 0\n  const y = props.schY ?? 0\n\n  return (\n    <subcircuit name={props.name}>\n${componentsTSX || '      {/* Add components here */}'}\n    </subcircuit>\n  )\n}\n`
    setExportPreview({ fileName: `${exportName}.tsx`, content: exportedTSX })
    setCodeViewTab('export')
    setShowExportDialog(false)
    alert(`Export preview opened: ${exportName}.tsx`)
  }

  const handleAutoLayout = async () => {
    setIsLayouting(true)
    try {
      await applyLayout()
      alert('Layout applied successfully!')
    } catch (error) {
      alert('Layout failed: ' + (error as Error).message)
    } finally {
      setIsLayouting(false)
    }
  }

  const handleAutoWire = () => {
    try {
      autoWireCommonNets()
      alert('Connected any detected VCC and GND pins to shared net ports.')
    } catch (error) {
      alert('Auto wire failed: ' + (error as Error).message)
    }
  }

  const handleExportZip = async () => {
    setIsZipExporting(true)
    try {
      const workspaceJson = exportWorkspaceJSON()
      const ws = JSON.parse(workspaceJson) as { name?: string }
      const safeName = (ws.name || 'workspace').replace(/[^a-z0-9_-]/gi, '_')
      const zip = new JSZip()
      const root = zip.folder(safeName) || zip

      Object.entries(fsMap).forEach(([path, content]) => {
        root.file(path, content)
      })

      root.file('workspace-export.json', workspaceJson)

      const zipBlob = await zip.generateAsync({ type: 'blob' })
      downloadBlobFile(zipBlob, `${safeName}-${Date.now()}.zip`)
      alert(`Exported ${Object.keys(fsMap).length} files as a workspace zip.`)
    } catch (error) {
      alert('Failed to export zip: ' + (error as Error).message)
    } finally {
      setIsZipExporting(false)
    }
  }

  const modalBase: React.CSSProperties = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.7)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 1000
  }

  return (
    <div className="editor-header" style={{ display: 'flex', flexDirection: 'column', height: 74, alignItems: 'stretch', paddingTop: 8, paddingBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h1>TSX Schematic Editor</h1>
        <div className="editor-header-actions">
          <button className="btn btn-secondary" onClick={handleAutoLayout} disabled={isLayouting || placedComponents.length === 0}>
            {isLayouting ? 'Layouting...' : 'Auto Layout'}
          </button>
          <button className="btn btn-secondary" onClick={handleAutoWire} disabled={placedComponents.length === 0}>
            Auto Wire
          </button>
          <button className="btn btn-secondary" onClick={removeSelectedComponents} disabled={selectedComponentIds.length === 0}>
            Delete Selected
          </button>
          <button className="btn btn-secondary" onClick={handleExportZip} disabled={isZipExporting || Object.keys(fsMap).length === 0}>
            {isZipExporting ? 'Exporting Zip...' : 'Export Zip'}
          </button>
          <button className="btn btn-primary" onClick={handleCreateSchematicPage}>New Schematic</button>
          <button className="btn btn-secondary" onClick={() => setShowImportDialog(true)}>Import TSX</button>
          {showAdvancedToolbar && (
            <button className="btn btn-secondary" onClick={() => setShowBatchImportDialog(true)}>Import Batch</button>
          )}
          <button className="btn btn-secondary" onClick={() => zipInputRef.current?.click()} disabled={isZipImporting}>
            {isZipImporting ? 'Importing Zip...' : 'Import Zip'}
          </button>
          {showAdvancedToolbar && (
            <button className="btn btn-secondary" onClick={() => setShowPatchDialog(true)}>Apply Patch</button>
          )}
          {showAdvancedToolbar && (
            <button className="btn btn-secondary" onClick={handleCopy}>Copy TSX</button>
          )}
          <button className="btn btn-secondary" onClick={handleExport}>Export Circuit</button>
          {showAdvancedToolbar && (
            <button className="btn btn-secondary" onClick={handleExportWorkspace} title="Download workspace as JSON">Export WS</button>
          )}
          {showAdvancedToolbar && (
            <button className="btn btn-secondary" onClick={() => setShowWsImportDialog(true)} title="Import a workspace JSON">Import WS</button>
          )}
          <button className="btn btn-primary" onClick={() => setShowExportDialog(true)}>Export as Component</button>
        </div>
      </div>

      <input
        ref={zipInputRef}
        type="file"
        accept=".zip"
        onChange={handleZipImport}
        style={{ display: 'none' }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12, color: '#aaa' }}>
        <button className="btn btn-secondary" disabled={breadcrumbStack.length === 0} onClick={goBackFile} style={{ padding: '2px 8px', fontSize: 11 }}>
          Back
        </button>
        <span style={{ padding: '2px 8px', border: '1px solid #505050', borderRadius: 4, color: '#d4d4d4', fontSize: 11, background: '#252526' }}>
          Editing: {currentFileLabel}
        </span>
        <span>{[...breadcrumbStack, activeFilePath].join('  ›  ')}</span>
      </div>

      {showExportDialog && (
        <div style={modalBase}>
          <div style={{ background: '#2d2d2d', padding: 30, borderRadius: 8, minWidth: 400, border: '1px solid #3e3e3e' }}>
            <h2 style={{ marginBottom: 20, fontSize: 18 }}>Export as Reusable Component</h2>
            <div style={{ marginBottom: 20 }}>
              <label className="property-label">Component Name</label>
              <input type="text" className="property-input" value={exportName} onChange={e => setExportName(e.target.value)} placeholder="MyComponent" style={{ fontSize: 14 }} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={handleExportAsComponent} style={{ flex: 1 }}>Export Component</button>
              <button className="btn btn-secondary" onClick={() => setShowExportDialog(false)} style={{ flex: 1 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showImportDialog && (
        <div style={modalBase}>
          <div style={{ background: '#2d2d2d', padding: 30, borderRadius: 8, minWidth: 640, maxWidth: 820, border: '1px solid #3e3e3e' }}>
            <h2 style={{ marginBottom: 20, fontSize: 18 }}>Import Minimal TSX</h2>
            <div style={{ marginBottom: 12, fontSize: 12, color: '#aaa' }}>
              Supported: {'<chip />'}, {'<net />'}, {'<trace from="..." to="..." />'}, {'<board>...</board>'}, {'<subcircuit>...</subcircuit>'}
            </div>
            <textarea
              value={importContent} onChange={e => setImportContent(e.target.value)}
              placeholder="Paste TSX here..."
              style={{ width: '100%', minHeight: 260, resize: 'vertical', background: '#1e1e1e', border: '1px solid #3e3e3e', color: '#d4d4d4', padding: 12, fontFamily: 'monospace', fontSize: 13, borderRadius: 6, marginBottom: 16 }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={handleImport} style={{ flex: 1 }}>Import Into Current File</button>
              <button className="btn btn-secondary" onClick={() => setShowImportDialog(false)} style={{ flex: 1 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showBatchImportDialog && (
        <div style={modalBase}>
          <div style={{ background: '#2d2d2d', padding: 30, borderRadius: 8, minWidth: 640, maxWidth: 860, border: '1px solid #3e3e3e' }}>
            <h2 style={{ marginBottom: 20, fontSize: 18 }}>Batch Import Files</h2>
            <div style={{ marginBottom: 12, fontSize: 12, color: '#aaa' }}>
              Paste a JSON array of file objects or a path-to-content object map. Imported subcircuits are registered automatically for patches, and broken relative imports are rejected.
            </div>
            <textarea
              value={batchImportContent}
              onChange={e => setBatchImportContent(e.target.value)}
              placeholder={'[{"fileName":"Deb_button_test2.tsx","content":"export function Deb_button_test2(...) { ... }"}]'}
              style={{ width: '100%', minHeight: 240, resize: 'vertical', background: '#1e1e1e', border: '1px solid #3e3e3e', color: '#d4d4d4', padding: 12, fontFamily: 'monospace', fontSize: 13, borderRadius: 6, marginBottom: 16 }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={handleBatchImport} style={{ flex: 1 }}>Import Batch</button>
              <button className="btn btn-secondary" onClick={() => setShowBatchImportDialog(false)} style={{ flex: 1 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showPatchDialog && (
        <div style={modalBase}>
          <div style={{ background: '#2d2d2d', padding: 30, borderRadius: 8, minWidth: 520, border: '1px solid #3e3e3e' }}>
            <h2 style={{ marginBottom: 16, fontSize: 18 }}>Apply Patch</h2>
            <div style={{ marginBottom: 12, fontSize: 12, color: '#aaa' }}>
              Patches only activate when their required subcircuits are present in the registry.
            </div>
            <select
              value={selectedPatchId}
              onChange={e => setSelectedPatchId(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', background: '#1e1e1e', border: '1px solid #3e3e3e', color: '#d4d4d4', borderRadius: 6, marginBottom: 12 }}
            >
              <option value="">{applicablePatches.length > 0 ? 'Select a patch' : 'No applicable patches yet'}</option>
              {applicablePatches.map(patch => (
                <option key={patch.id} value={patch.id}>{patch.name}</option>
              ))}
            </select>
            <div style={{ marginBottom: 16, fontSize: 12, color: '#bbb', lineHeight: 1.5 }}>
              {applicablePatches.find(patch => patch.id === selectedPatchId)?.description || applicablePatches[0]?.description || 'Import matching subcircuits first to unlock a patch.'}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={handleApplyPatch} style={{ flex: 1 }} disabled={applicablePatches.length === 0}>Apply Patch</button>
              <button className="btn btn-secondary" onClick={() => setShowPatchDialog(false)} style={{ flex: 1 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showWsImportDialog && (
        <div style={modalBase}>
          <div style={{ background: '#2d2d2d', padding: 30, borderRadius: 8, minWidth: 500, border: '1px solid #3e3e3e' }}>
            <h2 style={{ marginBottom: 20, fontSize: 18 }}>Import Workspace JSON</h2>
            <textarea
              value={wsImportContent} onChange={e => setWsImportContent(e.target.value)}
              placeholder="Paste workspace JSON here..."
              style={{ width: '100%', minHeight: 200, resize: 'vertical', background: '#1e1e1e', border: '1px solid #3e3e3e', color: '#d4d4d4', padding: 12, fontFamily: 'monospace', fontSize: 13, borderRadius: 6, marginBottom: 16 }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={handleImportWorkspace} style={{ flex: 1 }}>Import Workspace</button>
              <button className="btn btn-secondary" onClick={() => setShowWsImportDialog(false)} style={{ flex: 1 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
