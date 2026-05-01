import { SymbolDocument, SymbolPort, SymbolPortDirection, SymbolSelection, SymbolShape } from '../types/symbolDocument'

const SYMBOL_EDITOR_PREFIX = 'symbols/.editor/'
const SYMBOL_EDITOR_SUFFIX = '.symbol.json'

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

export const createSymbolDocument = (name: string): SymbolDocument => {
  return {
    kind: 'symbol',
    name: toSafeSymbolName(name),
    description: '',
    width: 120,
    height: 80,
    shapes: [],
    ports: []
  }
}

export const parseSymbolDocument = (raw: string, fallbackName: string): SymbolDocument | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<SymbolDocument>
    if (parsed.kind !== 'symbol') return null

    return {
      kind: 'symbol',
      name: toSafeSymbolName(String(parsed.name || fallbackName || 'MySymbol')),
      description: String(parsed.description || ''),
      width: Number(parsed.width || 120),
      height: Number(parsed.height || 80),
      needsManualReview: !!parsed.needsManualReview,
      shapes: Array.isArray(parsed.shapes) ? (parsed.shapes as SymbolShape[]) : [],
      ports: Array.isArray(parsed.ports) ? (parsed.ports as SymbolPort[]) : []
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

const symbolShapeToTsx = (shape: SymbolShape): string => {
  if (shape.kind === 'schematicline') {
    return `<schematicline x1={${toTsxNumber(shape.x1)}} y1={${toTsxNumber(shape.y1)}} x2={${toTsxNumber(shape.x2)}} y2={${toTsxNumber(shape.y2)}} />`
  }

  if (shape.kind === 'schematicrect') {
    return `<schematicrect schX={${toTsxNumber(shape.schX)}} schY={${toTsxNumber(shape.schY)}} width={${toTsxNumber(shape.width)}} height={${toTsxNumber(shape.height)}} />`
  }

  if (shape.kind === 'schematiccircle') {
    return `<schematiccircle center={{ x: ${toTsxNumber(shape.center.x)}, y: ${toTsxNumber(shape.center.y)} }} radius={${toTsxNumber(shape.radius)}} />`
  }

  if (shape.kind === 'schematicarc') {
    return `<schematicarc center={{ x: ${toTsxNumber(shape.center.x)}, y: ${toTsxNumber(shape.center.y)} }} radius={${toTsxNumber(shape.radius)}} startAngleDegrees={${toTsxNumber(shape.startAngleDegrees)}} endAngleDegrees={${toTsxNumber(shape.endAngleDegrees)}} />`
  }

  return `<schematictext schX={${toTsxNumber(shape.schX)}} schY={${toTsxNumber(shape.schY)}} text="${escapeStringLiteral(shape.text)}" />`
}

const symbolPortToTsx = (port: SymbolPort): string => {
  return `<port name="${escapeStringLiteral(port.name)}" direction="${port.direction}" schX={${toTsxNumber(port.schX)}} schY={${toTsxNumber(port.schY)}} />`
}

const toSafeComponentIdentifier = (raw: string): string => {
  const safe = toSafeSymbolName(raw)
  if (/^[0-9]/.test(safe)) return `Symbol_${safe}`
  return safe
}

export const generateSymbolTsx = (document: SymbolDocument): string => {
  const fnName = toSafeComponentIdentifier(document.name || 'MySymbol')
  const rows = [
    ...document.shapes.map(symbolShapeToTsx),
    ...document.ports.map(symbolPortToTsx)
  ]

  const body = rows.length > 0
    ? rows.map(row => `          ${row}`).join('\n')
    : '          {/* Empty symbol */}'

  return `export default function ${fnName}(props: { name: string; schX?: number; schY?: number }) {\n  return (\n    <chip\n      name={props.name}\n      schX={props.schX}\n      schY={props.schY}\n      footprint=\"none\"\n      symbol={\n        <symbol>\n${body}\n        </symbol>\n      }\n    />\n  )\n}\n`
}

const parseNumericProp = (tag: string, propName: string): { value: number | null; dynamic: boolean } => {
  const exprMatch = tag.match(new RegExp(`${propName}\\s*=\\s*\\{([^}]+)\\}`))
  if (exprMatch?.[1] !== undefined) {
    const raw = exprMatch[1].trim()
    if (/^-?\\d+(?:\\.\\d+)?$/.test(raw)) {
      return { value: Number(raw), dynamic: false }
    }
    return { value: null, dynamic: true }
  }

  const stringMatch = tag.match(new RegExp(`${propName}\\s*=\\s*[\"']([^\"']+)[\"']`))
  if (stringMatch?.[1] !== undefined) {
    const raw = stringMatch[1].trim()
    if (/^-?\\d+(?:\\.\\d+)?$/.test(raw)) {
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

const parseCenter = (tag: string): { center: { x: number; y: number } | null; dynamic: boolean } => {
  const match = tag.match(/center\s*=\s*\{\{\s*x\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*y\s*:\s*(-?\d+(?:\.\d+)?)\s*\}\}/)
  if (match) {
    return {
      center: { x: Number(match[1]), y: Number(match[2]) },
      dynamic: false
    }
  }

  if (/center\s*=/.test(tag)) {
    return { center: null, dynamic: true }
  }

  return { center: null, dynamic: false }
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
    const width = parseNumericProp(tag, 'width')
    const height = parseNumericProp(tag, 'height')
    if ([schX.value, schY.value, width.value, height.value].every(v => v !== null)) {
      document.shapes.push({ id: nextImportedId('rect'), kind: 'schematicrect', schX: schX.value as number, schY: schY.value as number, width: width.value as number, height: height.value as number })
    } else {
      needsManualReview = needsManualReview || schX.dynamic || schY.dynamic || width.dynamic || height.dynamic
    }
  })

  const circleTags = [...body.matchAll(/<schematiccircle\b[^>]*\/?>(?:<\/schematiccircle>)?/g)].map(match => match[0])
  circleTags.forEach(tag => {
    const center = parseCenter(tag)
    const radius = parseNumericProp(tag, 'radius')
    if (center.center && radius.value !== null) {
      document.shapes.push({ id: nextImportedId('circle'), kind: 'schematiccircle', center: center.center, radius: radius.value })
    } else {
      needsManualReview = needsManualReview || center.dynamic || radius.dynamic
    }
  })

  const arcTags = [...body.matchAll(/<schematicarc\b[^>]*\/?>(?:<\/schematicarc>)?/g)].map(match => match[0])
  arcTags.forEach(tag => {
    const center = parseCenter(tag)
    const radius = parseNumericProp(tag, 'radius')
    const startAngle = parseNumericProp(tag, 'startAngleDegrees')
    const endAngle = parseNumericProp(tag, 'endAngleDegrees')
    if (center.center && radius.value !== null && startAngle.value !== null && endAngle.value !== null) {
      document.shapes.push({
        id: nextImportedId('arc'),
        kind: 'schematicarc',
        center: center.center,
        radius: radius.value,
        startAngleDegrees: startAngle.value,
        endAngleDegrees: endAngle.value
      })
    } else {
      needsManualReview = needsManualReview || center.dynamic || radius.dynamic || startAngle.dynamic || endAngle.dynamic
    }
  })

  const textTags = [...body.matchAll(/<schematictext\b[^>]*\/?>(?:<\/schematictext>)?/g)].map(match => match[0])
  textTags.forEach(tag => {
    const schX = parseNumericProp(tag, 'schX')
    const schY = parseNumericProp(tag, 'schY')
    const text = parseStringProp(tag, 'text')
    if (schX.value !== null && schY.value !== null && text.value !== null) {
      document.shapes.push({
        id: nextImportedId('text'),
        kind: 'schematictext',
        schX: schX.value,
        schY: schY.value,
        text: text.value
      })
    } else {
      needsManualReview = needsManualReview || schX.dynamic || schY.dynamic || text.dynamic
    }
  })

  const portTags = [...body.matchAll(/<port\b[^>]*\/?>(?:<\/port>)?/g)].map(match => match[0])
  portTags.forEach(tag => {
    const name = parseStringProp(tag, 'name')
    const direction = parseStringProp(tag, 'direction')
    const schX = parseNumericProp(tag, 'schX')
    const schY = parseNumericProp(tag, 'schY')
    if (name.value !== null && schX.value !== null && schY.value !== null) {
      const parsedDirection = (direction.value || 'passive') as SymbolPortDirection
      document.ports.push({
        id: nextImportedId('port'),
        name: name.value,
        direction: ['input', 'output', 'inout', 'passive'].includes(parsedDirection) ? parsedDirection : 'passive',
        schX: schX.value,
        schY: schY.value
      })
    } else {
      needsManualReview = needsManualReview || name.dynamic || direction.dynamic || schX.dynamic || schY.dynamic
    }
  })

  if (/\{[^}]*=>|\{[^}]*\bprops\b|\{[^}]*\bmap\b/.test(body)) {
    needsManualReview = true
  }

  document.needsManualReview = needsManualReview
  return document
}

export const updateSymbolSelectionAfterDelete = (
  selection: SymbolSelection,
  deletedId: string,
  deletedKind: 'shape' | 'port'
): SymbolSelection => {
  if (!selection) return null
  if (selection.kind === deletedKind && selection.id === deletedId) return null
  return selection
}
