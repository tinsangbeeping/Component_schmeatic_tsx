import React, { useRef, useState, useEffect } from 'react'
import { useEditorStore } from '../store/editorStore'
import { PlacedComponent } from '../types/catalog'
import { getCatalogItem } from '../catalog'
import { SchematicSymbol } from './SchematicSymbol'
import { getPinConfig } from '../types/schematic'
import { extractAllSubcircuits } from '../utils/projectManager'

export const Canvas: React.FC = () => {
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
    setActiveFilePath
  } = useEditorStore()

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
    if (component.catalogId === 'symbol-instance') {
      return { width: 120, height: 56 }
    }
    if (component.catalogId === 'customchip') {
      const legacyCount = Math.max(2, Number(component.props.pinCount || 8))
      const leftPins = Math.max(0, Number(component.props.leftPins ?? Math.ceil(legacyCount / 2)))
      const rightPins = Math.max(0, Number(component.props.rightPins ?? Math.floor(legacyCount / 2)))
      const topPins = Math.max(0, Number(component.props.topPins ?? 0))
      const bottomPins = Math.max(0, Number(component.props.bottomPins ?? 0))
      const sideRows = Math.max(leftPins, rightPins)
      const topBottomCols = Math.max(topPins, bottomPins)
      return {
        width: Math.max(100, 28 + topBottomCols * 20),
        height: Math.max(80, 24 + sideRows * 20)
      }
    }
    const schematic = getPinConfig(component.catalogId)
    return {
      width: schematic?.width || 60,
      height: schematic?.height || 40
    }
  }

  const getDynamicPins = (component: PlacedComponent) => {
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

    if (component.catalogId === 'symbol-instance') {
      const ports = ((component.props.ports as string[] | undefined) || []).map(String)
      const width = 120
      if (ports.length === 0) return []
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
      const legacyCount = Math.max(2, Number(component.props.pinCount || 8))
      const leftCount = Math.max(0, Number(component.props.leftPins ?? Math.ceil(legacyCount / 2)))
      const rightCount = Math.max(0, Number(component.props.rightPins ?? Math.floor(legacyCount / 2)))
      const topCount = Math.max(0, Number(component.props.topPins ?? 0))
      const bottomCount = Math.max(0, Number(component.props.bottomPins ?? 0))

      const bodyWidth = Math.max(100, 28 + Math.max(topCount, bottomCount) * 20)
      const bodyHeight = Math.max(80, 24 + Math.max(leftCount, rightCount) * 20)

      const namedMap = new Map<string, string>()
      const rawNames = String(component.props.pinNames || '').trim()
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

      const leftPins = Array.from({ length: leftCount }).map((_, index) => {
        const slotKey = `L${index + 1}`
        return {
          name: getName(slotKey, `L${index + 1}`),
          x: 0,
          y: 20 + index * 20
        }
      })

      const rightPins = Array.from({ length: rightCount }).map((_, index) => {
        const slotKey = `R${index + 1}`
        return {
          name: getName(slotKey, `R${index + 1}`),
          x: bodyWidth,
          y: 20 + index * 20
        }
      })

      const topPins = Array.from({ length: topCount }).map((_, index) => {
        const slotKey = `U${index + 1}`
        return {
          name: getName(slotKey, `U${index + 1}`),
          x: 20 + index * 20,
          y: 0
        }
      })

      const bottomPins = Array.from({ length: bottomCount }).map((_, index) => {
        const slotKey = `D${index + 1}`
        return {
          name: getName(slotKey, `D${index + 1}`),
          x: 20 + index * 20,
          y: bodyHeight
        }
      })

      return [...leftPins, ...rightPins, ...topPins, ...bottomPins]
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
        const compX = comp.props.schX || 0
        const compY = comp.props.schY || 0
        const { width, height } = getComponentSize(comp)
        
        return compX >= minX && compX + width <= maxX && compY >= minY && compY + height <= maxY
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

    if (symbolComponentName) {
      const existingNames = placedComponents.map(c => c.name)
      let i = 1
      let uniqueName = `${symbolComponentName}${i}`
      while (existingNames.includes(uniqueName)) {
        i += 1
        uniqueName = `${symbolComponentName}${i}`
      }

      const ports = symbolComponentPorts ? JSON.parse(symbolComponentPorts) : []

      addPlacedComponent({
        id: `symc-${Date.now()}-${Math.random()}`,
        catalogId: 'subcircuit-instance',
        name: uniqueName,
        props: {
          subcircuitName: symbolComponentName,
          subcircuitPath: symbolComponentPath || `symbols/${symbolComponentName}.tsx`,
          ports,
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

  const endpointKey = (componentId: string, pinName: string) => `${componentId}::${pinName}`
  const endpointPosition = (key: string): { x: number; y: number } | null => {
    const [componentId, pinName] = key.split('::')
    const component = placedComponents.find(c => c.id === componentId)
    if (!component) return null
    return getPinPositionForComponent(component, pinName)
  }

  const wirePathById = new Map<string, string>()
  const junctionDotByWireId = new Map<string, Array<{ x: number; y: number; key: string }>>()

  const endpointDegree = new Map<string, number>()
  wires.forEach((wire) => {
    const fromKey = endpointKey(wire.from.componentId, wire.from.pinName)
    const toKey = endpointKey(wire.to.componentId, wire.to.pinName)
    endpointDegree.set(fromKey, (endpointDegree.get(fromKey) || 0) + 1)
    endpointDegree.set(toKey, (endpointDegree.get(toKey) || 0) + 1)
  })

  const parent = new Map<string, string>()
  const find = (value: string): string => {
    const current = parent.get(value) || value
    if (current === value) {
      parent.set(value, value)
      return value
    }
    const root = find(current)
    parent.set(value, root)
    return root
  }
  const union = (a: string, b: string) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA === rootB) return
    if (rootA < rootB) {
      parent.set(rootB, rootA)
    } else {
      parent.set(rootA, rootB)
    }
  }

  wires.forEach((wire) => {
    const fromKey = endpointKey(wire.from.componentId, wire.from.pinName)
    const toKey = endpointKey(wire.to.componentId, wire.to.pinName)
    if (!parent.has(fromKey)) parent.set(fromKey, fromKey)
    if (!parent.has(toKey)) parent.set(toKey, toKey)
    union(fromKey, toKey)
  })

  const groupWires = new Map<string, typeof wires>()
  const groupEndpoints = new Map<string, Set<string>>()
  wires.forEach((wire) => {
    const fromKey = endpointKey(wire.from.componentId, wire.from.pinName)
    const root = find(fromKey)
    const existing = groupWires.get(root) || []
    existing.push(wire)
    groupWires.set(root, existing)
    const endpointSet = groupEndpoints.get(root) || new Set<string>()
    endpointSet.add(fromKey)
    endpointSet.add(endpointKey(wire.to.componentId, wire.to.pinName))
    groupEndpoints.set(root, endpointSet)
  })

  groupWires.forEach((group, root) => {
    const endpoints = [...(groupEndpoints.get(root) || new Set<string>())]
    const branchEndpoints = endpoints.filter(key => (endpointDegree.get(key) || 0) >= 3)

    if (branchEndpoints.length === 0) {
      group.forEach((wire) => {
        const from = endpointPosition(endpointKey(wire.from.componentId, wire.from.pinName))
        const to = endpointPosition(endpointKey(wire.to.componentId, wire.to.pinName))
        if (!from || !to) return
        const midX = from.x + Math.abs(to.x - from.x) / 2
        wirePathById.set(wire.id, `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`)
        junctionDotByWireId.set(wire.id, [])
      })
      return
    }

    const positions = endpoints
      .map((key) => ({ key, pos: endpointPosition(key) }))
      .filter((entry): entry is { key: string; pos: { x: number; y: number } } => !!entry.pos)

    if (positions.length === 0) return

    const avgX = positions.reduce((sum, entry) => sum + entry.pos.x, 0) / positions.length
    const minX = Math.min(...positions.map(entry => entry.pos.x))
    const maxX = Math.max(...positions.map(entry => entry.pos.x))
    let trunkX = Math.max(minX, Math.min(maxX, avgX))

    if (Math.abs(maxX - minX) < 10) {
      trunkX = avgX + 12
    }

    const groupDots = branchEndpoints
      .map((key) => ({ key, pos: endpointPosition(key) }))
      .filter((entry): entry is { key: string; pos: { x: number; y: number } } => !!entry.pos)
      .map((entry) => ({ x: trunkX, y: entry.pos.y, key: `junction-${root}-${entry.key}` }))

    group.forEach((wire) => {
      const from = endpointPosition(endpointKey(wire.from.componentId, wire.from.pinName))
      const to = endpointPosition(endpointKey(wire.to.componentId, wire.to.pinName))
      if (!from || !to) return
      wirePathById.set(wire.id, `M ${from.x} ${from.y} L ${trunkX} ${from.y} L ${trunkX} ${to.y} L ${to.x} ${to.y}`)
      junctionDotByWireId.set(wire.id, groupDots)
    })
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

    const routedPath = Array.isArray(wire.routePoints) && wire.routePoints.length >= 2
      ? wire.routePoints.map((point: { x: number; y: number }, index: number) => (
        `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`
      )).join(' ')
      : null

    const wirePath = routedPath
      || wirePathById.get(wire.id)
      || `M ${fromPos.x} ${fromPos.y} L ${(fromPos.x + toPos.x) / 2} ${fromPos.y} L ${(fromPos.x + toPos.x) / 2} ${toPos.y} L ${toPos.x} ${toPos.y}`
    const junctionDots = routedPath ? [] : (junctionDotByWireId.get(wire.id) || [])

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
        {/* Dots at connection points */}
        <circle cx={fromPos.x} cy={fromPos.y} r="3" fill="#2196F3" style={{ pointerEvents: 'none' }} />
        <circle cx={toPos.x} cy={toPos.y} r="3" fill="#2196F3" style={{ pointerEvents: 'none' }} />
        {junctionDots.map(dot => (
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
            const isSymbolInstance = component.catalogId === 'symbol-instance'
            const isNetPort = component.catalogId === 'netport'
            const isPublicPort = component.catalogId === 'public-port'
            const isNet = component.catalogId === 'net'

            if (!isSubcircuit && !isSheetInstance && !isSymbolInstance && !isNetPort && !isPublicPort && !getCatalogItem(component.catalogId)) {
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
                    : isSheetInstance
                    ? 'rgba(76, 175, 80, 0.12)'
                    : isSubcircuit
                    ? 'rgba(255, 152, 0, 0.12)'
                    : isSymbolInstance
                    ? 'rgba(0, 188, 212, 0.12)'
                    : 'transparent',
                  border: isSelected
                    ? '2px solid #007acc'
                    : isNetPort
                    ? '1px dashed rgba(156, 39, 176, 0.7)'
                    : isPublicPort
                    ? '1px solid rgba(255, 193, 7, 0.9)'
                    : isNet
                    ? 'none'
                    : isSheetInstance
                    ? '2px dashed rgba(76, 175, 80, 0.6)'
                    : isSubcircuit
                    ? '2px dashed rgba(255, 152, 0, 0.55)'
                    : isSymbolInstance
                    ? '2px dashed rgba(0, 188, 212, 0.6)'
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
                  if (isSymbolInstance && component.props.symbolName) {
                    setActiveFilePath(`symbols/${component.props.symbolName}.tsx`)
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
                    : isSymbolInstance
                    ? '#26c6da'
                    : '#e0e0e0',
                  fontWeight: 500,
                  pointerEvents: 'none'
                }}>
                  {!isNet && !isPublicPort && (
                    <>
                  {isSheetInstance ? '🗂 ' : isSubcircuit ? '📦 ' : isNetPort ? '🔌 ' : ''}{component.name}
                  {component.props.resistance && ` (${component.props.resistance})`}
                  {component.props.capacitance && ` (${component.props.capacitance})`}
                    </>
                  )}
                </div>

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

                {isSymbolInstance && (
                  <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    fontSize: 12,
                    color: '#26c6da',
                    fontWeight: 600,
                    pointerEvents: 'none',
                    textAlign: 'center',
                    whiteSpace: 'nowrap'
                  }}>
                    {component.props.symbolName}
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

                {!isSubcircuit && !isSheetInstance && !isSymbolInstance && !isNetPort && !isPublicPort && (
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
                {pins.map((pin) => {
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
