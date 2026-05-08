import { minimalImportExportTestUtils } from '../src/store/editorStore'
import type { PlacedComponent, WireConnection } from '../src/types/catalog'

type CaseDef = {
  id: string
  description: string
  source: string
}

const cases: CaseDef[] = [
  {
    id: 'case-1',
    description: 'explicit <net /> + one chip + one trace',
    source: `
<chip name="U1" pinCount={8} footprint="soic8" />
<net name="VCC" />
<trace from=".U1 > .pin1" to="net.VCC" />
`.trim()
  },
  {
    id: 'case-2',
    description: 'one net reused by multiple traces',
    source: `
<chip name="U1" pinCount={8} footprint="soic8" />
<chip name="U2" pinCount={8} footprint="soic8" />
<net name="GND" />
<trace from=".U1 > .pin1" to="net.GND" />
<trace from=".U2 > .pin2" to="net.GND" />
`.trim()
  },
  {
    id: 'case-3',
    description: 'implicit net via net.* trace with no explicit <net />',
    source: `
<chip name="U1" pinCount={8} footprint="soic8" />
<chip name="U2" pinCount={8} footprint="soic8" />
<trace from=".U1 > .pin1" to="net.VCC" />
<trace from=".U2 > .pin3" to="net.VCC" />
`.trim()
  },
  {
    id: 'case-4',
    description: 'import without schematic coordinates',
    source: `
<chip name="U1" pinCount={8} footprint="soic8" />
<net name="VCC" />
<trace from=".U1 > .pin1" to="net.VCC" />
`.trim()
  },
  {
    id: 'case-6',
    description: 'trace directly from net.GND to net.VCC merges nets',
    source: `
<net name="GND" />
<net name="VCC" />
<trace from="net.GND" to="net.VCC" />
`.trim()
  },
  {
    id: 'case-7',
    description: 'merged net survives round-trip without splitting back',
    source: `
<chip name="U1" pinCount={8} footprint="soic8" />
<net name="GND" />
<net name="VCC" />
<trace from="net.GND" to="net.VCC" />
<trace from=".U1 > .pin1" to="net.VCC" />
`.trim()
  },
  {
    id: 'case-8',
    description: 'merged net reused by chip pins on both former names',
    source: `
<chip name="U1" pinCount={8} footprint="soic8" />
<chip name="U2" pinCount={8} footprint="soic8" />
<net name="GND" />
<net name="VCC" />
<trace from=".U1 > .pin1" to="net.GND" />
<trace from=".U2 > .pin2" to="net.VCC" />
<trace from="net.GND" to="net.VCC" />
`.trim()
  }
]

const canonical = (name: string): string => name.trim().toUpperCase()

const endpointSignature = (
  endpoint: { componentId: string; pinName: string },
  byId: Map<string, PlacedComponent>
): string => {
  const component = byId.get(endpoint.componentId)
  if (!component) return 'missing'

  if (component.catalogId === 'net' || component.catalogId === 'netport') {
    const netName = canonical(String(component.props.netName || component.props.name || component.name || ''))
    return `net:${netName}`
  }

  const compName = String(component.name || component.props.name || '')
  return `comp:${compName}.${endpoint.pinName}`
}

const logicalSignature = (components: PlacedComponent[], wires: WireConnection[]) => {
  const byId = new Map(components.map(component => [component.id, component]))

  const edges = wires
    .map((wire) => {
      const a = endpointSignature(wire.from, byId)
      const b = endpointSignature(wire.to, byId)
      return [a, b].sort().join(' <-> ')
    })
    // Exclude self-loop edges produced by net-to-net merge (net:X <-> net:X)
    .filter(edge => {
      const halves = edge.split(' <-> ')
      return halves[0] !== halves[1]
    })
    .sort()

  const nets = components
    .filter(component => component.catalogId === 'net' || component.catalogId === 'netport')
    .map(component => canonical(String(component.props.netName || component.props.name || component.name || '')))
    .filter(Boolean)
  const uniqueNets = [...new Set(nets)].sort()

  return {
    edges,
    nets: uniqueNets
  }
}

const countMatches = (source: string, re: RegExp): number => {
  const matches = source.match(re)
  return matches ? matches.length : 0
}

const stripCommentBlocks = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '')

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message)
  }
}

