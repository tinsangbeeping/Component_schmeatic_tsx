import React, { useEffect, useMemo, useState } from 'react'
import { SymbolDocument, SymbolSelection, SymbolShape, SymbolToolMode } from '../types/symbolDocument'

interface Point {
  x: number
  y: number
}

interface SymbolCanvasProps {
  document: SymbolDocument
  toolMode: SymbolToolMode
  selected: SymbolSelection
  onToolModeChange: (mode: SymbolToolMode) => void
  onSelectionChange: (selection: SymbolSelection) => void
  onDocumentChange: (document: SymbolDocument) => void
}

const snapValue = (value: number): number => Math.round(value)

const nextShapeId = (() => {
  let i = 0
  return (prefix: string) => {
    i += 1
    return `${prefix}-${Date.now()}-${i}`
  }
})()

const toArcPath = (shape: Extract<SymbolShape, { kind: 'schematicarc' }>): string => {
  const startRadians = (shape.startAngleDegrees * Math.PI) / 180
  const endRadians = (shape.endAngleDegrees * Math.PI) / 180
  const sx = shape.center.x + shape.radius * Math.cos(startRadians)
  const sy = shape.center.y + shape.radius * Math.sin(startRadians)
  const ex = shape.center.x + shape.radius * Math.cos(endRadians)
  const ey = shape.center.y + shape.radius * Math.sin(endRadians)
  const delta = ((shape.endAngleDegrees - shape.startAngleDegrees) % 360 + 360) % 360
  const largeArc = delta > 180 ? 1 : 0
  return `M ${sx} ${sy} A ${shape.radius} ${shape.radius} 0 ${largeArc} 1 ${ex} ${ey}`
}

