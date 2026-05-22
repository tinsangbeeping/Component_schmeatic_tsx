import { ElectricalDirection, SymbolDocument, SymbolPort, SymbolPortSide, SymbolSelection, SymbolShape, TscircuitPortDirection } from '../types/symbolDocument'
import {
  symbolShapeToTscircuitPrimitive,
  tscircuitArcToSymbolArc,
  tscircuitCircleToSymbolCircle,
  tscircuitRectToSymbolRect
} from './symbolPrimitiveCompatibility'

const SYMBOL_EDITOR_PREFIX = 'symbols/.editor/'
const SYMBOL_EDITOR_SUFFIX = '.symbol.json'
const DEFAULT_SYMBOL_WIDTH = 120
const DEFAULT_SYMBOL_HEIGHT = 80

const toSafeSymbolName = (raw: string): string => {
  return raw.trim().replace(/[^a-zA-Z0-9_]/g, '_') || 'MySymbol'
}

export const isSymbolEditorPath = (filePath: string): boolean => {
  return filePath.startsWith(SYMBOL_EDITOR_PREFIX) && filePath.endsWith(SYMBOL_EDITOR_SUFFIX)
}

export const getSymbolNameFromEditorPath = (filePath: string): string => {
  if (!isSymbolEditorPath(filePath)) return 'MySymbol'
  return filePath.slice(SYMBOL_EDITOR_PREFIX.length, -SYMBOL_EDITOR_SUFFIX.length) || 'MySymbol'
}

export const getSymbolEditorPathFromName = (name: string): string => {
  return `${SYMBOL_EDITOR_PREFIX}${toSafeSymbolName(name)}${SYMBOL_EDITOR_SUFFIX}`
}

export const getGeneratedSymbolTsxPath = (name: string): string => {
  return `symbols/${toSafeSymbolName(name)}.tsx`
}

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

const normalizeLegacyRectShape = (shape: Record<string, any>): SymbolShape => {
  const width = Math.abs(toFiniteNumber(shape.width))
  const height = Math.abs(toFiniteNumber(shape.height))
  const normalized = tscircuitRectToSymbolRect({
    x: shape.x,
    y: shape.y,
    schX: shape.schX,
    schY: shape.schY,
    width,
    height,
    center: shape.center ?? ((shape.cx !== undefined || shape.cy !== undefined)
      ? { x: shape.cx, y: shape.cy }
      : undefined)
  })

  return {
    id: String(shape.id || `rect-${Date.now()}`),
    kind: 'schematicrect',
    cx: normalized.cx,
    cy: normalized.cy,
    width,
    height
  }
}

const normalizeLegacyCircleShape = (shape: Record<string, any>): SymbolShape => {
  const cx = toFiniteNumber(shape.cx ?? shape.center?.x ?? shape.x)
  const cy = toFiniteNumber(shape.cy ?? shape.center?.y ?? shape.y)

  return {
    id: String(shape.id || `circle-${Date.now()}`),
    kind: 'schematiccircle',
    cx,
    cy,
    radius: Math.abs(toFiniteNumber(shape.radius))
  }
}

const normalizeLegacyArcShape = (shape: Record<string, any>): SymbolShape => {
  const cx = toFiniteNumber(shape.cx ?? shape.center?.x ?? shape.x)
  const cy = toFiniteNumber(shape.cy ?? shape.center?.y ?? shape.y)
  const rawDirection = String(shape.direction || '').toLowerCase()

  return {
    id: String(shape.id || `arc-${Date.now()}`),
    kind: 'schematicarc',
    cx,
    cy,
    radius: Math.abs(toFiniteNumber(shape.radius)),
    startAngle: toFiniteNumber(shape.startAngle ?? shape.startAngleDegrees),
    endAngle: toFiniteNumber(shape.endAngle ?? shape.endAngleDegrees),
    direction: rawDirection === 'clockwise' || rawDirection === 'counterclockwise' ? rawDirection : undefined
  }
}

