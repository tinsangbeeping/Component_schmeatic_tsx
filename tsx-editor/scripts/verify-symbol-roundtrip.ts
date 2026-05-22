import { buildWorkspaceComponentRegistry, buildWorkspaceSymbolRegistry, extractAllSymbols } from '../src/utils/projectManager'
import { createSymbolDocument, generateSymbolTsx, importSymbolTsxToDocument } from '../src/utils/symbolDocument'
import { getArcEndpoint, toSvgArcAngle } from '../src/utils/arcAngles'
import type { FSMap } from '../src/types/catalog'
import { schematicArcProps, schematicCircleProps, schematicLineProps, schematicRectProps } from '@tscircuit/props'

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message)
}

const approximatelyEqual = (left: number, right: number) => Math.abs(left - right) < 1e-6

const extractSingleTag = (tsx: string, tagName: string): string => {
  const tag = tsx.match(new RegExp(`<${tagName}\\b[^>]*\\/>`))?.[0]
  if (!tag) throw new Error(`missing <${tagName} /> in exported TSX`)
  return tag
}

const extractTags = (tsx: string, tagName: string): string[] => {
  return [...tsx.matchAll(new RegExp(`<${tagName}\\b[^>]*\\/>`, 'g'))].map(match => match[0])
}

const parseNumericAttr = (tag: string, attr: string): number => {
  const value = tag.match(new RegExp(`${attr}\\s*=\\s*\\{([^}]+)\\}`))?.[1]?.trim()
  if (!value || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`missing numeric attr ${attr} on tag: ${tag}`)
  }
  return Number(value)
}

const parseCenterAttr = (tag: string): { x: number; y: number } => {
  const match = tag.match(/center\s*=\s*\{\{\s*x\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*y\s*:\s*(-?\d+(?:\.\d+)?)\s*\}\}/)
  if (!match) throw new Error(`missing numeric center attr on tag: ${tag}`)
  return { x: Number(match[1]), y: Number(match[2]) }
}