export const SymbolCanvas: React.FC<SymbolCanvasProps> = ({
  document,
  toolMode,
  selected,
  onToolModeChange,
  onSelectionChange,
  onDocumentChange
}) => {
  const WORLD_HALF_EXTENT = 100000
  const WORLD_EXTENT = WORLD_HALF_EXTENT * 2
  const [draftStart, setDraftStart] = useState<Point | null>(null)
  const [draftEnd, setDraftEnd] = useState<Point | null>(null)
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 })
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState<{ clientX: number; clientY: number; viewX: number; viewY: number } | null>(null)
  const [selectionBox, setSelectionBox] = useState<{ start: Point; end: Point } | null>(null)

  const drawingTools: Array<{ mode: SymbolToolMode; label: string }> = [
    { mode: 'select', label: 'select' },
    { mode: 'schematicline', label: 'line' },
    { mode: 'schematicrect', label: 'rect' },
    { mode: 'schematiccircle', label: 'circle' },
    { mode: 'schematicarc', label: 'arc' },
    { mode: 'schematictext', label: 'text' },
    { mode: 'port', label: 'port' }
  ]

  const pointerToCanvasPoint = (event: React.MouseEvent<SVGSVGElement>): Point => {
    const svg = event.currentTarget
    const pt = svg.createSVGPoint()
    pt.x = event.clientX
    pt.y = event.clientY
    const transformed = pt.matrixTransform(svg.getScreenCTM()?.inverse())
    return { x: snapValue(transformed.x), y: snapValue(transformed.y) }
  }

  const deleteSelected = () => {
    if (!selected) return

    if (selected.kind === 'shape') {
      onDocumentChange({
        ...document,
        shapes: document.shapes.filter(shape => shape.id !== selected.id)
      })
      onSelectionChange(null)
      return
    }

    onDocumentChange({
      ...document,
      ports: document.ports.filter(port => port.id !== selected.id)
    })
    onSelectionChange(null)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTyping = !!target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable
      )

      if (isTyping) return

      if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
        event.preventDefault()
        deleteSelected()
        return
      }

      if (event.key === 'o' || event.key === 'O') {
        event.preventDefault()
        setViewport({ x: 0, y: 0, zoom: 1 })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selected])

  const resetDraft = () => {
    setDraftStart(null)
    setDraftEnd(null)
  }

  const handleCanvasMouseDown = (event: React.MouseEvent<SVGSVGElement>) => {
    const point = pointerToCanvasPoint(event)

    if (toolMode === 'select') {
      if (event.ctrlKey || event.metaKey) {
        setSelectionBox({ start: point, end: point })
        return
      }

      setIsPanning(true)
      setPanStart({
        clientX: event.clientX,
        clientY: event.clientY,
        viewX: viewport.x,
        viewY: viewport.y
      })
      return
    }

    if (toolMode === 'schematictext') {
      const text = window.prompt('Text value:', 'Label')
      if (!text) return
      const nextDoc: SymbolDocument = {
        ...document,
        shapes: [...document.shapes, {
          id: nextShapeId('text'),
          kind: 'schematictext',
          schX: point.x,
          schY: point.y,
          text
        }]
      }
      onDocumentChange(nextDoc)
      onToolModeChange('select')
      return
    }

    if (toolMode === 'port') {
      const name = window.prompt('Port name:', 'P1')?.trim()
      if (!name) return
      const direction = (window.prompt('Direction (input/output/inout/passive):', 'passive') || 'passive').trim().toLowerCase()
      const normalizedDirection = ['input', 'output', 'inout', 'passive'].includes(direction) ? direction as 'input' | 'output' | 'inout' | 'passive' : 'passive'
      const nextDoc: SymbolDocument = {
        ...document,
        ports: [...document.ports, {
          id: nextShapeId('port'),
          name,
          direction: normalizedDirection,
          schX: point.x,
          schY: point.y
        }]
      }
      onDocumentChange(nextDoc)
      onToolModeChange('select')
      return
    }

    setDraftStart(point)
    setDraftEnd(point)
  }

  const handleCanvasMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
    if (selectionBox) {
      setSelectionBox({ ...selectionBox, end: pointerToCanvasPoint(event) })
      return
    }

    if (isPanning && panStart) {
      const dx = (event.clientX - panStart.clientX) / viewport.zoom
      const dy = (event.clientY - panStart.clientY) / viewport.zoom
      setViewport(prev => ({
        ...prev,
        x: panStart.viewX - dx,
        y: panStart.viewY - dy
      }))
      return
    }

    if (!draftStart) return
    setDraftEnd(pointerToCanvasPoint(event))
  }

  const handleCanvasMouseUp = () => {
    if (selectionBox) {
      const minX = Math.min(selectionBox.start.x, selectionBox.end.x)
      const maxX = Math.max(selectionBox.start.x, selectionBox.end.x)
      const minY = Math.min(selectionBox.start.y, selectionBox.end.y)
      const maxY = Math.max(selectionBox.start.y, selectionBox.end.y)

      const intersects = (bounds: { minX: number; maxX: number; minY: number; maxY: number }): boolean => {
        return !(bounds.maxX < minX || bounds.minX > maxX || bounds.maxY < minY || bounds.minY > maxY)
      }

      const shapeBounds = (shape: SymbolShape): { minX: number; maxX: number; minY: number; maxY: number } => {
        if (shape.kind === 'schematicline') {
          return {
            minX: Math.min(shape.x1, shape.x2),
            maxX: Math.max(shape.x1, shape.x2),
            minY: Math.min(shape.y1, shape.y2),
            maxY: Math.max(shape.y1, shape.y2)
          }
        }

        if (shape.kind === 'schematicrect') {
          return {
            minX: shape.schX,
            maxX: shape.schX + shape.width,
            minY: shape.schY,
            maxY: shape.schY + shape.height
          }
        }

        if (shape.kind === 'schematiccircle') {
          return {
            minX: shape.center.x - shape.radius,
            maxX: shape.center.x + shape.radius,
            minY: shape.center.y - shape.radius,
            maxY: shape.center.y + shape.radius
          }
        }

        if (shape.kind === 'schematicarc') {
          return {
            minX: shape.center.x - shape.radius,
            maxX: shape.center.x + shape.radius,
            minY: shape.center.y - shape.radius,
            maxY: shape.center.y + shape.radius
          }
        }

        return {
          minX: shape.schX,
          maxX: shape.schX + Math.max(6, shape.text.length * 6),
          minY: shape.schY - 8,
          maxY: shape.schY + 2
        }
      }

      const selectedPort = [...document.ports].reverse().find(port => intersects({
        minX: port.schX - 4,
        maxX: port.schX + 4,
        minY: port.schY - 4,
        maxY: port.schY + 4
      }))

      if (selectedPort) {
        onSelectionChange({ kind: 'port', id: selectedPort.id })
      } else {
        const selectedShape = [...document.shapes].reverse().find(shape => intersects(shapeBounds(shape)))
        onSelectionChange(selectedShape ? { kind: 'shape', id: selectedShape.id } : null)
      }

      setSelectionBox(null)
      return
    }

    if (isPanning) {
      setIsPanning(false)
      setPanStart(null)
      return
    }

    if (!draftStart || !draftEnd) return

    let nextShape: SymbolShape | null = null

    if (toolMode === 'schematicline') {
      nextShape = {
        id: nextShapeId('line'),
        kind: 'schematicline',
        x1: draftStart.x,
        y1: draftStart.y,
        x2: draftEnd.x,
        y2: draftEnd.y
      }
    } else if (toolMode === 'schematicrect') {
      nextShape = {
        id: nextShapeId('rect'),
        kind: 'schematicrect',
        schX: Math.min(draftStart.x, draftEnd.x),
        schY: Math.min(draftStart.y, draftEnd.y),
        width: Math.abs(draftEnd.x - draftStart.x),
        height: Math.abs(draftEnd.y - draftStart.y)
      }
    } else if (toolMode === 'schematiccircle') {
      nextShape = {
        id: nextShapeId('circle'),
        kind: 'schematiccircle',
        center: { x: draftStart.x, y: draftStart.y },
        radius: Math.max(1, Math.round(Math.hypot(draftEnd.x - draftStart.x, draftEnd.y - draftStart.y)))
      }
    } else if (toolMode === 'schematicarc') {
      nextShape = {
        id: nextShapeId('arc'),
        kind: 'schematicarc',
        center: { x: draftStart.x, y: draftStart.y },
        radius: Math.max(1, Math.round(Math.hypot(draftEnd.x - draftStart.x, draftEnd.y - draftStart.y))),
        startAngleDegrees: 0,
        endAngleDegrees: 180
      }
    }

    if (nextShape) {
      onDocumentChange({
        ...document,
        shapes: [...document.shapes, nextShape]
      })
      onSelectionChange({ kind: 'shape', id: nextShape.id })
      onToolModeChange('select')
    }

    resetDraft()
  }

  const handleCanvasWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const cursor = pointerToCanvasPoint(event)
    const oldZoom = viewport.zoom
    const zoomFactor = event.deltaY < 0 ? 1.12 : 1 / 1.12
    const newZoom = Math.max(0.1, Math.min(12, oldZoom * zoomFactor))
    const zoomRatio = oldZoom / newZoom

    setViewport(prev => ({
      x: cursor.x - (cursor.x - prev.x) * zoomRatio,
      y: cursor.y - (cursor.y - prev.y) * zoomRatio,
      zoom: newZoom
    }))
  }

  const draftShape = useMemo<SymbolShape | null>(() => {
    if (!draftStart || !draftEnd) return null

    if (toolMode === 'schematicline') {
      return { id: 'draft', kind: 'schematicline', x1: draftStart.x, y1: draftStart.y, x2: draftEnd.x, y2: draftEnd.y }
    }

    if (toolMode === 'schematicrect') {
      return {
        id: 'draft',
        kind: 'schematicrect',
        schX: Math.min(draftStart.x, draftEnd.x),
        schY: Math.min(draftStart.y, draftEnd.y),
        width: Math.abs(draftEnd.x - draftStart.x),
        height: Math.abs(draftEnd.y - draftStart.y)
      }
    }

    if (toolMode === 'schematiccircle') {
      return {
        id: 'draft',
        kind: 'schematiccircle',
        center: { x: draftStart.x, y: draftStart.y },
        radius: Math.max(1, Math.round(Math.hypot(draftEnd.x - draftStart.x, draftEnd.y - draftStart.y)))
      }
    }

    if (toolMode === 'schematicarc') {
      return {
        id: 'draft',
        kind: 'schematicarc',
        center: { x: draftStart.x, y: draftStart.y },
        radius: Math.max(1, Math.round(Math.hypot(draftEnd.x - draftStart.x, draftEnd.y - draftStart.y))),
        startAngleDegrees: 0,
        endAngleDegrees: 180
      }
    }

    return null
  }, [draftEnd, draftStart, toolMode])

  const renderShape = (shape: SymbolShape, isDraft = false) => {
    const isSelected = !isDraft && selected?.kind === 'shape' && selected.id === shape.id
    const stroke = isSelected ? '#2ea8ff' : '#88d498'
    const common = {
      stroke,
      strokeWidth: isSelected ? 2 : 1.4,
      fill: 'none' as const,
      opacity: isDraft ? 0.6 : 1,
      onMouseDown: (event: React.MouseEvent) => {
        event.stopPropagation()
        onSelectionChange({ kind: 'shape', id: shape.id })
        onToolModeChange('select')
      }
    }

    if (shape.kind === 'schematicline') {
      return <line key={shape.id} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} {...common} />
    }

    if (shape.kind === 'schematicrect') {
      return <rect key={shape.id} x={shape.schX} y={shape.schY} width={shape.width} height={shape.height} {...common} />
    }

    if (shape.kind === 'schematiccircle') {
      return <circle key={shape.id} cx={shape.center.x} cy={shape.center.y} r={shape.radius} {...common} />
    }

    if (shape.kind === 'schematicarc') {
      return <path key={shape.id} d={toArcPath(shape)} {...common} />
    }

    return (
      <text
        key={shape.id}
        x={shape.schX}
        y={shape.schY}
        fill={isSelected ? '#2ea8ff' : '#f2f2f2'}
        fontSize={8}
        onMouseDown={(event) => {
          event.stopPropagation()
          onSelectionChange({ kind: 'shape', id: shape.id })
          onToolModeChange('select')
        }}
      >
        {shape.text}
      </text>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#1a1a1a', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid #2f2f2f', background: '#202020' }}>
        {drawingTools.map(item => (
          <button
            key={item.mode}
            className={toolMode === item.mode ? 'btn btn-primary' : 'btn btn-secondary'}
            onClick={() => onToolModeChange(item.mode)}
            style={{ fontSize: 11, padding: '3px 8px' }}
          >
            {item.label}
          </button>
        ))}
        <button
          className="btn btn-secondary"
          onClick={deleteSelected}
          disabled={!selected}
          style={{ fontSize: 11, padding: '3px 8px' }}
        >
          Delete
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => setViewport({ x: 0, y: 0, zoom: 1 })}
          style={{ fontSize: 11, padding: '3px 8px' }}
          title="Back to origin (shortcut: O)"
        >
          Origin
        </button>
        <span style={{ marginLeft: 'auto', color: '#9a9a9a', fontSize: 12 }}>
          {document.width} x {document.height} | {viewport.zoom.toFixed(2)}x
        </span>
      </div>

      <div style={{ flex: 1, padding: 10, minHeight: 0 }}>
        <svg
          viewBox={`${viewport.x} ${viewport.y} ${document.width / viewport.zoom} ${document.height / viewport.zoom}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', background: '#151515', border: '1px solid #2f2f2f' }}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onWheel={handleCanvasWheel}
        >
          <defs>
            <pattern id="symbol-grid" width="10" height="10" patternUnits="userSpaceOnUse">
              <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#252525" strokeWidth="0.6" />
            </pattern>
          </defs>
          <rect x={-WORLD_HALF_EXTENT} y={-WORLD_HALF_EXTENT} width={WORLD_EXTENT} height={WORLD_EXTENT} fill="url(#symbol-grid)" />

          {document.shapes.map(shape => renderShape(shape))}
          {document.ports.map(port => {
            const isSelected = selected?.kind === 'port' && selected.id === port.id
            const color = isSelected ? '#2ea8ff' : '#ffd166'
            return (
              <g
                key={port.id}
                onMouseDown={(event) => {
                  event.stopPropagation()
                  onSelectionChange({ kind: 'port', id: port.id })
                  onToolModeChange('select')
                }}
              >
                <circle cx={port.schX} cy={port.schY} r={2.6} stroke={color} fill="none" strokeWidth={1.3} />
                <line x1={port.schX - 7} y1={port.schY} x2={port.schX + 7} y2={port.schY} stroke={color} strokeWidth={1.2} />
                <text x={port.schX + 4} y={port.schY - 4} fill={color} fontSize={7}>{port.name}</text>
              </g>
            )
          })}

          {selectionBox && (
            <rect
              x={Math.min(selectionBox.start.x, selectionBox.end.x)}
              y={Math.min(selectionBox.start.y, selectionBox.end.y)}
              width={Math.abs(selectionBox.end.x - selectionBox.start.x)}
              height={Math.abs(selectionBox.end.y - selectionBox.start.y)}
              fill="rgba(0, 122, 204, 0.15)"
              stroke="#2ea8ff"
              strokeWidth={1.2}
              strokeDasharray="4 3"
            />
          )}

          {draftShape && renderShape(draftShape, true)}
        </svg>
      </div>
    </div>
  )
}