const normalizeLegacyTextShape = (shape: Record<string, any>): SymbolShape => {
  return {
    id: String(shape.id || `text-${Date.now()}`),
    kind: 'schematictext',
    x: toFiniteNumber(shape.x ?? shape.schX),
    y: toFiniteNumber(shape.y ?? shape.schY),
    text: String(shape.text || '')
  }
}

const normalizeSymbolShape = (shape: Record<string, any>): SymbolShape | null => {
  if (!shape || typeof shape !== 'object') return null
  const shapeKind = String(shape.kind || shape.type || '')

  if (shapeKind === 'schematicline') {
    return {
      id: String(shape.id || `line-${Date.now()}`),
      kind: 'schematicline',
      x1: toFiniteNumber(shape.x1),
      y1: toFiniteNumber(shape.y1),
      x2: toFiniteNumber(shape.x2),
      y2: toFiniteNumber(shape.y2)
    }
  }

  if (shapeKind === 'schematicrect') return normalizeLegacyRectShape(shape)
  if (shapeKind === 'schematiccircle') return normalizeLegacyCircleShape(shape)
  if (shapeKind === 'schematicarc') return normalizeLegacyArcShape(shape)
  if (shapeKind === 'schematictext') return normalizeLegacyTextShape(shape)

  return null
}

const normalizeSymbolPort = (port: Record<string, any>, fallbackOrder: number): SymbolPort | null => {
  if (!port || typeof port !== 'object') return null
  const name = String(port.name || '').trim()
  if (!name) return null
  return {
    id: String(port.id || `port-${Date.now()}-${fallbackOrder}`),
    name,
    electricalDirection: port.electricalDirection,
    side: port.side,
    order: port.order !== undefined ? Number(port.order) : fallbackOrder,
    schX: toFiniteNumber(port.schX ?? port.x),
    schY: toFiniteNumber(port.schY ?? port.y)
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const snapPortToBoundary = (port: SymbolPort, width: number, height: number): SymbolPort => {
  if (port.side === 'left') return { ...port, schX: 0, schY: clamp(port.schY, 0, height) }
  if (port.side === 'right') return { ...port, schX: width, schY: clamp(port.schY, 0, height) }
  if (port.side === 'top') return { ...port, schX: clamp(port.schX, 0, width), schY: 0 }
  return { ...port, schX: clamp(port.schX, 0, width), schY: height }
}

const distributePortsWithinBoundary = (ports: SymbolPort[], width: number, height: number): SymbolPort[] => {
  const needsRemap = ports.some((port) => {
    if (port.side === 'left' || port.side === 'right') {
      return (port.schX !== 0 && port.schX !== width) || port.schY < 0 || port.schY > height
    }
    return (port.schY !== 0 && port.schY !== height) || port.schX < 0 || port.schX > width
  })

  if (!needsRemap) {
    return ports.map((port) => snapPortToBoundary(port, width, height))
  }

  const margin = 10
  const bySide: Record<SymbolPortSide, SymbolPort[]> = {
    left: [],
    right: [],
    top: [],
    bottom: []
  }

  ports.forEach((port) => {
    bySide[port.side].push(port)
  })

  const distribute = (count: number, start: number, end: number): number[] => {
    if (count <= 0) return []
    if (count === 1) return [(start + end) / 2]
    return Array.from({ length: count }, (_, index) => start + ((end - start) * index) / (count - 1))
  }

  const sortPorts = (portsForSide: SymbolPort[], axis: 'x' | 'y') => {
    return [...portsForSide].sort((a, b) => {
      if (a.order !== undefined && b.order !== undefined && a.order !== b.order) return a.order - b.order
      return (axis === 'x' ? a.schX - b.schX : a.schY - b.schY)
    })
  }

  const left = sortPorts(bySide.left, 'y')
  const right = sortPorts(bySide.right, 'y')
  const top = sortPorts(bySide.top, 'x')
  const bottom = sortPorts(bySide.bottom, 'x')

  const leftYs = distribute(left.length, margin, height - margin)
  const rightYs = distribute(right.length, margin, height - margin)
  const topXs = distribute(top.length, margin, width - margin)
  const bottomXs = distribute(bottom.length, margin, width - margin)

  return [
    ...left.map((port, index) => ({ ...port, schX: 0, schY: leftYs[index] ?? height / 2 })),
    ...right.map((port, index) => ({ ...port, schX: width, schY: rightYs[index] ?? height / 2 })),
    ...top.map((port, index) => ({ ...port, schX: topXs[index] ?? width / 2, schY: 0 })),
    ...bottom.map((port, index) => ({ ...port, schX: bottomXs[index] ?? width / 2, schY: height }))
  ]
}

export const createSymbolDocument = (name: string): SymbolDocument => {
  return {
    kind: 'symbol',
    name: toSafeSymbolName(name),
    description: '',
    width: DEFAULT_SYMBOL_WIDTH,
    height: DEFAULT_SYMBOL_HEIGHT,
    shapes: [],
    ports: []
  }
}

export const parseSymbolDocument = (raw: string, fallbackName: string): SymbolDocument | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<SymbolDocument>
    if (parsed.kind !== 'symbol') return null

    const width = Math.max(20, Number(parsed.width || DEFAULT_SYMBOL_WIDTH))
    const height = Math.max(20, Number(parsed.height || DEFAULT_SYMBOL_HEIGHT))

    const normalizedShapes = (Array.isArray(parsed.shapes) ? parsed.shapes : [])
      .map(shape => normalizeSymbolShape(shape as Record<string, any>))
      .filter(Boolean) as SymbolShape[]

    const normalizedPorts = distributePortsWithinBoundary((Array.isArray(parsed.ports) ? parsed.ports : [])
      .map((port, index) => normalizeSymbolPort(port as Record<string, any>, index))
      .filter(Boolean) as SymbolPort[], width, height)

    return {
      kind: 'symbol',
      name: toSafeSymbolName(String(parsed.name || fallbackName || 'MySymbol')),
      description: String(parsed.description || ''),
      width,
      height,
      needsManualReview: !!parsed.needsManualReview,
      shapes: normalizedShapes,
      ports: normalizedPorts
    }
  } catch {
    return null
  }
}