const normalizeRef = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^\/+/, '')
    .replace(/^symbols\/(?:\.editor|editor)\//, '')
    .replace(/^symbols\//, '')
    .replace(/\.symbol\.json$/i, '')
    .replace(/\.(tsx|ts)$/i, '')
}

const resolveSymbolByRef = (fsMap: FSMap, symbolRef: string) => {
  const allSymbols = extractAllSymbols(fsMap)
  const map = new Map<string, ReturnType<typeof extractAllSymbols>[number]>()

  const add = (symbol: ReturnType<typeof extractAllSymbols>[number], alias: string) => {
    const key = normalizeRef(alias)
    if (!key) return
    map.set(key, symbol)
  }

  allSymbols.forEach((symbol) => {
    add(symbol, symbol.id)
    add(symbol, symbol.name)
    add(symbol, symbol.filePath)
    add(symbol, `symbols/${symbol.id}`)
    add(symbol, `symbols/${symbol.id}.tsx`)
    add(symbol, `symbols/.editor/${symbol.id}.symbol.json`)
    add(symbol, `symbols/editor/${symbol.id}.symbol.json`)
  })

  return map.get(normalizeRef(symbolRef))
}

const run = () => {
  assert(toSvgArcAngle(0) === 180, 'arc angle basis: 0 degrees must render on the left side')
  assert(toSvgArcAngle(90) === 270, 'arc angle basis: 90 degrees must render on the top side')
  assert(toSvgArcAngle(180) === 0, 'arc angle basis: 180 degrees must render on the right side')
  assert(toSvgArcAngle(270) === 90, 'arc angle basis: 270 degrees must render on the bottom side')

  const leftPoint = getArcEndpoint(0, 0, 10, 0)
  const topPoint = getArcEndpoint(0, 0, 10, 90)
  const rightPoint = getArcEndpoint(0, 0, 10, 180)
  const bottomPoint = getArcEndpoint(0, 0, 10, 270)
  assert(approximatelyEqual(leftPoint.x, -10) && approximatelyEqual(leftPoint.y, 0), 'arc angle basis: 0 degrees endpoint mismatch')
  assert(approximatelyEqual(topPoint.x, 0) && approximatelyEqual(topPoint.y, -10), 'arc angle basis: 90 degrees endpoint mismatch')
  assert(approximatelyEqual(rightPoint.x, 10) && approximatelyEqual(rightPoint.y, 0), 'arc angle basis: 180 degrees endpoint mismatch')
  assert(approximatelyEqual(bottomPoint.x, 0) && approximatelyEqual(bottomPoint.y, 10), 'arc angle basis: 270 degrees endpoint mismatch')

  const symbolDoc = createSymbolDocument('test1')
  symbolDoc.width = 160
  symbolDoc.height = 120
  symbolDoc.shapes = [
    { id: 'line-1', kind: 'schematicline', x1: 10, y1: 20, x2: 120, y2: 34 },
    { id: 'rect-1', kind: 'schematicrect', cx: 70, cy: 75, width: 46, height: 18 },
    { id: 'circle-1', kind: 'schematiccircle', cx: 120, cy: 36, radius: 20 },
    { id: 'arc-1', kind: 'schematicarc', cx: 84, cy: 56, radius: 12, startAngle: 0, endAngle: 180, direction: 'clockwise' },
    { id: 'text-1', kind: 'schematictext', x: 14, y: 108, text: 'ASYM' }
  ]
  symbolDoc.ports = [
    { id: 'p-left', name: 'VIN', side: 'left', schX: 0, schY: 36, electricalDirection: 'input' },
    { id: 'p-right', name: 'VOUT', side: 'right', schX: 160, schY: 64, electricalDirection: 'output' },
    { id: 'p-top', name: 'EN', side: 'top', schX: 90, schY: 0, electricalDirection: 'input' }
  ]

  const generatedTsx = generateSymbolTsx(symbolDoc)
  const directImport = importSymbolTsxToDocument(generatedTsx, 'test1')
  assert(generatedTsx.includes('<schematicline x1={10} y1={100} x2={120} y2={86} />'), 'exported TSX must flip schematicline Y coordinates into tscircuit space')
  assert(generatedTsx.includes('<schematicrect schX={70} schY={45} width={46} height={18} />'), 'exported TSX must preserve rect center while flipping Y into tscircuit space')
  assert(generatedTsx.includes('<schematiccircle center={{x: 120, y: 84}} radius={20} />'), 'exported TSX must use circle center/radius props in tscircuit Y space')
  assert(generatedTsx.includes('<schematicarc center={{x: 84, y: 64}} radius={12} startAngleDegrees={0} endAngleDegrees={180} direction="clockwise" />'), 'exported TSX must preserve declared tscircuit arc angles/direction')
  assert(generatedTsx.includes('<port name="VIN" direction="left" side="left" order={0} schX={0} schY={84} />'), 'exported TSX must use official port schX/schY props in flipped Y space')
  assert(generatedTsx.includes('<port name="VIN"'), 'exported TSX should include ports')

  // Validate primitive semantics against official @tscircuit/props schemas.
  const lineTag = extractSingleTag(generatedTsx, 'schematicline')
  const rectTag = extractSingleTag(generatedTsx, 'schematicrect')
  const circleTag = extractSingleTag(generatedTsx, 'schematiccircle')
  const arcTag = extractSingleTag(generatedTsx, 'schematicarc')

  const parsedLine = schematicLineProps.parse({
    x1: parseNumericAttr(lineTag, 'x1'),
    y1: parseNumericAttr(lineTag, 'y1'),
    x2: parseNumericAttr(lineTag, 'x2'),
    y2: parseNumericAttr(lineTag, 'y2')
  })
  assert(parsedLine.x1 === 10 && parsedLine.y1 === 100 && parsedLine.x2 === 120 && parsedLine.y2 === 86, 'schematicline semantic parse mismatch')

  const parsedRect = schematicRectProps.parse({
    schX: parseNumericAttr(rectTag, 'schX'),
    schY: parseNumericAttr(rectTag, 'schY'),
    width: parseNumericAttr(rectTag, 'width'),
    height: parseNumericAttr(rectTag, 'height')
  })
  assert(parsedRect.schX === 70 && parsedRect.schY === 45, 'schematicrect semantic parse mismatch')

  const parsedCircle = schematicCircleProps.parse({
    center: parseCenterAttr(circleTag),
    radius: parseNumericAttr(circleTag, 'radius')
  })
  assert(parsedCircle.center.x === 120 && parsedCircle.center.y === 84, 'schematiccircle semantic parse mismatch')

  const parsedArc = schematicArcProps.parse({
    center: parseCenterAttr(arcTag),
    radius: parseNumericAttr(arcTag, 'radius'),
    startAngleDegrees: parseNumericAttr(arcTag, 'startAngleDegrees'),
    endAngleDegrees: parseNumericAttr(arcTag, 'endAngleDegrees'),
    direction: arcTag.match(/direction\s*=\s*"([^"]+)"/)?.[1]
  })
  assert(parsedArc.center.x === 84 && parsedArc.center.y === 64, 'schematicarc center semantic parse mismatch')
  assert(parsedArc.startAngleDegrees === 0 && parsedArc.endAngleDegrees === 180, 'schematicarc angle semantic parse mismatch')
  assert(parsedArc.direction === 'clockwise', 'schematicarc direction semantic parse mismatch')

  // A: Symbol Maker -> placed instance (geometry+ports survive symbol extraction path)
  const fsMapA: FSMap = {
    'symbols/test1.tsx': generatedTsx
  }
  const extractedA = extractAllSymbols(fsMapA).find(symbol => symbol.id === 'test1')
  assert(!!extractedA, 'A: expected extracted symbol test1')
  const extractedKinds = new Set((extractedA?.geometry?.shapes || []).map(shape => String((shape as any).kind)))
  assert((extractedA?.geometry?.shapes.length || 0) > 0, 'A: expected non-empty symbol geometry after extraction')
  assert(extractedKinds.has('schematicline'), 'A: expected schematicline to be preserved')
  assert(extractedKinds.has('schematicrect') || extractedKinds.has('schematiccircle'), 'A: expected asymmetric body primitives to be preserved')
  assert((extractedA?.ports.length || 0) === 3, 'A: expected 3 ports from Symbol Maker')

  // B: Missing symbol geometry should be detectable as unresolved reference.
  const missing = resolveSymbolByRef(fsMapA, 'symbols/does-not-exist.tsx')
  assert(!missing, 'B: unresolved symbolRef should remain missing (placeholder path expected in runtime)')

  // C: Primitive roundtrip must preserve Symbol Maker local geometry.
  const reimported = importSymbolTsxToDocument(generatedTsx, 'test1')
  const originalRect = symbolDoc.shapes.find(shape => shape.kind === 'schematicrect') as any
  const roundtripRect = reimported.shapes.find(shape => shape.kind === 'schematicrect') as any
  assert(!!roundtripRect, 'C: roundtrip rect is missing')
  assert(roundtripRect.cx === originalRect.cx, 'C: rect cx changed during roundtrip')
  assert(roundtripRect.cy === originalRect.cy, 'C: rect cy changed during roundtrip')
  assert(roundtripRect.width === originalRect.width, 'C: rect width changed during roundtrip')
  assert(roundtripRect.height === originalRect.height, 'C: rect height changed during roundtrip')

  const originalCircle = symbolDoc.shapes.find(shape => shape.kind === 'schematiccircle') as any
  const roundtripCircle = reimported.shapes.find(shape => shape.kind === 'schematiccircle') as any
  assert(!!roundtripCircle, 'C: roundtrip circle is missing')
  assert(roundtripCircle.cx === originalCircle.cx, 'C: circle cx changed during roundtrip')
  assert(roundtripCircle.cy === originalCircle.cy, 'C: circle cy changed during roundtrip')

  const originalArc = symbolDoc.shapes.find(shape => shape.kind === 'schematicarc') as any
  const roundtripArc = reimported.shapes.find(shape => shape.kind === 'schematicarc') as any
  assert(!!roundtripArc, 'C: roundtrip arc is missing')
  assert(roundtripArc.cx === originalArc.cx, 'C: arc cx changed during roundtrip')
  assert(roundtripArc.cy === originalArc.cy, 'C: arc cy changed during roundtrip')
  assert(roundtripArc.startAngle === originalArc.startAngle, 'C: arc startAngle changed during roundtrip')
  assert(roundtripArc.endAngle === originalArc.endAngle, 'C: arc endAngle changed during roundtrip')
  assert(roundtripArc.direction === originalArc.direction, 'C: arc direction changed during roundtrip')

  const quarterArcDoc = createSymbolDocument('quarterArc')
  quarterArcDoc.width = 120
  quarterArcDoc.height = 80
  quarterArcDoc.shapes = [
    { id: 'arc-quarter', kind: 'schematicarc', cx: 50, cy: 30, radius: 17, startAngle: 180, endAngle: 270, direction: 'clockwise' }
  ]
  const quarterArcTsx = generateSymbolTsx(quarterArcDoc)
  assert(quarterArcTsx.includes('<schematicarc center={{x: 50, y: 50}} radius={17} startAngleDegrees={180} endAngleDegrees={270} direction="clockwise" />'), 'C: top-left quarter arc must export declared tscircuit angles/direction literally')
  const reimportedQuarterArc = importSymbolTsxToDocument(quarterArcTsx, 'quarterArc')
  const quarterArcRoundtrip = reimportedQuarterArc.shapes.find(shape => shape.kind === 'schematicarc') as any
  assert(quarterArcRoundtrip.startAngle === 180, 'C: quarter arc startAngle changed during roundtrip')
  assert(quarterArcRoundtrip.endAngle === 270, 'C: quarter arc endAngle changed during roundtrip')
  assert(quarterArcRoundtrip.direction === 'clockwise', 'C: quarter arc must default to clockwise drawing')

  const implicitDirectionQuarterArc = importSymbolTsxToDocument(
    quarterArcTsx.replace(/\s+direction="(?:clockwise|counterclockwise)"/, ''),
    'quarterArcNoDirection'
  )
  const implicitDirectionArc = implicitDirectionQuarterArc.shapes.find(shape => shape.kind === 'schematicarc') as any
  assert(implicitDirectionArc.direction === undefined, 'C: imported arcs without direction must preserve implicit tscircuit direction')
  const implicitDirectionTsx = generateSymbolTsx(implicitDirectionQuarterArc)
  assert(!extractSingleTag(implicitDirectionTsx, 'schematicarc').includes('direction='), 'C: implicit arc direction must not be exported as an explicit direction')

  const angledArcDoc = createSymbolDocument('angledArc')
  angledArcDoc.width = 120
  angledArcDoc.height = 80
  angledArcDoc.shapes = [
    { id: 'arc-angled', kind: 'schematicarc', cx: 60, cy: 40, radius: 16, startAngle: 90, endAngle: 210, direction: 'clockwise' }
  ]
  const angledArcTsx = generateSymbolTsx(angledArcDoc)
  assert(angledArcTsx.includes('<schematicarc center={{x: 60, y: 40}} radius={16} startAngleDegrees={90} endAngleDegrees={210} direction="clockwise" />'), 'C: 90-210 clockwise arc must export declared tscircuit angles/direction literally')
  const reimportedAngledArc = importSymbolTsxToDocument(angledArcTsx, 'angledArc')
  const angledArcRoundtrip = reimportedAngledArc.shapes.find(shape => shape.kind === 'schematicarc') as any
  assert(angledArcRoundtrip.startAngle === 90, 'C: angled arc startAngle changed during roundtrip')
  assert(angledArcRoundtrip.endAngle === 210, 'C: angled arc endAngle changed during roundtrip')

  const arcFixtureCases = [
    { startAngle: 0, endAngle: 30, radius: 1 },
    { startAngle: 0, endAngle: 60, radius: 2 },
    { startAngle: 0, endAngle: 90, radius: 3 },
    { startAngle: 0, endAngle: 330, radius: 11 }
  ]
  ;(['clockwise', 'counterclockwise'] as const).forEach((direction, directionIndex) => {
    const fixtureDoc = createSymbolDocument(`arcFixture${direction}`)
    fixtureDoc.width = 160
    fixtureDoc.height = 80
    fixtureDoc.shapes = arcFixtureCases.map((arcCase, index) => ({
      id: `${direction}-arc-${index}`,
      kind: 'schematicarc',
      cx: 20 + index * 34,
      cy: 24 + directionIndex * 28,
      radius: arcCase.radius,
      startAngle: arcCase.startAngle,
      endAngle: arcCase.endAngle,
      direction
    }))

    const fixtureTsx = generateSymbolTsx(fixtureDoc)
    const arcTags = extractTags(fixtureTsx, 'schematicarc')
    assert(arcTags.length === arcFixtureCases.length, `C: ${direction} arc fixture should export all requested arcs`)
    arcTags.forEach((tag, index) => {
      const parsed = schematicArcProps.parse({
        center: parseCenterAttr(tag),
        radius: parseNumericAttr(tag, 'radius'),
        startAngleDegrees: parseNumericAttr(tag, 'startAngleDegrees'),
        endAngleDegrees: parseNumericAttr(tag, 'endAngleDegrees'),
        direction: tag.match(/direction\s*=\s*"([^"]+)"/)?.[1]
      })
      assert(parsed.radius === arcFixtureCases[index].radius, `C: ${direction} arc fixture radius mismatch`)
      assert(parsed.startAngleDegrees === arcFixtureCases[index].startAngle, `C: ${direction} arc fixture exported start angle mismatch`)
      assert(parsed.endAngleDegrees === arcFixtureCases[index].endAngle, `C: ${direction} arc fixture exported end angle mismatch`)
      assert(parsed.direction === direction, `C: ${direction} arc fixture exported direction mismatch`)
    })

    const roundtrip = importSymbolTsxToDocument(fixtureTsx, `arcFixture${direction}`)
    assert(roundtrip.shapes.filter(shape => shape.kind === 'schematicarc').length === arcFixtureCases.length, `C: ${direction} arc fixture roundtrip should preserve all arcs`)
  })

  // D: EFR32PowerChip symbolRef/port-side behavior via registry.
  const efrDoc = createSymbolDocument('EFR32PowerChip')
  efrDoc.width = 200
  efrDoc.height = 120
  efrDoc.shapes = [
    { id: 'efr-body', kind: 'schematicrect', cx: 100, cy: 60, width: 120, height: 70 }
  ]
  efrDoc.ports = [
    { id: 'efr-left-1', name: 'VREGVDD', side: 'left', schX: 0, schY: 28, electricalDirection: 'input' },
    { id: 'efr-left-2', name: 'AVDD', side: 'left', schX: 0, schY: 84, electricalDirection: 'input' },
    { id: 'efr-right-1', name: 'DVDD', side: 'right', schX: 200, schY: 30, electricalDirection: 'output' },
    { id: 'efr-right-2', name: 'DECOUPLE', side: 'right', schX: 200, schY: 88, electricalDirection: 'passive' }
  ]

  const fsMapD: FSMap = {
    ...fsMapA,
    'symbols/EFR32PowerChip.tsx': generateSymbolTsx(efrDoc)
  }

  const componentRegistry = buildWorkspaceComponentRegistry(fsMapD)
  const symbolRegistry = buildWorkspaceSymbolRegistry(fsMapD)
  const componentDef = componentRegistry.EFR32PowerChip
  assert(!!componentDef, 'D: expected EFR32PowerChip component definition')
  assert(!!componentDef?.symbolRef, 'D: expected EFR32PowerChip symbolRef')

  const resolved = symbolRegistry[normalizeRef(componentDef?.symbolRef || '')]
  assert(!!resolved, 'D: EFR32PowerChip symbolRef must resolve in symbol registry')
  assert((resolved?.geometry?.shapes.length || 0) > 0, 'D: EFR32PowerChip should have renderable symbol geometry')
  const leftPorts = (resolved?.ports || []).filter(port => port.side === 'left')
  const rightPorts = (resolved?.ports || []).filter(port => port.side === 'right')
  assert(leftPorts.length >= 1, 'D: expected at least one left-side port')
  assert(rightPorts.length >= 1, 'D: expected at least one right-side port')
  assert(leftPorts.every(port => port.schX === 0), 'D: expected left ports to snap to schX=0')
  assert(rightPorts.every(port => port.schX === (resolved?.width || 200)), 'D: expected right ports to snap to schX=width')

  const importedLegacy = importSymbolTsxToDocument(`export default function EFR32Power() {
  return (
    <chip name="U1" symbol={
      <symbol>
        <port name="RESETN" schX={-15} schY={9} direction="left" />
        <port name="BODEN" schX={-15} schY={7} direction="left" />
        <port name="VREGVDD" schX={-15} schY={4} direction="left" />
        <port name="DVDD" schX={15} schY={4} direction="right" />
        <port name="DECOUPLE" schX={15} schY={1} direction="right" />
        <port name="VREGVSS_1" schX={15} schY={-4} direction="right" />
      </symbol>
    } />
  )
}
`, 'EFR32Power')
  const importedRight = importedLegacy.ports.filter(port => port.side === 'right')
  assert(importedLegacy.ports.every(port => port.schX === 0 || port.schX === importedLegacy.width || port.schY === 0 || port.schY === importedLegacy.height), 'D: imported ports should snap to symbol edges')
  assert(new Set(importedRight.map(port => port.schY)).size === importedRight.length, 'D: imported right-side ports should be vertically separated')

  console.log('PASS A: Symbol Maker geometry is preserved for placed symbol extraction path')
  console.log('PASS B: Missing symbol geometry is detectable via unresolved symbolRef')
  console.log('PASS C: Rect primitive local geometry survives export-import roundtrip')
  console.log('PASS D: EFR32PowerChip symbolRef resolves with proper geometry and sided ports')
  console.log('All symbol roundtrip checks passed.')
}

run()
