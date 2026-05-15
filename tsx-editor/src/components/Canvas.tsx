import React, { ReactNode, useRef, useState, useEffect, useMemo } from 'react'
import { useEditorStore } from '../store/editorStore'
import { PlacedComponent } from '../types/catalog'
import { getCatalogItem } from '../catalog'
import { SchematicSymbol } from './SchematicSymbol'
import { getPinConfig } from '../types/schematic'
import { SymbolDefinition } from '../types/project'
import { buildWorkspaceComponentRegistry, buildWorkspaceSymbolRegistry, extractAllSubcircuits, extractAllSymbols } from '../utils/projectManager'
import { getSymbolBounds, getSymbolBoundsFromGeometry } from '../utils/symbolBounds'
import { buildCustomChipLayout } from '../utils/customChipLayout'
import { getArcEndpoint } from '../utils/arcAngles'

const normalizeSymbolRef = (value: string): string => {
  const trimmed = String(value || '').trim().replace(/\\/g, '/')
  if (!trimmed) return ''

  let normalized = trimmed
    .replace(/^\.?\//, '')
    .replace(/^\/+/, '')

  normalized = normalized.replace(/^symbols\/(?:\.editor|editor)\//, '')
  normalized = normalized.replace(/^symbols\//, '')
  normalized = normalized.replace(/\.symbol\.json$/i, '')
  normalized = normalized.replace(/\.(tsx|ts)$/i, '')

  return normalized
}

export const Canvas: React.FC = () => {
  type LocalTransform = {
    translateX: number
    translateY: number
  }

  type ResolvedSymbolData = {
    symbolDefinition?: SymbolDefinition
    symbolRefRaw: string
    symbolRefNormalized: string
    hasSymbolLink: boolean
    width: number
    height: number
    origin: { x: number; y: number }
    bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
    localTransform: LocalTransform
    ports: Array<{ name: string; schX: number; schY: number; side?: string; order?: number }>
    shapes: Array<any>
  }

  const applyLocalTransformPoint = (x: number, y: number, localTransform: LocalTransform) => ({
    x: Number(x || 0) + localTransform.translateX,
    y: Number(y || 0) + localTransform.translateY
  })

  const renderSymbolPrimitive = (
    shape: any,
    localTransform: LocalTransform,
    strokeColor: string,
    key: string
  ): ReactNode => {
    if (shape.kind === 'schematicline') {
      const p1 = applyLocalTransformPoint(Number(shape.x1 || 0), Number(shape.y1 || 0), localTransform)
      const p2 = applyLocalTransformPoint(Number(shape.x2 || 0), Number(shape.y2 || 0), localTransform)
      return <line key={key} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={strokeColor} strokeWidth={2} />
    }

    if (shape.kind === 'schematicrect') {
      const width = Math.max(1, Number(shape.width || 1))
      const height = Math.max(1, Number(shape.height || 1))
      const hasTopLeft = Number.isFinite(Number(shape.x)) && Number.isFinite(Number(shape.y))
      const topLeft = applyLocalTransformPoint(
        Number(shape.cx ?? shape.schX ?? (hasTopLeft ? Number(shape.x) + width / 2 : 0)) - width / 2,
        Number(shape.cy ?? shape.schY ?? (hasTopLeft ? Number(shape.y) + height / 2 : 0)) - height / 2,
        localTransform
      )
      return (
        <rect
          key={key}
          x={topLeft.x}
          y={topLeft.y}
          width={width}
          height={height}
          stroke={strokeColor}
          strokeWidth={2}
          fill="none"
        />
      )
    }

    if (shape.kind === 'schematiccircle') {
      const center = applyLocalTransformPoint(Number(shape.cx ?? shape.center?.x ?? 0), Number(shape.cy ?? shape.center?.y ?? 0), localTransform)
      return (
        <circle
          key={key}
          cx={center.x}
          cy={center.y}
          r={Math.max(1, Number(shape.radius || 1))}
          stroke={strokeColor}
          strokeWidth={2}
          fill="none"
        />
      )
    }

    if (shape.kind === 'schematicarc') {
      const center = applyLocalTransformPoint(Number(shape.cx ?? shape.center?.x ?? 0), Number(shape.cy ?? shape.center?.y ?? 0), localTransform)
      const radius = Math.max(1, Number(shape.radius || 1))
      const startAngle = Number((shape.startAngle ?? shape.startAngleDegrees) || 0)
      const endAngle = Number((shape.endAngle ?? shape.endAngleDegrees) || 180)
      const direction = String(shape.direction || 'clockwise').toLowerCase() === 'counterclockwise' ? 'counterclockwise' : 'clockwise'
      const startPoint = getArcEndpoint(center.x, center.y, radius, startAngle)
      const endPoint = getArcEndpoint(center.x, center.y, radius, endAngle)
      const delta = direction === 'counterclockwise'
        ? ((startAngle - endAngle) % 360 + 360) % 360
        : ((endAngle - startAngle) % 360 + 360) % 360
      const largeArc = delta > 180 ? 1 : 0
      const sweepFlag = direction === 'counterclockwise' ? 0 : 1
      const d = `M ${startPoint.x} ${startPoint.y} A ${radius} ${radius} 0 ${largeArc} ${sweepFlag} ${endPoint.x} ${endPoint.y}`
      return <path key={key} d={d} stroke={strokeColor} strokeWidth={2} fill="none" />
    }

    if (shape.kind === 'schematictext') {
      const origin = applyLocalTransformPoint(Number(shape.x ?? shape.schX ?? 0), Number(shape.y ?? shape.schY ?? 0), localTransform)
      return <text key={key} x={origin.x} y={origin.y} fill={strokeColor} fontSize={10}>{String(shape.text || '')}</text>
    }

    return null
  }

  const SNAP_STEP = 2
  const CANVAS_HALF_EXTENT = 100000
  const CANVAS_EXTENT = CANVAS_HALF_EXTENT * 2
  const canvasRef = useRef<HTMLDivElement>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState({ x: 0, y: 0 })
  const [draggedComponentId, setDraggedComponentId] = useState<string | null>(null)
  const [hoveredPin, setHoveredPin] = useState<{ componentId: string; pinName: string } | null>(null)
  const [cursorStyle, setCursorStyle] = useState<string>('default')
  const [selectionBox, setSelectionBox] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null)
  const [isBoxSelecting, setIsBoxSelecting] = useState(false)

  const {
    placedComponents,
    wires,
    selectedComponentIds,
    wiringStart,
    cursorNearPin,
    subcircuitCreation,
    viewport,
    setViewport,
    setSelectedComponents,
    toggleComponentSelection,
    updatePlacedComponent,
    addPlacedComponent,
    startWiring,
    completeWiring,
    cancelWiring,
    removeWire,
    disconnectPin,
    toggleSubcircuitPinSelection,
    setCursorNearPin,
    openSubcircuitEditor,
    insertSubcircuitInstance,
    setActiveFilePath,
    fsMap
  } = useEditorStore()

  const workspaceSymbolRegistry = useMemo(() => buildWorkspaceSymbolRegistry(fsMap), [fsMap])

  const symbolRegistryByName = useMemo(() => {
    const map = new Map<string, SymbolDefinition>()

    const addAlias = (symbol: SymbolDefinition, alias: string) => {
      const key = normalizeSymbolRef(alias)
      if (!key) return
      map.set(key, symbol)
    }

    const allSymbols = extractAllSymbols(fsMap)
    allSymbols.forEach((symbol) => {
      addAlias(symbol, symbol.id)
      addAlias(symbol, symbol.name)
      addAlias(symbol, symbol.filePath)
      addAlias(symbol, `symbols/${symbol.id}`)
      addAlias(symbol, `symbols/${symbol.id}.tsx`)
      addAlias(symbol, `symbols/.editor/${symbol.id}.symbol.json`)
      addAlias(symbol, `symbols/editor/${symbol.id}.symbol.json`)
    })

    Object.values(workspaceSymbolRegistry).forEach((symbol) => {
      addAlias(symbol, symbol.id)
      addAlias(symbol, symbol.name)
      addAlias(symbol, symbol.filePath)
      addAlias(symbol, `symbols/${symbol.id}`)
      addAlias(symbol, `symbols/${symbol.id}.tsx`)
      addAlias(symbol, `symbols/.editor/${symbol.id}.symbol.json`)
      addAlias(symbol, `symbols/editor/${symbol.id}.symbol.json`)
    })

    return map
  }, [fsMap, workspaceSymbolRegistry])

  const debugSymbolResolution = (component: PlacedComponent, symbolRef: string, resolved?: SymbolDefinition) => {
    if (typeof window === 'undefined' || !(window as any).__SYMBOL_DEBUG) return
    const keys = Object.keys(workspaceSymbolRegistry)
    console.debug('[symbol-resolution]', {
      componentId: component.id,
      componentName: component.name,
      catalogId: component.catalogId,
      symbolRef,
      normalizedSymbolRef: normalizeSymbolRef(symbolRef),
      workspaceSymbolRegistryKeys: keys,
      resolvedId: resolved?.id,
      resolvedPath: resolved?.filePath
    })
  }

  const workspaceComponentRegistry = useMemo(() => buildWorkspaceComponentRegistry(fsMap), [fsMap])

  const getResolvedSymbolData = (component: PlacedComponent): ResolvedSymbolData => {
    const componentType = String(component.props.componentType || component.props.symbolName || '').trim()
    const componentDef = componentType ? workspaceComponentRegistry[componentType] : undefined
    const symbolRefRaw = String(component.props.symbolRef || componentDef?.symbolRef || '').trim()
    const symbolName = String(component.props.symbolName || '').trim()
    const symbolPath = String(component.props.subcircuitPath || '').trim()
    const hasSymbolLink =
      component.catalogId === 'symbol-instance'
      || symbolRefRaw.length > 0
      || componentType.length > 0
      || symbolName.length > 0
      || symbolPath.startsWith('symbols/')

    const candidates = [
      symbolRefRaw,
      componentDef?.symbolRef || '',
      symbolName,
      symbolPath,
      componentType
    ]
      .map(value => normalizeSymbolRef(value))
      .filter(Boolean)

    const symbolDefinition = candidates
      .map(candidate => symbolRegistryByName.get(candidate))
      .find(Boolean)

    debugSymbolResolution(component, symbolRefRaw, symbolDefinition)

    const resolvedPorts = (symbolDefinition?.ports || []).map(port => ({
      name: String(port.name || ''),
      schX: Number(port.x || 0),
      schY: Number(port.y || 0),
      side: (port as any).side as string | undefined,
      order: (port as any).order as number | undefined
    }))

    const fallbackPorts = Array.isArray(component.props.symbolPorts)
      ? component.props.symbolPorts.map((port: any) => ({
          name: String(port.name || ''),
          schX: Number(port.schX ?? port.x ?? 0),
          schY: Number(port.schY ?? port.y ?? 0),
          side: port.side as string | undefined,
          order: port.order !== undefined ? Number(port.order) : undefined
        }))
      : []

    const ports = resolvedPorts.length > 0 ? resolvedPorts : fallbackPorts

    const resolvedShapes = Array.isArray(symbolDefinition?.geometry?.shapes)
      ? symbolDefinition.geometry.shapes
      : (Array.isArray(component.props.symbolShapes) ? component.props.symbolShapes : [])

    const bounds = symbolDefinition
      ? getSymbolBounds(symbolDefinition)
      : getSymbolBoundsFromGeometry(
          resolvedShapes,
          ports.map((port) => ({ x: Number(port.schX || 0), y: Number(port.schY || 0) })),
          Number(component.props.symbolWidth || 120),
          Number(component.props.symbolHeight || 80)
        )

    const width = Math.max(20, bounds.width)
    const height = Math.max(20, bounds.height)
    const origin = {
      x: Number(symbolDefinition?.geometry?.origin?.x || 0),
      y: Number(symbolDefinition?.geometry?.origin?.y || 0)
    }

    return {
      symbolDefinition,
      symbolRefRaw,
      symbolRefNormalized: normalizeSymbolRef(symbolRefRaw),
      hasSymbolLink,
      width,
      height,
      origin,
      bounds,
      localTransform: {
        translateX: -bounds.minX,
        translateY: -bounds.minY
      },
      ports: ports.map((port) => ({
        name: String(port.name || ''),
        schX: Number(port.schX || 0),
        schY: Number(port.schY || 0),
        side: port.side,
        order: port.order
      })),
      shapes: resolvedShapes.map(shape => ({ ...shape }))
    }
  }

  const isCustomSymbolComponent = (component: PlacedComponent): boolean => {
    if (component.catalogId === 'symbol-instance') return true
    if (Array.isArray(component.props.symbolShapes) || Array.isArray(component.props.symbolPorts)) return true
    if (String(component.props.symbolRef || '').trim().length > 0) return true
    if (String(component.props.componentType || '').trim().length > 0) return true
    const symbolPath = String(component.props.subcircuitPath || '').trim()
    if (symbolPath.startsWith('symbols/')) return true
    const symbolName = String(component.props.symbolName || '').trim()
    return symbolName.length > 0
  }

  const normalizeRotation = (rotation: any): number => {
    const raw = String(rotation || '0deg').trim()
    const parsed = Number(raw.replace(/deg$/, ''))
    const base = Number.isFinite(parsed) ? parsed : 0
    return ((base % 360) + 360) % 360
  }

  const rotatePoint = (x: number, y: number, width: number, height: number, rotation: number) => {
    if (rotation === 90) {
      return { x: height - y, y: x }
    }

    if (rotation === 180) {
      return { x: width - x, y: height - y }
    }

    if (rotation === 270) {
      return { x: y, y: width - x }
    }

    return { x, y }
  }

  const getBaseComponentSize = (component: PlacedComponent) => {
    if (isCustomSymbolComponent(component)) {
      const resolved = getResolvedSymbolData(component)
      return {
        width: resolved.bounds.width,
        height: resolved.bounds.height
      }
    }

    if (component.catalogId === 'netport') {
      return { width: 72, height: 22 }
    }
    if (component.catalogId === 'public-port') {
      return { width: 18, height: 18 }
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

  const getDynamicPins = (component: PlacedComponent) => {
    if (isCustomSymbolComponent(component)) {
      const resolved = getResolvedSymbolData(component)
      const symbolPorts = resolved.ports
      if (symbolPorts.length > 0) {
        const validSide = (side: unknown): 'left' | 'right' | 'top' | 'bottom' | undefined => {
          if (side === 'left' || side === 'right' || side === 'top' || side === 'bottom') return side
          return undefined
        }
        const normalized = symbolPorts
          .filter(port => String(port.name || '').trim().length > 0)
          .map((port, index) => {
            const localX = Number(port.schX) + resolved.localTransform.translateX
            const localY = Number(port.schY) + resolved.localTransform.translateY
            const fallbackSide = (() => {
              if (Math.abs(localX - resolved.bounds.width / 2) >= Math.abs(localY - resolved.bounds.height / 2)) {
                return localX >= resolved.bounds.width / 2 ? 'right' : 'left'
              }
              return localY >= resolved.bounds.height / 2 ? 'bottom' : 'top'
            })()
            const side = validSide(port.side) || fallbackSide
            const rawX = Number(localX)
            const rawY = Number(localY)
            const x = Number.isFinite(rawX) ? rawX : NaN
            const y = Number.isFinite(rawY) ? rawY : NaN
            const rawOrder = Number((port as any).order)
            const order = Number.isFinite(rawOrder) ? rawOrder : undefined
            return {
              name: String(port.name),
              side,
              x,
              y,
              order,
              index
            }
          })

        const sorted = [...normalized].sort((a, b) => {
          const rank = (side: 'left' | 'right' | 'top' | 'bottom') => {
            if (side === 'left') return 0
            if (side === 'right') return 1
            if (side === 'top') return 2
            return 3
          }
          const sideDelta = rank(a.side) - rank(b.side)
          if (sideDelta !== 0) return sideDelta

          if (a.order !== undefined && b.order !== undefined && a.order !== b.order) {
            return a.order - b.order
          }

          if (a.side === 'left' || a.side === 'right') {
            if (Number.isFinite(a.y) && Number.isFinite(b.y) && a.y !== b.y) return a.y - b.y
          } else {
            if (Number.isFinite(a.x) && Number.isFinite(b.x) && a.x !== b.x) return a.x - b.x
          }

          return a.index - b.index
        })

        const sideMembers: Record<'left' | 'right' | 'top' | 'bottom', number[]> = {
          left: [],
          right: [],
          top: [],
          bottom: []
        }
        sorted.forEach((port, index) => {
          sideMembers[port.side].push(index)
        })

        const distributedCoord = (
          members: number[],
          selfIndex: number,
          span: number
        ): number => {
          const rank = members.indexOf(selfIndex)
          if (rank < 0 || members.length <= 1) return span / 2
          return ((rank + 1) * span) / (members.length + 1)
        }

        return sorted.map((port, index) => {
          let x = Number(port.x)
          let y = Number(port.y)

          if (port.side === 'left') {
            x = 0
            if (!Number.isFinite(y)) y = distributedCoord(sideMembers.left, index, resolved.bounds.height)
          } else if (port.side === 'right') {
            x = resolved.bounds.width
            if (!Number.isFinite(y)) y = distributedCoord(sideMembers.right, index, resolved.bounds.height)
          } else if (port.side === 'top') {
            y = 0
            if (!Number.isFinite(x)) x = distributedCoord(sideMembers.top, index, resolved.bounds.width)
          } else {
            y = resolved.bounds.height
            if (!Number.isFinite(x)) x = distributedCoord(sideMembers.bottom, index, resolved.bounds.width)
          }

          return {
            name: port.name,
            x,
            y
          }
        })
      }

      // Symbol-backed components must use SymbolDefinition ports only.
      return []
    }

    if (component.catalogId === 'netport') {
      return [{ name: 'port', x: 0, y: 11 }]
    }

    if (component.catalogId === 'public-port') {
      return [{ name: 'port', x: 9, y: 9 }]
    }

    if (component.catalogId === 'subcircuit-instance' || component.catalogId === 'sheet-instance') {
      const ports = (component.props.ports as string[] | undefined) || []
      const width = component.catalogId === 'sheet-instance' ? 150 : 130
      if (ports.length === 0) {
        return [{ name: 'IO', x: 0, y: 20 }]
      }
      return ports.map((portName, index) => {
        const row = Math.floor(index / 2)
        const isLeft = index % 2 === 0
        return {
          name: portName,
          x: isLeft ? 0 : width,
          y: 18 + row * 18
        }
      })
    }

    if (component.catalogId === 'customchip') {
      const layout = buildCustomChipLayout(component.props, component.name)
      return layout.pins.map((pin) => ({
        name: pin.name,
        x: pin.x,
        y: pin.y
      }))
    }

    const schematic = getPinConfig(component.catalogId)
    return schematic?.pins.map(pin => ({ name: pin.name, x: pin.x, y: pin.y })) || []
  }

  const getComponentSize = (component: PlacedComponent) => {
    const base = getBaseComponentSize(component)
    const rotation = normalizeRotation(component.props.schRotation)
    if (rotation === 90 || rotation === 270) {
      return { width: base.height, height: base.width }
    }
    return base
  }

  const getComponentBounds = (component: PlacedComponent) => {
    const { width, height } = getComponentSize(component)
    const schX = Number(component.props.schX || 0)
    const schY = Number(component.props.schY || 0)
    return {
      minX: schX,
      minY: schY,
      maxX: schX + width,
      maxY: schY + height
    }
  }

  const getPinPositionForComponent = (component: PlacedComponent, pinName: string): { x: number; y: number } | null => {
    const pin = getDynamicPins(component).find(p => p.name === pinName)
    if (!pin) return null

    const base = getBaseComponentSize(component)
    const rotation = normalizeRotation(component.props.schRotation)
    const rotated = rotatePoint(pin.x, pin.y, base.width, base.height, rotation)

    return {
      x: (component.props.schX || 0) + rotated.x,
      y: (component.props.schY || 0) + rotated.y
    }
  }

  const getWorldPointFromClient = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null

    const zoom = viewport.zoom ?? 1
    return {
      x: (clientX - rect.left - viewport.x) / zoom,
      y: (clientY - rect.top - viewport.y) / zoom
    }
  }

  // Handle canvas panning
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    const isBackgroundTarget =
      e.target === canvasRef.current
      || (e.target as HTMLElement).classList.contains('canvas-grid')
      || (e.target as HTMLElement).tagName === 'svg'
      || (e.target as HTMLElement).tagName === 'path'
      || (e.target as HTMLElement).tagName === 'rect'

    if (isBackgroundTarget) {
      // Ctrl+drag for selection box
      if (e.ctrlKey || e.metaKey) {
        setIsBoxSelecting(true)
        const startPoint = getWorldPointFromClient(e.clientX, e.clientY)
        if (startPoint) {
          setSelectionBox({ start: startPoint, end: startPoint })
        }
        return
      }
      
      setIsPanning(true)
      setPanStart({ x: e.clientX - viewport.x, y: e.clientY - viewport.y })
      
      // Clear selection
      setSelectedComponents([])
    }
  }

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (isBoxSelecting && selectionBox) {
      const endPoint = getWorldPointFromClient(e.clientX, e.clientY)
      if (endPoint) {
        setSelectionBox({ ...selectionBox, end: endPoint })
      }
      return
    }
    
    if (isPanning) {
      setViewport({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y
      })
    }
  }

  const handleCanvasMouseUp = () => {
    if (isBoxSelecting && selectionBox) {
      // Select all components within the box
      const minX = Math.min(selectionBox.start.x, selectionBox.end.x)
      const maxX = Math.max(selectionBox.start.x, selectionBox.end.x)
      const minY = Math.min(selectionBox.start.y, selectionBox.end.y)
      const maxY = Math.max(selectionBox.start.y, selectionBox.end.y)
      
      const selectedIds = placedComponents.filter(comp => {
        const bounds = getComponentBounds(comp)
        return bounds.minX >= minX && bounds.maxX <= maxX && bounds.minY >= minY && bounds.maxY <= maxY
      }).map(comp => comp.id)
      
      setSelectedComponents(selectedIds)
      setSelectionBox(null)
      setIsBoxSelecting(false)
    }
    setIsPanning(false)
  }

  // Handle drop from catalog
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const catalogItemId = e.dataTransfer.getData('catalogItemId')
    const subcircuitName = e.dataTransfer.getData('subcircuitName')
    const subcircuitPath = e.dataTransfer.getData('subcircuitPath')
    const sheetName = e.dataTransfer.getData('sheetName')
    const sheetPath = e.dataTransfer.getData('sheetPath')
    const sheetPorts = e.dataTransfer.getData('sheetPorts')
    const symbolName = e.dataTransfer.getData('symbolName')
    const symbolComponentName = e.dataTransfer.getData('symbolComponentName')
    const symbolComponentPath = e.dataTransfer.getData('symbolComponentPath')
    const symbolComponentPorts = e.dataTransfer.getData('symbolComponentPorts')
    const symbolComponentPortGeometry = e.dataTransfer.getData('symbolComponentPortGeometry')
    const symbolComponentGeometry = e.dataTransfer.getData('symbolComponentGeometry')
    const workspaceComponentType = e.dataTransfer.getData('workspaceComponentType')
    const workspaceComponentSymbolRef = e.dataTransfer.getData('workspaceComponentSymbolRef')
    const workspaceComponentSourcePath = e.dataTransfer.getData('workspaceComponentSourcePath')
    const workspaceComponentPins = e.dataTransfer.getData('workspaceComponentPins')
    const workspaceComponentPortGeometry = e.dataTransfer.getData('workspaceComponentPortGeometry')
    const workspaceComponentGeometry = e.dataTransfer.getData('workspaceComponentGeometry')
    
    if (!canvasRef.current) return

    // Calculate drop position relative to canvas
    const rect = canvasRef.current.getBoundingClientRect()
    const zoom = viewport.zoom ?? 1
    const x = Math.round(((e.clientX - rect.left - viewport.x) / zoom) / SNAP_STEP) * SNAP_STEP
    const y = Math.round(((e.clientY - rect.top - viewport.y) / zoom) / SNAP_STEP) * SNAP_STEP

    if (subcircuitName) {
      insertSubcircuitInstance(subcircuitName, {
        schX: x,
        schY: y,
        filePath: subcircuitPath || undefined
      })
      return
    }

    if (sheetPath) {
      const existingNames = placedComponents.map(c => c.name)
      let i = 1
      const baseName = sheetName || sheetPath.split('/').pop()?.replace(/\.(tsx|ts)$/, '') || 'Sheet'
      let uniqueName = baseName
      while (existingNames.includes(uniqueName)) {
        i += 1
        uniqueName = `${baseName}${i}`
      }

      addPlacedComponent({
        id: `sheet-${Date.now()}-${Math.random()}`,
        catalogId: 'sheet-instance',
        name: uniqueName,
        props: {
          sheetName: uniqueName,
          sheetPath,
          ports: sheetPorts ? JSON.parse(sheetPorts) : [],
          schX: x,
          schY: y
        },
        tsxSnippet: ''
      })
      return
    }

    if (workspaceComponentType) {
      const existingNames = placedComponents.map(c => c.name)
      let i = 1
      let uniqueName = `U${i}`
      while (existingNames.includes(uniqueName)) {
        i += 1
        uniqueName = `U${i}`
      }

      const pins = workspaceComponentPins ? JSON.parse(workspaceComponentPins) : []
      const portGeometry = workspaceComponentPortGeometry ? JSON.parse(workspaceComponentPortGeometry) : []
      const geometry = workspaceComponentGeometry ? JSON.parse(workspaceComponentGeometry) : null

      addPlacedComponent({
        id: `wcomp-${Date.now()}-${Math.random()}`,
        catalogId: 'symbol-instance',
        name: uniqueName,
        props: {
          componentType: workspaceComponentType,
          symbolRef: normalizeSymbolRef(workspaceComponentSymbolRef || workspaceComponentType) || undefined,
          symbolName: workspaceComponentType,
          subcircuitPath: workspaceComponentSourcePath || undefined,
          ports: Array.isArray(pins) ? pins.map(String) : [],
          symbolPorts: Array.isArray(portGeometry)
            ? portGeometry.map((port: any) => ({
                name: String(port.name || ''),
                schX: Number(port.schX ?? port.x ?? 0),
                schY: Number(port.schY ?? port.y ?? 0),
                side: port.side ?? undefined,
                order: port.order !== undefined ? Number(port.order) : undefined
              }))
            : [],
          symbolShapes: geometry?.shapes || [],
          symbolWidth: Number(geometry?.width || 120),
          symbolHeight: Number(geometry?.height || 80),
          symbolOriginX: Number(geometry?.origin?.x || 0),
          symbolOriginY: Number(geometry?.origin?.y || 0),
          schX: x,
          schY: y
        },
        tsxSnippet: `<${workspaceComponentType} name="${uniqueName}" schX={${x}} schY={${y}} />`
      })
      return
    }

    if (symbolComponentName) {
      const existingNames = placedComponents.map(c => c.name)
      let i = 1
      let uniqueName = `${symbolComponentName}${i}`
      while (existingNames.includes(uniqueName)) {
        i += 1
        uniqueName = `${symbolComponentName}${i}`
      }

      const ports = symbolComponentPorts ? JSON.parse(symbolComponentPorts) : []
      const portGeometry = symbolComponentPortGeometry ? JSON.parse(symbolComponentPortGeometry) : []
      const geometry = symbolComponentGeometry ? JSON.parse(symbolComponentGeometry) : null

      addPlacedComponent({
        id: `symc-${Date.now()}-${Math.random()}`,
        catalogId: 'symbol-instance',
        name: uniqueName,
        props: {
          symbolRef: normalizeSymbolRef(symbolComponentPath || symbolComponentName) || undefined,
          symbolName: symbolComponentName,
          subcircuitPath: symbolComponentPath || `symbols/${symbolComponentName}.tsx`,
          ports,
          symbolPorts: Array.isArray(portGeometry)
            ? portGeometry.map((port: any) => ({
                name: String(port.name || ''),
                schX: Number(port.schX ?? port.x ?? 0),
                schY: Number(port.schY ?? port.y ?? 0),
                side: port.side ?? undefined,
                order: port.order !== undefined ? Number(port.order) : undefined
              }))
            : [],
          symbolShapes: geometry?.shapes || [],
          symbolWidth: Number(geometry?.width || 120),
          symbolHeight: Number(geometry?.height || 80),
          symbolOriginX: Number(geometry?.origin?.x || 0),
          symbolOriginY: Number(geometry?.origin?.y || 0),
          schX: x,
          schY: y
        },
        tsxSnippet: `<${symbolComponentName} name="${uniqueName}" schX={${x}} schY={${y}} />`
      })
      return
    }

    if (symbolName) {
      const existingNames = placedComponents.map(c => c.name)
      let i = 1
      let uniqueName = `${symbolName}${i}`
      while (existingNames.includes(uniqueName)) {
        i += 1
        uniqueName = `${symbolName}${i}`
      }

      addPlacedComponent({
        id: `sym-${Date.now()}-${Math.random()}`,
        catalogId: 'symbol-instance',
        name: uniqueName,
        props: {
          symbolRef: normalizeSymbolRef(symbolName) || undefined,
          symbolName,
          schX: x,
          schY: y
        },
        tsxSnippet: `<${symbolName} name="${uniqueName}" schX={${x}} schY={${y}} />`
      })
      return
    }

    // Handle regular catalog item drop
    if (!catalogItemId) return

    const catalogItem = getCatalogItem(catalogItemId)
    if (!catalogItem) return

    // Generate unique name
    const baseName = catalogItem.metadata.defaultProps.name || 'COMP'
    const existingNames = placedComponents.map(c => c.name)
    let counter = 1
    let uniqueName = baseName

    if (catalogItemId !== 'net') {
      while (existingNames.includes(uniqueName)) {
        const match = baseName.match(/^([A-Z]+)(\d*)$/)
        if (match) {
          const prefix = match[1]
          uniqueName = `${prefix}${counter}`
          counter++
        } else {
          uniqueName = `${baseName}${counter}`
          counter++
        }
      }
    }

    const props = {
      ...catalogItem.metadata.defaultProps,
      name: uniqueName,
      schX: x,
      schY: y
    }

    const newComponent: PlacedComponent = {
      id: `comp-${Date.now()}-${Math.random()}`,
      catalogId: catalogItemId,
      name: uniqueName,
      props,
      tsxSnippet: catalogItem.emitTSX(props)
    }

    addPlacedComponent(newComponent)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  // Handle component dragging
  const handleComponentMouseDown = (e: React.MouseEvent, componentId: string) => {
    e.stopPropagation()

    const targetComponent = placedComponents.find(component => component.id === componentId)
    if (!targetComponent) return

    if (e.ctrlKey || e.metaKey) {
      toggleComponentSelection(componentId)
      return
    }
    
    // Check if clicking near a pin
    const isNetLikeSymbol =
      targetComponent.catalogId === 'net' ||
      targetComponent.catalogId === 'netport' ||
      targetComponent.catalogId === 'netlabel'

    if (cursorNearPin && cursorNearPin.componentId === componentId && !isNetLikeSymbol) {
      return // Let pin click handle it
    }
    
    const isAlreadySelected = selectedComponentIds.includes(componentId)

    // React state updates are async, so derive drag targets synchronously.
    const dragTargetIds = isAlreadySelected ? selectedComponentIds : [componentId]

    if (!isAlreadySelected) {
      setSelectedComponents([componentId])
    }

    setDraggedComponentId(componentId)

    const startX = e.clientX
    const startY = e.clientY

    // Drag either the current selection or the clicked component.
    const initialPositions = placedComponents
      .filter(c => dragTargetIds.includes(c.id))
      .map(c => ({
        id: c.id,
        schX: c.props.schX || 0,
        schY: c.props.schY || 0
      }))

    const handleMouseMove = (e: MouseEvent) => {
      const zoom = viewport.zoom ?? 1
      const dx = (e.clientX - startX) / zoom
      const dy = (e.clientY - startY) / zoom
      
      // Move all selected components
      initialPositions.forEach(({ id, schX, schY }) => {
        const comp = placedComponents.find(c => c.id === id)
        if (!comp) return

        const newX = Math.round((schX + dx) / SNAP_STEP) * SNAP_STEP
        const newY = Math.round((schY + dy) / SNAP_STEP) * SNAP_STEP

        const newProps = {
          ...comp.props,
          schX: newX,
          schY: newY
        }

        if (comp.catalogId === 'subcircuit-instance') {
          updatePlacedComponent(id, {
            props: newProps,
            tsxSnippet: `<${comp.props.subcircuitName} name="${comp.name}" schX={${newX}} schY={${newY}} />`
          })
          return
        }

        if (isCustomSymbolComponent(comp)) {
          updatePlacedComponent(id, {
            props: newProps
          })
          return
        }

        // netport/netlabel have no catalog entry but are draggable — update position directly
        if (comp.catalogId === 'netport' || comp.catalogId === 'public-port' || comp.catalogId === 'net' || comp.catalogId === 'netlabel') {
          if ((window as any).__NETPORT_DEBUG) console.log('[netport:drag]', { name: comp.name, newX, newY })
          updatePlacedComponent(id, { props: newProps })
          return
        }

        const catalogItem = getCatalogItem(comp.catalogId)
        if (!catalogItem) return

        updatePlacedComponent(id, {
          props: newProps,
          tsxSnippet: catalogItem.emitTSX(newProps)
        })
      })
    }

    const handleMouseUp = () => {
      setDraggedComponentId(null)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  // Handle pin click for wiring
  const handlePinClick = (e: React.MouseEvent, componentId: string, pinName: string) => {
    e.stopPropagation()

    if (subcircuitCreation.active) {
      toggleSubcircuitPinSelection(componentId, pinName)
      return
    }
    
    if (!wiringStart) {
      // Start wiring from this pin
      startWiring(componentId, pinName)
    } else {
      // Complete wiring to this pin
      if (wiringStart.componentId !== componentId) {
        completeWiring(componentId, pinName)
      } else {
        // Cancel if clicking same component
        cancelWiring()
      }
    }
  }

  const renderCustomSymbolInstance = (
    component: PlacedComponent,
    isSelected: boolean,
    baseWidth: number,
    baseHeight: number,
    rotation: number
  ) => {
    const resolved = getResolvedSymbolData(component)
    const strokeColor = isSelected ? '#007acc' : '#4CAF50'
    const pins = getDynamicPins(component)

    if (resolved.hasSymbolLink && resolved.shapes.length === 0) {
      const ref = resolved.symbolRefRaw || resolved.symbolRefNormalized || String(component.props.symbolName || component.props.componentType || 'unknown')
      if (typeof window !== 'undefined') {
        console.warn(`[symbol-instance] Missing symbol geometry: ${ref}`, {
          componentId: component.id,
          componentName: component.name,
          normalizedRef: resolved.symbolRefNormalized,
          registryKeys: Object.keys(workspaceSymbolRegistry)
        })
      }
      return (
        <div
          style={{
            width: baseWidth,
            height: baseHeight,
            border: '1px dashed #ff4d4f',
            color: '#ff8080',
            fontSize: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: 4,
            boxSizing: 'border-box',
            background: 'rgba(60, 10, 10, 0.25)',
            transform: `rotate(${rotation}deg)`,
            transformOrigin: 'center center'
          }}
          title={`Missing symbol geometry: ${ref}`}
        >
          {`Missing symbol geometry: ${ref}`}
        </div>
      )
    }

    return (
      <svg
        width={baseWidth}
        height={baseHeight}
        viewBox={`0 0 ${baseWidth} ${baseHeight}`}
        style={{
          overflow: 'visible',
          transform: `rotate(${rotation}deg)`,
          transformOrigin: 'center center'
        }}
      >
        <g>
          {resolved.shapes.map((shape: any, index: number) => (
            renderSymbolPrimitive(shape, resolved.localTransform, strokeColor, String(shape.id || `shape-${index}`))
          ))}

          {isSelected && (
            <rect
              x={0}
              y={0}
              width={resolved.bounds.width}
              height={resolved.bounds.height}
              fill="none"
              stroke="#007acc"
              strokeWidth={1.5}
              strokeDasharray="4,3"
              pointerEvents="none"
            />
          )}

          {pins.map((pin) => {
            const isPinNearCursor = cursorNearPin?.componentId === component.id && cursorNearPin?.pinName === pin.name
            const isPinWiringStart = wiringStart?.componentId === component.id && wiringStart?.pinName === pin.name
            const pinKey = `${component.id}:${pin.name}`
            const isPinCandidate = subcircuitCreation.candidatePins.some(
              candidate => `${candidate.componentId}:${candidate.pinName}` === pinKey
            )
            const isPinSelectedForSubcircuit = subcircuitCreation.selectedPins.some(
              selected => `${selected.componentId}:${selected.pinName}` === pinKey
            )
            const radius = isPinNearCursor ? 6 : 5

            return (
              <g key={pin.name}>
                <circle
                  cx={pin.x}
                  cy={pin.y}
                  r={radius}
                  fill={isPinSelectedForSubcircuit
                    ? '#FF5722'
                    : isPinCandidate && subcircuitCreation.active
                    ? '#FFD54F'
                    : isPinWiringStart
                    ? '#FFC107'
                    : isPinNearCursor
                    ? '#2196F3'
                    : '#888'}
                  stroke="#1e1e1e"
                  strokeWidth={2}
                />
                <circle
                  cx={pin.x}
                  cy={pin.y}
                  r={12}
                  fill="rgba(0,0,0,0.001)"
                  style={{ cursor: subcircuitCreation.active ? 'pointer' : 'crosshair' }}
                  onClick={(e) => handlePinClick(e, component.id, pin.name)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    disconnectPin(component.id, pin.name)
                  }}
                />
              </g>
            )
          })}
        </g>
      </svg>
    )
  }

  const renderCustomChipInstance = (
    component: PlacedComponent,
    isSelected: boolean,
    baseWidth: number,
    baseHeight: number,
    rotation: number
  ) => {
    const layout = buildCustomChipLayout(component.props, component.name)
    const strokeColor = isSelected ? '#007acc' : '#4CAF50'
    const pins = getDynamicPins(component)
    const pinByName = new Map(layout.pins.map(pin => [pin.name, pin]))

    return (
      <svg
        width={baseWidth}
        height={baseHeight}
        viewBox={`0 0 ${baseWidth} ${baseHeight}`}
        style={{
          overflow: 'visible',
          transform: `rotate(${rotation}deg)`,
          transformOrigin: 'center center'
        }}
      >
        <rect
          x={layout.bodyX}
          y={layout.bodyY}
          width={layout.bodyWidth}
          height={layout.bodyHeight}
          rx={6}
          ry={6}
          fill="none"
          stroke={strokeColor}
          strokeWidth={2}
        />

        <text
          x={layout.bodyX + layout.bodyWidth / 2}
          y={layout.bodyY + 16}
          fill={strokeColor}
          fontSize={layout.titleFontSize}
          fontWeight={700}
          textAnchor="middle"
        >
          {layout.title}
        </text>

        {layout.subtitle && (
          <text
            x={layout.bodyX + layout.bodyWidth / 2}
            y={layout.bodyY + 30}
            fill={strokeColor}
            fontSize={layout.subtitleFontSize}
            textAnchor="middle"
          >
            {layout.subtitle}
          </text>
        )}

        {layout.pins.map((pin) => (
          <text
            key={`label-${pin.name}`}
            x={pin.labelX}
            y={pin.labelY}
            fill={strokeColor}
            fontSize={layout.pinFontSize}
            textAnchor={pin.textAnchor}
            pointerEvents="none"
          >
            {pin.name}
          </text>
        ))}

        {pins.map((pin) => {
          const isPinNearCursor = cursorNearPin?.componentId === component.id && cursorNearPin?.pinName === pin.name
          const isPinWiringStart = wiringStart?.componentId === component.id && wiringStart?.pinName === pin.name
          const pinKey = `${component.id}:${pin.name}`
          const isPinCandidate = subcircuitCreation.candidatePins.some(
            candidate => `${candidate.componentId}:${candidate.pinName}` === pinKey
          )
          const isPinSelectedForSubcircuit = subcircuitCreation.selectedPins.some(
            selected => `${selected.componentId}:${selected.pinName}` === pinKey
          )
          const radius = isPinNearCursor ? 6 : 5
          const layoutPin = pinByName.get(pin.name)

          return (
            <g key={pin.name}>
              <circle
                cx={pin.x}
                cy={pin.y}
                r={radius}
                fill={isPinSelectedForSubcircuit
                  ? '#FF5722'
                  : isPinCandidate && subcircuitCreation.active
                  ? '#FFD54F'
                  : isPinWiringStart
                  ? '#FFC107'
                  : isPinNearCursor
                  ? '#2196F3'
                  : '#888'}
                stroke="#1e1e1e"
                strokeWidth={2}
              />
              {layoutPin && layoutPin.side !== 'top' && layoutPin.side !== 'bottom' && (
                <line
                  x1={layoutPin.side === 'left' ? layoutPin.x - 8 : layoutPin.x + 8}
                  y1={layoutPin.y}
                  x2={layoutPin.x}
                  y2={layoutPin.y}
                  stroke={strokeColor}
                  strokeWidth={1.5}
                  pointerEvents="none"
                />
              )}
              <circle
                cx={pin.x}
                cy={pin.y}
                r={12}
                fill="rgba(0,0,0,0.001)"
                style={{ cursor: subcircuitCreation.active ? 'pointer' : 'crosshair' }}
                onClick={(e) => handlePinClick(e, component.id, pin.name)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  disconnectPin(component.id, pin.name)
                }}
              />
            </g>
          )
        })}

        {isSelected && (
          <rect
            x={0}
            y={0}
            width={baseWidth}
            height={baseHeight}
            fill="none"
            stroke="#007acc"
            strokeWidth={1.5}
            strokeDasharray="4,3"
            pointerEvents="none"
          />
        )}
      </svg>
    )
  }

  // Check if cursor is near any pin
  const checkCursorNearPin = (e: React.MouseEvent) => {
    const mousePoint = getWorldPointFromClient(e.clientX, e.clientY)
    if (!mousePoint) return

    let nearPin: { componentId: string; pinName: string } | null = null

    for (const component of placedComponents) {
      const pins = getDynamicPins(component)

      for (const pin of pins) {
        const pinPos = getPinPositionForComponent(component, pin.name)

        if (!pinPos) continue

        const distance = Math.sqrt(
          Math.pow(mousePoint.x - pinPos.x, 2) + Math.pow(mousePoint.y - pinPos.y, 2)
        )

        if (distance < 15) { // 15px threshold
          nearPin = { componentId: component.id, pinName: pin.name }
          break
        }
      }

      if (nearPin) break
    }

    setCursorNearPin(nearPin)
    setHoveredPin(nearPin)
    
    // Update cursor style
    if (nearPin) {
      setCursorStyle('crosshair')
    } else if (isPanning) {
      setCursorStyle('grabbing')
    } else {
      setCursorStyle('default')
    }
  }

  const toPointKey = (x: number, y: number) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`

  const sanitizeWirePoints = (
    fromPos: { x: number; y: number },
    toPos: { x: number; y: number },
    routePoints?: Array<{ x: number; y: number }>
  ): Array<{ x: number; y: number }> => {
    const source = Array.isArray(routePoints) && routePoints.length >= 2
      ? routePoints.map(point => ({ x: Number(point.x), y: Number(point.y) }))
      : [
        { x: fromPos.x, y: fromPos.y },
        { x: (fromPos.x + toPos.x) / 2, y: fromPos.y },
        { x: (fromPos.x + toPos.x) / 2, y: toPos.y },
        { x: toPos.x, y: toPos.y }
      ]

    const normalized = source.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    if (normalized.length === 0) return [fromPos, toPos]

    // Enforce endpoint termination: no segment may continue beyond target pins.
    normalized[0] = { x: fromPos.x, y: fromPos.y }
    normalized[normalized.length - 1] = { x: toPos.x, y: toPos.y }

    // Remove zero-length consecutive points.
    const deduped: Array<{ x: number; y: number }> = []
    normalized.forEach((point) => {
      const prev = deduped[deduped.length - 1]
      if (!prev || prev.x !== point.x || prev.y !== point.y) {
        deduped.push(point)
      }
    })

    if (deduped.length < 2) return [fromPos, toPos]

    // Remove collinear middle points to avoid mirrored-C overlaps and dangling visual kinks.
    const compact: Array<{ x: number; y: number }> = [deduped[0]]
    for (let i = 1; i < deduped.length - 1; i += 1) {
      const a = compact[compact.length - 1]
      const b = deduped[i]
      const c = deduped[i + 1]
      const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)
      if (!collinear) compact.push(b)
    }
    compact.push(deduped[deduped.length - 1])

    const orthogonalized: Array<{ x: number; y: number }> = [compact[0]]
    for (let i = 1; i < compact.length; i += 1) {
      const prev = orthogonalized[orthogonalized.length - 1]
      const next = compact[i]
      if (prev.x !== next.x && prev.y !== next.y) {
        // Enforce orthogonal rendering: convert diagonal into one elbow.
        orthogonalized.push({ x: next.x, y: prev.y })
      }
      orthogonalized.push(next)
    }

    return orthogonalized.length >= 2 ? orthogonalized : [fromPos, toPos]
  }

  const buildPathString = (points: Array<{ x: number; y: number }>): string => {
    if (points.length < 2) return ''
    return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
  }

  const endpointUseCount = new Map<string, number>()
  const renderedPathUseCount = new Map<string, number>()
  wires.forEach((wire) => {
    const fromComp = placedComponents.find(c => c.id === wire.from.componentId)
    const toComp = placedComponents.find(c => c.id === wire.to.componentId)
    if (!fromComp || !toComp) return
    const fromPos = getPinPositionForComponent(fromComp, wire.from.pinName)
    const toPos = getPinPositionForComponent(toComp, wire.to.pinName)
    if (!fromPos || !toPos) return
    const fromKey = toPointKey(fromPos.x, fromPos.y)
    const toKey = toPointKey(toPos.x, toPos.y)
    endpointUseCount.set(fromKey, (endpointUseCount.get(fromKey) || 0) + 1)
    endpointUseCount.set(toKey, (endpointUseCount.get(toKey) || 0) + 1)
  })

  // Render wire between two pins
  const renderWire = (wire: any) => {
    const fromComp = placedComponents.find(c => c.id === wire.from.componentId)
    const toComp = placedComponents.find(c => c.id === wire.to.componentId)

    if (!fromComp || !toComp) {
      console.log('Wire missing component:', wire, { fromComp, toComp })
      return null
    }

    const fromPos = getPinPositionForComponent(fromComp, wire.from.pinName)
    const toPos = getPinPositionForComponent(toComp, wire.to.pinName)
    if (!fromPos || !toPos) return null

    let points = sanitizeWirePoints(fromPos, toPos, wire.routePoints)
    const pathFingerprint = points.map(point => toPointKey(point.x, point.y)).join('|')
    const overlapLane = renderedPathUseCount.get(pathFingerprint) || 0
    renderedPathUseCount.set(pathFingerprint, overlapLane + 1)

    // Orthogonal overlap avoidance for duplicated auto-generated paths.
    if (overlapLane > 0 && wire.routingIntent !== 'manual') {
      const dx = Math.abs(toPos.x - fromPos.x)
      const dy = Math.abs(toPos.y - fromPos.y)
      const offset = overlapLane * 4
      points = points.map(point => ({
        x: dx >= dy ? point.x : point.x + offset,
        y: dx >= dy ? point.y + offset : point.y
      }))
      points[0] = { x: fromPos.x, y: fromPos.y }
      points[points.length - 1] = { x: toPos.x, y: toPos.y }
    }

    const wirePath = buildPathString(points)
    if (!wirePath) return null

    const endpointDots: Array<{ x: number; y: number; key: string }> = []
    const fromKey = toPointKey(fromPos.x, fromPos.y)
    const toKey = toPointKey(toPos.x, toPos.y)
    if ((endpointUseCount.get(fromKey) || 0) > 1) {
      endpointDots.push({ x: fromPos.x, y: fromPos.y, key: `${wire.id}-from` })
    }
    if ((endpointUseCount.get(toKey) || 0) > 1) {
      endpointDots.push({ x: toPos.x, y: toPos.y, key: `${wire.id}-to` })
    }

    return (
      <g key={wire.id}>
        {/* Visible wire */}
        <path
          d={wirePath}
          stroke="#2196F3"
          strokeWidth="3.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ pointerEvents: 'none' }}
        />
        {/* Invisible hit area — double-click to disconnect */}
        <path
          d={wirePath}
          stroke="rgba(0,0,0,0.01)"
          strokeWidth="14"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            removeWire(wire.id)
          }}
        />
        {/* Dots only for actual shared endpoints/junction termination points */}
        {endpointDots.map(dot => (
          <circle key={dot.key} cx={dot.x} cy={dot.y} r="4" fill="#2196F3" style={{ pointerEvents: 'none' }} />
        ))}
      </g>
    )
  }

  // Render temporary wire during wiring
  const renderTempWire = () => {
    if (!wiringStart || !hoveredPin) return null

    const fromComp = placedComponents.find(c => c.id === wiringStart.componentId)
    const toComp = placedComponents.find(c => c.id === hoveredPin.componentId)
    
    if (!fromComp || !toComp) return null

    const fromPos = getPinPositionForComponent(fromComp, wiringStart.pinName)
    const toPos = getPinPositionForComponent(toComp, hoveredPin.pinName)

    if (!fromPos || !toPos) return null

    const midX = (fromPos.x + toPos.x) / 2

    return (
      <g>
        <path
          d={`M ${fromPos.x} ${fromPos.y} L ${midX} ${fromPos.y} L ${midX} ${toPos.y} L ${toPos.x} ${toPos.y}`}
          stroke="#FFC107"
          strokeWidth="3.5"
          fill="none"
          strokeDasharray="5,5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx={fromPos.x} cy={fromPos.y} r="3" fill="#FFC107" />
        <circle cx={toPos.x} cy={toPos.y} r="3" fill="#FFC107" />
      </g>
    )
  }

  const handleCanvasWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const newZoom = Math.min(4, Math.max(0.1, (viewport.zoom ?? 1) * zoomFactor))
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top
    const newX = mouseX - (mouseX - viewport.x) * (newZoom / (viewport.zoom ?? 1))
    const newY = mouseY - (mouseY - viewport.y) * (newZoom / (viewport.zoom ?? 1))
    setViewport({ x: newX, y: newY, zoom: newZoom })
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return
      if (e.key === 'r' || e.key === 'R') {
        setViewport({ x: 0, y: 0, zoom: 1 })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div className="canvas-container">
      <div
        ref={canvasRef}
        className={`canvas`}
        style={{ cursor: cursorStyle }}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={(e) => {
          handleCanvasMouseMove(e)
          checkCursorNearPin(e)
        }}
        onMouseUp={handleCanvasMouseUp}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onWheel={handleCanvasWheel}
      >
        <div 
          className="canvas-grid"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom ?? 1})`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
            transformOrigin: '0 0'
          }}
        />
        
        <div style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom ?? 1})`, position: 'relative', transformOrigin: '0 0' }}>
          {/* Render wires as SVG */}
          <svg 
            style={{
              position: 'absolute', 
              top: -CANVAS_HALF_EXTENT, 
              left: -CANVAS_HALF_EXTENT, 
              width: `${CANVAS_EXTENT}px`, 
              height: `${CANVAS_EXTENT}px`,
              pointerEvents: 'none',
              overflow: 'visible',
              zIndex: 5
            }}
            viewBox={`${-CANVAS_HALF_EXTENT} ${-CANVAS_HALF_EXTENT} ${CANVAS_EXTENT} ${CANVAS_EXTENT}`}
          >
            {wires.map((wire) => renderWire(wire))}
            {renderTempWire()}
            
            {/* Selection box */}
            {selectionBox && (
              <rect
                x={Math.min(selectionBox.start.x, selectionBox.end.x)}
                y={Math.min(selectionBox.start.y, selectionBox.end.y)}
                width={Math.abs(selectionBox.end.x - selectionBox.start.x)}
                height={Math.abs(selectionBox.end.y - selectionBox.start.y)}
                fill="rgba(0, 122, 204, 0.1)"
                stroke="#007acc"
                strokeWidth="2"
                strokeDasharray="5,5"
              />
            )}
          </svg>

          {/* Render components */}
          {placedComponents.map((component) => {
            const pins = getDynamicPins(component)
            const { width, height } = getComponentSize(component)
            const baseSize = getBaseComponentSize(component)
            const rotation = normalizeRotation(component.props.schRotation)
            const isSelected = selectedComponentIds.includes(component.id)
            const isSubcircuit = component.catalogId === 'subcircuit-instance'
            const isSheetInstance = component.catalogId === 'sheet-instance'
            const isCustomChip = component.catalogId === 'customchip'
            const useCustomSymbolRenderer = isCustomSymbolComponent(component)
            const useCustomChipRenderer = isCustomChip
            const isNetPort = component.catalogId === 'netport'
            const isPublicPort = component.catalogId === 'public-port'
            const isNet = component.catalogId === 'net'
            const isNetLabel = component.catalogId === 'netlabel'
            const labelNetName = String(component.props.net || component.props.netName || '').trim()
            const isHelperNetLabel = isNetLabel && (
              component.props.internalHelper === true
              || !labelNetName
              || /^netlabel-\d+$/i.test(String(component.name || ''))
            )

            // Internal helper nodes must never render or become selectable.
            if (isHelperNetLabel) {
              return null
            }

            if (!isSubcircuit && !isSheetInstance && !useCustomSymbolRenderer && !useCustomChipRenderer && !isNetPort && !isPublicPort && !isNetLabel && !getCatalogItem(component.catalogId)) {
              return null
            }
            
            return (
              <div
                key={component.id}
                className={`placed-component ${isSelected ? 'selected' : ''}`}
                style={{
                  left: component.props.schX || 0,
                  top: component.props.schY || 0,
                  width,
                  height,
                  background: isNetPort
                    ? 'rgba(156, 39, 176, 0.15)'
                    : isPublicPort
                    ? 'rgba(255, 193, 7, 0.18)'
                    : isNetLabel
                    ? 'transparent'
                    : isSheetInstance
                    ? 'rgba(76, 175, 80, 0.12)'
                    : isSubcircuit
                    ? 'rgba(255, 152, 0, 0.12)'
                    : useCustomSymbolRenderer
                    ? 'transparent'
                    : 'transparent',
                  border: isSelected
                    ? '2px solid #007acc'
                    : isNetPort
                    ? '1px dashed rgba(156, 39, 176, 0.7)'
                    : isPublicPort
                    ? '1px solid rgba(255, 193, 7, 0.9)'
                    : isNetLabel
                    ? 'none'
                    : isNet
                    ? 'none'
                    : isSheetInstance
                    ? '2px dashed rgba(76, 175, 80, 0.6)'
                    : isSubcircuit
                    ? '2px dashed rgba(255, 152, 0, 0.55)'
                    : useCustomSymbolRenderer
                    ? 'none'
                    : '1px solid #3e3e3e',
                  cursor: cursorNearPin?.componentId === component.id ? 'crosshair' : 'move',
                  boxShadow: isSelected ? '0 0 0 2px rgba(0, 122, 204, 0.3)' : 'none',
                  borderRadius: isSubcircuit || isSheetInstance || isNetPort ? '4px' : isPublicPort ? '999px' : '0'
                }}
                onMouseDown={(e) => handleComponentMouseDown(e, component.id)}
                onDoubleClick={() => {
                  if (isSubcircuit && component.props.subcircuitName) {
                    const subPath = String(component.props.subcircuitPath || '')
                    if (subPath && (subPath.startsWith('symbols/') || subPath.startsWith('raw/'))) {
                      setActiveFilePath(subPath)
                    } else {
                      openSubcircuitEditor(component.props.subcircuitName)
                    }
                  }
                  if (isSheetInstance && component.props.sheetPath) {
                    setActiveFilePath(component.props.sheetPath)
                  }
                  if (useCustomSymbolRenderer && component.props.symbolName) {
                    const symbolPath = String(component.props.subcircuitPath || `symbols/${component.props.symbolName}.tsx`)
                    setActiveFilePath(symbolPath)
                  }
                }}
              >
                {/* Component label */}
                <div style={{
                  position: 'absolute',
                  top: -20,
                  left: 0,
                  fontSize: 11,
                  color: isSelected
                    ? '#007acc'
                    : isNetPort
                    ? '#ce93d8'
                    : isPublicPort
                    ? '#ffd54f'
                    : isSheetInstance
                    ? '#81c784'
                    : isSubcircuit
                    ? '#ff9800'
                    : useCustomSymbolRenderer
                    ? '#26c6da'
                    : '#e0e0e0',
                  fontWeight: 500,
                  pointerEvents: 'none'
                }}>
                  {!isNet && !isPublicPort && !isNetLabel && (
                    <>
                  {isSheetInstance ? '🗂 ' : isSubcircuit ? '📦 ' : isNetPort ? '🔌 ' : ''}{component.name}
                  {component.props.resistance && ` (${component.props.resistance})`}
                  {component.props.capacitance && ` (${component.props.capacitance})`}
                    </>
                  )}
                </div>

                {isNetLabel && (
                  <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: 0,
                    transform: 'translateY(-50%)',
                    fontSize: 11,
                    color: isSelected ? '#007acc' : '#8bc34a',
                    fontWeight: 700,
                    pointerEvents: 'none',
                    whiteSpace: 'nowrap',
                    padding: '1px 6px',
                    borderRadius: 3,
                    border: `1px solid ${isSelected ? '#007acc' : 'rgba(139,195,74,0.5)'}`,
                    background: 'rgba(20, 30, 20, 0.55)'
                  }}>
                    {String(component.props.net || component.props.netName || component.name || '').trim() || 'NET'}
                  </div>
                )}

                {isSheetInstance && (
                  <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                    fontSize: 13,
                    color: '#66bb6a',
                    fontWeight: 600,
                    pointerEvents: 'none',
                    textAlign: 'center',
                    whiteSpace: 'nowrap'
                  }}>
                    {component.props.sheetName || component.name}
                  </div>
                )}

                {isSubcircuit && (
                  <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                    fontSize: 13,
                    color: '#ff9800',
                    fontWeight: 600,
                    pointerEvents: 'none',
                    textAlign: 'center',
                    whiteSpace: 'nowrap'
                  }}>
                    {component.props.subcircuitName}
                  </div>
                )}


                {isNetPort && (
                  <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: 8,
                    transform: 'translateY(-50%)',
                    fontSize: 11,
                    color: '#ce93d8',
                    fontWeight: 600,
                    pointerEvents: 'none'
                  }}>
                    net.{component.props.netName || component.name}
                  </div>
                )}

                {isPublicPort && (
                  <div
                    style={{
                      width: baseSize.width,
                      height: baseSize.height,
                      borderRadius: '999px',
                      background: 'rgba(255, 193, 7, 0.28)',
                      border: '2px solid rgba(255, 193, 7, 0.95)',
                      boxSizing: 'border-box'
                    }}
                  />
                )}

                {!isSubcircuit && !isSheetInstance && !useCustomSymbolRenderer && !isNetPort && !isPublicPort && !isNetLabel && (
                  !useCustomChipRenderer && (
                  <div
                    style={{
                      width: baseSize.width,
                      height: baseSize.height,
                      transform: `rotate(${rotation}deg)`,
                      transformOrigin: 'center center'
                    }}
                  >
                    <SchematicSymbol
                      type={component.catalogId}
                      width={baseSize.width}
                      height={baseSize.height}
                      color={isSelected ? '#007acc' : '#4CAF50'}
                    />
                  </div>
                  )
                )}

                {useCustomSymbolRenderer && (
                  renderCustomSymbolInstance(component, isSelected, baseSize.width, baseSize.height, rotation)
                )}

                {useCustomChipRenderer && (
                  renderCustomChipInstance(component, isSelected, baseSize.width, baseSize.height, rotation)
                )}

                {isNet && (
                  <div style={{
                    position: 'absolute',
                    left: 8,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    fontSize: 11,
                    color: isSelected ? '#007acc' : '#4CAF50',
                    fontWeight: 700,
                    pointerEvents: 'none',
                    whiteSpace: 'nowrap',
                    maxWidth: '65%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}>
                    {component.props.name || component.name}
                  </div>
                )}

                {/* Render pins */}
                {!useCustomSymbolRenderer && !useCustomChipRenderer && pins.map((pin) => {
                  const rotatedPin = rotatePoint(pin.x, pin.y, baseSize.width, baseSize.height, rotation)
                  const isPinNearCursor = cursorNearPin?.componentId === component.id && cursorNearPin?.pinName === pin.name
                  const isPinWiringStart = wiringStart?.componentId === component.id && wiringStart?.pinName === pin.name
                  const pinKey = `${component.id}:${pin.name}`
                  const isPinCandidate = subcircuitCreation.candidatePins.some(
                    candidate => `${candidate.componentId}:${candidate.pinName}` === pinKey
                  )
                  const isPinSelectedForSubcircuit = subcircuitCreation.selectedPins.some(
                    selected => `${selected.componentId}:${selected.pinName}` === pinKey
                  )
                  
                  return (
                    <div
                      key={pin.name}
                      className="component-pin"
                      style={{
                        position: 'absolute',
                        left: rotatedPin.x - 5,
                        top: rotatedPin.y - 5,
                        width: isPinNearCursor ? 12 : 10,
                        height: isPinNearCursor ? 12 : 10,
                        background: isPinSelectedForSubcircuit
                          ? '#FF5722'
                          : isPinCandidate && subcircuitCreation.active
                          ? '#FFD54F'
                          : isPinWiringStart
                          ? '#FFC107'
                          : isPinNearCursor
                          ? '#2196F3'
                          : '#888',
                        border: '2px solid #1e1e1e',
                        borderRadius: '50%',
                        cursor: subcircuitCreation.active ? 'pointer' : 'crosshair',
                        zIndex: 10,
                        transition: 'all 0.15s',
                        transform: isPinNearCursor ? 'scale(1.3)' : 'scale(1)'
                      }}
                      onClick={(e) => handlePinClick(e, component.id, pin.name)}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        if (component.catalogId === 'netport' || component.catalogId === 'public-port') return
                        disconnectPin(component.id, pin.name)
                      }}
                      title={component.catalogId === 'netport' || component.catalogId === 'public-port'
                        ? `${component.name}.${pin.name}`
                        : `${component.name}.${pin.name} — double-click to disconnect`}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