const runCase = (testCase: CaseDef) => {
  const parsed = minimalImportExportTestUtils.parseImportedTSXToCanvas(testCase.source, 'main.tsx')
  const exported = minimalImportExportTestUtils.exportCanvasToTSX('main.tsx', parsed.components, parsed.wires)
  const reparsed = minimalImportExportTestUtils.parseImportedTSXToCanvas(exported, 'main.tsx')

  const beforeSig = logicalSignature(parsed.components, parsed.wires)
  const afterSig = logicalSignature(reparsed.components, reparsed.wires)

  const commonChecks = () => {
    assert(JSON.stringify(beforeSig.edges) === JSON.stringify(afterSig.edges), `${testCase.id}: logical edges changed after re-import`)
    // Pure merge cases (e.g. net-to-net only) may have no cross-component edges; require at least one net or edge
    assert(beforeSig.edges.length > 0 || beforeSig.nets.length > 0, `${testCase.id}: expected at least one logical element (edge or net)`)
    assert(!/netAnchorKind\s*=/.test(exported), `${testCase.id}: internal netAnchorKind leaked into export`)
    assert(!/isImplicitImportedNetAnchor\s*=/.test(exported), `${testCase.id}: internal implicit-anchor flag leaked into export`)
  }

  switch (testCase.id) {
    case 'case-1': {
      const codeOnly = stripCommentBlocks(exported)
      assert(countMatches(codeOnly, /<net\b[^>]*name="VCC"[^>]*\/>/g) === 1, 'case-1: expected exactly one logical VCC net component')
      assert(countMatches(exported, /net\.VCC/g) >= 1, 'case-1: expected net.VCC in trace endpoint(s)')
      commonChecks()
      break
    }

    case 'case-2': {
      const codeOnly = stripCommentBlocks(exported)
      assert(countMatches(codeOnly, /<net\b[^>]*name="GND"[^>]*\/>/g) === 1, 'case-2: expected exactly one logical GND net component')
      assert(countMatches(exported, /net\.GND/g) >= 2, 'case-2: expected net.GND reused by multiple traces')
      commonChecks()
      break
    }

    case 'case-3': {
      const implicitAnchors = parsed.components.filter(component =>
        component.catalogId === 'netport' || component.props.isImplicitImportedNetAnchor === true
      )
      assert(implicitAnchors.length === 0, 'case-3: no implicit netport anchors should be generated')
      assert(countMatches(exported, /net\.VCC/g) >= 2, 'case-3: expected net.VCC trace references after export')
      assert(countMatches(exported, /<net\b[^>]*name="VCC"[^>]*\/>/g) === 1, 'case-3: expected inferred explicit VCC net metadata to be emitted')
      commonChecks()
      break
    }

    case 'case-4': {
      const noCoords = parsed.components.filter(component =>
        typeof component.props.schX !== 'number' || typeof component.props.schY !== 'number'
      )
      assert(noCoords.length === 0, 'case-4: expected fallback schematic coordinates on all imported components')
      commonChecks()
      break
    }

    case 'case-6': {
      const codeOnly = stripCommentBlocks(exported)
      assert(countMatches(codeOnly, /<net\b[^>]*\/>/g) === 1, 'case-6: expected one merged explicit net after net-to-net merge')
      assert(countMatches(codeOnly, /<net\b[^>]*name="GND"[^>]*\/>/g) === 1, 'case-6: expected merged canonical net to be GND')
      assert(countMatches(exported, /net\.VCC/g) === 0, 'case-6: expected all net references remapped away from net.VCC')
      commonChecks()
      break
    }

    case 'case-7': {
      const uniqueAfterNets = [...new Set(afterSig.nets)]
      assert(uniqueAfterNets.length === 1, 'case-7: expected one logical net after round-trip merge')
      assert(uniqueAfterNets[0] === 'GND', 'case-7: expected merged net canonical name to remain GND')
      assert(countMatches(exported, /net\.VCC/g) === 0, 'case-7: expected no net.VCC references after merge')
      commonChecks()
      break
    }

    case 'case-8': {
      const codeOnly = stripCommentBlocks(exported)
      assert(countMatches(exported, /net\.GND/g) >= 2, 'case-8: expected both chip traces to use merged net.GND')
      assert(countMatches(exported, /net\.VCC/g) === 0, 'case-8: expected former net.VCC references to be merged away')
      assert(countMatches(codeOnly, /<net\b[^>]*\/>/g) === 1, 'case-8: expected one explicit merged net component')
      commonChecks()
      break
    }

    default:
      throw new Error(`Unhandled case: ${testCase.id}`)
  }

  return {
    exported,
    beforeSig,
    afterSig
  }
}

const main = () => {
  console.log('Running minimal TSX import/export round-trip verification...')

  for (const testCase of cases) {
    const result = runCase(testCase)
    console.log(`PASS ${testCase.id}: ${testCase.description}`)
    console.log(`  logical edges: ${result.beforeSig.edges.length}`)
    console.log(`  logical nets:  ${result.beforeSig.nets.join(', ') || '(none)'}`)
  }

  // Case 5: overall import -> export -> re-import logical equivalence across all cases.
  const allEquivalent = cases.every((testCase) => {
    const parsed = minimalImportExportTestUtils.parseImportedTSXToCanvas(testCase.source, 'main.tsx')
    const exported = minimalImportExportTestUtils.exportCanvasToTSX('main.tsx', parsed.components, parsed.wires)
    const reparsed = minimalImportExportTestUtils.parseImportedTSXToCanvas(exported, 'main.tsx')

    const beforeSig = logicalSignature(parsed.components, parsed.wires)
    const afterSig = logicalSignature(reparsed.components, reparsed.wires)

    return JSON.stringify(beforeSig) === JSON.stringify(afterSig)
  })

  assert(allEquivalent, 'case-5: logical equivalence failed for one or more cases')
  console.log('PASS case-5: import -> export -> re-import logical equivalence')
  console.log('All minimal round-trip checks passed.')
}

main()
