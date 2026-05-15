import { SymbolDefinition } from '../types/project'

type SymbolShape = Record<string, any>

type SymbolPoint = {
  x: number
  y: number
}

export interface SymbolBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

const toFinite = (value: unknown, fallback = 0): number => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

const shapePoints = (shape: SymbolShape): SymbolPoint[] => {
  if (shape.kind === 'schematicline') {
    return [
      { x: toFinite(shape.x1), y: toFinite(shape.y1) },
      { x: toFinite(shape.x2), y: toFinite(shape.y2) }
    ]
  }

  if (shape.kind === 'schematicrect') {
    const width = Math.abs(toFinite(shape.width))
    const height = Math.abs(toFinite(shape.height))
    const centerX = toFinite((shape as any).cx ?? (shape as any).schX)
    const centerY = toFinite((shape as any).cy ?? (shape as any).schY)
    return [
      { x: centerX - width / 2, y: centerY - height / 2 },
      { x: centerX + width / 2, y: centerY + height / 2 }
    ]
  }

  if (shape.kind === 'schematiccircle' || shape.kind === 'schematicarc') {
    const centerX = toFinite((shape as any).cx ?? (shape as any).center?.x ?? (shape as any).x)
    const centerY = toFinite((shape as any).cy ?? (shape as any).center?.y ?? (shape as any).y)
    const radius = Math.abs(toFinite(shape.radius))
    return [
      { x: centerX - radius, y: centerY - radius },
      { x: centerX + radius, y: centerY + radius }
    ]
  }

  if (shape.kind === 'schematictext') {
    const x = toFinite((shape as any).x ?? (shape as any).schX)
    const y = toFinite((shape as any).y ?? (shape as any).schY)
    const textWidth = Math.max(1, String(shape.text || '').length) * 6
    return [
      { x, y: y - 8 },
      { x: x + textWidth, y: y + 2 }
    ]
  }

  return []
}

export const getSymbolBoundsFromGeometry = (
  shapes: SymbolShape[],
  ports: Array<{ x: number; y: number }> = [],
  fallbackWidth = 120,
  fallbackHeight = 80
): SymbolBounds => {
  const points: SymbolPoint[] = []

  shapes.forEach((shape) => {
    points.push(...shapePoints(shape))
  })

  ports.forEach((port) => {
    points.push({ x: toFinite(port.x), y: toFinite(port.y) })
  })

  if (points.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: Math.max(20, toFinite(fallbackWidth, 120)),
      maxY: Math.max(20, toFinite(fallbackHeight, 80)),
      width: Math.max(20, toFinite(fallbackWidth, 120)),
      height: Math.max(20, toFinite(fallbackHeight, 80))
    }
  }

  const minX = Math.min(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y))
  const maxX = Math.max(...points.map((point) => point.x))
  const maxY = Math.max(...points.map((point) => point.y))

  const width = Math.max(20, maxX - minX)
  const height = Math.max(20, maxY - minY)

  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height
  }
}

export const getSymbolBounds = (symbolDefinition: SymbolDefinition | undefined): SymbolBounds => {
  const fallbackWidth = Number(symbolDefinition?.width || symbolDefinition?.geometry?.width || 120)
  const fallbackHeight = Number(symbolDefinition?.height || symbolDefinition?.geometry?.height || 80)

  if (!symbolDefinition) {
    return getSymbolBoundsFromGeometry([], [], fallbackWidth, fallbackHeight)
  }

  const explicitBounds = symbolDefinition.bounds || symbolDefinition.geometry?.bounds
  if (explicitBounds) {
    const minX = toFinite(explicitBounds.minX)
    const minY = toFinite(explicitBounds.minY)
    const maxX = toFinite(explicitBounds.maxX, minX + fallbackWidth)
    const maxY = toFinite(explicitBounds.maxY, minY + fallbackHeight)
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(20, maxX - minX),
      height: Math.max(20, maxY - minY)
    }
  }

  const shapes = Array.isArray(symbolDefinition.geometry?.shapes)
    ? symbolDefinition.geometry?.shapes || []
    : []

  const ports = Array.isArray(symbolDefinition.ports)
    ? symbolDefinition.ports.map((port) => ({ x: Number(port.x || 0), y: Number(port.y || 0) }))
    : []

  return getSymbolBoundsFromGeometry(shapes, ports, fallbackWidth, fallbackHeight)
}