const toTsxNumber = (value: number): string => {
  const rounded = Number(value.toFixed(3))
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

const escapeStringLiteral = (value: string): string => {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

const toTscircuitY = (localY: number, symbolHeight: number): number => symbolHeight - localY

const fromTscircuitY = (tscircuitY: number, symbolHeight: number): number => symbolHeight - tscircuitY

const inferImportedSymbolHeight = (shapes: SymbolShape[], ports: SymbolPort[]) => {
  let maxY = 0

  const extend = (_x: number, y: number) => {
    maxY = Math.max(maxY, y)
  }

  shapes.forEach((shape) => {
    if (shape.kind === 'schematicline') {
      extend(shape.x1, shape.y1)
      extend(shape.x2, shape.y2)
      return
    }

    if (shape.kind === 'schematicrect') {
      extend(shape.cx + shape.width / 2, shape.cy + shape.height / 2)
      return
    }

    if (shape.kind === 'schematiccircle' || shape.kind === 'schematicarc') {
      extend(shape.cx + shape.radius, shape.cy + shape.radius)
      return
    }

    extend(shape.x, shape.y)
  })

  ports.forEach((port) => {
    extend(port.schX, port.schY)
  })

  return {
    height: Math.max(DEFAULT_SYMBOL_HEIGHT, Math.ceil(maxY))
  }
}

const flipImportedShapeY = (shape: SymbolShape, symbolHeight: number): SymbolShape => {
  if (shape.kind === 'schematicline') {
    return {
      ...shape,
      y1: fromTscircuitY(shape.y1, symbolHeight),
      y2: fromTscircuitY(shape.y2, symbolHeight)
    }
  }

  if (shape.kind === 'schematicrect') {
    return {
      ...shape,
      cy: fromTscircuitY(shape.cy, symbolHeight)
    }
  }

  if (shape.kind === 'schematiccircle' || shape.kind === 'schematicarc') {
    return {
      ...shape,
      cy: fromTscircuitY(shape.cy, symbolHeight)
    }
  }

  return {
    ...shape,
    y: fromTscircuitY(shape.y, symbolHeight)
  }
}

const flipImportedPortY = (port: SymbolPort, symbolHeight: number): SymbolPort => {
  return {
    ...port,
    schY: fromTscircuitY(port.schY, symbolHeight)
  }
}

const isRenderableSymbolShape = (shape: SymbolShape): boolean => {
  if (shape.kind === 'schematicline') {
    return shape.x1 !== shape.x2 || shape.y1 !== shape.y2
  }

  if (shape.kind === 'schematicrect') {
    return Math.abs(shape.width) > 0 && Math.abs(shape.height) > 0
  }

  if (shape.kind === 'schematiccircle') {
    return Math.abs(shape.radius) > 0
  }

  if (shape.kind === 'schematicarc') {
    const delta = Math.abs(((shape.endAngle - shape.startAngle) % 360 + 360) % 360)
    return Math.abs(shape.radius) > 0 && delta > 0
  }

  if (shape.kind === 'schematictext') {
    return shape.text.trim().length > 0
  }

  return false
}

const symbolShapeToTsx = (shape: SymbolShape, symbolHeight: number): string => {
  const primitive = symbolShapeToTscircuitPrimitive(shape)

  if (primitive.kind === 'schematicline') {
    return `<schematicline x1={${toTsxNumber(primitive.props.x1)}} y1={${toTsxNumber(toTscircuitY(primitive.props.y1, symbolHeight))}} x2={${toTsxNumber(primitive.props.x2)}} y2={${toTsxNumber(toTscircuitY(primitive.props.y2, symbolHeight))}} />`
  }

  if (primitive.kind === 'schematicrect') {
    return `<schematicrect schX={${toTsxNumber(primitive.props.schX)}} schY={${toTsxNumber(toTscircuitY(primitive.props.schY, symbolHeight))}} width={${toTsxNumber(primitive.props.width)}} height={${toTsxNumber(primitive.props.height)}} />`
  }

  if (primitive.kind === 'schematiccircle') {
    return `<schematiccircle center={{x: ${toTsxNumber(primitive.props.center.x)}, y: ${toTsxNumber(toTscircuitY(primitive.props.center.y, symbolHeight))}}} radius={${toTsxNumber(primitive.props.radius)}} />`
  }

  if (primitive.kind === 'schematicarc') {
    const directionPart = primitive.props.direction ? ` direction="${primitive.props.direction}"` : ''
    return `<schematicarc center={{x: ${toTsxNumber(primitive.props.center.x)}, y: ${toTsxNumber(toTscircuitY(primitive.props.center.y, symbolHeight))}}} radius={${toTsxNumber(primitive.props.radius)}} startAngleDegrees={${toTsxNumber(primitive.props.startAngleDegrees)}} endAngleDegrees={${toTsxNumber(primitive.props.endAngleDegrees)}}${directionPart} />`
  }

  return `<schematictext schX={${toTsxNumber(primitive.props.schX)}} schY={${toTsxNumber(toTscircuitY(primitive.props.schY, symbolHeight))}} text="${escapeStringLiteral(primitive.props.text)}" />`
}

const symbolPortToTsx = (port: SymbolPort, symbolWidth: number, symbolHeight: number): string => {
  const sideToTscDirection: Record<SymbolPortSide, TscircuitPortDirection> = {
    left: 'left',
    right: 'right',
    top: 'up',
    bottom: 'down'
  }
  const normalizedCoord = (() => {
    if (port.side === 'left') return { x: 0, y: port.schY }
    if (port.side === 'right') return { x: symbolWidth, y: port.schY }
    if (port.side === 'top') return { x: port.schX, y: 0 }
    return { x: port.schX, y: symbolHeight }
  })()
  const sidePart = ` side="${port.side}"`
  const orderPart = port.order !== undefined ? ` order={${port.order}}` : ''
  const direction = sideToTscDirection[port.side]
  return `<port name="${escapeStringLiteral(port.name)}" direction="${direction}"${sidePart}${orderPart} schX={${toTsxNumber(normalizedCoord.x)}} schY={${toTsxNumber(toTscircuitY(normalizedCoord.y, symbolHeight))}} />`
}

const toSafeComponentIdentifier = (raw: string): string => {
  const safe = toSafeSymbolName(raw)
  if (/^[0-9]/.test(safe)) return `Symbol_${safe}`
  return safe
}

const normalizeSymbolDocumentLocal = (document: SymbolDocument): { normalizedShapes: SymbolShape[]; normalizedPorts: SymbolPort[]; width: number; height: number } => {
  const normalizedShapes = (document.shapes as Array<Record<string, any>>)
    .map(shape => normalizeSymbolShape(shape))
    .filter(Boolean) as SymbolShape[]

  const normalizedPorts = (document.ports as Array<Record<string, any>>)
    .map((port, index) => normalizeSymbolPort(port, index))
    .filter(Boolean) as SymbolPort[]

  const width = Math.max(20, Number(document.width || DEFAULT_SYMBOL_WIDTH))
  const height = Math.max(20, Number(document.height || DEFAULT_SYMBOL_HEIGHT))

  return {
    normalizedShapes,
    normalizedPorts: normalizedPorts.map((port) => snapPortToBoundary(port, width, height)),
    width,
    height
  }
}

export const generateSymbolTsx = (document: SymbolDocument): string => {
  const fnName = toSafeComponentIdentifier(document.name || 'MySymbol')
  const normalized = normalizeSymbolDocumentLocal(document)
  const symbolWidth = Math.max(20, Number(normalized.width || DEFAULT_SYMBOL_WIDTH))
  const symbolHeight = Math.max(20, Number(normalized.height || DEFAULT_SYMBOL_HEIGHT))
  const rows = [
    ...normalized.normalizedShapes.filter(isRenderableSymbolShape).map(shape => symbolShapeToTsx(shape, symbolHeight)),
    ...normalized.normalizedPorts.map(port => symbolPortToTsx(port, symbolWidth, symbolHeight))
  ]

  const body = rows.length > 0
    ? rows.map(row => `          ${row}`).join('\n')
    : '          {/* Empty symbol */}'

  return `export default function ${fnName}(props) {\n  return (\n    <chip\n      name={props.name}\n      schX={props.schX}\n      schY={props.schY}\n      symbol={\n        <symbol>\n${body}\n        </symbol>\n      }\n    />\n  )\n}\n`
}

const parseNumericProp = (tag: string, propName: string): { value: number | null; dynamic: boolean } => {
  const exprMatch = tag.match(new RegExp(`${propName}\\s*=\\s*\\{([^}]+)\\}`))
  if (exprMatch?.[1] !== undefined) {
    const raw = exprMatch[1].trim()
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
      return { value: Number(raw), dynamic: false }
    }
    return { value: null, dynamic: true }
  }

  const stringMatch = tag.match(new RegExp(`${propName}\\s*=\\s*[\"']([^\"']+)[\"']`))
  if (stringMatch?.[1] !== undefined) {
    const raw = stringMatch[1].trim()
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
      return { value: Number(raw), dynamic: false }
    }
    return { value: null, dynamic: true }
  }

  return { value: null, dynamic: false }
}

