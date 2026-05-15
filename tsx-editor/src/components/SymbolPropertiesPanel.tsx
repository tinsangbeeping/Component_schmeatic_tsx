import React from 'react'
import { ElectricalDirection, SymbolDocument, SymbolSelection, SymbolShape } from '../types/symbolDocument'

interface SymbolPropertiesPanelProps {
  document: SymbolDocument
  selected: SymbolSelection
  onSelectionChange: (selection: SymbolSelection) => void
  onDocumentChange: (document: SymbolDocument) => void
  onExportTsx: () => void
}

const toNumber = (value: string, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const updateShape = (document: SymbolDocument, shapeId: string, updater: (shape: SymbolShape) => SymbolShape): SymbolDocument => {
  return {
    ...document,
    shapes: document.shapes.map(shape => (shape.id === shapeId ? updater(shape) : shape))
  }
}

const electricalDirections: ElectricalDirection[] = ['input', 'output', 'inout', 'passive']

export const SymbolPropertiesPanel: React.FC<SymbolPropertiesPanelProps> = ({
  document,
  selected,
  onSelectionChange,
  onDocumentChange,
  onExportTsx
}) => {
  const selectedShape = selected?.kind === 'shape'
    ? document.shapes.find(shape => shape.id === selected.id) || null
    : null
  const selectedPort = selected?.kind === 'port'
    ? document.ports.find(port => port.id === selected.id) || null
    : null
  const selectedMulti = selected?.kind === 'multi' ? selected : null

  return (
    <div className="enhanced-properties-panel">
      <div className="inspector-banner">
        <div>
          <div className="inspector-title">Symbol Maker</div>
          <div className="inspector-subtitle">JSON source of truth for symbol primitives and ports.</div>
        </div>
        <div className="inspector-stats">
          <span className="inspector-stat">{document.shapes.length} shapes</span>
          <span className="inspector-stat">{document.ports.length} ports</span>
        </div>
      </div>

      <div style={{ padding: 12, display: 'grid', gap: 10 }}>
        <div className="property-group">
          <label>Name</label>
          <input
            value={document.name}
            onChange={(event) => onDocumentChange({ ...document, name: event.target.value.replace(/[^a-zA-Z0-9_]/g, '_') })}
          />
        </div>
        <div className="property-group">
          <label>Description</label>
          <input
            value={document.description}
            onChange={(event) => onDocumentChange({ ...document, description: event.target.value })}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div className="property-group">
            <label>Width</label>
            <input
              type="number"
              value={document.width}
              onChange={(event) => onDocumentChange({ ...document, width: Math.max(20, toNumber(event.target.value, document.width)) })}
            />
          </div>
          <div className="property-group">
            <label>Height</label>
            <input
              type="number"
              value={document.height}
              onChange={(event) => onDocumentChange({ ...document, height: Math.max(20, toNumber(event.target.value, document.height)) })}
            />
          </div>
        </div>

        <button className="btn btn-primary" onClick={onExportTsx}>Export Symbol TSX</button>

        <div style={{ marginTop: 8, fontSize: 12, color: '#aaa' }}>
          Selected: {selectedShape
            ? `${selectedShape.kind} (${selectedShape.id})`
            : selectedPort
            ? `port (${selectedPort.id})`
            : selectedMulti
            ? `${selectedMulti.shapeIds.length} shape(s), ${selectedMulti.portIds.length} port(s)`
            : 'none'}
        </div>

        {selectedMulti && (
          <div style={{ borderTop: '1px solid #3e3e3e', paddingTop: 10, display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 12, color: '#bbb' }}>
              Group selection active. Primitive-level fields are disabled for multi-edit.
            </div>
            <button
              className="btn btn-secondary"
              style={{ width: '100%' }}
              onClick={() => {
                const shapeSet = new Set(selectedMulti.shapeIds)
                const portSet = new Set(selectedMulti.portIds)
                onDocumentChange({
                  ...document,
                  shapes: document.shapes.filter(shape => !shapeSet.has(shape.id)),
                  ports: document.ports.filter(port => !portSet.has(port.id))
                })
                onSelectionChange(null)
              }}
            >
              Delete Selected Group
            </button>
          </div>
        )}

        {selectedShape && (
          <div style={{ borderTop: '1px solid #3e3e3e', paddingTop: 10 }}>
            {selectedShape.kind === 'schematicline' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input type="number" value={selectedShape.x1} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, x1: toNumber(e.target.value, selectedShape.x1) })))} />
                <input type="number" value={selectedShape.y1} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, y1: toNumber(e.target.value, selectedShape.y1) })))} />
                <input type="number" value={selectedShape.x2} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, x2: toNumber(e.target.value, selectedShape.x2) })))} />
                <input type="number" value={selectedShape.y2} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, y2: toNumber(e.target.value, selectedShape.y2) })))} />
              </div>
            )}

            {selectedShape.kind === 'schematicrect' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input type="number" value={selectedShape.cx} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, cx: toNumber(e.target.value, selectedShape.cx) } as SymbolShape)))} />
                <input type="number" value={selectedShape.cy} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, cy: toNumber(e.target.value, selectedShape.cy) } as SymbolShape)))} />
                <input type="number" value={selectedShape.width} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, width: Math.max(1, toNumber(e.target.value, selectedShape.width)) })))} />
                <input type="number" value={selectedShape.height} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, height: Math.max(1, toNumber(e.target.value, selectedShape.height)) })))} />
              </div>
            )}

            {selectedShape.kind === 'schematiccircle' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input type="number" value={selectedShape.cx} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, cx: toNumber(e.target.value, selectedShape.cx) } as SymbolShape)))} />
                <input type="number" value={selectedShape.cy} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, cy: toNumber(e.target.value, selectedShape.cy) } as SymbolShape)))} />
                <input type="number" value={selectedShape.radius} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, radius: Math.max(1, toNumber(e.target.value, selectedShape.radius)) })))} />
              </div>
            )}

            {selectedShape.kind === 'schematicarc' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input type="number" value={selectedShape.cx} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, cx: toNumber(e.target.value, selectedShape.cx) } as SymbolShape)))} />
                <input type="number" value={selectedShape.cy} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, cy: toNumber(e.target.value, selectedShape.cy) } as SymbolShape)))} />
                <input type="number" value={selectedShape.radius} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, radius: Math.max(1, toNumber(e.target.value, selectedShape.radius)) })))} />
                <input type="number" value={selectedShape.startAngle} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, startAngle: toNumber(e.target.value, selectedShape.startAngle) } as SymbolShape)))} />
                <input type="number" value={selectedShape.endAngle} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, endAngle: toNumber(e.target.value, selectedShape.endAngle) } as SymbolShape)))} />
                <select value={selectedShape.direction || 'clockwise'} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, direction: e.target.value as 'clockwise' | 'counterclockwise' } as SymbolShape)))}>
                  <option value="clockwise">clockwise</option>
                  <option value="counterclockwise">counterclockwise</option>
                </select>
              </div>
            )}

            {selectedShape.kind === 'schematictext' && (
              <div style={{ display: 'grid', gap: 8 }}>
                <input value={selectedShape.text} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, text: e.target.value })))} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <input type="number" value={selectedShape.x} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, x: toNumber(e.target.value, selectedShape.x) } as SymbolShape)))} />
                  <input type="number" value={selectedShape.y} onChange={e => onDocumentChange(updateShape(document, selectedShape.id, shape => ({ ...shape as any, y: toNumber(e.target.value, selectedShape.y) } as SymbolShape)))} />
                </div>
              </div>
            )}

            <button
              className="btn btn-secondary"
              style={{ marginTop: 10, width: '100%' }}
              onClick={() => {
                onDocumentChange({ ...document, shapes: document.shapes.filter(shape => shape.id !== selectedShape.id) })
                onSelectionChange(null)
              }}
            >
              Delete Selected Shape
            </button>
          </div>
        )}

        {selectedPort && (
          <div style={{ borderTop: '1px solid #3e3e3e', paddingTop: 10, display: 'grid', gap: 8 }}>
            <input value={selectedPort.name} onChange={e => onDocumentChange({ ...document, ports: document.ports.map(port => port.id === selectedPort.id ? { ...port, name: e.target.value } : port) })} />
            <select
              value={selectedPort.electricalDirection || 'passive'}
              onChange={e => onDocumentChange({ ...document, ports: document.ports.map(port => port.id === selectedPort.id ? { ...port, electricalDirection: e.target.value as ElectricalDirection } : port) })}
            >
              {electricalDirections.map(direction => <option key={direction} value={direction}>{direction}</option>)}
            </select>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input type="number" value={selectedPort.x} onChange={e => onDocumentChange({ ...document, ports: document.ports.map(port => port.id === selectedPort.id ? { ...port, x: toNumber(e.target.value, selectedPort.x) } : port) })} />
              <input type="number" value={selectedPort.y} onChange={e => onDocumentChange({ ...document, ports: document.ports.map(port => port.id === selectedPort.id ? { ...port, y: toNumber(e.target.value, selectedPort.y) } : port) })} />
            </div>
            <button
              className="btn btn-secondary"
              style={{ width: '100%' }}
              onClick={() => {
                onDocumentChange({ ...document, ports: document.ports.filter(port => port.id !== selectedPort.id) })
                onSelectionChange(null)
              }}
            >
              Delete Selected Port
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
