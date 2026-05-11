import React, { useMemo, useState } from 'react'
import { getAllCatalogItems } from '../catalog'
import { CatalogItem } from '../types/catalog'
import { useEditorStore } from '../store/editorStore'
import { buildWorkspaceComponentRegistry, buildWorkspaceSymbolRegistry, extractAllSubcircuits, extractAllSymbols } from '../utils/projectManager'

interface CatalogPanelProps {
  onDragStart: (item: CatalogItem) => void
  embedded?: boolean
}

export const CatalogPanel: React.FC<CatalogPanelProps> = ({ onDragStart, embedded = false }) => {
  const [searchQuery, setSearchQuery] = useState('')
  const [mode, setMode] = useState<'all' | 'components' | 'subcircuits'>('all')
  const { fsMap, setFSMap } = useEditorStore()

  const primitiveIds = new Set([
    'schematicline',
    'schematicrect',
    'schematiccircle',
    'schematicarc',
    'schematicpath',
    'schematictext'
  ])
  const showPrimitiveTools = typeof window !== 'undefined' && (window as any).__SHOW_PRIMITIVE_TOOLS === true
  const showAdvancedConnectivity = typeof window !== 'undefined' && (window as any).__SHOW_ADVANCED_CONNECTIVITY === true

  const partItems = useMemo(
    () => getAllCatalogItems()
      .filter(item => item.metadata.kind === 'part')
      .filter(item => showPrimitiveTools || !primitiveIds.has(item.metadata.id)),
    [showPrimitiveTools]
  )
  const quickItems = useMemo(() => partItems.filter(item => ['resistor', 'capacitor', 'chip', 'customchip'].includes(item.metadata.id)), [partItems])

  const realComponentIds = new Set([
    'resistor', 'capacitor', 'inductor', 'diode', 'led', 'transistor',
    'chip', 'customchip', 'switch', 'pushbutton', 'pinheader', 'testpoint', 'voltageprobe', 'voltagesource'
  ])
  const connectivityToolIds = new Set(['trace', 'netlabel'])
  const advancedIds = new Set(['net', 'jumper', 'solderjumper', ...primitiveIds])

  const subcircuits = extractAllSubcircuits(fsMap).map(subcircuit => ({
    name: subcircuit.name,
    path: subcircuit.filePath,
    ports: subcircuit.ports,
    isUserCreated: true
  }))

  const filteredParts = searchQuery
    ? partItems.filter(item =>
        item.metadata.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.metadata.description?.toLowerCase() || '').includes(searchQuery.toLowerCase()) ||
        item.metadata.id.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : partItems

  const symbolComponents = extractAllSymbols(fsMap)
    .filter(symbol => !searchQuery || symbol.name.toLowerCase().includes(searchQuery.toLowerCase()))

  const workspaceSymbolRegistry = buildWorkspaceSymbolRegistry(fsMap)
  const workspaceComponentRegistry = buildWorkspaceComponentRegistry(fsMap)
  const customChipComponents = Object.values(workspaceComponentRegistry)
    .filter(component => component.role === 'custom-chip')
    .filter(component => !searchQuery || component.componentType.toLowerCase().includes(searchQuery.toLowerCase()))

  const realComponentItems = filteredParts.filter(item => realComponentIds.has(item.metadata.id))
  const connectivityItems = filteredParts.filter(item => connectivityToolIds.has(item.metadata.id))
  const advancedItems = filteredParts.filter(item => advancedIds.has(item.metadata.id))

  const filteredSubcircuits = searchQuery
    ? subcircuits.filter(({ name }) =>
        name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : subcircuits

  const handleDragStart = (e: React.DragEvent, item: CatalogItem) => {
    e.dataTransfer.setData('catalogItemId', item.metadata.id)
    onDragStart(item)
  }

  const handleSubcircuitDragStart = (e: React.DragEvent, subcircuitName: string, subcircuitPath: string) => {
    e.dataTransfer.setData('subcircuitName', subcircuitName)
    e.dataTransfer.setData('subcircuitPath', subcircuitPath)
    const subcircuitItem: CatalogItem = {
      metadata: {
        id: subcircuitName,
        label: subcircuitName,
        kind: 'subcircuit',
        category: 'Subcircuits',
        editablePropsSchema: {},
        defaultProps: { name: subcircuitName }
      },
      emitTSX: (props) => `<${subcircuitName} name="${subcircuitName}_1" schX={${props.schX}} schY={${props.schY}} />`
    }
    onDragStart(subcircuitItem)
  }

  const handleSymbolDragStart = (
    e: React.DragEvent,
    symbolName: string,
    symbolPath: string,
    ports: Array<{ name: string; x: number; y: number }>,
    geometry?: {
      width: number
      height: number
      origin: { x: number; y: number }
      shapes: Array<Record<string, any>>
    }
  ) => {
    e.dataTransfer.setData('symbolComponentName', symbolName)
    e.dataTransfer.setData('symbolComponentPath', symbolPath)
    e.dataTransfer.setData('symbolComponentPorts', JSON.stringify(ports.map(port => port.name)))
    e.dataTransfer.setData('symbolComponentPortGeometry', JSON.stringify(ports))
    if (geometry) {
      e.dataTransfer.setData('symbolComponentGeometry', JSON.stringify(geometry))
    }
    const symbolItem: CatalogItem = {
      metadata: {
        id: symbolName,
        label: symbolName,
        kind: 'subcircuit',
        category: 'Symbols',
        editablePropsSchema: {},
        defaultProps: { name: `${symbolName}1` }
      },
      emitTSX: (props) => `<${symbolName} name="${symbolName}1" schX={${props.schX}} schY={${props.schY}} />`
    }
    onDragStart(symbolItem)
  }

  const handleWorkspaceComponentDragStart = (
    e: React.DragEvent,
    componentType: string
  ) => {
    const componentDef = workspaceComponentRegistry[componentType]
    if (!componentDef) return
    const symbol = workspaceSymbolRegistry[componentDef.symbolRef]

    e.dataTransfer.setData('workspaceComponentType', componentDef.componentType)
    e.dataTransfer.setData('workspaceComponentSymbolRef', componentDef.symbolRef)
    e.dataTransfer.setData('workspaceComponentPins', JSON.stringify(componentDef.pins || []))
    if (componentDef.sourceFilePath) {
      e.dataTransfer.setData('workspaceComponentSourcePath', componentDef.sourceFilePath)
    }
    if (symbol) {
      e.dataTransfer.setData('workspaceComponentPortGeometry', JSON.stringify(symbol.ports || []))
      if (symbol.geometry) {
        e.dataTransfer.setData('workspaceComponentGeometry', JSON.stringify(symbol.geometry))
      }
    }

    const item: CatalogItem = {
      metadata: {
        id: componentDef.componentType,
        label: componentDef.componentType,
        kind: 'part',
        category: 'Custom Chips',
        editablePropsSchema: {},
        defaultProps: { name: 'U1' }
      },
      emitTSX: (props) => `<${componentDef.componentType} name="${props.name || 'U1'}" schX={${props.schX}} schY={${props.schY}} />`
    }
    onDragStart(item)
  }

  const getDisplayLabel = (item: CatalogItem): string => {
    if (item.metadata.id === 'trace') return 'Wire Tool'
    if (item.metadata.id === 'netlabel') return 'Net Label Tool'
    if (item.metadata.id === 'net') return 'Named Net (Advanced)'
    if (item.metadata.id === 'jumper') return 'Physical Jumper Component'
    if (item.metadata.id === 'solderjumper') return 'PCB Solder Jumper Component'
    return item.metadata.label
  }

  const handleDeleteSubcircuit = (path: string, name: string) => {
    if (confirm(`Delete subcircuit "${name}"?`)) {
      const newFsMap = { ...fsMap }
      delete newFsMap[path]
      setFSMap(newFsMap)
      setTimeout(() => useEditorStore.getState().regenerateTSX(), 0)
    }
  }

  const panelContent = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Search bar */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #3e3e3e' }}>
        <input
          type="text"
          placeholder="Search components..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            padding: '6px 10px',
            background: '#1e1e1e',
            border: '1px solid #3e3e3e',
            borderRadius: '4px',
            color: '#cccccc',
            fontSize: '13px',
            outline: 'none'
          }}
          onFocus={(e) => e.target.style.borderColor = '#007acc'}
          onBlur={(e) => e.target.style.borderColor = '#3e3e3e'}
        />
      </div>

      <div className="catalog-tabs">
        <button
          className={`catalog-tab ${mode === 'all' ? 'active' : ''}`}
          onClick={() => setMode('all')}
          style={{ flex: 1 }}
        >
          All
        </button>
        <button
          className={`catalog-tab ${mode === 'components' ? 'active' : ''}`}
          onClick={() => setMode('components')}
          style={{ flex: 1 }}
        >
          Components
        </button>
        <button
          className={`catalog-tab ${mode === 'subcircuits' ? 'active' : ''}`}
          onClick={() => setMode('subcircuits')}
          style={{ flex: 1 }}
        >
          Subcircuits
        </button>
      </div>
      
      <div className="catalog-items" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        <div style={{ padding: '6px 4px 10px', color: '#888', fontSize: 11, fontWeight: 600 }}>
          Quick Add
        </div>
        {quickItems.map((item) => (
          <div
            key={`quick-${item.metadata.id}`}
            className="catalog-item"
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
          >
            <div className="catalog-item-label">{getDisplayLabel(item)}</div>
            {item.metadata.description && (
              <div className="catalog-item-desc">{item.metadata.description}</div>
            )}
          </div>
        ))}

        {mode !== 'components' && (
          <>
            <div style={{ padding: mode === 'all' ? '12px 4px 10px' : '6px 4px 10px', color: '#888', fontSize: 11, fontWeight: 600 }}>
              Subcircuits
            </div>
            {filteredSubcircuits.length === 0 ? (
          <div style={{ padding: '12px 8px', color: '#888', fontSize: 12, lineHeight: 1.4 }}>
            {searchQuery ? 'No matching subcircuits.' : 'No subcircuits yet. Select components and click "Create Subcircuit".'}
          </div>
            ) : (
              filteredSubcircuits.map(({ name, path }) => (
            <div
              key={path}
              className="catalog-item"
              draggable
              onDragStart={(e) => handleSubcircuitDragStart(e, name, path)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <div style={{ flex: 1 }}>
                <div className="catalog-item-label">{name}</div>
                <div className="catalog-item-desc">Reusable subcircuit</div>
              </div>
              <button
                className="btn"
                style={{
                  padding: '2px 8px',
                  fontSize: 11,
                  background: '#d32f2f',
                  color: 'white'
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  handleDeleteSubcircuit(path, name)
                }}
                title="Delete subcircuit"
              >
                ×
              </button>
            </div>
              ))
            )}
          </>
        )}

        {mode !== 'subcircuits' && (
          <>
            <div style={{ padding: '6px 4px 10px', color: '#888', fontSize: 11, fontWeight: 600 }}>
              Real Components
            </div>
            {realComponentItems.map((item) => (
              <div
                key={item.metadata.id}
                className="catalog-item"
                draggable
                onDragStart={(e) => handleDragStart(e, item)}
              >
                <div className="catalog-item-label">{getDisplayLabel(item)}</div>
                {item.metadata.description && (
                  <div className="catalog-item-desc">{item.metadata.description}</div>
                )}
              </div>
            ))}

            {symbolComponents.length > 0 && (
              <>
                {customChipComponents.length > 0 && (
                  <>
                    <div style={{ padding: '6px 4px 10px', color: '#888', fontSize: 11, fontWeight: 600 }}>
                      Custom Chip Components
                    </div>
                    {customChipComponents.map(component => (
                      <div
                        key={`custom-chip-${component.componentType}`}
                        className="catalog-item"
                        draggable
                        onDragStart={(e) => handleWorkspaceComponentDragStart(e, component.componentType)}
                        title="Drag onto canvas to place custom chip component"
                      >
                        <div className="catalog-item-label">{component.componentType}</div>
                        <div className="catalog-item-desc">
                          {`symbolRef: ${component.symbolRef} | pins: ${component.pins.length}`}
                        </div>
                      </div>
                    ))}
                  </>
                )}

                <div style={{ padding: '6px 4px 10px', color: '#888', fontSize: 11, fontWeight: 600 }}>
                  Custom Symbol Components
                </div>
                {symbolComponents.map(symbol => (
                  <div
                    key={symbol.filePath}
                    className="catalog-item"
                    draggable
                    onDragStart={(e) => handleSymbolDragStart(e, symbol.name, symbol.filePath, symbol.ports, symbol.geometry)}
                    title="Drag onto canvas to place symbol component"
                  >
                    <div className="catalog-item-label">{symbol.name}</div>
                    <div className="catalog-item-desc">
                      {symbol.ports.length > 0 ? `Pins: ${symbol.ports.map(p => p.name).join(', ')}` : 'No ports'}
                    </div>
                  </div>
                ))}
              </>
            )}

            <div style={{ padding: '8px 4px 10px', color: '#888', fontSize: 11, fontWeight: 600 }}>
              Connectivity Tools
            </div>
            {connectivityItems.map((item) => (
              <div
                key={item.metadata.id}
                className="catalog-item"
                draggable={item.metadata.id !== 'trace'}
                onDragStart={(e) => {
                  if (item.metadata.id === 'trace') return
                  handleDragStart(e, item)
                }}
              >
                <div className="catalog-item-label">{getDisplayLabel(item)}</div>
                <div className="catalog-item-desc">
                  {item.metadata.id === 'trace'
                    ? 'Tool mode: click one pin then another pin to connect.'
                    : item.metadata.description}
                </div>
              </div>
            ))}

            {showAdvancedConnectivity && advancedItems.length > 0 && (
              <>
                <div style={{ padding: '8px 4px 10px', color: '#888', fontSize: 11, fontWeight: 600 }}>
                  Advanced / PCB / Special
                </div>
                {advancedItems.map((item) => (
                  <div
                    key={item.metadata.id}
                    className="catalog-item"
                    draggable
                    onDragStart={(e) => handleDragStart(e, item)}
                  >
                    <div className="catalog-item-label">{getDisplayLabel(item)}</div>
                    {item.metadata.description && (
                      <div className="catalog-item-desc">{item.metadata.description}</div>
                    )}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )

  if (embedded) {
    return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>{panelContent}</div>
  }

  return (
    <div className="left-panel">
      <div className="panel-header">Component Library</div>
      {panelContent}
    </div>
  )
}