const parseStringProp = (tag: string, propName: string): { value: string | null; dynamic: boolean } => {
  const stringMatch = tag.match(new RegExp(`${propName}\\s*=\\s*[\"']([^\"']*)[\"']`))
  if (stringMatch?.[1] !== undefined) {
    return { value: String(stringMatch[1]), dynamic: false }
  }

  const exprMatch = tag.match(new RegExp(`${propName}\\s*=\\s*\\{([^}]+)\\}`))
  if (exprMatch?.[1] !== undefined) {
    const raw = exprMatch[1].trim()
    const quoted = raw.match(/^[\"']([\s\S]*)[\"']$/)
    if (quoted) {
      return { value: quoted[1], dynamic: false }
    }
    return { value: null, dynamic: true }
  }

  return { value: null, dynamic: false }
}

const parseCoordinatePair = (tag: string, firstProp: string, secondProp: string): { x: number | null; y: number | null; dynamic: boolean } => {
  const first = parseNumericProp(tag, firstProp)
  const second = parseNumericProp(tag, secondProp)
  const dynamic = first.dynamic || second.dynamic
  if (first.value === null || second.value === null) {
    return { x: first.value, y: second.value, dynamic }
  }
  return { x: first.value, y: second.value, dynamic }
}

const parseCenterLike = (tag: string): { cx: number | null; cy: number | null; dynamic: boolean } => {
  const centerObject = tag.match(/center\s*=\s*\{\{\s*x\s*:\s*([^,}]+)\s*,\s*y\s*:\s*([^}]+)\s*\}\}/)
  if (centerObject) {
    const rawX = centerObject[1].trim()
    const rawY = centerObject[2].trim()
    const xIsNumber = /^-?\d+(?:\.\d+)?$/.test(rawX)
    const yIsNumber = /^-?\d+(?:\.\d+)?$/.test(rawY)
    if (xIsNumber && yIsNumber) {
      return { cx: Number(rawX), cy: Number(rawY), dynamic: false }
    }
    return { cx: null, cy: null, dynamic: true }
  }

  const direct = parseCoordinatePair(tag, 'cx', 'cy')
  if (direct.x !== null && direct.y !== null) {
    return { cx: direct.x, cy: direct.y, dynamic: direct.dynamic }
  }

  const legacyXY = parseCoordinatePair(tag, 'x', 'y')
  return { cx: legacyXY.x, cy: legacyXY.y, dynamic: legacyXY.dynamic || /center\s*=/.test(tag) }
}

