import { SymbolShape } from '../types/symbolDocument'

export type TscircuitSymbolPrimitive =
  | {
      kind: 'schematicline'
      props: {
        x1: number
        y1: number
        x2: number
        y2: number
      }
    }
  | {
      kind: 'schematicrect'
      props: {
        schX: number
        schY: number
        width: number
        height: number
      }
    }
  | {
      kind: 'schematiccircle'
      props: {
        center: { x: number; y: number }
        radius: number
      }
    }
  | {
      kind: 'schematicarc'
      props: {
        center: { x: number; y: number }
        radius: number
        startAngleDegrees: number
        endAngleDegrees: number
        direction?: 'clockwise' | 'counterclockwise'
      }
    }
  | {
      kind: 'schematictext'
      props: {
        schX: number
        schY: number
        text: string
      }
    }

export const symbolShapeToTscircuitPrimitive = (shape: SymbolShape): TscircuitSymbolPrimitive => {
  if (shape.kind === 'schematicline') {
    return {
      kind: 'schematicline',
      props: {
        x1: shape.x1,
        y1: shape.y1,
        x2: shape.x2,
        y2: shape.y2
      }
    }
  }

  if (shape.kind === 'schematicrect') {
    return {
      kind: 'schematicrect',
      props: {
        schX: shape.cx,
        schY: shape.cy,
        width: shape.width,
        height: shape.height
      }
    }
  }

  if (shape.kind === 'schematiccircle') {
    return {
      kind: 'schematiccircle',
      props: {
        center: { x: shape.cx, y: shape.cy },
        radius: shape.radius
      }
    }
  }

  if (shape.kind === 'schematicarc') {
    return {
      kind: 'schematicarc',
      props: {
        center: { x: shape.cx, y: shape.cy },
        radius: shape.radius,
        startAngleDegrees: shape.startAngle,
        endAngleDegrees: shape.endAngle,
        direction: shape.direction
      }
    }
  }

  return {
    kind: 'schematictext',
    props: {
      schX: shape.x,
      schY: shape.y,
      text: shape.text
    }
  }
}

const toFinite = (value: unknown, fallback = 0): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export const tscircuitRectToSymbolRect = (input: {
  x?: unknown
  y?: unknown
  schX?: unknown
  schY?: unknown
  width?: unknown
  height?: unknown
  center?: { x?: unknown; y?: unknown } | null
}) => {
  const width = Math.abs(toFinite(input.width))
  const height = Math.abs(toFinite(input.height))
  const hasTopLeftX = input.x !== null && input.x !== undefined && Number.isFinite(Number(input.x))
  const hasTopLeftY = input.y !== null && input.y !== undefined && Number.isFinite(Number(input.y))
  const centerX = hasTopLeftX
    ? toFinite(input.x) + width / 2
    : toFinite(input.schX ?? input.center?.x, 0)
  const centerY = hasTopLeftY
    ? toFinite(input.y) + height / 2
    : toFinite(input.schY ?? input.center?.y, 0)

  return { cx: centerX, cy: centerY, width, height }
}

export const tscircuitCircleToSymbolCircle = (input: {
  cx?: unknown
  cy?: unknown
  x?: unknown
  y?: unknown
  center?: { x?: unknown; y?: unknown } | null
  radius?: unknown
}) => {
  return {
    cx: toFinite(input.cx ?? input.center?.x ?? input.x),
    cy: toFinite(input.cy ?? input.center?.y ?? input.y),
    radius: Math.abs(toFinite(input.radius))
  }
}

export const tscircuitArcToSymbolArc = (input: {
  cx?: unknown
  cy?: unknown
  x?: unknown
  y?: unknown
  center?: { x?: unknown; y?: unknown } | null
  radius?: unknown
  startAngle?: unknown
  endAngle?: unknown
  startAngleDegrees?: unknown
  endAngleDegrees?: unknown
  direction?: unknown
}) => {
  const rawDirection = String(input.direction || '').toLowerCase()
  const direction: 'clockwise' | 'counterclockwise' | undefined = rawDirection === 'clockwise' || rawDirection === 'counterclockwise'
    ? rawDirection
    : undefined
  const start = toFinite(input.startAngle ?? input.startAngleDegrees)
  const end = toFinite(input.endAngle ?? input.endAngleDegrees)
  return {
    cx: toFinite(input.cx ?? input.center?.x ?? input.x),
    cy: toFinite(input.cy ?? input.center?.y ?? input.y),
    radius: Math.abs(toFinite(input.radius)),
    startAngle: start,
    endAngle: end,
    direction
  }
}