const nextImportedId = (() => {
  let index = 0
  return (prefix: string): string => {
    index += 1
    return `${prefix}-${index}`
  }
})()

export const importSymbolTsxToDocument = (tsx: string, symbolNameHint: string): SymbolDocument => {
  const body = tsx.match(/<symbol\b[^>]*>([\s\S]*?)<\/symbol>/)?.[1] || ''
  const document = createSymbolDocument(symbolNameHint)
  let needsManualReview = false

  const lineTags = [...body.matchAll(/<schematicline\b[^>]*\/?>(?:<\/schematicline>)?/g)].map(match => match[0])
  lineTags.forEach(tag => {
    const x1 = parseNumericProp(tag, 'x1')
    const y1 = parseNumericProp(tag, 'y1')
    const x2 = parseNumericProp(tag, 'x2')
    const y2 = parseNumericProp(tag, 'y2')
    if ([x1.value, y1.value, x2.value, y2.value].every(v => v !== null)) {
      document.shapes.push({ id: nextImportedId('line'), kind: 'schematicline', x1: x1.value as number, y1: y1.value as number, x2: x2.value as number, y2: y2.value as number })
    } else {
      needsManualReview = needsManualReview || x1.dynamic || y1.dynamic || x2.dynamic || y2.dynamic
    }
  })

  const rectTags = [...body.matchAll(/<schematicrect\b[^>]*\/?>(?:<\/schematicrect>)?/g)].map(match => match[0])
  rectTags.forEach(tag => {
    const schX = parseNumericProp(tag, 'schX')
    const schY = parseNumericProp(tag, 'schY')
    const x = parseNumericProp(tag, 'x')
    const y = parseNumericProp(tag, 'y')
    const width = parseNumericProp(tag, 'width')
    const height = parseNumericProp(tag, 'height')
    const center = parseCenterLike(tag)

    if (width.value !== null && height.value !== null && (x.value !== null || schX.value !== null || center.cx !== null) && (y.value !== null || schY.value !== null || center.cy !== null)) {
      const normalized = tscircuitRectToSymbolRect({
        x: x.value,
        y: y.value,
        schX: schX.value,
        schY: schY.value,
        width: width.value,
        height: height.value,
        center: center.cx !== null && center.cy !== null ? { x: center.cx, y: center.cy } : null
      })
      document.shapes.push({
        id: nextImportedId('rect'),
        kind: 'schematicrect',
        cx: normalized.cx,
        cy: normalized.cy,
        width: normalized.width,
        height: normalized.height
      })
    } else {
      needsManualReview = needsManualReview || schX.dynamic || schY.dynamic || x.dynamic || y.dynamic || width.dynamic || height.dynamic || center.dynamic
    }
  })

  const circleTags = [...body.matchAll(/<schematiccircle\b[^>]*\/?>(?:<\/schematiccircle>)?/g)].map(match => match[0])
  circleTags.forEach(tag => {
    const center = parseCenterLike(tag)
    const radius = parseNumericProp(tag, 'radius')
    if (center.cx !== null && center.cy !== null && radius.value !== null) {
      const normalized = tscircuitCircleToSymbolCircle({ center: { x: center.cx, y: center.cy }, radius: radius.value })
      document.shapes.push({ id: nextImportedId('circle'), kind: 'schematiccircle', cx: normalized.cx, cy: normalized.cy, radius: normalized.radius })
    } else {
      needsManualReview = needsManualReview || center.dynamic || radius.dynamic
    }
  })

  const arcTags = [...body.matchAll(/<schematicarc\b[^>]*\/?>(?:<\/schematicarc>)?/g)].map(match => match[0])
  arcTags.forEach(tag => {
    const center = parseCenterLike(tag)
    const radius = parseNumericProp(tag, 'radius')
    const startAngle = parseNumericProp(tag, 'startAngle')
    const endAngle = parseNumericProp(tag, 'endAngle')
    const startAngleDegrees = parseNumericProp(tag, 'startAngleDegrees')
    const endAngleDegrees = parseNumericProp(tag, 'endAngleDegrees')
    const direction = parseStringProp(tag, 'direction')
    const start = startAngleDegrees.value ?? startAngle.value
    const end = endAngleDegrees.value ?? endAngle.value
    if (center.cx !== null && center.cy !== null && radius.value !== null && start !== null && end !== null) {
      const normalized = tscircuitArcToSymbolArc({
        center: { x: center.cx, y: center.cy },
        radius: radius.value,
        startAngle: start,
        endAngle: end,
        direction: direction.value
      })
      document.shapes.push({
        id: nextImportedId('arc'),
        kind: 'schematicarc',
        cx: normalized.cx,
        cy: normalized.cy,
        radius: normalized.radius,
        startAngle: normalized.startAngle,
        endAngle: normalized.endAngle,
        direction: normalized.direction
      })
    } else {
      needsManualReview = needsManualReview || center.dynamic || radius.dynamic || startAngle.dynamic || endAngle.dynamic || startAngleDegrees.dynamic || endAngleDegrees.dynamic || direction.dynamic
    }
  })

  const textTags = [...body.matchAll(/<schematictext\b[^>]*\/?>(?:<\/schematictext>)?/g)].map(match => match[0])
  textTags.forEach(tag => {
    const schX = parseNumericProp(tag, 'schX')
    const schY = parseNumericProp(tag, 'schY')
    const x = parseNumericProp(tag, 'x')
    const y = parseNumericProp(tag, 'y')
    const text = parseStringProp(tag, 'text')
    const normalizedX = schX.value ?? x.value
    const normalizedY = schY.value ?? y.value
    if (normalizedX !== null && normalizedY !== null && text.value !== null) {
      document.shapes.push({
        id: nextImportedId('text'),
        kind: 'schematictext',
        x: normalizedX,
        y: normalizedY,
        text: text.value
      })
    } else {
      needsManualReview = needsManualReview || schX.dynamic || schY.dynamic || x.dynamic || y.dynamic || text.dynamic
    }
  })

  const portTags = [...body.matchAll(/<port\b[^>]*\/?>(?:<\/port>)?/g)].map(match => match[0])
  const importedPorts: SymbolPort[] = []
  portTags.forEach(tag => {
    const name = parseStringProp(tag, 'name')
    const direction = parseStringProp(tag, 'direction')
    const side = parseStringProp(tag, 'side')
    const order = parseNumericProp(tag, 'order')
    const x = parseNumericProp(tag, 'x')
    const y = parseNumericProp(tag, 'y')
    const schX = parseNumericProp(tag, 'schX')
    const schY = parseNumericProp(tag, 'schY')
    if (name.value !== null) {
      const rawDirection = String(direction.value || 'passive').toLowerCase()
      const validElectricalDirections: ElectricalDirection[] = ['input', 'output', 'inout', 'passive']
      const directionAsSide: Record<string, SymbolPortSide> = {
        left: 'left',
        right: 'right',
        top: 'top',
        bottom: 'bottom',
        up: 'top',
        down: 'bottom'
      }
      const parsedElectricalDirection = validElectricalDirections.includes(rawDirection as ElectricalDirection)
        ? (rawDirection as ElectricalDirection)
        : undefined
      const sideValue = String(side.value || '').toLowerCase()
      const parsedSide = ((): SymbolPortSide => {
        if (sideValue in directionAsSide) return directionAsSide[sideValue]
        if (rawDirection in directionAsSide) return directionAsSide[rawDirection]
        const px = schX.value ?? x.value ?? 0
        const py = schY.value ?? y.value ?? 0
        const absX = Math.abs(px)
        const absY = Math.abs(py)
        if (absX >= absY) return px >= 0 ? 'right' : 'left'
        return py >= 0 ? 'top' : 'bottom'
      })()
      importedPorts.push({
        id: nextImportedId('port'),
        name: name.value,
        electricalDirection: parsedElectricalDirection,
        side: parsedSide,
        order: order.value !== null ? order.value : undefined,
        schX: schX.value ?? x.value ?? 0,
        schY: schY.value ?? y.value ?? 0
      })
      if ((x.value ?? schX.value) === null || (y.value ?? schY.value) === null) {
        needsManualReview = true
      }
    } else {
      needsManualReview = needsManualReview || name.dynamic || direction.dynamic || x.dynamic || y.dynamic || schX.dynamic || schY.dynamic
    }
  })

  if (/\{[^}]*=>|\{[^}]*\bprops\b|\{[^}]*\bmap\b/.test(body)) {
    needsManualReview = true
  }

  const inferredHeight = inferImportedSymbolHeight(document.shapes, importedPorts)
  document.height = inferredHeight.height
  document.shapes = document.shapes.map(shape => flipImportedShapeY(shape, document.height))
  document.ports = distributePortsWithinBoundary(importedPorts.map(port => flipImportedPortY(port, document.height)), document.width, document.height)

  document.needsManualReview = needsManualReview
  return document
}

export const updateSymbolSelectionAfterDelete = (
  selection: SymbolSelection,
  deletedId: string,
  deletedKind: 'shape' | 'port'
): SymbolSelection => {
  if (!selection) return null
  if (selection.kind === 'multi') {
    const shapeIds = deletedKind === 'shape'
      ? selection.shapeIds.filter(id => id !== deletedId)
      : selection.shapeIds
    const portIds = deletedKind === 'port'
      ? selection.portIds.filter(id => id !== deletedId)
      : selection.portIds
    if (shapeIds.length === 0 && portIds.length === 0) return null
    if (shapeIds.length === 1 && portIds.length === 0) return { kind: 'shape', id: shapeIds[0] }
    if (portIds.length === 1 && shapeIds.length === 0) return { kind: 'port', id: portIds[0] }
    return { kind: 'multi', shapeIds, portIds }
  }
  if (selection.kind === deletedKind && selection.id === deletedId) return null
  return selection
}
